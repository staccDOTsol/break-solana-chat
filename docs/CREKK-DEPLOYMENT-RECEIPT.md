# crekk deployment receipt

Recorded 2026-10-05 02:12 UTC for Cherry Servers bare metal server 1020903
(`188.214.129.187`, Ubuntu 24.04.5). This is an independent Agave 4.3.0
ledger, not a Solana mainnet or testnet snapshot.

## Source and binaries

- Source: `staccDOTsol/agave` branch `crekk`, upstream base
  `d8d06e8b9a6216f079f2c241325759f72f12bfa9`, model account/genesis patch
  `7116ed83d995ce182270caddc3e3e5b6a602486b`, deployment documentation
  commit `5dc45ba00c06b8736915716f43e671043d06aa3b`. The reproducible
  branch [`codex/crekk-model-genesis`](https://github.com/staccDOTsol/agave/tree/codex/crekk-model-genesis)
  points to `2138cfd2e6324972a294b724ad43a2b3db8e9a22`; its later commits
  only correct documentation and compute-budget tests, so the running
  validator binary remains the one built from `7116ed83`.
- Validator: `/root/agave-crekk/target/release/agave-validator`, SHA-256
  `45e8d02659b60b0f08c833237e3b6215ded23003fb0f304fd4c75179d8e1c927`.
  `agave-validator --version` identifies source `7116ed83`.
- Genesis tool SHA-256:
  `cc4a2196f694bbf08affdb5427964817e1a34bd938dbdb9a8f22002bb69fb908`.
- Preloaded inference executable `BkWuzU3fn4NS7LXdBxH1j4gRyRw3ma35aNGytbANzUvB`
  SHA-256: `f001b20326fe45ef08a247fa0c72ff96ade687feda313100fc531c9a6eabf417`.
  Token-2022 is also preloaded and executable.

## Genesis and accounts

- Genesis hash: `3E5sqjXQ2FKbGGEqmwbrhYwynrjUGwhNJUvQcU5t5q6P`.
  Shred version: `63371`. Genesis binary SHA-256:
  `2111703510df371f108c0f23e597452f50530514546f7c3cbfe9483cb2300688`.
- Initial capitalization: `2,001,000,672,488,321,040` lamports
  (`2,001,000,672.488321040` SOL) in 312 genesis accounts. The explicit
  distribution is `2,000,000,000` SOL to treasury
  `D88qwUFs75jLzVD9noGp8nyPEw4yqqvco3oMrRote2wa`, `1,000,000` SOL
  bootstrap stake, and `500` SOL validator identity; the remaining
  `172.488321040` SOL funds vote, feature, sysvar, and executable accounts.
  Agave's default inflation policy applies after genesis.
- Validator identity: `6XhWm43fdR1A5ttiCsqoviWwJnZuTvJG8h95sjEnFicv`;
  vote account: `HJmeqbJqDitvdpidcjmNnJNx5bmhbkBRRPVzofzg3G3G`.
- Vanity Token-2022 model mint `DxNXApfiPXYcobrM3NsePAXMDYyaPgB8jfK4yc9ichat`
  was omitted from genesis for initialization by a local signer. The treasury
  and mint signer files were never transferred to this server. Validator
  identity, vote, and stake signers were generated on the server in a
  root-only directory with mode `0600` files.
- Development genesis activates transaction v1 feature
  `txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL` and direct account data
  mapping. Its custom runtime raises the loaded account data limit to
  `256 MiB`; the measured Qwen3-8B export is `4,224,531,264` bytes
  (`3.934401 GiB`) in separate model accounts.

## Services and ingress

- `crekk-validator.service` is enabled. Its configuration SHA-256 is
  `ae8d216312abb1e4739b090458eeaef591f2efebcba4e9dfa2d3722eaa446588`.
  RPC transaction history is enabled. Blockstore retention is capped at
  `100,000,000` shreds, Agave's minimum; full snapshots run every `10,000`
  slots without incremental snapshots. Kernel receive and send buffer maxima
  are `134217728` bytes. The service has an expected genesis hash guard.
- `caddy.service` serves `https://rpc-model.staccpad.fun/` and
  `wss://rpc-model.staccpad.fun/` with an automatically renewed TLS
  certificate. External HTTPS JSON RPC returned the exact genesis hash;
  a WSS handshake returned HTTP 101. Caddy proxies to validator ports 8899
  and 8900. Inbound JSON RPC request bodies are capped at `8 MB`; large RPC
  responses have no Caddy response-header timeout. Caddy configuration
  SHA-256 is
  `8ef5806ae7224d38cc066e1668c7f792f859f12c08e19a1cc39ed7df6732ab10`.
- Browser CORS preflight was verified for `model.squarefun.xyz`,
  `launch.squarefun.xyz`, `chat.staccpad.fun`, `model.staccpad.fun`, and
  `explorer.solana.com`; an unlisted origin received no allow-origin header.
  Direct HTTP RPC `188.214.129.187:8899` stays available during the local
  model upload. Gossip is UDP 8001; QUIC TPU is UDP 8003 and is advertised
  through `getClusterNodes`. Ubuntu UFW was inactive at recording time.
- At recording time, external RPC showed a healthy advancing slot, and
  transaction history lookup returned normally. Disk had `204 GiB` free of
  `234 GiB`; build artifacts used `2.9 GiB`, ledger `889 MiB`.

## Live compute budget check

A server-signed memo requested `209,715,200` loaded-account bytes (`200 MiB`)
through `ComputeBudget::SetLoadedAccountsDataSizeLimit`. Simulation succeeded
at `9,166` compute units, and signature
`5pXEBfCPX6iNWxhADznPLRUWgZorx9w1dqawGLaDDeyKcPMUkiUHmqChjFqb88wNckuXQVhK5ak7FH7LXttXQBaE`
finalized without error in slot `3724`. HTTPS `getTransaction` returned both
instructions and a null transaction error. This verifies acceptance of the
larger request; the memo itself did not load 200 MiB of account data.
The focused `solana-compute-budget-instruction` release test
`test_process_instructions` passed after correcting two stale crekk test
expectations for its raised compute-unit cap.

A second live transaction loaded 20 finalized sealed weight accounts, each
`10,272,896` bytes, for `205,457,920` account-data bytes (`195.94 MiB`). It
requested the same `200 MiB` limit and ran a harmless memo. Simulation
succeeded at `12,747` compute units; signature
`SR4Lq72TkwiDqpxi5e99LX3ZbbZkiSwvTdU62n9crzDHP1SugLbXnpfdBLuuJsgjShmkNBTAGbxnSPntD2MKVDi`
finalized without error in slot `7333`. HTTPS `getTransaction` confirms 23
message keys (payer, two program IDs, and 20 weight accounts) and null error.
Agave's `svm/src/account_loader.rs` loads and counts every message account key,
so this transaction exercises actual account loading above the old `64 MiB`
cap while the model upload proceeds.

## Checks

```bash
curl -sS https://rpc-model.staccpad.fun/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}'
ssh root@188.214.129.187 'systemctl status crekk-validator caddy --no-pager'
ssh root@188.214.129.187 'df -h /root && du -sh /root/crekk-chain/ledger'
```
