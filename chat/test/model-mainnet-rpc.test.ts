import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { POST } from "../server/model-mainnet-rpc.ts";

function request(method: string, params: unknown[] = [], origin = "https://chat.staccpad.fun"): Request {
  return new Request("https://chat.staccpad.fun/api/model-mainnet-rpc", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

test("public RPC proxy rejects arbitrary Solana RPC methods", async () => {
  assert.equal((await POST(request("getProgramAccounts", []))).status, 403);
});

test("market activity is scoped to the fixed model market", async () => {
  assert.equal((await POST(request("getSignaturesForAddress", [PublicKey.default.toBase58(), { limit: 6 }]))).status, 403);
});

test("wallet-signed unrelated transfer cannot use the model trade sender", async () => {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  assert.equal((await POST(request("sendTransaction", [Buffer.from(transaction.serialize()).toString("base64")]))).status, 403);
});

test("model trade sender requires the site origin", async () => {
  assert.equal((await POST(request("sendTransaction", ["AAAA"], "https://elsewhere.example"))).status, 403);
});
