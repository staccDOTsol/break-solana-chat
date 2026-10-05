import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getAddressEncoder, getProgramDerivedAddress, address } from "@solana/kit";
import { verifyGenesisProgram } from "../scripts/program-verification.ts";

const loader = address("BPFLoaderUpgradeab1e11111111111111111111111");
const program = address("BkWuzU3fn4NS7LXdBxH1j4gRyRw3ma35aNGytbANzUvB");
const authority = address("D88qwUFs75jLzVD9noGp8nyPEw4yqqvco3oMrRote2wa");
const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
const account = (data: Uint8Array, executable: boolean) => ({
  data: [Buffer.from(data).toString("base64"), "base64"] as [string, string],
  executable,
  owner: loader,
});

test("genesis preload matches canonical ProgramData, authority, slot and exact ELF", async () => {
  const [programData] = await getProgramDerivedAddress({
    programAddress: loader, seeds: [getAddressEncoder().encode(program)],
  });
  const programBytes = Buffer.alloc(36);
  programBytes.writeUInt32LE(2);
  programBytes.set(getAddressEncoder().encode(programData), 4);
  const dataBytes = Buffer.alloc(45 + binary.length);
  dataBytes.writeUInt32LE(3);
  dataBytes[12] = 1;
  dataBytes.set(getAddressEncoder().encode(authority), 13);
  dataBytes.set(binary, 45);
  const verified = await verifyGenesisProgram(program, account(programBytes, true),
    account(dataBytes, false), binary, authority);
  assert.equal(verified.programData, programData);
  assert.equal(verified.deploymentSlot, 0n);
  assert.equal(verified.verifiedByteForByte, true);
  for (const [changedProgram, changedData, expectedAuthority] of [
    [account(programBytes, false), account(dataBytes, false), authority],
    [account(Buffer.from(programBytes).fill(0, 4, 36), true), account(dataBytes, false), authority],
    [account(programBytes, true), account(Buffer.from(dataBytes).fill(1, 4, 5), false), authority],
    [account(programBytes, true), account(Buffer.from(dataBytes).fill(0, 12, 13), false), authority],
    [account(programBytes, true), account(dataBytes, false), program],
    [account(programBytes, true), account(Buffer.from(dataBytes).fill(0, 45, 46), false), authority],
  ] as const) {
    await assert.rejects(verifyGenesisProgram(program, changedProgram, changedData,
      binary, expectedAuthority));
  }
});
