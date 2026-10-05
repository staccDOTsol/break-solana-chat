/** End-to-end sponsored chat check against a completed custom-chain deployment.
 * The access token stays in ignored local storage so a long run can be resumed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deploymentPaths } from "./deployment-paths.ts";
import { checkedGenesis, TESTNET_GENESIS } from "../src/chain/network.ts";

type Session = {
  id: string; stage: string; stateAddress?: string; confirmed: number; error?: string;
  messages: { role: string; text: string }[];
  receipts: { signature: string }[];
  run?: { generatedTokens: number; processedPromptTokens: number; promptTokens: number };
  header?: { phase: number; layer: number; count: number };
};
type Credentials = { id: string; accessToken: string };

const genesis = checkedGenesis(process.env.SEA_EXPECTED_GENESIS ?? "");
const baseUrl = new URL(process.env.SEA_SMOKE_BASE_URL ?? "http://127.0.0.1:3000");
if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("Smoke API URL must use HTTP or HTTPS");
if (genesis === TESTNET_GENESIS)
  throw new Error("Use this smoke check only on a custom chain");
const paths = deploymentPaths(resolve(import.meta.dirname, "../../inference"), genesis);
const directory = resolve(paths.outputDir, "chat-smoke");
const credentialsPath = resolve(directory, "credentials.json");
const reportPath = resolve(directory, "report.json");
const prompt = "Hi";
const expectedProgram = "BkWuzU3fn4NS7LXdBxH1j4gRyRw3ma35aNGytbANzUvB";
const expectedSponsor = "AkUdZMSEGB9KPdXDoH5iLK7fbYdPjg34MgFXANhuR7H5";
await mkdir(directory, { recursive: true, mode: 0o700 });

async function api<T>(path: string, method = "GET", body?: unknown, token?: string): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${result.error ?? "unknown error"}`);
  return result;
}

const status = await api<{
  ready: boolean; cluster: string; genesis: string; program?: string; registry?: string;
  sponsorship?: { enabled: boolean; address: string };
}>("/api/status");
if (!status.ready || status.cluster !== "custom" || status.genesis !== genesis ||
    status.program !== expectedProgram || !status.registry ||
    status.sponsorship?.enabled !== true || status.sponsorship.address !== expectedSponsor)
  throw new Error("Custom-chain API is not ready with the expected genesis, program, registry, and sponsor");

let credentials: Credentials;
try {
  credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as Credentials;
  if (!/^[a-f0-9-]{36}$/.test(credentials.id) || !/^[a-f0-9]{64}$/.test(credentials.accessToken))
    throw new Error("Invalid saved smoke credentials");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  const created = await api<{ accessToken: string; session: Session }>("/api/sessions", "POST", {});
  credentials = { id: created.session.id, accessToken: created.accessToken };
  await writeFile(credentialsPath, JSON.stringify(credentials) + "\n", { mode: 0o600, flag: "wx" });
}

const sessionPath = `/api/sessions/${credentials.id}`;
let session = await api<Session>(sessionPath, "GET", undefined, credentials.accessToken);
if (session.stage === "idle") {
  session = await api<Session>(`${sessionPath}/messages`, "POST",
    { text: prompt, maximumOutputTokens: 1 }, credentials.accessToken);
}
if (!session.messages.some(message => message.role === "you" && message.text === prompt))
  throw new Error("Saved smoke session does not contain the expected prompt");
const startedAt = new Date().toISOString();
let lastReport = 0;
for (;;) {
  const report = {
    startedAt, updatedAt: new Date().toISOString(), genesis, baseUrl: baseUrl.origin,
    sessionId: credentials.id, registry: status.registry, stage: session.stage,
    stateAddress: session.stateAddress, confirmed: session.confirmed,
    promptTokens: session.run?.promptTokens, processedPromptTokens: session.run?.processedPromptTokens,
    generatedTokens: session.run?.generatedTokens, header: session.header,
    output: session.messages.find(message => message.role === "model")?.text,
    recentReceipts: session.receipts.slice(0, 3).map(receipt => receipt.signature),
    error: session.error,
  };
  if (Date.now() - lastReport >= 30_000 || ["done", "error", "paused"].includes(session.stage)) {
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report));
    lastReport = Date.now();
  }
  if (session.stage === "done") {
    if (session.confirmed < 1 || !session.stateAddress || !session.run?.generatedTokens || !report.output)
      throw new Error("Chat completed without a confirmed on-chain response");
    break;
  }
  if (["error", "paused", "closed"].includes(session.stage))
    throw new Error(`Chat ended in ${session.stage}: ${session.error ?? "no error detail"}`);
  await new Promise(resolve => setTimeout(resolve, 10_000));
  session = await api<Session>(sessionPath, "GET", undefined, credentials.accessToken);
}
