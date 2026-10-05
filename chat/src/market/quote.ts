import BN from "bn.js";

// Keep the displayed curve sell floor in step with Pump SDK sellInstructions.
export function curveSellMinimum(solAmount: BN, slippage: number): BN {
  const tenthsOfPercent = Math.floor(slippage * 10);
  const adjustment = solAmount.clone().mul(new BN(tenthsOfPercent)).div(new BN(1_000));
  return solAmount.clone().sub(adjustment);
}
