/** Reuse only finalized, full-payload comparisons of immutable sealed blobs. */
export type AuditEntry = {
  name: string;
  address: string;
  file: string;
  slot: number;
  payloadBytes: number;
  expectedSha256: string;
  actualSha256: string;
  byteForByteMatch: boolean;
  headerMatches: boolean;
};
export type SealedAudit = {
  complete: boolean;
  running: boolean;
  cluster: string;
  genesis: string;
  program: string;
  revision: string;
  programSha256: string;
  programDeploymentSlot: number;
  sealedAccountsAtDiscovery: number;
  accounts: AuditEntry[];
};

export function auditEntries(audit: SealedAudit, expected: {
  cluster?: string; genesis: string; program: string; revision: string; programSha256: string;
  programDeploymentSlot: bigint;
}) {
  if (audit.complete !== true || audit.running !== false || audit.cluster !== (expected.cluster ?? "testnet") ||
      audit.genesis !== expected.genesis || audit.program !== expected.program ||
      audit.revision !== expected.revision || audit.programSha256 !== expected.programSha256 ||
      !Number.isSafeInteger(audit.programDeploymentSlot) ||
      BigInt(audit.programDeploymentSlot) !== expected.programDeploymentSlot ||
      !Array.isArray(audit.accounts) || audit.accounts.length !== audit.sealedAccountsAtDiscovery)
    throw new Error("Finalized audit does not match this deployment");
  const entries = new Map<string, AuditEntry>();
  for (const entry of audit.accounts) {
    if (entries.has(entry.address) || !Number.isSafeInteger(entry.slot) || entry.slot < 0 ||
        !Number.isSafeInteger(entry.payloadBytes) || entry.payloadBytes < 0 ||
        entry.byteForByteMatch !== true || entry.headerMatches !== true ||
        !/^[a-f0-9]{64}$/.test(entry.expectedSha256) || entry.actualSha256 !== entry.expectedSha256)
      throw new Error("Invalid finalized audit entry");
    entries.set(entry.address, entry);
  }
  return entries;
}

export function canReuseSealedAudit(entry: AuditEntry, current: {
  name: string; address: string; payloadSha256: string; image: Uint8Array;
  program: string; owner: string; space: bigint; header: Uint8Array;
  finalizedSlot: bigint; programDeploymentSlot: bigint;
}) {
  const header = Buffer.from(current.header);
  return entry.name === current.name && entry.address === current.address &&
    entry.byteForByteMatch === true && entry.headerMatches === true &&
    entry.expectedSha256 === current.payloadSha256 && entry.actualSha256 === current.payloadSha256 &&
    entry.payloadBytes === current.image.length - 128 &&
    current.owner === current.program && current.space === BigInt(current.image.length) &&
    current.programDeploymentSlot <= BigInt(entry.slot) && BigInt(entry.slot) <= current.finalizedSlot &&
    header.length === 128 && header.subarray(0, 8).toString() === "SEABLOB2" &&
    header[8] === 1 && header[9] === current.image[9] &&
    header.subarray(48, 68).equals(Buffer.from(current.image.subarray(48, 68)));
}
