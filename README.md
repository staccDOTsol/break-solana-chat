# BREAK — inference without a kill switch

A fork of the original [solana-labs/break](https://github.com/solana-labs/break), adapted toward a real Qwen3-8B model running through Solana testnet transactions. The landing page argues for independent model execution; the console reports actual deployment state.

**Current state: exported and locally validated, not a live model deployment.** The public testnet RPC rate-limited the program deployment. The approximately 4 GiB model has not been uploaded. No mainnet transactions are authorized or supported by the new transport.

| Measured artifact | Result |
|---|---:|
| Checkpoint | `Qwen/Qwen3-8B`, revision `b968826d9c46dd6066d109eabc6255188de91218` |
| Parameters retained | 8,190,735,360 |
| Model dimensions | 36 layers, hidden 4096, FFN 12288, 32 query heads, 8 KV heads |
| Weight format | Signed INT4, groups of 128, binary16 scales; float32 norm weights |
| Account storage | 4,224,531,264 bytes / **3.934401 GiB** |
| Accounts | 569 weight accounts + 1 immutable registry |
| Testnet storage rent quote | 21,460.98945792 SOL (2026-09-23; rerun the plan for a fresh quote) |
| Upload plan | 1,208,420 transactions at 3,500 payload bytes per write |
| Forward instructions, short-context token | 91,191, down from 119,032; excludes the start-token instruction and session setup |

The instruction reduction is **23.4%** with identical outputs before the portable-math change. This is still a very large amount of work per token. It is not an interactive-speed result or a demonstrated frontier model on mainnet.

## Run the page

Use the new `chat` package. The original game remains in `client`, `server`, and `program`; do not install the root package to run this experiment.

```sh
cd chat
npm ci
npm run server   # localhost:8787: receipts and local tokenizer only
npm run dev      # localhost:5173: landing page and browser transaction client
```

The receipt server never runs inference or calls a model provider. The browser signs transactions; model arithmetic belongs to the on-chain program. Chat stays disabled until the full sealed registry is deployed and verified. The UI and transport are implemented but their full live-chain conversation remains unverified.

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
npm run deploy:model -- --execute --program YOUR_DEPLOYED_PROGRAM \
  --payer ~/test.json --rpc YOUR_TESTNET_RPC --lanes 2
```

The uploader resumes confirmed byte offsets, verifies each full payload by reading it back before sealing, and publishes the registry only after all weights are sealed. Resolve uncertain transaction confirmations before resuming. The public RPC already returned connection-rate-limit errors during program upload; bulk upload needs an endpoint that can sustain the measured volume. An interrupted program buffer key has been preserved locally for recovery; it is not committed.

## Signers, context and parallel work

A session binds a unique state account to its authority signer and an immutable model registry. Each of 16 lanes has a separate writable worker account and a separate fee payer. The shared state, model and authority are read-only in tile transactions. Every result binds the session, phase, epoch, row range and completed slice count. The merge rejects stale, incomplete and foreign-session results.

Each lane accumulates up to 128 rows before a shared-state barrier. A transaction computes 24 rows of a 4096-column matrix, or 8 rows of a 12288-column matrix. Native and SBF execute the same pinned `libm` routines. Norm, quantization and RoPE work is split so each step fits the real 1.4M-CU limit.

The present session holds **128 tokens** with per-head INT8 K/V. It occupies 9,971,712 bytes. Extending context requires splitting K/V into additional session accounts. Browser keys persist in IndexedDB; clearing browser storage destroys access to those keys. Closing a session returns session rent and lane balances to its authority. Fresh session/work addresses prevent old signed work replaying into a replacement conversation. Context data is public on testnet; signer isolation is not encryption.

## Runtime evidence

Agave HEAD inspected: `e3fdd18f9b82cb4f75cf5f8c02d9c085aff6b866` (4.5.0-alpha.0). Testnet reported 4.3.0-rc.1. The local SBF harness uses the compatible Mollusk/Agave 4.2.2 runtime with relevant observed gates mirrored, so successful local execution still needs confirmation on testnet.

Observed active gates include tx v1, SBPF v3, direct account mapping/pointers and the 100M-CU block budget. The remaining-CU syscall and 128-account-lock gate were inactive. V1 supports larger messages; it does **not** raise the 1.4M-CU transaction ceiling, 64MiB loaded-data ceiling, 256KiB heap, or 10MiB account ceiling. Both v1 compute and loaded-data budgets must be explicit; priority fees are total lamports, not a per-CU price.

The original Break documentation is preserved in [docs/UPSTREAM-BREAK.md](docs/UPSTREAM-BREAK.md).
