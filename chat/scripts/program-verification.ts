import { createHash } from "node:crypto";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";

const UPGRADEABLE_LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");

type Account = {
  data: readonly [string, string];
  executable: boolean;
  owner: string;
};

/** Check the finalized genesis preload against the exact binary we will use. */
export async function verifyGenesisProgram(
  program: string,
  programAccount: Account | null,
  programDataAccount: Account | null,
  localBinary: Uint8Array,
  expectedAuthority: string,
) {
  const programAddress = address(program);
  const authority = address(expectedAuthority);
  if (!programAccount?.executable || programAccount.owner !== UPGRADEABLE_LOADER)
    throw new Error("Genesis program is absent or not owned by the upgradeable loader");
  const programBytes = Buffer.from(programAccount.data[0], "base64");
  if (programBytes.length !== 36 || programBytes.readUInt32LE(0) !== 2)
    throw new Error("Genesis program has an invalid upgradeable Program header");
  const programData = getAddressDecoder().decode(programBytes.subarray(4));
  const [derivedProgramData] = await getProgramDerivedAddress({
    programAddress: UPGRADEABLE_LOADER,
    seeds: [getAddressEncoder().encode(programAddress)],
  });
  if (programData !== derivedProgramData)
    throw new Error("Genesis program points to a noncanonical ProgramData address");
  if (!programDataAccount || programDataAccount.executable || programDataAccount.owner !== UPGRADEABLE_LOADER)
    throw new Error("Genesis ProgramData is absent or has the wrong owner");
  const bytes = Buffer.from(programDataAccount.data[0], "base64");
  if (bytes.length !== 45 + localBinary.length || bytes.readUInt32LE(0) !== 3)
    throw new Error("Genesis ProgramData size or header differs from the local binary");
  const slot = bytes.readBigUInt64LE(4);
  if (slot !== 0n)
    throw new Error(`Expected a genesis-preloaded program at slot 0, found slot ${slot}`);
  if (bytes[12] !== 1 || getAddressDecoder().decode(bytes.subarray(13, 45)) !== authority)
    throw new Error("Genesis ProgramData upgrade authority differs from the configured authority");
  if (!bytes.subarray(45).equals(Buffer.from(localBinary)))
    throw new Error("Genesis ProgramData ELF differs byte-for-byte from the local binary");
  return {
    program: programAddress,
    programData,
    authority,
    deploymentSlot: slot,
    programBytes: localBinary.length,
    sha256: createHash("sha256").update(localBinary).digest("hex"),
    verifiedByteForByte: true,
  };
}
