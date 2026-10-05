# Primary Trade + Chat site cutover

`chat.staccpad.fun` is the primary landing page. Its Trade panel signs only
Solana mainnet Pump/PumpSwap transactions for
`DxNXApfiPXYcobrM3NsePAXMDYyaPgB8jfK4yc9ichat`; its Chat panel uses the
chain reported by `/api/status`. The same public key identifies the token
on both chains, but balances and transactions are independent.

## Gates before changing the live Fly app

1. Finish all 569 sealed Qwen3-8B weight accounts and the sealed registry on
   genesis `3E5sqjXQ2FKbGGEqmwbrhYwynrjUGwhNJUvQcU5t5q6P`. Require the
   complete upload receipt and byte audit, not only an uploader percentage.
2. Run a local custom-chain chat service with `SEA_EXPECTED_GENESIS` set to
   that genesis, `SEA_RPC_URL=https://rpc-model.staccpad.fun/`, a distinct
   `PORT` such as `8788`, the local custom sponsor key file in
   `SEA_SPONSOR_KEYPAIR`, and an isolated `SEA_SESSION_DIRECTORY`. Then run:

   ```sh
   SEA_EXPECTED_GENESIS=3E5sqjXQ2FKbGGEqmwbrhYwynrjUGwhNJUvQcU5t5q6P \
   SEA_SMOKE_BASE_URL=http://127.0.0.1:8788 \
   ./chat/node_modules/.bin/tsx chat/scripts/custom-chat-smoke.ts
   ```

   Require confirmed model-program transactions and a nonempty generated
   response. Keep the existing testnet Fly app serving during this check.
## Optional lander rollout while chat is still on testnet

Once the model uploader is idle, the primary Trade + Chat lander can go live
without switching chat chains:

```sh
cd /Users/stacc/break-solana-chat
fly deploy --config fly.toml --remote-only
```

`fly.toml` retains the existing sponsored testnet chat and `/chat/<id>`
sessions. The lander labels chat as testnet, checks Solana mainnet for the
exact DxNX market, and keeps Buy/Sell disabled while the mint is absent. Do
not run this deploy while the Mac-to-validator model uploader is active.

## Custom-chain cutover after the model and smoke gates pass

The model uploader and its Mac-to-validator connection should be idle before
the Fly build context is sent. `.dockerignore` excludes raw model weight bins
and local node_modules; a local Docker context probe measured 33.43 MB.

From the repository root:

```sh
cd /Users/stacc/break-solana-chat
npm --prefix chat run build
npm --prefix chat test
fly deploy --config fly.custom.toml --remote-only
fly status --config fly.custom.toml
```

`fly.custom.toml` keeps the same Fly app, volume, and primary domain while
switching the sponsored chat RPC to the verified custom genesis. It uses the
existing `SEA_CUSTOM_SPONSOR_KEYPAIR_B64` Fly secret; do not copy the D88
treasury or DxNX mint secret to Fly.

## Verify the primary site before mainnet launch

- `https://chat.staccpad.fun/api/status` must report `ready: true`,
  `cluster: "custom"`, and the exact genesis above.
- `https://chat.staccpad.fun/api/model-mainnet-rpc` must answer a permitted
  `getGenesisHash` request with Solana mainnet genesis
  `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` and reject
  `getProgramAccounts` and unrelated signed transfers.
- On `https://chat.staccpad.fun/`, confirm the matching mint, Buy/Sell controls,
  truthful **prelaunch** price/activity panel, and no horizontal overflow on mobile.
  Reopen `/chat/<existing-session-id>` to ensure old shared session links still
  route to the same Fly volume.
- The atomic launch script checks the saved custom-chain smoke report, the
  primary site's exact custom genesis/program/registry/sponsor, and a confirmed
  chat receipt against the custom ledger. Keep all these checks intact.

## Launch and verify the mainnet token

Only after the public primary site passes the checks above, simulate the
create plus first buy and inspect its output. Then submit the exact gated
transaction from the local payer and mint keys:

```sh
node /Users/stacc/stacc-mint/prepare-sea-chat-atomic.cjs
SEND=1 node /Users/stacc/stacc-mint/prepare-sea-chat-atomic.cjs
```

Confirm the mainnet mint, metadata, and first buy receipt before claiming
trading is live. The site shows an empty prelaunch chart and disables Buy/Sell
until the exact mint and canonical Pump market are present.

## Chart record

- The chart stores observed reserve ratios once per minute in
  `/data/model-market-history.json` and displays the last 24 hours. It never
  backfills unobserved prices or labels sampled prices as executed trades.
