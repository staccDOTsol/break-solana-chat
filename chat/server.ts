import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { address } from "@solana/kit";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { Transport } from "./src/chain/transport.ts";
const artifacts = resolve(
  import.meta.dirname,
  "../inference/artifacts/qwen3-8b-q4g128",
);
const deploymentPath = resolve(
  import.meta.dirname,
  "../inference/deployment/public.json",
);
const rpc = process.env.SOLANA_TESTNET_RPC ?? "https://api.testnet.solana.com";
env.allowRemoteModels = false;
let tokenizer: ReturnType<typeof AutoTokenizer.from_pretrained> | undefined;
const getTokenizer = () =>
  (tokenizer ??= AutoTokenizer.from_pretrained(artifacts, {
    local_files_only: true,
  }));
let verified: { at: number; deployment: unknown } | undefined;
async function body(req: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16000) throw new Error("Request too large");
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
  const transport = new Transport(rpc);
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
createServer(async (req, res) => {
  const respond = (code: number, value: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
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
      let deployment, error;
      try {
        deployment = await deployed();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      respond(200, {
        ready: !!deployment,
        stage: deployment
          ? "MODEL READY / TESTNET"
          : "WEIGHTS EXPORTED / NOT DEPLOYED",
        model: manifest.model,
        bytes: manifest.totalBytes,
        accounts: manifest.files.length,
        revision: manifest.revision,
        cluster: "testnet",
        rpc,
        message: deployment
          ? "Verified model registry on testnet. Create a signer-bound session to begin."
          : (error ??
            `${(manifest.totalBytes / 2 ** 30).toFixed(3)} GiB exported. Local reference and SBF checks pass. Full weight deployment is pending; public RPC rate limits interrupted the program upload.`),
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
    if (path === "/api/validation") {
      respond(
        200,
        JSON.parse(
          await readFile(
            resolve(
              import.meta.dirname,
              "../inference/reports/validation.json",
            ),
            "utf8",
          ),
        ),
      );
      return;
    }
    respond(404, { error: "Not found" });
  } catch (error) {
    respond(400, {
      error: error instanceof Error ? error.message : "Request failed",
    });
  }
}).listen(8787, "127.0.0.1", () =>
  console.log("Receipt/tokenizer service: http://127.0.0.1:8787"),
);
