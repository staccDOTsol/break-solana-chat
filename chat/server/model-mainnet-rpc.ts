import { PUMP_PROGRAM_ID, bondingCurvePda } from "@pump-fun/pump-sdk";
import { PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MODEL_MINT_ADDRESS } from "../src/market/config";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
// The current Pump SDK buyInstructions/sellInstructions call the legacy buy/sell methods.
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const EXTEND_POOL_DISCRIMINATOR = Buffer.from([234, 102, 194, 203, 150, 72, 62, 229]);
const MODEL_MINT = new PublicKey(MODEL_MINT_ADDRESS);
const MODEL_CURVE = bondingCurvePda(MODEL_MINT);
const MODEL_POOL = canonicalPumpPoolPda(MODEL_MINT);
// This URL is configured on the server, never supplied by a browser request.
const UPSTREAM = process.env.MODEL_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const ALLOWED_METHODS = new Set([
  "getGenesisHash",
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getRecentPrioritizationFees",
  "sendTransaction",
]);
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RPC_TIMEOUT_MS = 12_000;

type RateWindow = { started: number; reads: number; sends: number };
const rateWindows = new Map<string, RateWindow>();
let verifiedUntil = 0;
let verification: Promise<void> | null = null;

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function boundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) throw new Error("Empty body.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("Body exceeds size limit.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function rateAllowed(ip: string, sending: boolean): boolean {
  const now = Date.now();
  let window = rateWindows.get(ip);
  if (!window || now - window.started >= 60_000) {
    window = { started: now, reads: 0, sends: 0 };
    rateWindows.set(ip, window);
  }
  window.reads++;
  if (sending) window.sends++;
  if (rateWindows.size > 2_000) {
    for (const [key, value] of rateWindows) {
      if (now - value.started >= 60_000) rateWindows.delete(key);
    }
  }
  return window.reads <= 120 && window.sends <= 5;
}

async function callUpstream(body: string, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Mainnet RPC returned HTTP ${response.status}.`);
  return boundedBody(response.body, maxBytes);
}

async function verifyMainnet(): Promise<void> {
  if (Date.now() < verifiedUntil) return;
  if (!verification) {
    verification = (async () => {
      const url = new URL(UPSTREAM);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("Model mainnet RPC URL must be HTTPS without embedded credentials.");
      }
      const result = JSON.parse(await callUpstream(
        JSON.stringify({ jsonrpc: "2.0", id: "genesis", method: "getGenesisHash" }),
        8 * 1024
      )) as { result?: unknown };
      if (result.result !== MAINNET_GENESIS) throw new Error("Model trade RPC is not Solana mainnet.");
      verifiedUntil = Date.now() + 60_000;
    })().finally(() => { verification = null; });
  }
  await verification;
}

function validModelTrade(encoded: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 8_192) return false;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length > 4_096) return false;
    const transaction = VersionedTransaction.deserialize(bytes);
    const message = transaction.message;
    if (message.header.numRequiredSignatures !== 1 || transaction.signatures.length !== 1) return false;
    if ("addressTableLookups" in message && message.addressTableLookups.length) return false;
    const payer = message.staticAccountKeys[0];
    if (!payer || !nacl.sign.detached.verify(message.serialize(), transaction.signatures[0], payer.toBytes())) {
      return false;
    }
    const modelAta = getAssociatedTokenAddressSync(MODEL_MINT, payer, true, TOKEN_2022_PROGRAM_ID);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer, true, TOKEN_PROGRAM_ID);
    const key = (index: number) => message.staticAccountKeys[index];
    let tradeInstructions = 0;
    let poolExtension = 0;
    let tradeVenue: "curve" | "pool" | null = null;
    for (const instruction of message.compiledInstructions) {
      const program = key(instruction.programIdIndex);
      if (!program) return false;
      if (program.equals(PUMP_PROGRAM_ID)) {
        tradeInstructions++;
        tradeVenue = "curve";
        const data = Buffer.from(instruction.data);
        const accounts = instruction.accountKeyIndexes.map(key);
        const buy = data.subarray(0, 8).equals(BUY_DISCRIMINATOR);
        const sell = data.subarray(0, 8).equals(SELL_DISCRIMINATOR);
        if ((!buy && !sell) || !accounts[2]?.equals(MODEL_MINT) ||
            !accounts[3]?.equals(MODEL_CURVE) || !accounts[5]?.equals(modelAta) ||
            !accounts[6]?.equals(payer) ||
            !(buy ? accounts[8] : accounts[9])?.equals(TOKEN_2022_PROGRAM_ID)) return false;
      } else if (program.equals(PUMP_AMM_PROGRAM_ID)) {
        const data = Buffer.from(instruction.data);
        const accounts = instruction.accountKeyIndexes.map(key);
        if (data.equals(EXTEND_POOL_DISCRIMINATOR)) {
          poolExtension++;
          if (poolExtension > 1 || tradeInstructions !== 0 ||
              !accounts[0]?.equals(MODEL_POOL) || !accounts[1]?.equals(payer) ||
              !accounts[2]?.equals(SystemProgram.programId) ||
              !accounts[4]?.equals(PUMP_AMM_PROGRAM_ID)) return false;
          continue;
        }
        tradeInstructions++;
        tradeVenue = "pool";
        if ((!data.subarray(0, 8).equals(BUY_DISCRIMINATOR) &&
             !data.subarray(0, 8).equals(SELL_DISCRIMINATOR)) ||
            !accounts[0]?.equals(MODEL_POOL) || !accounts[1]?.equals(payer) ||
            !accounts[3]?.equals(MODEL_MINT) || !accounts[4]?.equals(NATIVE_MINT) ||
            !accounts[5]?.equals(modelAta) || !accounts[6]?.equals(wsolAta) ||
            !accounts[11]?.equals(TOKEN_2022_PROGRAM_ID) || !accounts[12]?.equals(TOKEN_PROGRAM_ID)) {
          return false;
        }
      } else if (program.equals(ASSOCIATED_TOKEN_PROGRAM)) {
        const data = Buffer.from(instruction.data);
        const accounts = instruction.accountKeyIndexes.map(key);
        const mint = accounts[3];
        const expectedAta = mint?.equals(MODEL_MINT) ? modelAta : mint?.equals(NATIVE_MINT) ? wsolAta : null;
        const expectedProgram = mint?.equals(MODEL_MINT) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        if (data.length !== 1 || data[0] !== 1 || !expectedAta ||
            !accounts[0]?.equals(payer) || !accounts[1]?.equals(expectedAta) ||
            !accounts[2]?.equals(payer) || !accounts[5]?.equals(expectedProgram)) return false;
      } else if (program.equals(SystemProgram.programId)) {
        const data = Buffer.from(instruction.data);
        const accounts = instruction.accountKeyIndexes.map(key);
        if (data.length !== 12 || data.readUInt32LE(0) !== 2 ||
            !accounts[0]?.equals(payer) || !accounts[1]?.equals(wsolAta)) return false;
      } else if (program.equals(TOKEN_PROGRAM_ID)) {
        const data = Buffer.from(instruction.data);
        const accounts = instruction.accountKeyIndexes.map(key);
        const sync = data.length === 1 && data[0] === 17 && accounts[0]?.equals(wsolAta);
        const close = data.length === 1 && data[0] === 9 &&
          accounts[0]?.equals(wsolAta) && accounts[1]?.equals(payer) && accounts[2]?.equals(payer);
        if (!sync && !close) return false;
      } else if (!program.equals(ComputeBudgetProgram.programId)) {
        return false;
      }
    }
    return tradeInstructions === 1 && (poolExtension === 0 || tradeVenue === "pool");
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) return error(413, "RPC request is too large.");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return error(415, "Expected a JSON RPC request.");
  }

  let raw: string;
  let rpc: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    raw = await boundedBody(request.body, MAX_REQUEST_BYTES);
    rpc = JSON.parse(raw);
  } catch {
    return error(400, "Invalid or oversized JSON RPC request.");
  }
  if (!rpc || Array.isArray(rpc) || typeof rpc !== "object" || rpc.jsonrpc !== "2.0" ||
      typeof rpc.method !== "string" || !ALLOWED_METHODS.has(rpc.method) ||
      !Array.isArray(rpc.params) || rpc.params.length > 3 ||
      !(typeof rpc.id === "number" || typeof rpc.id === "string")) {
    return error(403, "RPC method or request shape is not allowed.");
  }

  if (rpc.method === "getSignaturesForAddress") {
    const address = rpc.params[0];
    const options = rpc.params[1];
    if ((address !== MODEL_CURVE.toBase58() && address !== MODEL_POOL.toBase58()) ||
        !options || Array.isArray(options) || typeof options !== "object") {
      return error(403, "Only model market activity can be read.");
    }
    const query = options as Record<string, unknown>;
    if (!Number.isInteger(query.limit) || (query.limit as number) < 1 || (query.limit as number) > 8 ||
        (query.commitment !== undefined && query.commitment !== "confirmed") ||
        Object.keys(query).some((key) => key !== "limit" && key !== "commitment")) {
      return error(403, "Model activity query is not allowed.");
    }
  }

  const sending = rpc.method === "sendTransaction";
  // Fly provides this header; browser-provided forwarding headers are untrusted.
  const ip = request.headers.get("fly-client-ip") || "unknown";
  if (!rateAllowed(ip, sending)) return error(429, "Model RPC rate limit exceeded.");
  if (sending) {
    if (request.headers.get("origin") !== new URL(request.url).origin ||
        typeof rpc.params[0] !== "string" || !validModelTrade(rpc.params[0])) {
      return error(403, "Only a wallet-signed Pump trade for the model mint can be submitted.");
    }
  }

  try {
    await verifyMainnet();
    const result = await callUpstream(raw);
    return new Response(result, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (failure) {
    console.error("Model mainnet RPC failed:", failure);
    return error(502, "Verified Solana mainnet RPC is unavailable.");
  }
}

export async function handleModelMainnetRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "RPC request is too large." }));
      return;
    }
    chunks.push(Buffer.from(chunk));
  }
  const host = req.headers.host ?? "127.0.0.1";
  const protocol = host === "chat.staccpad.fun" || host.endsWith(".fly.dev") ? "https" : "http";
  const request = new Request(`${protocol}://${host}/api/model-mainnet-rpc`, {
    method: "POST",
    headers: {
      "content-type": req.headers["content-type"] ?? "",
      "origin": req.headers.origin ?? "",
      "fly-client-ip": typeof req.headers["fly-client-ip"] === "string" ? req.headers["fly-client-ip"] : "unknown",
    },
    body: Buffer.concat(chunks),
  });
  const response = await POST(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}
