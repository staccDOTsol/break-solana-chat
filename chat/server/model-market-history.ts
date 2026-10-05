import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { MODEL_MINT_ADDRESS } from "../src/market/config.ts";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MARKET_RPC = process.env.MODEL_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const HISTORY_PATH = process.env.MODEL_MARKET_HISTORY_PATH || (process.env.NODE_ENV === "production"
  ? "/data/model-market-history.json"
  : resolve(import.meta.dirname, "../../inference/model-market-history.json"));
const MINT = new PublicKey(MODEL_MINT_ADDRESS);
const MAX_POINTS = 10_080; // Seven days of one-minute observations.
const INTERVAL_MS = 60_000;

export type MarketPoint = {
  at: number;
  price: number;
  reserveSol: number;
  venue: "Bonding curve" | "PumpSwap";
};
type History = { genesis: string; mint: string; points: MarketPoint[] };
const empty = (): History => ({ genesis: MAINNET_GENESIS, mint: MODEL_MINT_ADDRESS, points: [] });
let history = empty();
let busy = false;
let timer: NodeJS.Timeout | undefined;
let verifiedUntil = 0;

function validHistory(value: unknown): value is History {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<History>;
  return input.genesis === MAINNET_GENESIS && input.mint === MODEL_MINT_ADDRESS &&
    Array.isArray(input.points) && input.points.length <= MAX_POINTS &&
    input.points.every(point => Number.isFinite(point.at) && Number.isFinite(point.price) &&
      Number.isFinite(point.reserveSol) && point.price > 0 &&
      (point.venue === "Bonding curve" || point.venue === "PumpSwap"));
}

export async function readModelMarketHistory(): Promise<History> {
  try {
    const parsed: unknown = JSON.parse(await readFile(HISTORY_PATH, "utf8"));
    if (validHistory(parsed)) history = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Model market history read failed:", String(error));
    }
  }
  return history;
}

async function observe(connection: Connection): Promise<MarketPoint | undefined> {
  if (Date.now() >= verifiedUntil) {
    if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error("Market observer RPC is not Solana mainnet");
    verifiedUntil = Date.now() + 60_000;
  }
  const mintInfo = await connection.getAccountInfo(MINT, "confirmed");
  if (!mintInfo) return;
  if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("Model mint is not Token-2022");
  const decimals = unpackMint(MINT, mintInfo, TOKEN_2022_PROGRAM_ID).decimals;
  const curveKey = bondingCurvePda(MINT);
  const curveInfo = await connection.getAccountInfo(curveKey, "confirmed");
  if (!curveInfo || !curveInfo.owner.equals(PUMP_PROGRAM_ID)) return;
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  if (!curve.quoteMint.equals(SystemProgram.programId) && !curve.quoteMint.equals(NATIVE_MINT)) return;

  let base = curve.virtualTokenReserves;
  let quote = curve.virtualQuoteReserves;
  let reserve = curve.realQuoteReserves;
  let venue: MarketPoint["venue"] = "Bonding curve";
  if (curve.complete) {
    const poolKey = canonicalPumpPoolPda(MINT, curve.quoteMint);
    const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
    if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) return;
    const swap = await new OnlinePumpAmmSdk(connection).swapSolanaState(poolKey, PublicKey.default);
    if (!swap.pool.baseMint.equals(MINT) || !swap.pool.quoteMint.equals(NATIVE_MINT) ||
        !swap.baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return;
    base = swap.poolBaseAmount;
    quote = swap.poolQuoteAmount.add(swap.pool.virtualQuoteReserves);
    reserve = swap.poolQuoteAmount;
    venue = "PumpSwap";
  }
  const price = Number(quote.toString()) / 1e9 / (Number(base.toString()) / 10 ** decimals) * 1_000_000;
  if (!Number.isFinite(price) || price <= 0) return;
  return { at: Date.now(), price, reserveSol: Number(reserve.toString()) / 1e9, venue };
}

export async function sampleModelMarket(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const endpoint = new URL(MARKET_RPC);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("Market observer RPC must be HTTPS");
    const point = await observe(new Connection(endpoint.href, "confirmed"));
    if (!point) return;
    history.points.push(point);
    history.points = history.points.slice(-MAX_POINTS);
    await mkdir(dirname(HISTORY_PATH), { recursive: true });
    const temporary = `${HISTORY_PATH}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(history));
    await rename(temporary, HISTORY_PATH);
  } catch (error) {
    console.error("Model market observation failed:", String(error));
  } finally {
    busy = false;
  }
}

export async function startModelMarketHistory(): Promise<void> {
  await readModelMarketHistory();
  void sampleModelMarket();
  timer = setInterval(() => void sampleModelMarket(), INTERVAL_MS);
}

export function stopModelMarketHistory(): void {
  if (timer) clearInterval(timer);
}
