/** A real, resumable testnet forward pass. Signing material stays in ignored storage. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { Engine } from "../src/chain/engine.ts";
import { Transport, type Deployment } from "../src/chain/transport.ts";
import { savedSigner, readSigner } from "../server/keys.ts";
import { TpuRelay } from "./tpu-relay.ts";
import { writeUploadStatus } from "./upload-status.ts";

const root = resolve(import.meta.dirname, "../../inference");
const directory = resolve(root, "deployment/chat-smoke");
await mkdir(directory, { recursive: true, mode: 0o700 });
const deployment: Deployment = JSON.parse(await readFile(resolve(root, "deployment/public.json"), "utf8"));
const authority = await readSigner(process.env.SEA_SPONSOR_KEYPAIR ?? resolve(homedir(), "test.json"));
const state = await savedSigner(resolve(directory, "state-keypair.json"));
const workers = await Promise.all(Array.from({ length: 16 }, (_, i) => savedSigner(resolve(directory, `worker-${i}-keypair.json`))));
const payers = await Promise.all(Array.from({ length: 16 }, (_, i) => readSigner(resolve(root, `deployment/upload-payer-${i}-keypair.json`))));
const transport = new Transport();
const relay = new TpuRelay("https://api.testnet.solana.com");
await relay.ready;
transport.submitter = wire => relay.send([wire]);
const startedAt = new Date().toISOString();
let confirmations = 0, lastWrite = 0;
const reportPath = resolve(directory, "status.json");
const report: Record<string, unknown> = { startedAt, pid: process.pid, cluster: "testnet", program: deployment.program,
  registry: deployment.registry, state: state.address, sponsor: authority.address, inputToken: 151644,
  expectedToken: 8, complete: false, stage: "initializing" };
const save = () => {
  report.updatedAt = new Date().toISOString(); report.confirmationsThisRun = confirmations;
  writeUploadStatus(reportPath, report);
};
const engine = new Engine(transport, deployment, { authority, state, workers, payers }, (signature, lane) => {
  confirmations++;
  if (confirmations < 5 || confirmations % 100 === 0) console.log(JSON.stringify({ confirmed: confirmations, signature, lane }));
});
try {
  await save(); await engine.setup();
  console.log(JSON.stringify({ initialized: state.address }));
  const onProgress = (h: Awaited<ReturnType<Engine["read"]>>) => {
    report.header = h; report.stage = "inference";
    if (Date.now() - lastWrite > 5000) { lastWrite = Date.now(); void save(); console.log(JSON.stringify({ progress: h, confirmations })); }
  };
  const h = await engine.read();
  if (h.count > 1) throw new Error("Smoke session has more than one input token");
  const result = h.count === 0 ? await engine.token(151644, true, undefined, onProgress) : await engine.drive(undefined, onProgress);
  if (result.phase !== 14 || result.token !== 8) throw new Error(`Live/reference output differs: ${JSON.stringify(result)}`);
  Object.assign(report, { complete: true, stage: "verified", outputToken: result.token, header: result, finishedAt: new Date().toISOString() });
  await save(); await writeFile(resolve(root, "reports/testnet-inference-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ completed: report }));
} catch (error) {
  report.stage = "error"; report.error = String(error); await save(); console.error(error); process.exitCode = 1;
} finally { relay.close(); }
