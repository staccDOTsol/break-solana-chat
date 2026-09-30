# art chain stand-up — the vallie edition 🫡

**date:** 2026-09-30
**blockchain:** art (forked from mainnet-beta @ slot 451,760,522, warped to 452,304,000)
**validators:** 1 (and he's hiring — DMs open, bring your own RAM)

## the vallie

- one (1) Threadripper 7975WX, 754 GB RAM, 7 TB NVMe, pure spite
- currently rebuilding account indexes at 272,692 / 422,078 slots (65%, ~2h to go)
- memory usage: 352 GB / 754 GB — comfortably below the OOM line since we yeeted `spl-token-owner`
- self-heal loop v2 armed: restarts the process when it dies, NOT every 60s like v1 (which fought itself in a parking lot)

## what the vallie survived this week

1. **OOM killer** — the kernel walked up behind the validator and put 776 GB of RSS down. cause: `spl-token-owner` index on a full mainnet fork. fix: dropped it, kept `program-id` + `spl-token-mint`. moral: not every index deserves a home
2. **vote-before-produce deadlock** — new validators can't vote until they produce, can't produce until they vote. fix: `--no-wait-for-vote-to-start-leader`. the chain now boots itself
3. **leader schedule assertion** — upstream asserts the leader is who it computed. we asserted it isn't. now it just warns, like a polite colleague
4. **`getProgramAccounts` returning 0 for everything** — no secondary indexes = the RPC just shrugs. now they're building
5. **2 epochs of warp** — `--bootstrap-validator` fast-forwarded past the fork so the leader schedule recomputed with OUR vote account

## what's live

- chain advancing ~5 slots/sec, solo. consensus: me
- k² write-repetition fees live (5000·k² lamports per k-th write to the same account in a slot — spam scales quadratically, as it should)
- CU / heap / block ceilings: maxed. the constraint is the chain, not the accountant
- 51 program accounts rewritten — pump.fun, pump AMM, Raydium CLMM+CPMM, Meteora DLMM, LSTs, Kamino — every fee lands in the art treasury
- 2B SOL minted into a single stake account to vote with (democracy: simulated, cheaply)
- rpc.squarefun.xyz (HTTP + WS) via Caddy, launch-api.squarefun.xyz for coins/trades/candles
- launch.squarefun.xyz — art-branded pump fork, TradingView charts, sign-in removed
- /bridge page + art_bridge.so (232 KB) — r/s share vault, 1% fee stays in the vault, virtual offsets so inflation attacks bounce off
- deck.squarefun.xyz for the pitch
- browser mirror CI now building on all 3 OSes on GitHub-hosted runners (mac died on disk — full chromium git history ate a 72 GB SSD; `--no-history` sewn that shut)

## the tweet thread, preserved for historians

> wait til the not-Solana maxis hear about my single validator blockchain 🤣
>
> wen art chain but validator not OOM itself? **sewn**
>
> also: recruiting validators

## next up

1. wait for the index rebuild to land (~2h), RPC 8899 opens, `getProgramAccounts` works for the first time
2. verify pump bonding curves exist on art (fork snapshot was taken 9 min after $ART launched — they should be in there)
3. seed `global_params` in Supabase so the backend stops asking existential questions at startup
4. client-server (8081) comes up once RPC answers → coin page stops 500ing
5. mainnet side of the bridge (needs 1.25 SOL, user is "not yet")
6. validator recruiting drive (current applicants: 0)

## stats for the skeptics

- fork point: 9 min after $ART mint
- snapshot size: 105 GB
- stake: 2B SOL (minted, not redelegated — 500k mainnet stake accounts would've taken longer than reading this)
- cherry servers credit remaining: ~14 EUR (the real constraints are always economic)
