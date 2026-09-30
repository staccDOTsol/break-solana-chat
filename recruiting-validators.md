# recruiting validators — art chain

**date:** 2026-09-30
**status:** 1 validator live (the vallie). applicants: 0. DMs open.

## the pitch

art is a fork of solana mainnet-beta. full state — every account, every pump.fun bonding curve, every bored ape — carried over at slot 451,760,522 and running solo since. we're not building a chain from zero. we inherited one.

what's different:

- **k² write fees.** the k-th write to the same account in a slot costs 5000·k² lamports extra. bots that hammer one account pay quadratically. humans making one transfer pay nothing.
- **no ceilings.** CU limit, heap size, block size — maxed. the chain is the constraint, not the accountant.
- **51 program fee-receivers rewritten.** pump.fun, pump AMM, raydium CLMM+CPMM, meteora DLMM, LSTs, kamino — every fee that used to flow to the original deployers flows to the art treasury instead. it's a fairer fork.
- **single validator, zero contention.** ~5 slots/sec, ~430ms slots. nobody's fighting you for block space. yet.

## what a validator earns

- 50% of every transaction fee (the standard leader split; the other 50% burns — deflationary by default)
- that includes the k² spam tax. someone runs a wash bot on your slot, you get paid for watching
- stake is stake. art mints its own (2B SOL voted in at genesis — democracy, simulated cheaply)

## what you need to run one

| thing | the vallie (reference) | comfortable minimum |
| --- | --- | --- |
| CPU | Threadripper 7975WX (64c) | 32 cores |
| RAM | 754 GB | 512 GB (skip `spl-token-owner` index — we learned the hard way) |
| disk | 7 TB NVMe RAID0 | 4 TB NVMe |
| chain data | full snapshot @ art slot 0 (warp 452,304,000) | same, we ship the archive |

software: [staccDOTsol/agave](https://github.com/staccDOTsol/agave), branch `crekk`. it's agave with the k² fee, the maxed ceilings, and the snapshot surgery flags. build it, restore the archive, vote.

the flags that matter (the ones that took us a week to learn):

```
--no-wait-for-vote-to-start-leader   # or you deadlock at genesis: can't vote before you produce
--account-index program-id           # or getProgramAccounts returns nothing
--account-index spl-token-mint       # or the backend sees no tokens
--enable-rpc-transaction-history     # or solscan can't see you
```

and **not** `--account-index spl-token-owner` — that's the OOM. not every index deserves a home.

## what you get

- a validator set seat on the only chain where pump.fun fees don't go to pump.fun
- your name in the leader schedule (rotating, stake-weighted)
- the right to complain about index rebuild times with us

## how to apply

DM [@STACCoverflow](https://x.com/STACCoverflow) on X with:

1. your hardware (or your willingness to rent it — cherry servers works)
2. your pubkey (we'll wire your vote account into the schedule)
3. one sentence on why spam should pay quadratically

we ship you the snapshot archive (105 GB), the binary, and the self-heal script. you boot, you vote, you're in.

current applicants: **0**. be first. it's lonely at the top of a one-validator chain.
