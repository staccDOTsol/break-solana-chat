import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type RpcTransport, type Signature, type Blockhash } from "@solana/kit";
import { raceTransports, rpcErrorText } from "../src/chain/rpc-race.ts";
import { Transport, workFor, interleaveSlices, type Deployment } from "../src/chain/transport.ts";
import { createWallet } from "../src/chain/engine.ts";

const transport = (fn: (config: Parameters<RpcTransport>[0]) => Promise<unknown>) => fn as RpcTransport;
const result = (value: unknown) => ({ id: 1, jsonrpc: "2.0", result: value });
test("transaction failures retain BigInt instruction indexes without masking the actual error", () => {
  assert.equal(rpcErrorText({ InstructionError: [5n, "ProgramFailedToComplete"] }), '{"InstructionError":["5","ProgramFailedToComplete"]}');
});

test("RPC delivery races identical bytes, ignores a failed peer, and coalesces overlapping sends", async () => {
  const seen: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fallback = 0;
  const peers = [0, 1, 2].map(index => transport(async config => {
    seen.push(config.payload); await gate;
    if (index === 0) throw new Error("unavailable");
    return result("same-signature");
  }));
  const rpc = raceTransports(peers, transport(async () => { fallback++; return result("fallback"); }));
  const payload = { method: "sendTransaction", params: ["identical-signed-wire", { encoding: "base64" }] };
  const a = rpc({ payload }), b = rpc({ payload });
  assert.equal(seen.length, 3); seen.forEach(value => assert.deepEqual(value, payload));
  release(); assert.deepEqual(await a, await b); assert.equal(fallback, 0);
});

test("a fast empty cache does not hide a slower confirmed transaction", async () => {
  const confirmed = result({ value: [{ confirmationStatus: "confirmed", slot: 42n, err: null }] });
  const rpc = raceTransports([
    transport(async () => result({ value: [null] })),
    transport(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return confirmed; }),
  ], transport(async () => { assert.fail("fallback should not be needed"); }));
  assert.deepEqual(await rpc({ payload: { method: "getSignatureStatuses" } }), confirmed);
});

test("all failed peers use the fallback; all empty caches remain unconfirmed", async () => {
  const failed = transport(async () => { throw new Error("down"); });
  const fallback = transport(async () => result(42));
  assert.deepEqual(await raceTransports([failed, failed], fallback)({ payload: { method: "getSlot" } }), result(42));
  const empty = result({ value: [null] });
  assert.deepEqual(await raceTransports([failed, transport(async () => empty)], fallback)({ payload: { method: "getSignatureStatuses" } }), empty);
});

test("parallel writes distribute unique slices across RPCs and fail over identical bytes", async () => {
  const seen: { peer: number; wire: string }[] = [];
  let unavailable = false;
  const peers = [0, 1, 2].map(peer => transport(async config => {
    const wire = (config.payload as { params: string[] }).params[0];
    seen.push({ peer, wire });
    if (unavailable && peer === 0) throw new Error("peer down");
    return result(wire);
  }));
  const rpc = raceTransports(peers, transport(async () => { assert.fail("healthy peers remain"); }), true);
  const send = (wire: string) => rpc({ payload: { method: "sendTransaction", params: [wire] } });
  await Promise.all(Array.from({ length: 6 }, (_, i) => send(`slice-${i}`)));
  assert.deepEqual(seen, Array.from({ length: 6 }, (_, i) => ({ peer: i % 3, wire: `slice-${i}` })));
  unavailable = true; await send("retry-same-wire");
  assert.deepEqual(seen.slice(-2), [{ peer: 0, wire: "retry-same-wire" }, { peer: 1, wire: "retry-same-wire" }]);
});

test("TPU and RPC receive the same already-signed transaction without re-signing", async () => {
  const t = new Transport("https://api.testnet.solana.com", ["http://example.invalid"]), seen: string[] = [];
  t.submitter = async wire => { seen.push(wire); };
  Object.defineProperty(t, "rpc", { value: {
    getGenesisHash: () => ({ send: async () => t.expectedGenesis }),
    sendTransaction: (wire: string) => ({ send: async () => { seen.push(wire); return "signature"; } }),
  } });
  const signed = { wire: "same-wire", signature: "same-signature" as Signature, lastValidBlockHeight: 100n } as Awaited<ReturnType<Transport["sign"]>>;
  assert.equal(await t.submit(signed), signed.signature);
  assert.deepEqual(seen, [signed.wire, signed.wire]);
});

test("wrong RPC genesis prevents transaction submission", async () => {
  const t = new Transport("https://example.invalid", [], true, "expected-genesis");
  let sent = false;
  Object.defineProperty(t, "rpc", { value: {
    getGenesisHash: () => ({ send: async () => "other-genesis" }),
    sendTransaction: () => ({ send: async () => { sent = true; } }),
  } });
  const signed = { wire: "wire", signature: "signature" as Signature, lastValidBlockHeight: 100n } as Awaited<ReturnType<Transport["sign"]>>;
  await assert.rejects(() => t.submit(signed), /RPC genesis mismatch/);
  assert.equal(sent, false);
});

test("packing uses consecutive known epochs and leaves expensive matrix tiles separate", async () => {
  const wallet = await createWallet(), session = { authority: wallet.authority, state: wallet.state.address,
    workers: wallet.workers.map(key => key.address), payers: wallet.payers };
  const deployment: Deployment = { program: wallet.state.address, registry: wallet.authority.address,
    genesis: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY", shards: [3, 4, 5, 6].map(tensor => ({
      address: wallet.workers[0].address, tensor, rowStart: 0, rows: 10000, cols: 4096, encoding: 1, size: 0,
    })) };
  const h = { phase: 2, layer: 0, position: 0, cursor: 0, epoch: 50, token: 0, count: 1 };
  const pair = workFor(h, session, deployment)[0].batch!;
  assert.deepEqual(pair.map(ix => new DataView(ix.data!.buffer, ix.data!.byteOffset).getUint32(1, true)), [50, 51]);
  assert.equal(workFor({ ...h, cursor: 4 }, session, deployment)[0].batch, undefined);
  assert.equal(workFor({ ...h, phase: 7 }, session, deployment)[0].batch, undefined);
  assert.equal(workFor({ ...h, phase: 3 }, session, deployment).length, 16);
  const matrix = workFor({ ...h, phase: 3 }, session, deployment), slices = interleaveSlices(matrix);
  assert.equal(slices.length, 96);
  assert.deepEqual(slices.slice(0, 16).map(work => work.lane), Array.from({ length: 16 }, (_, i) => i));
  assert.deepEqual(slices.slice(16, 32).map(work => work.lane), Array.from({ length: 16 }, (_, i) => i));
  assert(slices.slice(16, 32).every(work => new DataView(work.instruction.data!.buffer, work.instruction.data!.byteOffset).getUint16(7, true) === 24));
  const activation = workFor({ ...h, phase: 9 }, session, deployment);
  assert.equal(activation.length, 4); assert(activation.every(work => work.batch?.length === 4));
  assert.equal(interleaveSlices(activation).length, 4);
  assert(interleaveSlices(activation).every(work => work.batch?.length === 4));
  const t = new Transport();
  Object.defineProperty(t, "rpc", { value: { getLatestBlockhash: () => ({ send: async () => ({ value: {
    blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 100n,
  } }) }) } });
  const signed = await t.sign(activation[0], activation[0].batch);
  assert(Buffer.from(signed.wire, "base64").length < 4096);
});
