/** Bounded live check: setup, packed normalization, one matrix slice, reclaim. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { Engine } from "../src/chain/engine.ts";
import { Transport, sendConfirmed, workFor, collectSlicesFor, mergeFor, type Deployment } from "../src/chain/transport.ts";
import { verifyRpcEndpoints } from "../src/chain/rpc-race.ts";
import { readSigner, savedSigner } from "../server/keys.ts";
import { TpuRelay } from "./tpu-relay.ts";
import { executeWave } from "../src/chain/wave.ts";
import { header as decodeHeader } from "../src/chain/layout.ts";

const root = resolve(import.meta.dirname, "../../inference"), directory = resolve(root, `deployment/rpc-smoke-${Date.now()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const deployment: Deployment = JSON.parse(await readFile(resolve(root, "deployment/public.json"), "utf8"));
const peers = await verifyRpcEndpoints((process.env.SEA_RPC_RACE_URLS ?? "").split(",").filter(Boolean), "https://api.testnet.solana.com");
if (!peers.length) throw new Error("Provide verified testnet RPC peers");
const authority = await readSigner(resolve(homedir(), "test.json"));
const state = await savedSigner(resolve(directory, "state-keypair.json"));
const workers = await Promise.all(Array.from({ length: 16 }, (_, i) => savedSigner(resolve(directory, `worker-${i}.json`))));
const independent = process.env.SEA_INDEPENDENT_SLICES === "1";
const pipelineBench = process.env.SEA_PIPELINE_BENCH === "1";
const payers = await Promise.all(Array.from({ length: 16 }, (_, i) => independent ? savedSigner(resolve(directory, `payer-${i}.json`)) : readSigner(resolve(root, `deployment/upload-payer-${i}-keypair.json`))));
const sliceWorkers = independent ? await Promise.all(Array.from({ length: 256 }, (_, i) => savedSigner(resolve(directory, `slice-${i}.json`)))) : undefined;
const slicePayers = independent ? await Promise.all(Array.from({ length: 256 }, (_, i) => savedSigner(resolve(directory, `slice-payer-${i}.json`)))) : undefined;
const transport = new Transport("https://api.testnet.solana.com", peers);
const relay = process.env.SEA_TPU_RELAY_BIN ? new TpuRelay("https://api.testnet.solana.com") : undefined;
if (relay) transport.submitter = wire => relay.send([wire]);
const receipts: { signature: string; at: string; lane?: number }[] = [];
const record = (signature: string, lane?: number) => { receipts.push({ signature, lane, at: new Date().toISOString() }); };
const engine = new Engine(transport, deployment, { authority, state, workers, payers, sliceWorkers, slicePayers }, record);
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), state: state.address, peers, independent, completeReply: false };
try {
  const start = performance.now(); await engine.setup();
  report.setupMs = Math.round(performance.now() - start); report.setupTransactions = receipts.length;
  console.log(JSON.stringify({ setupMs: report.setupMs, setupTransactions: report.setupTransactions }));
  const stop = new AbortController(), normalizationStart = performance.now();
  try { await engine.token(151644, false, stop.signal, h => { if (h.phase === 3) stop.abort(new Error("Reached matrix phase")); }); }
  catch (error) { if (!stop.signal.aborted) throw error; }
  const h = await engine.read();
  if (h.phase !== 3 || h.count !== 1) throw new Error("Packed normalization did not reach the expected state");
  report.normalizationMs = Math.round(performance.now() - normalizationStart);
  const work = workFor(h, engine.session, deployment), tileStart = performance.now();
  if (pipelineBench) {
    if (!independent) throw new Error("Pipeline benchmark requires independent slices");
    let current = h;
    const timings: { pipeline: boolean; milliseconds: number; slices: number; slot: string }[] = [];
    for (const pipeline of [false, true, true]) {
      transport.confirmationPollMs = pipeline ? 400 : 1000;
      const slices = workFor(current, engine.session, deployment);
      const collectors = collectSlicesFor(current, engine.session, deployment);
      let slot = 0n;
      const send = async (item: typeof slices[number]) => {
        const landed = await sendConfirmed(transport, item, undefined, signature => record(signature, item.lane), item.instruction.data?.[0] !== 8);
        if (landed > slot) slot = landed;
      };
      const start = performance.now();
      if (pipeline) await executeWave(slices, collectors, send);
      else { await Promise.all(slices.map(send)); await Promise.all(collectors.map(send)); }
      await send(mergeFor(current, engine.session, deployment));
      const account = await transport.rpc.getAccountInfo(state.address, { encoding: "base64", commitment: "confirmed",
        minContextSlot: slot, dataSlice: { offset: 0, length: 144 } }).send();
      current = decodeHeader(Buffer.from(account.value!.data[0], "base64"));
      timings.push({ pipeline, milliseconds: Math.round(performance.now() - start), slices: slices.length, slot: String(slot) });
      if (current.epoch !== h.epoch + timings.length || current.count !== 1) throw new Error("Wave checkpoint did not advance exactly once");
      console.log(JSON.stringify(timings.at(-1)));
    }
    if (current.phase !== 4 || current.cursor !== 0) throw new Error("Three matrix waves did not finish attention projection");
    report.pipelineTimings = timings; report.header = current;
  } else if (independent) {
    const slots = await Promise.all(work.map(item => sendConfirmed(transport, item, undefined, signature => record(signature, item.lane))));
    report.parallelSlices = work.length; report.executionSlots = [...new Set(slots.map(String))];
    const results = await Promise.all(collectSlicesFor(h, engine.session, deployment).map(item => sendConfirmed(transport, item, undefined, signature => record(signature, item.lane), true)));
    await sendConfirmed(transport, mergeFor(h, engine.session, deployment), undefined, record, true);
    const next = await engine.read();
    if (next.phase !== 3 || next.cursor !== 2048 || next.count !== 1) throw new Error("Parallel wave did not merge into the expected checkpoint");
    report.header = next;
  } else await sendConfirmed(transport, { ...work[0], instruction: work[0].parts![0] }, undefined, signature => record(signature, 0));
  report.matrixSliceMs = Math.round(performance.now() - tileStart); report.verified = true;
  console.log(JSON.stringify({ normalizationMs: report.normalizationMs, matrixSliceMs: report.matrixSliceMs, verified: true }));
} catch (error) { report.error = String(error); process.exitCode = 1; console.error(String(error)); }
finally {
  try { await engine.close(undefined, { reclaimPayers: independent }); report.storageReclaimed = true; }
  catch (error) { report.cleanupError = String(error); process.exitCode = 1; }
  relay?.close(); report.receipts = receipts; report.finishedAt = new Date().toISOString();
  const reportPath = pipelineBench ? "reports/testnet-pipeline-smoke.json" : independent ? "reports/testnet-independent-slices-smoke.json" : "reports/testnet-rpc-race-smoke.json";
  await writeFile(resolve(root, reportPath), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: `inference/${reportPath}`, storageReclaimed: report.storageReclaimed }));
}
