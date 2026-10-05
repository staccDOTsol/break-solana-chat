export const TESTNET_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
export const TESTNET_RPC = "https://api.testnet.solana.com";

export function checkedGenesis(value: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    throw new Error("Expected genesis must be a base58 Solana hash");
  return value;
}
