import { createWallet, Engine } from "./chain/engine.ts";
import { Transport, type Deployment } from "./chain/transport.ts";
import { MAX_SEQ } from "./chain/layout.ts";
import { loadWallet, saveWallet } from "./wallet.ts";

const element = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`#${id}`)!;
const progress = (message: string) =>
  (element("progress").textContent = message);
async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      (await response.json()).error ?? "Tokenizer request failed",
    );
  return response.json();
}
function message(role: string, text: string) {
  const div = document.createElement("div");
  div.className = `message message-${role}`;
  const label = document.createElement("small");
  label.textContent = role.toUpperCase();
  const content = document.createElement("p");
  content.textContent = text;
  div.append(label, content);
  element("messages").append(div);
  div.scrollIntoView({ block: "nearest" });
  return content;
}
export async function attachConsole() {
  const response = await fetch("/api/status");
  if (!response.ok)
    throw new Error("Start the local receipt service to connect this console.");
  const status = await response.json();
  element("status").textContent = status.stage;
  progress(status.message);
  if (!status.ready) return;
  const deployment: Deployment = await (await fetch("/api/deployment")).json();
  const transport = new Transport(status.rpc);
  let wallet = await loadWallet(deployment.registry),
    engine: Engine;
  let confirmed = 0,
    busy = false,
    hadTurn = false;
  let cancellation: AbortController | undefined;
  const receipt = (signature: string, lane?: number) => {
    confirmed++;
    element("metrics").textContent =
      `${confirmed.toLocaleString()} CONFIRMED TRANSACTIONS`;
    const cells = element("grid").children;
    const cell = cells[(lane ?? confirmed) % cells.length] as HTMLElement;
    cell.classList.add("confirmed");
    cell.title = signature;
  };
  const connect = () => {
    engine = new Engine(transport, deployment, wallet, receipt);
    element("authority").textContent = wallet.authority.address;
  };
  connect();
  const start = element<HTMLButtonElement>("start"),
    close = element<HTMLButtonElement>("close"),
    send = element<HTMLButtonElement>("send"),
    prompt = element<HTMLTextAreaElement>("prompt");
  start.disabled = false;
  start.textContent = "CREATE / RESUME SESSION ↗";
  const showError = (error: unknown) =>
    progress(error instanceof Error ? error.message : String(error));
  start.onclick = async () => {
    if (busy) return;
    busy = true;
    start.disabled = true;
    try {
      progress("Checking session accounts and independent fee payers…");
      await engine.setup();
      const h = await engine.read();
      hadTurn = h.count > 0;
      if (![0, 14].includes(h.phase)) {
        progress("Resuming an interrupted token from its on-chain checkpoint…");
        await engine.drive(undefined, (h) =>
          progress(`RESUMING / LAYER ${h.layer + 1}/36 · PHASE ${h.phase}`),
        );
      }
      prompt.disabled = false;
      send.disabled = false;
      close.disabled = false;
      start.textContent = "SESSION CONNECTED";
      progress(
        "Session ready. Execution is experimental and may take a long time per token.",
      );
    } catch (error) {
      showError(error);
      start.disabled = false;
      start.textContent = "CHECK FUNDING / RETRY ↗";
    } finally {
      busy = false;
    }
  };
  element<HTMLFormElement>("prompt-form").onsubmit = async (event) => {
    event.preventDefault();
    if (busy || !prompt.value.trim()) return;
    busy = true;
    send.disabled = true;
    close.disabled = true;
    cancellation = new AbortController();
    const text = prompt.value.trim();
    try {
      const { tokens } = await post("/api/tokenize", {
        text,
        continuation: hadTurn,
      });
      const current = await engine.read();
      const maxOutput = 8;
      if (current.count + tokens.length + maxOutput > MAX_SEQ)
        throw new Error(
          "This session’s 128-token context is full. Close it and start a fresh session.",
        );
      element("messages").querySelector(".welcome")?.remove();
      message("you", text);
      prompt.value = "";
      const output = message("model", "");
      const onProgress = (h: {
        layer: number;
        phase: number;
        cursor: number;
      }) =>
        progress(
          `LAYER ${h.layer + 1}/36 · PHASE ${h.phase} · ROW ${h.cursor.toLocaleString()} · ${confirmed.toLocaleString()} RECEIPTS`,
        );
      let prediction = 0;
      for (let i = 0; i < tokens.length; i++) {
        const result = await engine.token(
          tokens[i],
          i === tokens.length - 1,
          cancellation.signal,
          onProgress,
        );
        prediction = result.token;
      }
      const generated: number[] = [];
      for (let i = 0; i < maxOutput; i++) {
        if (prediction === 151645 || prediction === 151643) break;
        generated.push(prediction);
        output.textContent = (
          await post("/api/decode", { tokens: generated })
        ).text;
        // Every displayed token is consumed into the on-chain KV history so
        // the next turn cannot silently omit the last displayed token.
        const result = await engine.token(
          prediction,
          true,
          cancellation.signal,
          onProgress,
        );
        prediction = result.token;
      }
      hadTurn = true;
      progress(
        "Turn complete. Every displayed token came from the on-chain output head.",
      );
    } catch (error) {
      showError(error);
      start.disabled = false;
      start.textContent = "RESUME SESSION ↗";
    } finally {
      busy = false;
      send.disabled = false;
      close.disabled = false;
      cancellation = undefined;
    }
  };
  close.onclick = async () => {
    if (busy) return;
    busy = true;
    close.disabled = true;
    send.disabled = true;
    try {
      await engine.close();
      // Retain the funded authority and fee-payer keys; use fresh state/work
      // addresses so old signed work cannot replay into a new conversation.
      const next = await createWallet();
      wallet = { ...next, authority: wallet.authority, payers: wallet.payers };
      await saveWallet(deployment.registry, wallet);
      connect();
      hadTurn = false;
      prompt.disabled = true;
      start.disabled = false;
      start.textContent = "START A FRESH SESSION ↗";
      progress(
        "Session rent and remaining lane funds returned to your saved authority.",
      );
    } catch (error) {
      showError(error);
      close.disabled = false;
    } finally {
      busy = false;
    }
  };
}
