import type { RunProgress } from "../server/run-progress.ts";
type Credentials = { id: string; accessToken: string };
type Session = {
  id: string; stage: string; stateAddress?: string; confirmed: number; error?: string; queuePosition: number;
  messages: { id: string; role: string; text: string }[];
  receipts: { signature: string; lane?: number; at: string }[];
  header?: { phase: number; layer: number; count: number; cursor: number };
  run?: { promptTokens: number; processedPromptTokens: number; generatedTokens: number; maximumOutputTokens: number; startedAt?: string; progress?: RunProgress };
};
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const storageKey = "break-sponsored-chat-v1";
const ownerKey = (id: string) => `staccpad-chat-owner:${id}`;
let explorerQuery = "cluster=testnet";
const explorer = (kind: "address" | "tx", value: string) => `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}?${explorerQuery}`;
function applyNetwork(status: { cluster?: string; genesis?: string; explorerRpc?: string; registry?: string }) {
  if (status.cluster !== "testnet" && status.cluster !== "custom") return;
  const custom = status.cluster === "custom";
  explorerQuery = custom ? "cluster=custom" : "cluster=testnet";
  if (custom && status.explorerRpc) {
    try {
      const rpcUrl = new URL(status.explorerRpc);
      if (rpcUrl.protocol === "https:" || rpcUrl.protocol === "http:")
        explorerQuery = new URLSearchParams({ cluster: "custom", customUrl: rpcUrl.href }).toString();
    } catch { /* A custom RPC URL is optional for Explorer links. */ }
  }
  element("network-note").textContent = `CHAT.STACCPAD.FUN / ${custom ? "CUSTOM SOLANA CHAIN" : "SOLANA TESTNET"}`;
  element("network-pill-label").textContent = `${custom ? "CUSTOM CHAIN" : "TESTNET"} / TX V1`;
  element("network-pill").title = status.genesis ? `Genesis: ${status.genesis}` : "";
  element("hero-network").textContent = status.registry
    ? `Qwen3-8B, running on ${custom ? "a custom Solana chain" : "Solana testnet"}.`
    : `Qwen3-8B, awaiting deployment on ${custom ? "a custom Solana chain" : "Solana testnet"}.`;
  element("hero-chain-note").textContent = custom
    ? "Trade CHAT on Solana mainnet. Talk to the model on the custom model chain."
    : "Trade CHAT on Solana mainnet. The current chat runs on Solana testnet while the new model chain is prepared.";
  element("trade-chain-note").textContent = custom
    ? "Trades sign on Solana mainnet. Sponsored inference runs on the custom model chain. Balances and transactions are separate."
    : "Trades sign on Solana mainnet. Sponsored inference currently runs on Solana testnet. Balances and transactions are separate.";
  element("trade-chain-title").textContent = custom ? "ONE ADDRESS. TWO CHAINS." : "TRADE + TESTNET CHAT.";
  element("execution-network-note").textContent = custom
    ? "Prompts and model state are recorded on this chain."
    : "Prompts and model state are public on testnet.";
  element("sponsor-network-note").textContent = custom
    ? "No chain-native SOL hunting."
    : "No testnet SOL hunting.";
}
const phases: Record<number, string> = { 1: "Loading your token", 2: "Normalizing", 3: "Attention projections", 4: "Position encoding", 5: "Attention", 6: "Attention output", 7: "Normalizing", 8: "Feed-forward layers", 9: "Activation", 10: "Feed-forward output", 11: "Finishing the layer", 12: "Final normalization", 13: "Choosing the next token", 14: "Token ready", 15: "Preparing attention", 16: "Preparing feed-forward layers" };
function eta(range: RunProgress["finish"]) {
  if (!range) return "Estimating…";
  if (range.highSeconds < 60) return "Under a minute";
  const unit = range.highSeconds >= 3600 ? 3600 : 60, label = unit === 3600 ? "hr" : "min";
  const low = Math.max(1, Math.floor(range.lowSeconds / unit)), high = Math.max(low, Math.ceil(range.highSeconds / unit));
  return low === high ? `~${high} ${label}` : `~${low}–${high} ${label}`;
}

