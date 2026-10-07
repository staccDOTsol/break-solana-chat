import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, writeKeyPairSigner } from "@solana/kit";

export async function readSigner(path: string) {
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(path, "utf8"))));
}

export async function savedSigner(path: string) {
  try { return await readSigner(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const signer = await generateKeyPairSigner(true);
  await writeKeyPairSigner(signer, path);
  return signer;
}
