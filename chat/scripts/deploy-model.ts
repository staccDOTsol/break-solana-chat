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
import { Transport, TESTNET_GENESIS } from "../src/chain/transport.ts";

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
const CHUNK = 3500;
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
for (let i = 0; i < signers.length; i += 100) {
  const response = await transport.rpc
    .getMultipleAccounts(
      signers.slice(i, i + 100).map((s) => s.address),
      { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
    )
    .send();
  response.value.forEach((account, j) => {
    if (!account) remainingRent += rent.get(files[i + j].size)!;
    else if (account.owner !== program)
      throw new Error("Existing weight account has another owner");
  });
}
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
    const result = await transport.rpc
      .getSignatureStatuses([signed.signature], {
        searchTransactionHistory: true,
      })
      .send();
    const status = result.value[0];
    if (status?.err)
      throw new Error(
        `Transaction failed ${signed.signature}: ${JSON.stringify(status.err)}`,
      );
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    )
      return signed.signature;
    const height = await transport.rpc
      .getBlockHeight({ commitment: "confirmed" })
      .send();
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
for (const payer of payers) {
  const current = (await transport.rpc.getBalance(payer.address).send()).value;
  if (current < 2_000_000_000n)
    await send(
      uploader,
      [
        getTransferSolInstruction({
          source: uploader,
          destination: payer.address,
          amount: 2_000_000_000n - current,
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
async function upload(
  name: string,
  signer: KeyPairSigner,
  image: Uint8Array,
  payer: KeyPairSigner,
) {
  const hash = sha(image.subarray(128));
  const progressPath = resolve(output, `${name}-progress.json`);
  let chain = await transport.rpc
    .getAccountInfo(signer.address, { encoding: "base64" })
    .send();
  if (chain.value) {
    const data = Buffer.from(chain.value.data[0], "base64");
    if (
      chain.value.owner !== program ||
      data.length !== image.length ||
      !data.subarray(48, 68).equals(Buffer.from(image.subarray(48, 68)))
    )
      throw new Error(`Existing ${name} has incompatible metadata`);
    if (data[8] === 1) {
      if (sha(data.subarray(128)) !== hash)
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
  while (offset < image.length) {
    const end = Math.min(offset + CHUNK, image.length);
    const data = new Uint8Array(5 + end - offset);
    data[0] = 91;
    new DataView(data.buffer).setUint32(1, offset, true);
    data.set(image.subarray(offset, end), 5);
    await send(
      payer,
      [{ programAddress: program, accounts: metas, data }],
      20_000,
    );
    offset = end;
    await writeFile(progressPath + ".tmp", JSON.stringify({ hash, offset }), {
      mode: 0o600,
    });
    await rename(progressPath + ".tmp", progressPath);
  }
  chain = await transport.rpc
    .getAccountInfo(signer.address, { encoding: "base64" })
    .send();
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
  console.log(
    JSON.stringify({
      sealed: name,
      address: signer.address,
      bytes: image.length,
      hash,
    }),
  );
}
let next = 0;
await Promise.all(
  payers.map(async (payer) => {
    while (next < files.length) {
      const i = next++;
      const f = files[i];
      const image = await readFile(resolve(artifacts, f.name));
      if (sha(image.subarray(128)) !== f.payloadSha256)
        throw new Error("Local payload hash mismatch");
      await upload(`weight-${i}`, signers[i], image, payer);
    }
  }),
);
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
