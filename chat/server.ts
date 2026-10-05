import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { address } from "@solana/kit";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { TESTNET_GENESIS, TESTNET_RPC, Transport, type Deployment } from "./src/chain/transport.ts";
import { verifyRpcEndpoints } from "./src/chain/rpc-race.ts";
import { TpuRelay } from "./scripts/tpu-relay.ts";
import { deploymentPaths } from "./scripts/deployment-paths.ts";
import { readUploadStatus } from "./scripts/upload-status.ts";
import { SponsoredChat, ChatError } from "./server/sponsored-chat.ts";
import { handleModelMainnetRpc } from "./server/model-mainnet-rpc.ts";
import { readModelMarketHistory, startModelMarketHistory, stopModelMarketHistory } from "./server/model-market-history.ts";
const artifacts = resolve(
  import.meta.dirname,
  "../inference/artifacts/qwen3-8b-q4g128",
);
if (process.env.SEA_RPC_URL && !process.env.SEA_EXPECTED_GENESIS)
  throw new Error("SEA_EXPECTED_GENESIS is required when SEA_RPC_URL is configured");
const expectedGenesis = process.env.SEA_EXPECTED_GENESIS ?? TESTNET_GENESIS;
const rpc = process.env.SEA_RPC_URL ?? process.env.SOLANA_TESTNET_RPC ?? TESTNET_RPC;
const paths = deploymentPaths(resolve(import.meta.dirname, "../inference"), expectedGenesis, {
  outputDir: process.env.SEA_DEPLOYMENT_DIR,
  receiptPath: process.env.SEA_DEPLOYMENT_RECEIPT,
});
const deploymentPath = resolve(paths.outputDir, "public.json");
const configuredPeers = (process.env.SEA_RPC_RACE_URLS ?? "").split(",").map(value => value.trim()).filter(Boolean);
const rpcPeers = configuredPeers.length ? await verifyRpcEndpoints(configuredPeers, rpc, expectedGenesis).catch(() => []) : [];
console.log(`Transaction delivery: ${rpcPeers.length} verified RPC peers`);
let relay: TpuRelay | undefined;
const useTpu = !!process.env.SEA_TPU_RELAY_BIN;
env.allowRemoteModels = false;
let tokenizer: ReturnType<typeof AutoTokenizer.from_pretrained> | undefined;
const getTokenizer = () =>
  (tokenizer ??= AutoTokenizer.from_pretrained(artifacts, {
    local_files_only: true,
  }));
