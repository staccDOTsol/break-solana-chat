import "./style.css";
import { Buffer } from "buffer/";

// Pump and Solana browser SDKs expect the Node Buffer global.
Object.assign(globalThis, { Buffer });

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <a class="skip-link" href="#console">Skip to chat</a><nav><a class="wordmark" href="#">STACCPAD<span class="chat-brand">CHAT</span></a><span class="nav-note" id="network-note">CHAT.STACCPAD.FUN / CHECKING CHAIN</span><a class="nav-link" href="#market">TRADE ↘</a><a class="nav-link" href="#console">LIVE CHAT ↘</a><a class="nav-link" href="https://github.com/staccDOTsol/break-solana-chat" target="_blank" rel="noreferrer">SOURCE ↗</a></nav>
  <main>
    <section class="hero">
      <div class="eyebrow"><span class="dot"></span> OPERATION: REMOVE THE CHOKEPOINT</div>
      <h1>INFERENCE.<br>WITHOUT A<br><span class="outline">KILL SWITCH.</span></h1>
      <div class="hero-bottom"><p><span id="hero-network">Qwen3-8B, checking chain deployment.</span><br><span id="hero-chain-note">Trade CHAT on Solana mainnet. Checking the active chat chain.</span> STACC covers chat transactions.</p><div class="hero-actions"><a class="button" href="#market">TRADE CHAT <span>↘</span></a><a class="button secondary-hero" href="#console">TALK TO THE MODEL <span>↘</span></a></div></div>
      <div class="hero-stamp">OPEN<br>WEIGHTS.<br>BARE<br>TEETH.</div>
    </section>
    <div class="deployment-strip" aria-label="Model deployment"><div><strong>8.19B</strong><span>PARAMETERS</span></div><div><strong>569</strong><span>WEIGHT ACCOUNTS</span></div><div><strong>36</strong><span>TRANSFORMER LAYERS</span></div><div class="deployment-live"><span class="dot"></span><span id="deployment-label">CHECKING CHAIN</span><a id="registry-link" href="#receipts">VERIFY ↗</a></div></div>
    <section class="market-section" id="market" aria-labelledby="market-heading">
      <div class="market-heading"><div><div class="section-no">01 / SOLANA MAINNET</div><h2 id="market-heading">TRADE THE TOKEN.</h2><p>Buy or sell CHAT through its Pump market with your own Solana wallet. The chart and recent activity are read from mainnet. The on-chain model chat lives below on a separate chain.</p></div><div class="market-mint"><span>MODEL TOKEN / MAINNET CA</span><code>DxNXApfiPXYcobrM3NsePAXMDYyaPgB8jfK4yc9ichat</code><button type="button" id="copy-model-mint">COPY ADDRESS ↗</button></div></div>
      <div id="model-market" aria-live="polite"><p>Loading mainnet market…</p></div>
      <div class="market-boundary"><strong id="trade-chain-title">TRADE + CHAT.</strong><span id="trade-chain-note">Trades sign on Solana mainnet. Checking the active chat chain.</span><a href="#console">OPEN MODEL CHAT ↗</a></div>
    </section>
    <section class="console-section" id="console">
      <div class="console-title"><div><div class="section-no">02 / THE EXPERIMENT</div><h2>TALK TO<br>THE MACHINE.</h2></div><div class="network-pill" id="network-pill"><span class="dot"></span> <span id="network-pill-label">CHECKING CHAIN / TX V1</span></div></div>
      <div class="console-shell">
        <aside>
          <div class="label">THE MODEL</div><h3>Qwen3-8B<span class="model-subtitle">ALL 36 LAYERS. ON-CHAIN.</span></h3>
          <div class="sponsor-card"><span>↗</span><div><strong>THIS ONE’S ON STACC.</strong><p>Rent and transaction fees are sponsored. No wallet required.</p></div></div>
          <div class="label">CONNECTION</div><div id="status" role="status">CONNECTING…</div>
          <div class="label">CHAT LINK</div><a id="session-link" class="session-address"><code id="authority">Starts with your first message</code></a>
          <button id="share" class="text-button share-button" type="button" hidden>COPY CHAT LINK ↗</button>
          <button id="start" class="button secondary" disabled>NEW CHAT <span>+</span></button>
          <div class="label">CONFIRMED WORK</div><div id="grid" class="tx-grid" aria-label="Confirmed transaction activity"></div><div id="metrics">0 TRANSACTIONS</div>
          <details class="receipt-details"><summary>View transaction receipts <span>↗</span></summary><ol id="receipt-list"><li class="muted">Receipts appear as your message runs.</li></ol></details>
          <a id="program-link" class="program-link" href="#receipts" target="_blank" rel="noreferrer">INSPECT THE PROGRAM ↗</a>
        </aside>
        <div class="chat">
          <div class="chat-topbar"><span><i class="dot"></i> <span id="chat-mode">SPONSORED SESSION</span></span><span id="chat-state">READY WHEN YOU ARE</span></div>
          <div id="messages" class="messages" aria-live="polite" aria-relevant="additions text"><div class="welcome"><span aria-hidden="true">✳</span><div class="label">NO API KEY. NO WALLET.</div><h3>YOUR WORDS.<br>PUBLIC COMPUTE.</h3><p>Send a message to the full Qwen3-8B model. Its work runs as real transactions, with receipts you can inspect.</p><div class="prompt-suggestions"><button type="button" data-prompt="Hello!">Say hello ↗</button><button type="button" data-prompt="What is Solana?">Ask about Solana ↗</button></div></div></div>
          <section id="run-panel" class="run-panel" hidden aria-label="Live inference progress">
            <div class="run-estimates"><div><span>OVERALL WORK</span><strong id="run-percent">0.00%</strong></div><div><span id="next-token-label">FIRST REPLY TOKEN</span><strong id="next-token-eta">Estimating…</strong></div><div><span>FINISH IN</span><strong id="finish-eta">Estimating…</strong></div></div>
            <progress id="overall-progress" max="100" value="0" aria-label="Overall confirmed inference work"></progress>
            <p id="estimate-note" class="estimate-note">Measuring confirmed work…</p>
            <div class="run-heading"><strong id="run-title">Preparing your session</strong><span id="elapsed">0:00</span></div><div id="layer-grid" class="layer-grid" aria-label="Current token’s transformer layers"></div><div class="run-foot"><span id="run-detail">Your progress is saved automatically.</span><button id="pause" class="text-button" type="button">PAUSE</button></div>
          </section>
          <div id="progress" role="status">Connecting to the sponsored chat service…</div>
          <form id="prompt-form"><label class="sr-only" for="prompt">Your message</label><textarea id="prompt" placeholder="Ask the model something…" rows="2" maxlength="2000" disabled></textarea><button id="send" aria-label="Send message" disabled>↗</button></form>
          <div class="composer-options"><label for="output-length">RESPONSE LENGTH <select id="output-length"><option value="1">1 token</option><option value="4" selected>4 tokens</option><option value="8">8 tokens</option></select></label><span>ENTER TO SEND / SHIFT + ENTER FOR A NEW LINE</span></div>
          <p class="execution-note">This experiment can take hours to produce a reply. Your run continues if you leave this tab. <span id="execution-network-note">Prompts and model state are recorded on-chain.</span></p>
        </div>
      </div>
    </section>
    <section class="receipts" id="receipts"><div class="section-no">03 / SHOW THE WORK</div><h2>CLAIMS ARE CHEAP.<br>EXECUTION HAS RECEIPTS.</h2><div class="receipt-list"><div><span>01</span><h3>The complete model</h3><p>Qwen/Qwen3-8B. All 36 layers and 151,936 vocabulary entries retained. 569 weight accounts. The manifest pins the source revision and each payload hash.</p></div><div><span>02</span><h3>Sponsored by STACC</h3><p>Session rent and transaction fees are covered by the experiment. Open the page, send a message, and follow the work. <span id="sponsor-network-note">No chain-native SOL hunting.</span></p></div><div><span>03</span><h3>Every step inspectable</h3><p>The server schedules signed transactions and saves your run. Model arithmetic happens in the deployed program. Every confirmed step has an inspectable receipt.</p></div></div></section>
    <div class="ticker"><span>NO PROVIDER PERMISSION</span><b>✳</b><span>REAL WEIGHTS</span><b>✳</b><span>PUBLIC EXECUTION</span><b>✳</b><span>SPONSORED. PUBLIC. VERIFIABLE.</span><b>✳</b></div>
    <section class="manifesto" id="manifesto">
      <div class="section-no">04 / THE THESIS</div>
      <div><h2>SOLANA IS A PSYOP<br>AGAINST THE<br><em>MODEL CHOKEPOINT.</em></h2><p class="big-copy">The frontier should be infrastructure.<br>It should never be a permission slip.</p><p>OpenAI. Anthropic. Whoever comes next. A company can change its terms, revoke an API key, or decide that an entire country no longer gets access. Open weights are a beginning. Independent execution is the next fight.</p><p>This project joins a full Qwen3-8B deployment on a dedicated Solana-compatible chain with a token at the matching address on Solana mainnet. Each service is verified before it opens. Make the work inspectable. Make the interface replaceable.</p><div class="thesis-label">MANIFESTO / INDEPENDENT ON-CHAIN MODEL EXECUTION</div></div>
    </section>
    <section class="economics">
      <div class="economics-number">23,000<span>TESTNET SOL / EARLIER STACC CHALLENGE</span></div>
      <div><h2>IMAGINE THE<br>FOUNDATION<br>BARED ITS TEETH.</h2><p>The earlier testnet run used test SOL to test the machinery. What could the Foundation do with a deliberate mainnet commitment?</p><p class="spaced">N E G L I G I B L E.</p><p>That is the target for additional user cost. Sponsor execution. Fund storage deposits. Remove the provider’s tollbooth. Validators still consume resources; the user does not have to carry the bill.</p><a href="https://solana.com/news/announcing-the-solana-foundation-delegation-strategy" target="_blank" rel="noreferrer" class="footnote">Historical scale: the Foundation announced a 100M SOL delegation commitment in 2020. This is not a claim about its current treasury. ↗</a></div>
    </section>
  </main><footer><a class="wordmark" href="#">STACCPAD<span class="chat-brand">CHAT</span></a><p>BUILT BY STACC. FOR A WORLD THAT DOESN’T ASK FOR AN API KEY.</p><a href="https://github.com/staccDOTsol/break-solana-chat">FORK THE EXPERIMENT ↗</a></footer>`;

for (let i = 0; i < 64; i++)
  document.querySelector("#grid")!.appendChild(document.createElement("i"));

for (let i = 0; i < 36; i++) {
  const cell = document.createElement("i"); cell.title = `Layer ${i + 1}`;
  document.querySelector("#layer-grid")!.append(cell);
}
// The service sponsors and resumes real on-chain work; it never fabricates output.
import("./session.ts")
  .then((m) => m.attachConsole())
  .catch((error) => {
    document.querySelector("#status")!.textContent = "SETUP REQUIRED";
    document.querySelector("#progress")!.textContent = String(
      error instanceof Error ? error.message : error,
    );
  });

const mintAddress = "DxNXApfiPXYcobrM3NsePAXMDYyaPgB8jfK4yc9ichat";
document.querySelector<HTMLButtonElement>("#copy-model-mint")?.addEventListener("click", async () => {
  const button = document.querySelector<HTMLButtonElement>("#copy-model-mint")!;
  try { await navigator.clipboard.writeText(mintAddress); button.textContent = "COPIED ✓"; }
  catch { button.textContent = mintAddress; }
});
void import("./market/index.tsx")
  .then(({ mountMarket }) => mountMarket(document.querySelector<HTMLElement>("#model-market")!))
  .catch((error) => { document.querySelector("#model-market")!.textContent = `Mainnet market unavailable: ${error instanceof Error ? error.message : String(error)}`; });
