import { resolve } from "node:path";
import { checkedGenesis, TESTNET_GENESIS } from "../src/chain/network.ts";

export function deploymentPaths(
  inferenceRoot: string,
  expectedGenesis: string,
  overrides: { outputDir?: string; receiptPath?: string; programProofPath?: string } = {},
) {
  const genesis = checkedGenesis(expectedGenesis);
  const testnet = genesis === TESTNET_GENESIS;
  const outputDir = resolve(
    inferenceRoot,
    overrides.outputDir ?? (testnet ? "deployment" : `deployments/${genesis}`),
  );
  return {
    cluster: testnet ? "testnet" : "custom",
    outputDir,
    receiptPath: resolve(
      inferenceRoot,
      overrides.receiptPath ?? (testnet
        ? "reports/testnet-deployment-complete.json"
        : `reports/${genesis}/deployment-complete.json`),
    ),
    programProofPath: resolve(
      inferenceRoot,
      overrides.programProofPath ?? (testnet
        ? "reports/testnet-program.json"
        : `reports/${genesis}/program.json`),
    ),
  } as const;
}
