import { strict as assert } from "node:assert";
import { test } from "node:test";
import { auditEntries, canReuseSealedAudit, type SealedAudit } from "../scripts/sealed-audit.ts";

const hash = "a".repeat(64);
const entry = { name: "weight-0", address: "weight", file: "tensor.bin", slot: 200,
  payloadBytes: 4, expectedSha256: hash, actualSha256: hash, byteForByteMatch: true, headerMatches: true };
const audit: SealedAudit = { complete: true, running: false, cluster: "testnet", genesis: "testnet",
  program: "program", revision: "revision", programSha256: hash, programDeploymentSlot: 100,
  sealedAccountsAtDiscovery: 1, accounts: [entry] };
const identity = { genesis: "testnet", program: "program", revision: "revision",
  programSha256: hash, programDeploymentSlot: 100n };
const image = Buffer.alloc(132);
image.write("SEABLOB2");
const header = Buffer.from(image.subarray(0, 128));
header[8] = 1;
const current = { name: "weight-0", address: "weight", payloadSha256: hash, image,
  program: "program", owner: "program", space: 132n, header, finalizedSlot: 300n, programDeploymentSlot: 100n };

test("a finalized byte audit can be reused after checking the current immutable seal", () => {
  const entries = auditEntries(audit, identity);
  assert.equal(canReuseSealedAudit(entries.get("weight")!, current), true);
});
test("incomplete audits, changed model or program, and duplicate evidence cannot be reused", () => {
  for (const changed of [{ complete: false }, { running: true }, { revision: "other" },
    { programSha256: "b".repeat(64) }, { programDeploymentSlot: 101 },
    { sealedAccountsAtDiscovery: 2, accounts: [entry, entry] },
    { accounts: [{ ...entry, actualSha256: "b".repeat(64) }] }])
    assert.throws(() => auditEntries({ ...audit, ...changed }, identity));
});
test("a removed seal, changed owner, metadata or payload, and stale reads force full verification", () => {
  const unsealed = Buffer.from(header); unsealed[8] = 0;
  const changedMetadata = Buffer.from(header); changedMetadata[48] = 1;
  for (const changed of [{ header: unsealed }, { owner: "other" }, { header: changedMetadata },
    { payloadSha256: "b".repeat(64) }, { address: "other" }, { space: 133n },
    { finalizedSlot: 199n }, { programDeploymentSlot: 201n }])
    assert.equal(canReuseSealedAudit(entry, { ...current, ...changed }), false);
});
