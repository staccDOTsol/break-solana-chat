import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deploymentPaths } from "../scripts/deployment-paths.ts";
import { TESTNET_GENESIS } from "../src/chain/network.ts";

test("custom genesis keeps deployment state and receipt separate from testnet", () => {
  const root = "/tmp/sea-inference";
  const testnet = deploymentPaths(root, TESTNET_GENESIS);
  const customGenesis = `5${TESTNET_GENESIS.slice(1)}`;
  const custom = deploymentPaths(root, customGenesis);
  assert.equal(testnet.outputDir, `${root}/deployment`);
  assert.equal(custom.outputDir, `${root}/deployments/${customGenesis}`);
  assert.equal(custom.receiptPath, `${root}/reports/${customGenesis}/deployment-complete.json`);
  assert.notEqual(custom.programProofPath, testnet.programProofPath);
  assert.throws(() => deploymentPaths(root, "../other-chain"), /base58 Solana hash/);
});