export async function attachConsole() {
  let credentials: Credentials | undefined, session: Session | undefined, pending = false, connected = false, pollTimer: ReturnType<typeof setTimeout>;
  const routeId = location.pathname.match(/^\/chat\/([a-f0-9-]{36})\/?$/)?.[1];
  let chatId = routeId, missing = false;
  try {
    const legacy = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    const saved = routeId ? JSON.parse(localStorage.getItem(ownerKey(routeId)) ?? "null") ?? (legacy?.id === routeId ? legacy : null) : legacy;
    if (saved && /^[a-f0-9-]{36}$/.test(saved.id) && /^[a-f0-9]{64}$/.test(saved.accessToken)) {
      credentials = saved; chatId = saved.id;
      localStorage.setItem(ownerKey(saved.id), JSON.stringify(saved));
    }
  } catch { /* New chats can work without browser storage. */ }
  if (chatId && !routeId) history.replaceState({}, "", `/chat/${chatId}`);
  const readOnly = () => !!chatId && !credentials;
  const sessionPath = () => `/api/${credentials ? "sessions" : "chats"}/${chatId}`;
  const prompt = element<HTMLTextAreaElement>("prompt"), send = element<HTMLButtonElement>("send"), start = element<HTMLButtonElement>("start"), pause = element<HTMLButtonElement>("pause");
  const progress = (text: string, error = false) => { element("progress").textContent = text; element("progress").classList.toggle("error", error); };
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(path, { method, signal: AbortSignal.timeout(45_000), headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(credentials ? { authorization: `Bearer ${credentials.accessToken}` } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.error ?? "The chat service is temporarily unavailable.", response.status);
    return data;
  }
  let stream: AbortController | undefined, streamingId: string | undefined, streamConnected = false;
  const active = () => !!session && ["queued", "setup", "running"].includes(session.stage);
  function controls() {
    const canSend = connected && !pending && !readOnly() && !missing && (!session || ["idle", "done"].includes(session.stage));
    prompt.disabled = !canSend; send.disabled = !canSend || !prompt.value.trim();
    start.disabled = pending;
    pause.hidden = readOnly();
    pause.disabled = pending; pause.textContent = session && ["paused", "error"].includes(session.stage) ? "RESUME" : "PAUSE";
    element<HTMLSelectElement>("output-length").disabled = readOnly() || pending || active();
    element("chat-mode").textContent = readOnly() ? "SHARED CHAT / LIVE VIEW" : "SPONSORED SESSION";
    element("share").hidden = !chatId || missing;
  }
  function render(value: Session) {
    session = value;
    element("authority").textContent = `${value.id.slice(0, 8)}…${value.id.slice(-8)} ↗`;
    element<HTMLAnchorElement>("session-link").href = `/chat/${value.id}`;
    document.title = `${value.messages.find(message => message.role === "you")?.text.slice(0, 45) ?? "Chat"} — STACCPAD`;
    element("chat-state").textContent = ({ idle: "READY WHEN YOU ARE", queued: "QUEUED", setup: "CREATING SESSION", running: "COMPUTING ON-CHAIN", paused: "PAUSED / SAVED", done: "TURN COMPLETE", error: "RUN SAVED / RETRY", closed: "SESSION CLOSED" } as Record<string, string>)[value.stage] ?? value.stage;
    const messages = element("messages"), nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    if (value.messages.length) messages.querySelector(".welcome")?.remove();
    for (const entry of value.messages) {
      let node = document.getElementById(`message-${entry.id}`);
      if (!node) {
        node = document.createElement("article"); node.id = `message-${entry.id}`; node.className = `message message-${entry.role}`;
        const label = document.createElement("small"); label.textContent = entry.role === "you" ? (readOnly() ? "USER" : "YOU") : "QWEN3-8B / ON-CHAIN";
        const text = document.createElement("p"); node.append(label, text); messages.append(node);
      }
      const text = node.querySelector("p")!;
      const content = entry.text || (entry.role === "model" ? "Working through the model…" : "");
      if (text.textContent !== content) text.textContent = content;
      node.classList.toggle("message-pending", !entry.text && entry.role === "model");
    }
    if (nearBottom) messages.scrollTop = messages.scrollHeight;
    element("metrics").textContent = `${value.confirmed.toLocaleString()} CONFIRMED TRANSACTIONS`;
    Array.from(element("grid").children).forEach((node, i) => node.classList.toggle("confirmed", i < Math.min(64, value.confirmed)));
    if (value.receipts.length) element("receipt-list").replaceChildren(...value.receipts.slice(0, 6).map(receipt => {
      const li = document.createElement("li"), link = document.createElement("a");
      link.href = explorer("tx", receipt.signature); link.target = "_blank"; link.rel = "noreferrer";
      link.textContent = `${receipt.signature.slice(0, 8)}…${receipt.signature.slice(-6)} ↗`; li.append(link); return li;
    }));
    const run = value.run, h = value.header;
    element("run-panel").hidden = !run || ["done", "closed"].includes(value.stage);
    if (run) {
      const p = run.progress;
      element("run-percent").textContent = p ? `${p.percent < 1 ? p.percent.toFixed(2) : p.percent.toFixed(1)}%` : "—";
      const bar = element<HTMLProgressElement>("overall-progress"); bar.value = p?.percent ?? 0;
      element("next-token-label").textContent = run.generatedTokens === 0 ? "FIRST REPLY TOKEN" : "NEXT REPLY TOKEN";
      const stopped = ["paused", "error"].includes(value.stage), waiting = p?.estimateState === "waiting";
      element("next-token-eta").textContent = run.generatedTokens >= run.maximumOutputTokens ? "All shown" : stopped ? "Paused" : waiting ? "Waiting…" : eta(p?.nextToken ?? null);
      element("finish-eta").textContent = stopped ? "Paused" : waiting ? "Waiting…" : eta(p?.finish ?? null);
      element("estimate-note").textContent = stopped ? "Estimates resume with your run. Confirmed work is saved." : waiting ?
        "Waiting for a new confirmed checkpoint. Estimates will update when work advances." : p?.finish ?
        `Rough time remaining at recent speed. Up to ${run.maximumOutputTokens} reply tokens, including saving context; the model may stop early.` :
        "Measuring confirmed work. The first reply needs all input tokens to pass through all 36 layers.";
      element("run-title").textContent = value.stage === "queued" ? `Queue position ${Math.max(1, value.queuePosition)}` : value.stage === "setup" ? `Creating session · ${value.confirmed} transactions confirmed` : value.stage === "paused" ? "Paused. Your progress is saved." : value.stage === "error" ? "Your run is saved. Resume to retry." : h?.phase === 13 ? "Choosing the next token" : `Layer ${Math.min(36, (h?.layer ?? 0) + 1)} of 36`;
      element("run-detail").textContent = value.stage === "setup" ? "Allocating on-chain memory and workers. STACC covers every transaction." : `${phases[h?.phase ?? 0] ?? "Preparing"} · ${run.processedPromptTokens < run.promptTokens ? `Input ${run.processedPromptTokens + 1}/${run.promptTokens}` : "Input processed"} · Reply ${run.generatedTokens}/${run.maximumOutputTokens}`;
      Array.from(element("layer-grid").children).forEach((cell, i) => {
        cell.classList.toggle("complete", !!h && i < h.layer); cell.classList.toggle("current", !!h && i === h.layer);
      });
    }
    if (value.error) progress(value.error, true);
    else if (value.stage === "done") progress("Turn complete. Every response token came from on-chain computation.");
    else if (value.stage === "paused") progress("Paused at an on-chain checkpoint. Resume whenever you’re ready.");
    else if (active()) progress("STACC covers the fees. You can leave this tab; your run will keep going.");
    else if (readOnly()) progress("You’re watching a shared chat live. Start a new chat to send your own message.");
    else if (value.stage === "closed") progress("This chat is archived. Its link and messages are still available.");
    else progress("You’re connected. Send a message to begin your sponsored run.");
    controls();
  }
  async function ensureSession() {
    if (!credentials) {
      if (chatId) throw new Error("This is a shared chat. Start a new chat to send a message.");
      const created = await api("/api/sessions", "POST", {});
      credentials = { id: created.session.id, accessToken: created.accessToken };
      chatId = credentials.id; history.replaceState({}, "", `/chat/${chatId}`);
      try { localStorage.setItem(storageKey, JSON.stringify(credentials)); localStorage.setItem(ownerKey(chatId!), JSON.stringify(credentials)); } catch { progress("This browser cannot save your session. Keep this tab open to retain access."); }
      render(created.session); startStream();
    }
    return credentials;
  }
  function startStream() {
    if (!chatId || missing || streamingId === chatId) return;
    stream?.abort(); stream = new AbortController(); streamingId = chatId;
    const path = sessionPath(), token = credentials?.accessToken, controller = stream;
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`${path}/events`, {
            headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "text/event-stream" }, signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error("Live stream disconnected");
          const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
          streamConnected = true;
          try {
            for (;;) {
              const { value, done } = await reader.read(); if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let end: number;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
                const data = event.split("\n").find(line => line.startsWith("data: "));
                if (data) render(JSON.parse(data.slice(6)));
              }
            }
          } finally { reader.releaseLock(); }
        } catch { /* Polling and the next stream reconnect restore the latest snapshot. */ }
        streamConnected = false;
        if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
      }
    })();
  }
  async function poll() {
    try {
      if (!connected) await refreshStatus();
      if (chatId && !missing && !streamConnected) { render(await api(sessionPath())); startStream(); }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        missing = true; stream?.abort();
        progress("This chat could not be found. Start a new chat to continue.", true); controls(); return;
      }
      progress(`${String(error instanceof Error ? error.message : error)} Reconnecting…`, true);
    }
    finally { if (!missing) pollTimer = setTimeout(() => void poll(), active() ? 2500 : 7000); }
  }
  async function action(operation: () => Promise<void>) {
    if (pending) return; pending = true; controls();
    try { await operation(); } catch (error) { progress(error instanceof Error ? error.message : String(error), true); }
    finally { pending = false; controls(); }
  }
  async function refreshStatus() {
    try {
      const status = await api("/api/status"); connected = !!(status.ready && status.sponsorship?.enabled);
      applyNetwork(status);
      element("status").textContent = connected ? "CONNECTED / SPONSORED" : status.stage;
      element("deployment-label").textContent = status.registry ? "FULL MODEL DEPLOYED" : "DEPLOYMENT PENDING";
      if (status.registry) element<HTMLAnchorElement>("registry-link").href = explorer("address", status.registry);
      if (status.program) element<HTMLAnchorElement>("program-link").href = explorer("address", status.program);
      progress(connected ? "Everything is covered. Send a message to begin." : status.message);
    } catch {
      connected = false; element("status").textContent = "RECONNECTING";
      progress("The chat service is reconnecting. Your saved run is safe; retrying automatically.", true);
    }
    controls();
  }
  await refreshStatus();
  prompt.addEventListener("input", controls);
  prompt.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!send.disabled) element<HTMLFormElement>("prompt-form").requestSubmit(); }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach(button => button.addEventListener("click", () => {
    if (prompt.disabled) return; prompt.value = button.dataset.prompt!; prompt.focus(); controls();
  }));
  element<HTMLFormElement>("prompt-form").onsubmit = event => {
    event.preventDefault(); if (!prompt.value.trim() || send.disabled) return;
    const text = prompt.value.trim(), maximumOutputTokens = Number(element<HTMLSelectElement>("output-length").value);
    void action(async () => { const auth = await ensureSession(); const result = await api(`/api/sessions/${auth.id}/messages`, "POST", { text, maximumOutputTokens }); prompt.value = ""; render(result); });
  };
  pause.onclick = () => void action(async () => {
    if (!credentials || !session) return;
    const operation = ["paused", "error"].includes(session.stage) ? "resume" : "pause";
    progress(operation === "pause" ? "Pausing after pending transactions settle…" : "Resuming your saved run…");
    render(await api(`/api/sessions/${credentials.id}/${operation}`, "POST", {}));
  });
  start.onclick = () => void action(async () => {
    if (credentials && session && session.stage !== "closed") {
      progress("Closing this session and returning its storage deposit to the sponsor…");
      await api(`/api/sessions/${credentials.id}`, "DELETE");
    }
    credentials = undefined; try { localStorage.removeItem(storageKey); } catch {}
    location.assign("/#console");
  });
  element("share").onclick = () => void action(async () => {
    if (!chatId) return;
    const url = `${location.origin}/chat/${chatId}`;
    try { await navigator.clipboard.writeText(url); progress("Chat link copied. Anyone with the link can follow this conversation live."); }
    catch { progress(`Share this chat: ${url}`); }
  });
  setInterval(() => {
    if (!session?.run?.startedAt) return;
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(session.run.startedAt)) / 1000));
    element("elapsed").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
  if (chatId) { element("console").scrollIntoView(); await poll(); } else pollTimer = setTimeout(() => void poll(), 2500);
  window.addEventListener("pagehide", () => { clearTimeout(pollTimer); stream?.abort(); });
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  window.addEventListener("popstate", () => location.reload());
}
