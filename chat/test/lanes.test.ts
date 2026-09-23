import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AccountRole, generateKeyPairSigner } from "@solana/kit";
import { LANES, type Header, type Shard } from "../src/chain/layout.ts";
import { mergeFor, TESTNET_GENESIS, workFor } from "../src/chain/transport.ts";
const keys = await Promise.all(
  Array.from({ length: 38 }, () => generateKeyPairSigner()),
);
const session = {
  authority: keys[0],
  state: keys[1].address,
  workers: keys.slice(2, 18).map((k) => k.address),
  payers: keys.slice(18, 34),
};
const deployment = {
  program: keys[34].address,
  registry: keys[35].address,
  genesis: TESTNET_GENESIS,
  shards: [
    {
      address: keys[36].address,
      tensor: 4,
      rowStart: 0,
      rows: 4096,
      cols: 4096,
      size: 8650880,
      encoding: 1,
    },
  ] satisfies Shard[],
};
const h: Header = {
  phase: 3,
  layer: 0,
  position: 0,
  cursor: 0,
  epoch: 12,
  token: 9707,
  count: 1,
};
test("parallel tiles have disjoint writable account sets including fee payers", () => {
  const work = workFor(h, session, deployment);
  assert.equal(work.length, LANES);
  const seen = new Set<string>();
  for (const item of work) {
    const writable = [
      item.payer.address,
      ...item.instruction
        .accounts!.filter((a) => (a.role & 1) !== 0)
        .map((a) => a.address),
    ];
    for (const key of writable) {
      assert(!seen.has(key));
      seen.add(key);
    }
    assert.equal(item.instruction.accounts![0].role, AccountRole.READONLY);
    assert.equal(
      item.instruction.accounts![2].role,
      AccountRole.READONLY_SIGNER,
    );
  }
});
test("rejects shared fee payer even when writable worker accounts differ", () => {
  assert.throws(
    () =>
      workFor(
        h,
        { ...session, payers: Array(LANES).fill(keys[18]) },
        deployment,
      ),
    /independent fee payer/,
  );
});
test("merge is an explicit writable session barrier and reads worker results", () => {
  const work = mergeFor(h, session, deployment);
  assert.equal(work.instruction.accounts![0].address, session.state);
  assert.equal(work.instruction.accounts![0].role, AccountRole.WRITABLE);
  assert(
    work.instruction
      .accounts!.slice(3)
      .every((a) => a.role === AccountRole.READONLY),
  );
  assert.deepEqual([...work.instruction.data!], [5, 12, 0, 0, 0]);
});
test("rejects a missing weight range and an unintended cluster", () => {
  assert.throws(
    () => workFor({ ...h, cursor: 4096 }, session, deployment),
    /Missing tensor 5/,
  );
  assert.throws(
    () => workFor(h, session, { ...deployment, genesis: "mainnet" }),
    /restricted to testnet/,
  );
});