let verified: { at: number; deployment: Deployment } | undefined;
async function body(req: AsyncIterable<Uint8Array>, limit = 16000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function deployed() {
  if (verified && Date.now() - verified.at < 60_000) return verified.deployment;
  let deployment;
  try {
    deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
  } catch {
    return undefined;
  }
  if (deployment.genesis !== expectedGenesis)
    throw new Error("Saved deployment genesis does not match the configured chain");
  const transport = execution;
  await transport.checkNetwork();
  const result = await transport.rpc
    .getMultipleAccounts(
      [address(deployment.program), address(deployment.registry)],
      { encoding: "base64", dataSlice: { offset: 0, length: 64 } },
    )
    .send();
  const [program, registry] = result.value;
  if (
    !program?.executable ||
    !registry ||
    registry.owner !== deployment.program
  )
    throw new Error("Deployment is incomplete");
  const data = Buffer.from(registry.data[0], "base64");
  if (
    data.toString("utf8", 0, 8) !== "SEABLOB2" ||
    data[8] !== 1 ||
    data[9] !== 1 ||
    data.readUInt32LE(48) !== deployment.shards.length
  )
    throw new Error("Model registry is not sealed");
  verified = { at: Date.now(), deployment };
  return deployment;
}
async function tokenizeText(text: string, continuation: boolean) {
  const tokenizer = await getTokenizer();
  const options = {
    tokenize: true, add_generation_prompt: true, enable_thinking: false, return_tensor: false,
  };
  const raw = tokenizer.apply_chat_template([{ role: "user", content: text }], options) as number[];
  return continuation ? [151645, 198, ...raw] : raw;
}
const execution = new Transport(rpc, rpcPeers, true, expectedGenesis);
if (useTpu) execution.submitter = async wire => {
  relay ??= new TpuRelay(rpc, expectedGenesis); await relay.send([wire]);
};
const chat = new SponsoredChat({
  directory: process.env.SEA_SESSION_DIRECTORY ?? resolve(paths.outputDir, "chat-sessions"),
  sponsorPath: process.env.SEA_SPONSOR_KEYPAIR ?? resolve(homedir(), "test.json"),
  transport: execution, deployment: deployed, tokenize: tokenizeText,
  independentSlices: process.env.SEA_INDEPENDENT_SLICES === "1",
  decode: async tokens => (await getTokenizer()).decode(tokens, { skip_special_tokens: true }),
});
const server = createServer(async (req, res) => {
  const respond = (code: number, value: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (path === "/api/model-mainnet-rpc") {
      await handleModelMainnetRpc(req, res);
      return;
    }
    if (path === "/api/model-market-history") {
      if (req.method !== "GET") { respond(405, { error: "Method not allowed" }); return; }
      respond(200, await readModelMarketHistory());
      return;
    }
    const shared = path.match(/^\/api\/chats\/([a-f0-9-]{36})(?:\/(events))?$/);
    if (shared) {
      if (req.method !== "GET") { respond(405, { error: "Shared chats are read-only" }); return; }
      const [, id, events] = shared, value = await chat.shared(id);
      if (!events) { respond(200, value); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      const unsubscribe = await chat.subscribeShared(id, value => {
        if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
        if (!res.destroyed) res.write(`event: session\ndata: ${JSON.stringify(value)}\n\n`);
      });
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": keepalive\n\n"); }, 15_000);
      res.on("close", () => { clearInterval(heartbeat); unsubscribe(); }); return;
    }
    if (path === "/api/sessions" || path.startsWith("/api/sessions/")) {
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host)
          throw new ChatError("Please use the chat page to make this request.", 403);
        if (req.method === "POST" && req.headers["content-type"] !== "application/json")
          throw new ChatError("Expected application/json");
      }
      if (path === "/api/sessions" && req.method === "POST") {
        if (!await deployed()) throw new ChatError("The model is not ready yet.", 503);
        respond(201, await chat.create()); return;
      }
      const match = path.match(/^\/api\/sessions\/([a-f0-9-]{36})(?:\/(messages|pause|resume|events))?$/);
      if (!match) throw new ChatError("Chat endpoint not found", 404);
      const [, id, action] = match;
      const authorization = req.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (req.method === "GET" && action === "events") {
        await chat.get(id, token);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        const unsubscribe = await chat.subscribe(id, token, value => {
          if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
          if (!res.destroyed) res.write(`event: session\ndata: ${JSON.stringify(value)}\n\n`);
        });
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": keepalive\n\n"); }, 15_000);
        res.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      if (req.method === "GET" && !action) { respond(200, await chat.get(id, token)); return; }
      if (req.method === "POST" && action === "messages") {
        const input = await body(req);
        respond(202, await chat.serialize(id, () => chat.send(id, token, input.text, input.maximumOutputTokens ?? 8))); return;
      }
      if (req.method === "POST" && action === "pause") {
        respond(200, await chat.serialize(id, () => chat.pause(id, token))); return;
      }
      if (req.method === "POST" && action === "resume") {
        respond(202, await chat.serialize(id, () => chat.resume(id, token))); return;
      }
      if (req.method === "DELETE" && !action) {
        respond(200, await chat.serialize(id, () => chat.close(id, token))); return;
      }
      respond(405, { error: "Method not allowed" }); return;
    }
    if (
      req.method === "POST" &&
      (path === "/api/tokenize" || path === "/api/decode")
    ) {
      const input = await body(req),
        tokenizer = await getTokenizer();
      if (path === "/api/tokenize") {
        if (typeof input.text !== "string" || input.text.length > 2000)
          throw new Error("Invalid prompt");
        const options = {
          tokenize: true,
          add_generation_prompt: true,
          enable_thinking: false,
          return_tensor: false,
        };
        const raw = tokenizer.apply_chat_template(
          [{ role: "user", content: input.text }],
          options,
        ) as number[];
        // The preceding generated tokens are already in KV. Close that turn,
        // then append the new user/assistant template without retokenizing it.
        respond(200, {
          tokens: input.continuation ? [151645, 198, ...raw] : raw,
        });
      } else {
        if (
          !Array.isArray(input.tokens) ||
          input.tokens.length > 128 ||
          input.tokens.some(
            (t: unknown) =>
              !Number.isInteger(t) || Number(t) < 0 || Number(t) >= 151936,
          )
        )
          throw new Error("Invalid tokens");
        respond(200, {
          text: tokenizer.decode(input.tokens, { skip_special_tokens: true }),
        });
      }
      return;
    }
    if (req.method !== "GET") {
      respond(405, { error: "Method not allowed" });
      return;
    }
    if (path === "/api/health") { respond(200, { ok: true }); return; }
    if (path === "/api/status" || path === "/api/manifest") {
      let manifest;
      try {
        manifest = JSON.parse(
          await readFile(resolve(artifacts, "manifest.json"), "utf8"),
        );
      } catch {
        respond(200, {
          ready: false,
          stage: "EXPORT REQUIRED",
          message:
            "Export the pinned Qwen3-8B weights to prepare the experiment.",
        });
        return;
      }
      if (path === "/api/manifest") {
        respond(200, manifest);
        return;
      }
      let deployment, error, sponsorship;
      try {
        deployment = await deployed();
        if (deployment) sponsorship = await chat.sponsorship();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      respond(200, {
        ready: !!deployment && !!sponsorship,
        stage: deployment
          ? `MODEL ON-CHAIN / ${paths.cluster.toUpperCase()}`
          : "PROGRAM DEPLOYED / WEIGHT UPLOAD PENDING",
        model: manifest.model,
        bytes: manifest.totalBytes,
        accounts: manifest.files.length,
        revision: manifest.revision,
        cluster: paths.cluster,
        genesis: expectedGenesis,
        rpc,
        explorerRpc: paths.cluster === "custom" ? process.env.SEA_PUBLIC_RPC_URL : undefined,
        submission: rpcPeers.length ? (useTpu ? "tpu+parallel-rpc" : "parallel-rpc") : useTpu ? "tpu" : "rpc",
        rpcPeers: rpcPeers.length,
        independentSlices: process.env.SEA_INDEPENDENT_SLICES === "1",
        sponsorship,
        program: deployment?.program,
        registry: deployment?.registry,
        message: error ?? (deployment
          ? `Qwen3-8B is deployed on ${paths.cluster}. STACC sponsors session rent and transaction fees. Live inference is experimental.`
          : (error ??
            `${(manifest.totalBytes / 2 ** 30).toFixed(3)} GiB exported. The sealed model registry is still pending on ${paths.cluster}.`)),
      });
      return;
    }
    if (path === "/api/deployment") {
      const deployment = await deployed();
      respond(
        deployment ? 200 : 409,
        deployment ?? { error: "Model is not deployed" },
      );
      return;
    }
    if (path === "/api/upload") {
      try {
        respond(
          200,
          readUploadStatus(resolve(paths.outputDir, "upload-status.json")),
        );
      } catch {
        respond(200, {
          complete: false,
          message: "No upload progress recorded",
        });
      }
      return;
    }
    if (path === "/api/validation") {
      const report = resolve(import.meta.dirname, paths.cluster === "testnet"
        ? "../inference/reports/validation.json"
        : `../inference/reports/${expectedGenesis}/validation.json`);
      try { respond(200, JSON.parse(await readFile(report, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        respond(404, { error: "Validation report is pending for this chain" });
      }
      return;
    }
    if (path === "/api/deployment-receipt") {
      respond(200, JSON.parse(await readFile(paths.receiptPath, "utf8"))); return;
    }
    if (path === "/" || /^\/chat\/[a-f0-9-]{36}$/.test(path) || /^\/assets\/[A-Za-z0-9_-]+\.(?:js|css|woff2|png|svg)$/.test(path)) {
      const file = path.startsWith("/assets/") ? path.slice(1) : "index.html";
      if (path.startsWith("/chat/")) res.setHeader("X-Robots-Tag", "noindex");
      try {
        const content = await readFile(resolve(import.meta.dirname, "dist", file));
        const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".woff2") ? "font/woff2" : file.endsWith(".png") ? "image/png" : file.endsWith(".svg") ? "image/svg+xml" : "text/html";
        res.writeHead(200, { "Content-Type": type, "Cache-Control": file === "index.html" ? "no-cache" : "public, max-age=31536000, immutable" });
        res.end(content); return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    respond(404, { error: "Not found" });
  } catch (error) {
    respond(error instanceof ChatError ? error.status : 400, {
      error: error instanceof Error ? error.message : "Request failed",
    });
  }
}).listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? "127.0.0.1", () => {
  console.log("Sponsored chat service: http://127.0.0.1:8787");
  void chat.start().catch(error => console.error("Chat recovery failed:", String(error)));
  void startModelMarketHistory().catch(error => console.error("Model market history failed:", String(error)));
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  server.close();
  stopModelMarketHistory();
  void chat.shutdown().finally(() => { relay?.close(); process.exit(0); });
});
