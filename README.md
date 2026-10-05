# STACCPAD Chat — inference without a kill switch

Public experiment: **https://chat.staccpad.fun**. The persistent service runs on Fly; the custom domain is managed through Vercel DNS.

A fork of the original [solana-labs/break](https://github.com/solana-labs/break), adapted toward a real Qwen3-8B model running through Solana testnet transactions. The landing page argues for independent model execution; the console reports actual deployment state.

**Current state: the complete model is deployed and verified on Solana testnet.** All 569 weight accounts and the sealed registry are present. Every payload has byte-for-byte read-back evidence; the final audit rechecked finalized ownership, headers, sizes and registry bytes. See the [deployment receipt](inference/reports/testnet-deployment-complete.json). Live inference is under validation and is far slower than an ordinary chat service.

Program: [`BkWuzU3fn4NS7LXdBxH1j4gRyRw3ma35aNGytbANzUvB`](https://explorer.solana.com/address/BkWuzU3fn4NS7LXdBxH1j4gRyRw3ma35aNGytbANzUvB?cluster=testnet). See the [bytecode receipt](inference/reports/testnet-program.json).

| Measured artifact | Result |
|---|---:|
| Checkpoint | `Qwen/Qwen3-8B`, revision `b968826d9c46dd6066d109eabc6255188de91218` |
| Parameters retained | 8,190,735,360 |
| Model dimensions | 36 layers, hidden 4096, FFN 12288, 32 query heads, 8 KV heads |
| Weight format | Signed INT4, groups of 128, binary16 scales; float32 norm weights |
| Account storage | 4,224,531,264 bytes / **3.934401 GiB** |
| Accounts | 569 weight accounts + 1 immutable registry |
| Testnet storage rent quote | 21,460.98945792 SOL (2026-09-23; rerun the plan for a fresh quote) |
| Upload plan | 1,124,997 transactions at 3,760 payload bytes per write (4,089-byte v1 packets) |
| Forward instructions, short-context token | 91,191, down from 119,032; excludes the start-token instruction and session setup |

The instruction reduction is **23.4%** with identical outputs before the portable-math change. This is still a very large amount of work per token. It is not an interactive-speed result or a demonstrated frontier model on mainnet.

## Run the page

Use the new `chat` package. The original game remains in `client`, `server`, and `program`; do not install the root package to run this experiment.

```sh
cd chat
npm ci
npm run build
npm run server   # localhost:8787: built page, sponsored sessions, tokenizer and receipts
npm run dev      # optional Vite development server at localhost:5173
```

The server tokenizes text, schedules transactions and decodes the program's output tokens. All model arithmetic runs in the Solana program; no external model provider supplies responses. `SEA_SPONSOR_KEYPAIR` defaults to `~/test.json`. This key stays on the server and sponsors all session rent and fees. Sixteen separate fee-payer accounts funded by that sponsor let worker transactions execute in parallel. Visitors need neither a wallet nor testnet SOL.

Set `SEA_TPU_RELAY_BIN` to the compiled relay executable for batched delivery to testnet leaders. Small control transactions use RPC with preflight; stragglers reuse the same signed bytes through RPC. Independent matrix slices are submitted together and tracked by a completion bitmap; merging still requires every slice. The relay never receives private keys.

`SEA_RPC_RACE_URLS` accepts up to three operator-selected RPC endpoints. Startup verifies testnet genesis, health and slot freshness. Different slices use different RPC queues, each racing the same signed transaction through TPU; RPC failures move that exact transaction to another peer. Slices are interleaved across the 16 lanes so one worker's slices do not fill the front of the delivery queue. Reads race across the peers; an empty signature cache cannot beat a pending positive confirmation. Each peer has bounded submission concurrency, pacing, timeouts and cooldowns; the configured primary RPC remains a fallback. This improves delivery but does not remove shared writable-account locks within each lane or raise the 1.4M-CU execution ceiling. Known normalization/quantization steps are packed in pairs and four activation lanes share a transaction; the SBF benchmark checks packed results against individual execution and the full transaction compute budget. Setup batches four workers and their funding per transaction. Structured `inference-wave` logs report the actual time and transaction count per wave.

Sessions and signing keys persist in the ignored `inference/deployment/chat-sessions` directory (keep it on a persistent disk, mode 0700). The browser saves only an opaque access token in localStorage. Closing the tab leaves the job running; pause/resume and service restarts recover the token checkpoint without replaying consumed input. New Chat closes the current session and returns its storage deposit to the sponsor. One job runs at a time, with a bounded queue and at most eight output tokens per turn. The context limit is 128 tokens. This is an asynchronous experiment, not interactive-speed chat.

Each chat has a permanent `/chat/<id>` URL. Anyone with the link can read the conversation and follow its live event stream; only the browser holding its separate bearer token can send, pause, resume or close it. Access tokens never appear in share links. Output is published as each token becomes available, before the following token finishes. Public prompts and closed chat history remain readable.

The built server serves the home page, chat routes and allowlisted build assets. It does not expose key files or a general-purpose transaction signing endpoint. `fly.toml` runs one persistent machine with a `/data` volume for sessions (`SEA_SESSION_DIRECTORY`). The sponsor is injected as a Fly secret-backed file at `/run/sponsor.json`. Deploy with `flyctl deploy --app break-solana-chat --remote-only --ha=false`; retain the volume and single-runner topology across deploys.

## Export and validate

```sh
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r inference/requirements.txt
.venv/bin/python inference/export.py
cargo-build-sbf --manifest-path inference/program/Cargo.toml --arch v3
cargo run --release --manifest-path inference/bench/Cargo.toml
cargo build --release --manifest-path inference/reference-math/Cargo.toml
TOKENS=151644,872,198,9707,151645,198,151644,77091,198,151667,271,151668,271 \
  cargo run --release --manifest-path inference/program/Cargo.toml \
  --features no-entrypoint --example validate -- /tmp/qwen-validation
.venv/bin/python inference/validate.py --native /tmp/qwen-validation \
  --tokens 151644,872,198,9707,151645,198,151644,77091,198,151667,271,151668,271
npm --prefix chat test
npm --prefix chat run build
```

Use a fresh validation output directory. The native harness executes the production instruction handlers for all layers and writes intermediate states. An independent NumPy implementation checks those states and the complete vocabulary logits. Both use the same pinned scalar transcendental library to avoid rounding differences changing quantization bins; the NumPy model, matrix operations, attention and cache logic are independent. The SBF harness separately checks compute ceilings, native/SBF arithmetic, authority checks, stale epochs, foreign-session workers and replayed slices. See [validation receipts](inference/reports/validation.json).

These checks establish implementation consistency for the tested inputs. They do not establish general model quality, perplexity, long-context correctness, or end-to-end execution on the live testnet runtime.

## Upload

The default command is a read-only, live-cluster cost plan:

```sh
cd chat
npm run deploy:model
```

`--execute` requires a deployed program and reads the local payer file. Every path verifies the testnet genesis hash and transaction-v1 activation. Signing keys, checkpoint weights, progress files and deployment receipts stay under ignored directories.

```sh
cargo build --release --manifest-path ../inference/tpu-relay/Cargo.toml
npm run deploy:model -- --execute --program YOUR_DEPLOYED_PROGRAM \
  --payer ~/test.json --rpc https://api.testnet.solana.com \
  --tpu --lanes 16 --batch 64 --pipeline 1
```

The uploader resumes confirmed byte offsets, verifies each full payload by reading it back before sealing, and publishes the registry only after all weights are sealed. Expired byte-identical writes can be re-signed safely; other uncertain transactions stop for state reconciliation. `--only-tensor 1` uploads the small final-norm tensor without publishing a registry. TPU submission avoids a public RPC send request for every write; public RPC still supplies network state and batched confirmations. The public RPC transport paces requests at two per second and backs off on HTTP rate limits. Full-account reads are spaced six seconds apart. The relay bounds concurrent deliveries and paces signed-wire batches to 150 transactions/second. `inference/deployment/upload-status.json` records measured progress. Fee payers are funded for the estimated write count plus a reserve; storage deposits come from the supplied testnet payer.

Fresh write confirmations use the recent signature cache; historical lookups remain available for other transactions. Small funding, account-creation and seal transactions use RPC preflight and rebroadcast. On resume, unfinished payloads are read back before trusting saved offsets: missing chunks rewind the checkpoint, and matching writes beyond the checkpoint are recovered. Account read-back uses Zstandard compression, compares the payload byte-for-byte, and appends receipts to `inference/deployment/upload-verification.jsonl`. A read-only audit of all sealed accounts present at discovery is available with Python 3.14+: `python3 inference/audit_upload.py`; it saves its results in `inference/reports/testnet-payload-audit.json`.

For subsequent audits, `--reuse-report PATH --report NEW_PATH` reuses finalized comparisons after checking the current seal, owner, metadata, model hash and unchanged program deployment. Passing `--sealed-audit PATH` to the uploader avoids downloading those same immutable payloads again. The audit is loaded when the uploader reaches the previously sealed accounts, so it can finish alongside fresh uploads. The uploader validates the deployed program binary, rechecks finalized account headers and rejects a program upgrade before publishing the registry. Accounts without matching evidence still receive a full read-back. `SEA_TPU_TX_PER_SECOND` optionally adjusts relay pacing (default 150, maximum 175); it remains bounded below the observed peer quota.

`--pipeline` supports one to four active disjoint batches per lane, replenishing completed batches even while earlier confirmations are pending. The default is one: the four-batch public-testnet trial increased expiry and did not demonstrate a sustained throughput improvement. Saved offsets advance only across a contiguous confirmed prefix. Failures drain pending work and resume from that prefix. At most 2,048 writes may be in flight across all lanes. Resumes prioritize unfinished accounts; already sealed payloads are still rechecked before publishing the registry.

## Signers, context and parallel work

A session binds a unique state account to its authority signer and an immutable model registry. Each of 16 lanes has a separate writable worker account and a separate fee payer. The shared state, model and authority are read-only in tile transactions. Every result binds the session, phase, epoch, row range and completed slice count. The merge rejects stale, incomplete and foreign-session results.

With `SEA_INDEPENDENT_SLICES=1`, new chats provision 256 separate slice accounts and sponsored fee payers. Each 4096-column matrix wave has up to 96 independent slice transactions; a 12288-column wave has up to 256. Every slice writes a distinct account and uses a distinct fee payer. The session, authority and weights remain read-only during that work. Checked per-lane collection joins the slices before the existing shared-state merge; dependent transformer phases and tokens remain sequential. The upgrade keeps legacy chats and their partially completed lanes compatible.

Each lane accumulates up to 128 rows before a shared-state barrier. A transaction computes 24 rows of a 4096-column matrix, or 8 rows of a 12288-column matrix. Native and SBF execute the same pinned `libm` routines. Norm, quantization and RoPE work is split so each step fits the real 1.4M-CU limit. Activation packing is limited to four lanes: a captured testnet regression required about 266K CU per lane, exceeding the earlier synthetic benchmark. RPC errors preserve BigInt values as strings so the actual transaction failure stays visible.

The present session holds **128 tokens** with per-head INT8 K/V. It occupies 9,971,712 bytes. Extending context requires splitting K/V into additional session accounts. Session keys remain on the server; clearing browser storage loses the access token for that chat. Closing a session returns its rent to the sponsor while shared fee-payer balances remain available for other chats. Fresh session/work addresses prevent old signed work replaying into a replacement conversation. Context data is public on testnet; signer isolation is not encryption.

## Runtime evidence

Agave HEAD inspected: `e3fdd18f9b82cb4f75cf5f8c02d9c085aff6b866` (4.5.0-alpha.0). Testnet reported 4.3.0-rc.1. The local SBF harness uses the compatible Mollusk/Agave 4.2.2 runtime with relevant observed gates mirrored, so successful local execution still needs confirmation on testnet.

Observed active gates include tx v1, SBPF v3, direct account mapping/pointers and the 100M-CU block budget. The remaining-CU syscall and 128-account-lock gate were inactive. V1 supports larger messages; it does **not** raise the 1.4M-CU transaction ceiling, 64MiB loaded-data ceiling, 256KiB heap, or 10MiB account ceiling. Both v1 compute and loaded-data budgets must be explicit; priority fees are total lamports, not a per-CU price.

The original Break documentation is preserved in [docs/UPSTREAM-BREAK.md](docs/UPSTREAM-BREAK.md).
