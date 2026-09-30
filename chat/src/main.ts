import "./style.css";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <nav><a class="wordmark" href="#">BREAK<span>↗</span></a><span class="nav-note">A STACC EXPERIMENT / SOLANA TESTNET</span><a class="nav-link" href="https://github.com/staccDOTsol/break-solana-chat" target="_blank" rel="noreferrer">SOURCE ↗</a></nav>
  <main>
    <section class="hero">
      <div class="eyebrow"><span class="dot"></span> OPERATION: REMOVE THE CHOKEPOINT</div>
      <h1>INFERENCE.<br>WITHOUT A<br><span class="outline">KILL SWITCH.</span></h1>
      <div class="hero-bottom"><p>A model provider should never hold a nation’s intelligence hostage.<br>Put the weights in public. Make the execution verifiable. Let anyone run it.</p><a class="button" href="#console">ENTER THE EXPERIMENT <span>↘</span></a></div>
      <div class="hero-stamp">OPEN<br>WEIGHTS.<br>BARE<br>TEETH.</div>
    </section>
    <div class="ticker"><span>NO PROVIDER PERMISSION</span><b>✳</b><span>REAL WEIGHTS</span><b>✳</b><span>PUBLIC EXECUTION</span><b>✳</b><span>YOUR SIGNER. YOUR CONTEXT.</span><b>✳</b></div>
    <section class="manifesto" id="manifesto">
      <div class="section-no">01 / THE THESIS</div>
      <div><h2>SOLANA IS A PSYOP<br>AGAINST THE<br><em>MODEL CHOKEPOINT.</em></h2><p class="big-copy">The frontier should be infrastructure.<br>It should never be a permission slip.</p><p>OpenAI. Anthropic. Whoever comes next. A company can change its terms, revoke an API key, or decide that an entire country no longer gets access. Open weights are a beginning. Independent execution is the next fight.</p><p>This is the challenge: put a frontier open-weight model on Solana mainnet-beta. Make the work inspectable. Make the interface replaceable. Make the provider optional.</p><div class="thesis-label">MANIFESTO / FRONTIER MAINNET EXECUTION IS THE TARGET</div></div>
    </section>
    <section class="economics">
      <div class="economics-number">23,000<span>TESTNET SOL / STACC’S STARTING CHALLENGE</span></div>
      <div><h2>IMAGINE THE<br>FOUNDATION<br>BARED ITS TEETH.</h2><p>One builder with test SOL lying around can test the machinery. What could the Foundation do with a deliberate mainnet commitment?</p><p class="spaced">N E G L I G I B L E.</p><p>That is the target for additional user cost. Sponsor execution. Fund storage deposits. Remove the provider’s tollbooth. Validators still consume resources; the user does not have to carry the bill.</p><a href="https://solana.com/news/announcing-the-solana-foundation-delegation-strategy" target="_blank" rel="noreferrer" class="footnote">Historical scale: the Foundation announced a 100M SOL delegation commitment in 2020. This is not a claim about its current treasury. ↗</a></div>
    </section>
    <section class="console-section" id="console">
      <div class="console-title"><div><div class="section-no">02 / THE EXPERIMENT</div><h2>TALK TO<br>THE MACHINE.</h2></div><div class="network-pill"><span class="dot"></span> TESTNET / TX V1</div></div>
      <div class="console-shell">
        <aside><div class="label">MODEL</div><h3>Qwen3-8B<br>3.93 GiB</h3><p>8.19 billion parameters.<br>36 layers. Grouped 4-bit weights.</p><div class="label">EXECUTION</div><div id="status" role="status">CHECKING DEPLOYMENT…</div><div class="label">SESSION AUTHORITY</div><code id="authority">NO SESSION</code><p class="small">Each chat has its own signer and context. Sixteen independent fee payers and work accounts carry parallel tiles. Session data is public on testnet.</p><button id="start" class="button" disabled>START A SESSION ↗</button><button id="close" class="text-button" disabled>CLOSE & RECLAIM SESSION RENT</button><div class="label">WORK RECEIPTS</div><div id="grid" class="tx-grid" aria-label="Transaction activity"></div><div id="metrics">0 CONFIRMED TRANSACTIONS</div></aside>
        <div class="chat"><div id="messages" class="messages" aria-live="polite"><div class="welcome"><span>✳</span><h3>AN OPEN MODEL.<br>A PUBLIC MACHINE.</h3><p>The target is the complete Qwen3-8B model: 3.93 GiB of exported weights. Chat unlocks when the deployment and execution checks pass. Throughput is still being measured.</p></div></div><div id="progress" role="status">No inference has been submitted.</div><form id="prompt-form"><label class="sr-only" for="prompt">Your message</label><textarea id="prompt" placeholder="Ask the model something…" rows="2" maxlength="2000" disabled></textarea><button id="send" aria-label="Send message" disabled>↗</button></form><div class="chat-footer">SIGNED CONTEXT · VERIFIABLE WORK · EXPERIMENTAL 128-TOKEN WINDOW</div></div>
      </div>
    </section>
    <section class="receipts"><div class="section-no">03 / SHOW THE WORK</div><h2>CLAIMS ARE CHEAP.<br>EXECUTION HAS RECEIPTS.</h2><div class="receipt-list"><div><span>01</span><h3>A real checkpoint</h3><p>Qwen/Qwen3-8B. All 36 layers and 151,936 vocabulary entries retained. 569 weight accounts. The manifest pins the source revision and each payload hash.</p></div><div><span>02</span><h3>Actual parallelism</h3><p>Separate fee payers. Separate writable work accounts. Read-only shared weights. Explicit barriers between dependent operations.</p></div><div><span>03</span><h3>An honest ledger</h3><p>Model, network, transaction signatures and measured progress appear in the console. Testnet results do not stand in for a frontier mainnet deployment.</p></div></div></section>
  </main><footer><a class="wordmark" href="#">BREAK<span>↗</span></a><p>BUILT BY STACC. FOR A WORLD THAT DOESN’T ASK FOR AN API KEY.</p><a href="https://github.com/staccDOTsol/break-solana-chat">FORK THE EXPERIMENT ↗</a></footer>`;

for (let i = 0; i < 64; i++)
  document.querySelector("#grid")!.appendChild(document.createElement("i"));

// The transport installs the handlers after it has checked the actual cluster,
// deployment and tokenizer. A disconnected page must never pretend to infer.
import("./session.ts")
  .then((m) => m.attachConsole())
  .catch((error) => {
    document.querySelector("#status")!.textContent = "SETUP REQUIRED";
    document.querySelector("#progress")!.textContent = String(
      error instanceof Error ? error.message : error,
    );
  });
