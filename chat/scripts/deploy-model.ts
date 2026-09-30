/** Resumable testnet-only uploader. Default: a read-only cost/transaction plan. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  AccountRole,
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  writeKeyPairSigner,
  type KeyPairSigner,
  type Instruction,
} from "@solana/kit";
import {
  getCreateAccountInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import { TpuRelay } from "./tpu-relay.ts";
import { uploadPipeline } from "./upload-pipeline.ts";
import {
  Transport,
  TESTNET_GENESIS,
  type Work,
} from "../src/chain/transport.ts";

const option = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const execute = process.argv.includes("--execute");
const root = resolve(import.meta.dirname, "../../inference");
const artifacts = resolve(root, "artifacts/qwen3-8b-q4g128");
const output = resolve(root, "deployment");
const manifest = JSON.parse(
  await readFile(resolve(artifacts, "manifest.json"), "utf8"),
);
type FileSpec = {
  name: string;
  size: number;
  tensor: number;
  rowStart: number;
  rows: number;
  cols: number;
  encoding: number;
  payloadSha256: string;
};
const files: FileSpec[] = manifest.files;
// Two signatures and the current v1 account/config layout use 329 bytes.
// 3,760-byte writes serialize to 4,089 bytes, below the 4,096-byte ceiling.
const CHUNK = 3760;
const transport = new Transport(
  option("--rpc", "https://api.testnet.solana.com"),
);
await transport.checkNetwork();
const rent = new Map<number, bigint>();
for (const size of new Set<number>([
  ...files.map((f) => f.size),
  manifest.registryBytes,
])) {
  rent.set(
    size,
    await transport.rpc.getMinimumBalanceForRentExemption(BigInt(size)).send(),
  );
}
const totalRent = files.reduce(
  (sum, f) => sum + rent.get(f.size)!,
  rent.get(manifest.registryBytes)!,
);
const uploadTransactions =
  files.reduce((sum, f) => sum + Math.ceil((f.size - 128) / CHUNK) + 2, 0) +
  Math.ceil((manifest.registryBytes - 128) / CHUNK) +
  2;
const plan = {
  model: manifest.model,
  revision: manifest.revision,
  cluster: "testnet",
  genesis: TESTNET_GENESIS,
  bytes: manifest.totalBytes,
  GiB: manifest.totalBytes / 2 ** 30,
  accounts: files.length + 1,
  rentSOL: Number(totalRent) / 1e9,
  uploadTransactions,
  chunkBytes: CHUNK,
};
console.log(JSON.stringify(plan, null, 2));
if (!execute) process.exit(0);
const relay = process.argv.includes("--tpu")
  ? new TpuRelay(option("--rpc", "https://api.testnet.solana.com")!)
  : undefined;
if (relay) {
  await relay.ready;
  transport.submitter = (wire) => relay.send([wire]);
}
const onlyTensor = option("--only-tensor");
const selected = files
  .map((_, i) => i)
  .filter(
    (i) => onlyTensor === undefined || files[i].tensor === Number(onlyTensor),
  );
if (!selected.length) throw new Error("No matching tensor");
const batchSize = relay ? Number(option("--batch", "32")) : 1;
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128)
  throw new Error("--batch must be 1..128");
const pipeline = relay ? Number(option("--pipeline", "1")) : 1;
if (!Number.isInteger(pipeline) || pipeline < 1 || pipeline > 4)
  throw new Error("--pipeline must be 1..4");
const program = address(
  option("--program") ??
    (() => {
      throw new Error("--program is required with --execute");
    })(),
);
const payerPath = resolve(option("--payer", resolve(homedir(), "test.json"))!);
const uploader = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(await readFile(payerPath, "utf8"))),
);
const lanes = Number(option("--lanes", "2"));
if (!Number.isInteger(lanes) || lanes < 1 || lanes > 16)
  throw new Error("--lanes must be 1..16");
if (lanes * batchSize * pipeline > 2048)
  throw new Error(
    "Keep at most 2048 writes in flight; reduce --lanes, --batch or --pipeline",
  );
await mkdir(output, { recursive: true, mode: 0o700 });
const lockPath = resolve(output, "identity.json");
const identity = {
  program,
  revision: manifest.revision,
  uploader: uploader.address,
  genesis: TESTNET_GENESIS,
};
try {
  const old = JSON.parse(await readFile(lockPath, "utf8"));
  if (JSON.stringify(old) !== JSON.stringify(identity))
    throw new Error("Deployment identity does not match existing resume data");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  await writeFile(lockPath, JSON.stringify(identity), {
    mode: 0o600,
    flag: "wx",
  });
}
async function key(name: string) {
  const path = resolve(output, `${name}-keypair.json`);
  try {
    return await createKeyPairSignerFromBytes(
      Uint8Array.from(JSON.parse(await readFile(path, "utf8"))),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const signer = await generateKeyPairSigner(true);
    await writeKeyPairSigner(signer, path);
    return signer;
  }
}
const signers = await Promise.all(files.map((_, i) => key(`weight-${i}`)));
const registry = await key("registry");
const payers = await Promise.all(
  Array.from({ length: lanes }, (_, i) => key(`upload-payer-${i}`)),
);
const balance = (await transport.rpc.getBalance(uploader.address).send()).value;
// Reserve enough for transaction fees and program/session accounts. Existing
// deposits are deducted from the fresh plan below, so a resume need not fund
// the full storage amount a second time.
let remainingRent = rent.get(manifest.registryBytes)!;
const alreadySealed = new Set<number>();
for (let i = 0; i < signers.length; i += 100) {
  const response = await transport.rpc
    .getMultipleAccounts(
      signers.slice(i, i + 100).map((s) => s.address),
      { encoding: "base64", dataSlice: { offset: 0, length: 128 } },
    )
    .send();
  response.value.forEach((account, j) => {
    if (!account) remainingRent += rent.get(files[i + j].size)!;
    else if (account.owner !== program)
      throw new Error("Existing weight account has another owner");
    else if (Buffer.from(account.data[0], "base64")[8] === 1)
      alreadySealed.add(i + j);
  });
}
// Resume unfinished accounts immediately. Previously sealed payloads are
// still read back and checked before the registry can be published.
selected.sort(
  (a, b) => Number(alreadySealed.has(a)) - Number(alreadySealed.has(b)),
);
if (balance < remainingRent + 100_000_000_000n)
  throw new Error(
    "Insufficient test SOL for remaining storage plus 100 SOL fee reserve",
  );
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function send(
  payer: KeyPairSigner,
  instructions: Instruction[],
  units: number,
) {
  const signed = await transport.sign(
    { payer, instruction: instructions[0] },
    instructions,
    units,
  );
  if (Buffer.from(signed.wire, "base64").length > 4096)
    throw new Error("Transaction exceeds the v1 wire limit");
  let firstError: unknown;
  try {
    await transport.submit(signed);
  } catch (error) {
    firstError = error;
  }
  for (let attempt = 0; attempt < 90; attempt++) {
    const status = await transport.status(signed.signature);
    if (status?.err)
      throw new Error(
        `Transaction failed ${signed.signature}: ${JSON.stringify(status.err)}`,
      );
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    )
      return signed.signature;
    const height = await transport.height();
    if (height > signed.lastValidBlockHeight)
      throw new Error(
        `Transaction expired or confirmation is uncertain: ${signed.signature}. Resume after checking its status.`,
      );
    if (attempt % 8 === 7) {
      try {
        await transport.submit(signed);
      } catch (error) {
        firstError = error;
      }
    }
    await delay(1200);
  }
  throw new Error(
    `Confirmation uncertain for ${signed.signature}; stopped without re-signing. ${String(firstError ?? "")}`,
  );
}
const payerTarget =
  onlyTensor === undefined
    ? BigInt(Math.ceil(uploadTransactions / lanes)) * 10_000n + 2_000_000_000n
    : 2_000_000_000n;
for (const payer of payers) {
  const current = (await transport.rpc.getBalance(payer.address).send()).value;
  // The target includes two SOL of reserve. Avoid a new funding transaction
  // for every tiny fee difference when resuming an interrupted upload.
  if (current + 1_000_000_000n < payerTarget)
    await send(
      uploader,
      [
        getTransferSolInstruction({
          source: uploader,
          destination: payer.address,
          amount: payerTarget - current,
        }),
      ],
      20_000,
    );
}
const authority = {
  address: uploader.address,
  role: AccountRole.READONLY_SIGNER,
  signer: uploader,
};
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const startedAt = Date.now();
let confirmedBytes = 0,
  confirmedWrites = 0,
  sealedAccounts = 0;
let previouslyConfirmedBytes = 0;
for (let i = 0; i < files.length; i++) {
  try {
    const saved = JSON.parse(
      await readFile(resolve(output, `weight-${i}-progress.json`), "utf8"),
    );
    if (
      saved.hash !== files[i].payloadSha256 ||
      !Number.isInteger(saved.offset) ||
      saved.offset < 128 ||
      saved.offset > files[i].size
    )
      throw new Error(`Invalid saved progress for weight-${i}`);
    previouslyConfirmedBytes += saved.offset - 128;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
let lastProgressAt = 0;
async function reportProgress(force = false) {
  if (!force && Date.now() - lastProgressAt < 15_000) return;
  lastProgressAt = Date.now();
  const status = {
    updatedAt: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    cluster: "testnet",
    program,
    model: manifest.model,
    lanes,
    batchSize,
    pipeline,
    runConfirmedBytes: confirmedBytes,
    confirmedPayloadBytes: previouslyConfirmedBytes + confirmedBytes,
    totalPayloadBytes: manifest.totalBytes - 128 * (files.length + 1),
    runConfirmedWrites: confirmedWrites,
    runSealedAccounts: sealedAccounts,
    writesPerSecond: Number(
      (confirmedWrites / Math.max(1, (Date.now() - startedAt) / 1000)).toFixed(
        2,
      ),
    ),
    totalBytes: manifest.totalBytes,
    complete: false,
    running: true,
  };
  console.log(JSON.stringify({ progress: status }));
  await writeFile(
    resolve(output, "upload-status.json"),
    JSON.stringify(status) + "\n",
    { mode: 0o600 },
  );
}
let nextBulkReadAt = 0;
async function readWholeAccount(key: KeyPairSigner["address"]) {
  const reserved = Math.max(Date.now(), nextBulkReadAt);
  nextBulkReadAt = reserved + 6000;
  await delay(Math.max(0, reserved - Date.now()));
  return transport.rpc
    .getAccountInfo(key, { encoding: "base64", commitment: "confirmed" })
    .send();
}
async function upload(
  name: string,
  signer: KeyPairSigner,
  image: Uint8Array,
  payer: KeyPairSigner,
) {
  const hash = sha(image.subarray(128));
  const progressPath = resolve(output, `${name}-progress.json`);
  let chain = await transport.rpc
    .getAccountInfo(signer.address, {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 128 },
    })
    .send();
  if (chain.value) {
    const data = Buffer.from(chain.value.data[0], "base64");
    if (
      chain.value.owner !== program ||
      Number(chain.value.space) !== image.length ||
      !data.subarray(48, 68).equals(Buffer.from(image.subarray(48, 68)))
    )
      throw new Error(`Existing ${name} has incompatible metadata`);
    if (data[8] === 1) {
      const whole = await readWholeAccount(signer.address);
      if (
        !whole.value ||
        sha(Buffer.from(whole.value.data[0], "base64").subarray(128)) !== hash
      )
        throw new Error(`${name}: sealed payload hash mismatch`);
      return;
    }
  } else {
    const init = new Uint8Array(22);
    init[0] = 90;
    init[1] = image[9];
    init.set(image.subarray(48, 68), 2);
    await send(
      payer,
      [
        getCreateAccountInstruction({
          payer: uploader,
          newAccount: signer,
          lamports: rent.get(image.length)!,
          space: BigInt(image.length),
          programAddress: program,
        }),
        {
          programAddress: program,
          accounts: [
            {
              address: signer.address,
              role: AccountRole.WRITABLE_SIGNER,
              signer,
            },
            authority,
          ],
          data: init,
        },
      ],
      100_000,
    );
  }
  let offset = 128;
  try {
    const saved = JSON.parse(await readFile(progressPath, "utf8"));
    if (saved.hash !== hash) throw new Error("Resume hash mismatch");
    offset = saved.offset;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!Number.isInteger(offset) || offset < 128 || offset > image.length)
    throw new Error("Invalid resume offset");
  const metas = [
    { address: signer.address, role: AccountRole.WRITABLE },
    authority,
  ];
  async function writeRange(start: number, limit: number) {
    const signed: (Awaited<ReturnType<Transport["sign"]>> & { work: Work })[] =
      [];
    let end = start;
    for (let i = 0; i < batchSize && end < limit; i++) {
      const next = Math.min(end + CHUNK, limit);
      const data = new Uint8Array(5 + next - end);
      data[0] = 91;
      new DataView(data.buffer).setUint32(1, end, true);
      data.set(image.subarray(end, next), 5);
      const work = {
        payer,
        instruction: { programAddress: program, accounts: metas, data },
      };
      const tx = await transport.sign(work, [work.instruction], 20_000);
      if (Buffer.from(tx.wire, "base64").length > 4096)
        throw new Error("Oversized v1 write");
      signed.push({ ...tx, work });
      end = next;
    }
    if (relay) await relay.send(signed.map((tx) => tx.wire));
    else await transport.submit(signed[0]);
    let remaining = signed;
    let expiredRetries = 0;
    for (let attempt = 0; remaining.length && attempt < 100; attempt++) {
      const statuses = await Promise.all(
        remaining.map((tx) => transport.status(tx.signature)),
      );
      remaining = remaining.filter((tx, i) => {
        const status = statuses[i];
        if (status?.err)
          throw new Error(
            `Write ${tx.signature} failed: ${JSON.stringify(status.err)}`,
          );
        return (
          status?.confirmationStatus !== "confirmed" &&
          status?.confirmationStatus !== "finalized"
        );
      });
      if (!remaining.length) break;
      if (attempt % 4 === 3) {
        const height = await transport.height();
        if (remaining.some((tx) => height > tx.lastValidBlockHeight)) {
          if (++expiredRetries > 5)
            throw new Error("Repeated write expiry; confirmed offsets saved");
          // Writes set the same immutable bytes at the same offset. Retrying
          // only this idempotent operation with a fresh blockhash is safe even
          // if an old transaction was confirmed on a fork we did not observe.
          console.log(
            JSON.stringify({
              retryExpiredWrites: remaining.length,
              account: signer.address,
              retry: expiredRetries,
            }),
          );
          remaining = await Promise.all(
            remaining.map(async (tx) =>
              height > tx.lastValidBlockHeight
                ? {
                    ...(await transport.sign(
                      tx.work,
                      [tx.work.instruction],
                      20_000,
                    )),
                    work: tx.work,
                  }
                : tx,
            ),
          );
          attempt = 0;
        }
        if (relay) await relay.send(remaining.map((tx) => tx.wire));
        else await transport.submit(remaining[0]);
      }
      await delay(1000);
    }
    if (remaining.length)
      throw new Error(
        "Batch confirmation timed out; resume from the last confirmed offset",
      );
    return signed.length;
  }
  if (offset < image.length)
    await uploadPipeline(
      offset,
      image.length,
      CHUNK * batchSize,
      pipeline,
      writeRange,
      async (end, writes) => {
        await writeFile(
          progressPath + ".tmp",
          JSON.stringify({ hash, offset: end }),
          { mode: 0o600 },
        );
        await rename(progressPath + ".tmp", progressPath);
        confirmedBytes += end - offset;
        confirmedWrites += writes;
        offset = end;
        await reportProgress();
      },
    );
  chain = await readWholeAccount(signer.address);
  if (
    !chain.value ||
    sha(Buffer.from(chain.value.data[0], "base64").subarray(128)) !== hash
  )
    throw new Error(`Read-back verification failed for ${name}`);
  await send(
    payer,
    [{ programAddress: program, accounts: metas, data: Uint8Array.of(92) }],
    20_000,
  );
  sealedAccounts++;
  console.log(
    JSON.stringify({
      sealed: name,
      address: signer.address,
      bytes: image.length,
      hash,
    }),
  );
}
await reportProgress(true);
let next = 0;
let stopped = false;
const workers = await Promise.allSettled(
  payers.map(async (payer) => {
    try {
      while (!stopped && next < selected.length) {
        const i = selected[next++];
        const f = files[i];
        const image = await readFile(resolve(artifacts, f.name));
        if (sha(image.subarray(128)) !== f.payloadSha256)
          throw new Error("Local payload hash mismatch");
        await upload(`weight-${i}`, signers[i], image, payer);
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  }),
);
const failure = workers.find((r) => r.status === "rejected");
if (failure?.status === "rejected") {
  relay?.close();
  await reportProgress(true);
  const statusPath = resolve(output, "upload-status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  await writeFile(
    statusPath,
    JSON.stringify({
      ...status,
      running: false,
      error: String(failure.reason),
    }) + "\n",
    { mode: 0o600 },
  );
  throw failure.reason;
}
if (onlyTensor !== undefined) {
  console.log(
    "Selected tensor verified and sealed; full registry intentionally unpublished.",
  );
  await reportProgress(true);
  const statusPath = resolve(output, "upload-status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  await writeFile(
    statusPath,
    JSON.stringify({
      ...status,
      running: false,
      selectedTensorComplete: Number(onlyTensor),
    }) + "\n",
    { mode: 0o600 },
  );
  relay?.close();
  process.exit(0);
}
const registryImage = new Uint8Array(manifest.registryBytes);
registryImage.set(new TextEncoder().encode("SEABLOB2"));
registryImage[9] = 1;
new DataView(registryImage.buffer).setUint32(48, files.length, true);
const encoder = getAddressEncoder();
files.forEach((f, i) => {
  const d = new DataView(registryImage.buffer, 128 + i * 64, 64);
  registryImage.set(encoder.encode(signers[i].address), 128 + i * 64);
  [f.tensor, f.rowStart, f.rows, f.cols, f.encoding, f.size].forEach(
    (value, j) => d.setUint32(32 + j * 4, value, true),
  );
});
await upload("registry", registry, registryImage, payers[0]);
await writeFile(
  resolve(output, "public.json"),
  JSON.stringify(
    {
      program,
      registry: registry.address,
      genesis: TESTNET_GENESIS,
      model: manifest.model,
      revision: manifest.revision,
      shards: files.map((f, i) => ({ ...f, address: signers[i].address })),
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
console.log(
  "All model payloads verified and sealed on testnet. Public deployment receipt written.",
);
await reportProgress(true);
const statusPath = resolve(output, "upload-status.json");
const status = JSON.parse(await readFile(statusPath, "utf8"));
await writeFile(
  statusPath,
  JSON.stringify({ ...status, running: false, complete: true }) + "\n",
  { mode: 0o600 },
);

relay?.close();
