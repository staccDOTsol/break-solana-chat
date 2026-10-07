import { useEffect, useState } from "react";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { Connection, PublicKey, SystemProgram, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { MODEL_MINT_ADDRESS } from "./config";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MINT = new PublicKey(MODEL_MINT_ADDRESS);

type MarketView = {
  phase: "checking" | "prelaunch" | "pending" | "live" | "error";
  message: string;
  venue?: "Bonding curve" | "PumpSwap";
  spotPerMillion?: number;
  solReserve?: number;
  marketAddress?: PublicKey;
  observedAt?: number;
};
type Tick = { at: number; price: number };

function displaySol(value: number, precision = 6): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: precision });
}

function shortAddress(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-5)}`;
}

async function readMarket(connection: Connection): Promise<MarketView> {
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) {
    throw new Error("The market feed is not connected to Solana mainnet.");
  }
  const mintInfo = await connection.getAccountInfo(MINT, "confirmed");
  if (!mintInfo) return { phase: "prelaunch", message: "The model mint has not launched on Solana mainnet." };
  if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("The model address is not a Token-2022 mint on mainnet.");
  }
  const decimals = unpackMint(MINT, mintInfo, TOKEN_2022_PROGRAM_ID).decimals;
  const curveAddress = bondingCurvePda(MINT);
  const curveInfo = await connection.getAccountInfo(curveAddress, "confirmed");
  if (!curveInfo || !curveInfo.owner.equals(PUMP_PROGRAM_ID)) {
    return { phase: "pending", message: "The mint exists, but its Pump market is not available yet." };
  }

  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  if (!curve.quoteMint.equals(SystemProgram.programId) && !curve.quoteMint.equals(NATIVE_MINT)) {
    return { phase: "pending", message: "This Pump market is not quoted in SOL." };
  }

  let baseReserve = curve.virtualTokenReserves;
  let quoteReserve = curve.virtualQuoteReserves;
  let solReserve = curve.realQuoteReserves;
  let marketAddress = curveAddress;
  let venue: MarketView["venue"] = "Bonding curve";

  if (curve.complete) {
    const poolAddress = canonicalPumpPoolPda(MINT, curve.quoteMint);
    const poolInfo = await connection.getAccountInfo(poolAddress, "confirmed");
    if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) {
      return { phase: "pending", message: "The token graduated; its canonical PumpSwap pool is not available yet." };
    }
    const swap = await new OnlinePumpAmmSdk(connection).swapSolanaState(poolAddress, PublicKey.default);
    if (!swap.pool.baseMint.equals(MINT) || !swap.pool.quoteMint.equals(NATIVE_MINT) ||
        !swap.baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error("The PumpSwap market does not match this model token.");
    }
    baseReserve = swap.poolBaseAmount;
    quoteReserve = swap.poolQuoteAmount.add(swap.pool.virtualQuoteReserves);
    solReserve = swap.poolQuoteAmount;
    marketAddress = poolAddress;
    venue = "PumpSwap";
  }

  const baseTokens = Number(baseReserve.toString()) / 10 ** decimals;
  const quoteSol = Number(quoteReserve.toString()) / 1e9;
  const spotPerMillion = (quoteSol / baseTokens) * 1_000_000;
  if (!Number.isFinite(spotPerMillion) || spotPerMillion <= 0) {
    throw new Error("The market reserves are not ready for a price estimate.");
  }
  return {
    phase: "live",
    message: "Observed directly from Solana mainnet accounts.",
    venue,
    spotPerMillion,
    solReserve: Number(solReserve.toString()) / 1e9,
    marketAddress,
    observedAt: Date.now(),
  };
}

function PriceChart({ ticks }: { ticks: Tick[] }) {
  const prices = ticks.map((tick) => tick.price);
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const range = maximum - minimum;
  const start = ticks[0].at;
  const duration = Math.max(1, ticks[ticks.length - 1].at - start);
  const points = ticks.map((tick, index) => {
    const x = ticks.length === 1 ? 350 : 20 + ((tick.at - start) / duration) * 660;
    const y = range === 0 ? 130 : 235 - ((tick.price - minimum) / range) * 210;
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="rounded-lg border border-[#353a44] bg-[#17191f] p-3">
      <svg viewBox="0 0 700 260" preserveAspectRatio="none" className="h-52 w-full" role="img" aria-label="Observed indicative SOL price over the last 24 hours">
        {[25, 77, 130, 182, 235].map((y) => <line key={y} x1="0" x2="700" y1={y} y2={y} stroke="#30343d" strokeWidth="1" />)}
        {[0, 175, 350, 525, 700].map((x) => <line key={x} y1="0" y2="260" x1={x} x2={x} stroke="#242831" strokeWidth="1" />)}
        {ticks.length > 1 && <polyline points={points} fill="none" stroke="#c7ef71" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
        {ticks.length === 1 && <circle cx="350" cy="130" r="5" fill="#c7ef71" />}
      </svg>
      <div className="flex justify-between gap-3 text-[11px] text-gray-400">
        <span>{new Date(ticks[0].at).toLocaleTimeString()}</span>
        <span>{ticks.length === 1 ? "Collecting live observations" : `${ticks.length} observed mainnet prices`}</span>
        <span>{new Date(ticks[ticks.length - 1].at).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

export function ModelMarket() {
  const [view, setView] = useState<MarketView>({ phase: "checking", message: "Checking the model market on Solana mainnet…" });
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [activity, setActivity] = useState<ConfirmedSignatureInfo[]>([]);
  const [activityError, setActivityError] = useState(false);

  useEffect(() => {
    let active = true;
    const connection = new Connection(`${window.location.origin}/api/model-mainnet-rpc`, "confirmed");
    const refresh = async () => {
      try {
        const next = await readMarket(connection);
        if (!active) return;
        setView(next);
        if (next.phase !== "live" || !next.marketAddress || next.spotPerMillion === undefined) {
          setTicks([]);
          setActivity([]);
          return;
        }
        const point = { at: next.observedAt ?? Date.now(), price: next.spotPerMillion };
        try {
          const response = await fetch("/api/model-market-history", { cache: "no-store" });
          if (!response.ok) throw new Error("Market history unavailable");
          const saved = await response.json() as { genesis?: string; mint?: string; points?: Tick[] };
          if (saved.genesis !== MAINNET_GENESIS || saved.mint !== MODEL_MINT_ADDRESS || !Array.isArray(saved.points)) {
            throw new Error("Market history does not match the model mint");
          }
          const earliest = Date.now() - 24 * 60 * 60_000;
          const observed = saved.points.filter((value) => Number.isFinite(value.at) &&
            Number.isFinite(value.price) && value.price > 0 && value.at >= earliest)
            .slice(-1440);
          setTicks([...observed, point]);
        } catch {
          setTicks((previous) => [...previous, point].slice(-1440));
        }
        try {
          const signatures = await connection.getSignaturesForAddress(next.marketAddress, { limit: 6 }, "confirmed");
          if (active) { setActivity(signatures); setActivityError(false); }
        } catch {
          if (active) { setActivity([]); setActivityError(true); }
        }
      } catch (failure) {
        if (active) {
          setView({ phase: "error", message: failure instanceof Error ? failure.message : "Mainnet market data is unavailable." });
          setTicks([]);
          setActivity([]);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  return (
    <section className="overflow-hidden rounded-xl border border-[#3d4050] bg-[#202229]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#3d4050] px-5 py-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-lime-300">Mainnet market</p>
          <h2 className="mt-1 text-xl font-semibold">Price &amp; activity</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs ${view.phase === "live" ? "border-lime-300 text-lime-300" : "border-amber-400/50 text-amber-300"}`}>
          {view.phase === "live" ? view.venue : view.phase === "prelaunch" ? "Prelaunch" : "Waiting for market"}
        </span>
      </div>
      {view.phase === "live" && view.spotPerMillion !== undefined ? (
        <div className="space-y-5 p-5">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-[#353a44] bg-[#17191f] p-3">
              <p className="text-xs text-gray-400">Indicative SOL / 1M tokens</p>
              <p className="mt-1 text-lg font-semibold text-lime-300">{displaySol(view.spotPerMillion, 9)}</p>
            </div>
            <div className="rounded-lg border border-[#353a44] bg-[#17191f] p-3">
              <p className="text-xs text-gray-400">Observed SOL reserve</p>
              <p className="mt-1 text-lg font-semibold">{displaySol(view.solReserve ?? 0, 4)} SOL</p>
            </div>
          </div>
          <div>
            <PriceChart ticks={ticks.length ? ticks : [{ at: Date.now(), price: view.spotPerMillion }]} />
            <p className="mt-2 text-xs text-gray-400">Observed SOL reserve ratio per million tokens over the last 24 hours, before fees and price impact. This service saves one mainnet observation per minute after launch; no candles are backfilled or invented. The trade quote is calculated separately.</p>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Recent market transactions</h3>
            <p className="mt-1 text-xs text-gray-400">Confirmed signatures touching the {view.venue === "PumpSwap" ? "canonical pool" : "bonding curve"}; direction and amount are not inferred.</p>
            <div className="mt-3 divide-y divide-[#353a44] rounded-lg border border-[#353a44] bg-[#17191f]">
              {activity.map((item) => (
                <a key={item.signature} href={`https://explorer.solana.com/tx/${item.signature}?cluster=mainnet-beta`} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-[#252831]">
                  <span className="font-mono text-lime-300">{shortAddress(item.signature)}</span>
                  <span className="text-xs text-gray-400">{item.blockTime ? new Date(item.blockTime * 1000).toLocaleString() : `Slot ${item.slot}`}</span>
                </a>
              ))}
              {!activity.length && <p className="px-3 py-4 text-sm text-gray-400">{activityError ? "Recent transactions are temporarily unavailable." : "No recent confirmed market transactions."}</p>}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-5">
          <div className="relative flex h-52 items-center justify-center overflow-hidden rounded-lg border border-[#353a44] bg-[#17191f]">
            <div className="absolute inset-0 opacity-70" style={{ backgroundImage: "linear-gradient(#30343d 1px, transparent 1px), linear-gradient(90deg, #30343d 1px, transparent 1px)", backgroundSize: "25% 25%" }} />
            <div className="relative rounded-lg border border-[#3d4050] bg-[#202229] px-5 py-4 text-center">
              <p className="font-medium">{view.phase === "prelaunch" ? "No mainnet chart yet" : "Market data is pending"}</p>
              <p className="mt-1 max-w-sm text-sm text-gray-400">{view.message}</p>
            </div>
          </div>
          <div className="mt-5 rounded-lg border border-[#353a44] bg-[#17191f] px-4 py-5">
            <h3 className="text-sm font-semibold">Recent market transactions</h3>
            <p className="mt-2 text-sm text-gray-400">On-chain activity appears here after the model token launches.</p>
          </div>
        </div>
      )}
    </section>
  );
}
