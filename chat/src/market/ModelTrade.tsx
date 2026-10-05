import { useWallet } from "@solana/wallet-adapter-react";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  type BondingCurve,
  type FeeConfig,
  type Global,
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  buyQuoteInput,
  canonicalPumpPoolPda,
  sellBaseInput,
  type SwapSolanaState,
} from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";
import {
  type AccountInfo,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MODEL_MINT_ADDRESS } from "./config";
import { curveSellMinimum } from "./quote";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

type MarketBase = {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
};
type CurveMarket = MarketBase & {
  venue: "curve";
  curveAccountInfo: AccountInfo<Buffer>;
  curve: BondingCurve;
  global: Global;
  feeConfig: FeeConfig;
};
type PoolMarket = MarketBase & {
  venue: "pool";
  swap: SwapSolanaState;
};
type Market = CurveMarket | PoolMarket;

function poolPricing(swap: SwapSolanaState) {
  return {
    baseReserve: swap.poolBaseAmount,
    quoteReserve: swap.poolQuoteAmount,
    virtualQuoteReserves: swap.pool.virtualQuoteReserves,
    globalConfig: swap.globalConfig,
    feeConfig: swap.feeConfig,
    baseMint: swap.baseMint,
    baseMintAccount: swap.baseMintAccount,
    coinCreator: swap.pool.coinCreator,
    creator: swap.pool.creator,
    quoteMint: swap.pool.quoteMint,
    isMayhemMode: swap.pool.isMayhemMode,
    creatorFeeBps: swap.pool.creatorFeeBps,
  };
}

function parseUnits(value: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d*)?$/.test(value)) throw new Error("Enter a positive decimal amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction || "0").padEnd(decimals, "0"));
  if (raw <= 0n) throw new Error("The amount must be greater than zero.");
  if (raw > (1n << 64n) - 1n) throw new Error("The amount is too large.");
  return raw;
}

function formatUnits(raw: bigint, decimals: number, visibleDecimals = decimals): string {
  const scale = 10n ** BigInt(decimals);
  const whole = (raw / scale).toLocaleString();
  const fractional = (raw % scale).toString().padStart(decimals, "0")
    .slice(0, visibleDecimals).replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole;
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readMarket(connection: Connection, user?: PublicKey): Promise<Market> {
  const mint = new PublicKey(MODEL_MINT_ADDRESS);
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) throw new Error("The configured trade RPC is not Solana mainnet.");

  const curveAddress = bondingCurvePda(mint);
  const [mintInfo, curveAccountInfo] = await Promise.all([
    connection.getAccountInfo(mint, "confirmed"),
    connection.getAccountInfo(curveAddress, "confirmed"),
  ]);
  if (!mintInfo) throw new Error("The model token has not launched on mainnet yet.");
  if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("The model address is not the expected Token-2022 mint on Solana mainnet.");
  }
  const mintState = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID);
  if (!curveAccountInfo || !curveAccountInfo.owner.equals(PUMP_PROGRAM_ID)) {
    throw new Error("This mint does not have a live Pump bonding curve on mainnet.");
  }
  const curve = PUMP_SDK.decodeBondingCurve(curveAccountInfo);
  if (!curve.quoteMint.equals(SystemProgram.programId) && !curve.quoteMint.equals(NATIVE_MINT)) {
    throw new Error("This Pump curve is not quoted in SOL.");
  }
  if (curve.complete) {
    const poolKey = canonicalPumpPoolPda(mint, curve.quoteMint);
    const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
    if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) {
      throw new Error("The token graduated, but its canonical PumpSwap pool is not available yet.");
    }
    const swap = await new OnlinePumpAmmSdk(connection).swapSolanaState(poolKey, user ?? PublicKey.default);
    if (!swap.pool.baseMint.equals(mint) || !swap.pool.quoteMint.equals(NATIVE_MINT) ||
        !swap.baseTokenProgram.equals(mintInfo.owner)) {
      throw new Error("The canonical PumpSwap pool does not match this SOL model token.");
    }
    return { venue: "pool", mint, tokenProgram: mintInfo.owner, decimals: mintState.decimals, swap };
  }
  const sdk = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
  return { venue: "curve", mint, tokenProgram: mintInfo.owner, decimals: mintState.decimals, curveAccountInfo, curve, global, feeConfig };
}

async function readBalances(connection: Connection, market: Market, owner: PublicKey): Promise<{ sol: bigint; tokens: bigint }> {
  const ata = getAssociatedTokenAddressSync(market.mint, owner, true, market.tokenProgram);
  const [lamports, tokenInfo] = await Promise.all([
    connection.getBalance(owner, "confirmed"),
    connection.getAccountInfo(ata, "confirmed"),
  ]);
  const tokens = tokenInfo ? unpackAccount(ata, tokenInfo, market.tokenProgram).amount : 0n;
  return { sol: BigInt(lamports), tokens };
}

async function awaitMainnetConfirmation(connection: Connection, signature: string, lastValidBlockHeight: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const [statuses, blockHeight] = await Promise.all([
      connection.getSignatureStatuses([signature]),
      connection.getBlockHeight("confirmed"),
    ]);
    const status = statuses.value[0];
    if (status?.err) throw new Error(`Mainnet transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    if (blockHeight > lastValidBlockHeight) throw new Error("Mainnet blockhash expired before confirmation could be verified.");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Mainnet confirmation was not seen within one minute.");
}

export function ModelTrade() {
  const { publicKey, signTransaction, wallets, select } = useWallet();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [market, setMarket] = useState<Market | null>(null);
  const [status, setStatus] = useState("Checking Solana mainnet…");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageInput, setSlippageInput] = useState("2");
  const [balances, setBalances] = useState<{ sol: bigint; tokens: bigint }>({ sol: 0n, tokens: 0n });
  const [pending, setPending] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setConnection(new Connection(`${window.location.origin}/api/model-mainnet-rpc`, "confirmed"));
  }, []);

  const refresh = useCallback(async () => {
    if (!connection) return;
    setStatus("Checking Solana mainnet…");
    setMarket(null);
    try {
      const next = await readMarket(connection, publicKey ?? undefined);
      setMarket(next);
      setStatus(next.venue === "curve" ? "Pump bonding curve live on Solana mainnet" : "PumpSwap pool live on Solana mainnet");
      setBalances(publicKey ? await readBalances(connection, next, publicKey) : { sol: 0n, tokens: 0n });
    } catch (error) {
      setStatus(asError(error));
    }
  }, [connection, publicKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  const slippage = Number(slippageInput);
  const slippageValid = Number.isFinite(slippage) && slippage >= 0 && slippage <= 50;
  const quote = useMemo(() => {
    if (!market || !amount.trim()) return null;
    try {
      const input = new BN(parseUnits(amount.trim(), side === "buy" ? 9 : market.decimals).toString());
      if (market.venue === "pool") {
        if (side === "buy") {
          const priced = buyQuoteInput({ ...poolPricing(market.swap), quote: input, slippage });
          return { input, output: priced.base, maxInput: priced.maxQuote, minOutput: null, error: "" };
        }
        const priced = sellBaseInput({ ...poolPricing(market.swap), base: input, slippage });
        return { input, output: priced.uiQuote, maxInput: input, minOutput: priced.minQuote, error: "" };
      }
      const output = side === "buy"
        ? getBuyTokenAmountFromSolAmount({
            global: market.global, feeConfig: market.feeConfig, mintSupply: market.curve.tokenTotalSupply,
            bondingCurve: market.curve, amount: input, quoteMint: NATIVE_MINT,
          })
        : getSellSolAmountFromTokenAmount({
            global: market.global, feeConfig: market.feeConfig, mintSupply: market.curve.tokenTotalSupply,
            bondingCurve: market.curve, amount: input,
          });
      const maxInput = side === "buy"
        ? input.muln(10_000 + Math.ceil(slippage * 100)).divn(10_000)
        : input;
      const minOutput = side === "sell" ? curveSellMinimum(output, slippage) : null;
      return { input, output, maxInput, minOutput, error: "" };
    } catch (error) {
      return { input: null, output: null, maxInput: null, minOutput: null, error: asError(error) };
    }
  }, [amount, market, side, slippage]);

  const inputAmount = quote?.input ? BigInt(quote.input.toString()) : 0n;
  const maxInputAmount = quote?.maxInput ? BigInt(quote.maxInput.toString()) : 0n;
  const canSubmit = !!connection && !!market && !!publicKey && !!signTransaction && !!quote?.input && !!quote.output &&
    quote.output.gtn(0) && slippageValid && !pending &&
    (side === "buy" ? maxInputAmount < balances.sol : inputAmount <= balances.tokens);

  const submit = async () => {
    if (!connection || !publicKey || !signTransaction || !canSubmit) return;
    setPending(true);
    setMessage("");
    setSignature(null);
    let submittedSignature: string | null = null;
    try {
      // Read the curve and genesis again immediately before signing; a displayed quote can age.
      const fresh = await readMarket(connection, publicKey);
      const input = new BN(parseUnits(amount.trim(), side === "buy" ? 9 : fresh.decimals).toString());
      let instructions;
      if (fresh.venue === "pool") {
        if (side === "buy") {
          const priced = buyQuoteInput({ ...poolPricing(fresh.swap), quote: input, slippage });
          if (priced.base.lten(0)) throw new Error("This amount is too small to buy a token unit.");
          if (BigInt(priced.maxQuote.toString()) >= BigInt(await connection.getBalance(publicKey, "confirmed"))) {
            throw new Error("Insufficient SOL for the trade and network fee.");
          }
          instructions = await PUMP_AMM_SDK.buyQuoteInput(fresh.swap, input, slippage);
        } else {
          const current = await readBalances(connection, fresh, publicKey);
          if (BigInt(input.toString()) > current.tokens) throw new Error("Insufficient token balance.");
          const priced = sellBaseInput({ ...poolPricing(fresh.swap), base: input, slippage });
          if (priced.uiQuote.lten(0)) throw new Error("This amount is too small to sell.");
          instructions = await PUMP_AMM_SDK.sellBaseInput(fresh.swap, input, slippage);
        }
      } else if (side === "buy") {
        const tokens = getBuyTokenAmountFromSolAmount({
          global: fresh.global, feeConfig: fresh.feeConfig, mintSupply: fresh.curve.tokenTotalSupply,
          bondingCurve: fresh.curve, amount: input, quoteMint: NATIVE_MINT,
        });
        if (tokens.lten(0)) throw new Error("This amount is too small to buy a token unit.");
        const ata = getAssociatedTokenAddressSync(fresh.mint, publicKey, true, fresh.tokenProgram);
        const associatedUserAccountInfo = await connection.getAccountInfo(ata, "confirmed");
        instructions = await PUMP_SDK.buyInstructions({
          global: fresh.global, bondingCurveAccountInfo: fresh.curveAccountInfo,
          bondingCurve: fresh.curve, associatedUserAccountInfo, mint: fresh.mint,
          user: publicKey, amount: tokens, solAmount: input, slippage,
          tokenProgram: fresh.tokenProgram,
        });
      } else {
        const current = await readBalances(connection, fresh, publicKey);
        if (BigInt(input.toString()) > current.tokens) throw new Error("Insufficient token balance.");
        const solAmount = getSellSolAmountFromTokenAmount({
          global: fresh.global, feeConfig: fresh.feeConfig, mintSupply: fresh.curve.tokenTotalSupply,
          bondingCurve: fresh.curve, amount: input,
        });
        if (solAmount.lten(0)) throw new Error("This amount is too small to sell.");
        instructions = await PUMP_SDK.sellInstructions({
          global: fresh.global, bondingCurveAccountInfo: fresh.curveAccountInfo,
          bondingCurve: fresh.curve, mint: fresh.mint, user: publicKey,
          amount: input, solAmount, slippage, tokenProgram: fresh.tokenProgram,
          mayhemMode: fresh.curve.isMayhemMode ?? false,
          cashback: fresh.curve.isCashbackCoin ?? false,
        });
      }
      const latest = await connection.getLatestBlockhash("confirmed");
      const transaction = new VersionedTransaction(new TransactionMessage({
        payerKey: publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions],
      }).compileToV0Message());
      const signed = await signTransaction(transaction);
      submittedSignature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      setSignature(submittedSignature);
      setMessage("Transaction submitted to Solana mainnet. Waiting for confirmation…");
      await awaitMainnetConfirmation(connection, submittedSignature, latest.lastValidBlockHeight);
      setMessage("Trade confirmed on Solana mainnet.");
      setAmount("");
      await refresh();
    } catch (error) {
      setMessage(submittedSignature
        ? `Transaction was submitted, but confirmation could not be verified: ${asError(error)}`
        : asError(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="rounded-xl border border-[#3d4050] bg-[#202229] p-5">
      <p className="text-xs uppercase tracking-[0.2em] text-lime-300">Solana mainnet</p>
      <h2 className="mt-1 text-xl font-semibold">Trade the model token</h2>
      <p className="mt-2 text-xs text-gray-400 break-all">Model mint: {MODEL_MINT_ADDRESS}</p>
      <div className="mt-4 rounded border border-[#3d4050] bg-[#181a1f] px-3 py-2 text-sm">
        <span className={market ? "text-lime-300" : "text-amber-300"}>{status}</span>
      </div>

      {publicKey ? (
        <div className="mt-4 text-xs text-gray-300">
          <p className="break-all">Wallet: {publicKey.toBase58()}</p>
          <p className="mt-1">Mainnet balance: {formatUnits(balances.sol, 9, 4)} SOL · {formatUnits(balances.tokens, market?.decimals ?? 6, 4)} tokens</p>
        </div>
      ) : (
        <div className="mt-4">
          <p className="mb-2 text-xs text-gray-300">Connect the same Solana wallet you use for mainnet trading.</p>
          <select
            defaultValue=""
            onChange={(event) => {
              const choice = wallets.find((wallet) => wallet.adapter.name === event.target.value);
              if (choice) select(choice.adapter.name);
            }}
            className="w-full rounded border border-[#4b4f59] bg-[#181a1f] px-3 py-2 text-sm"
          >
            <option value="" disabled>Select a wallet</option>
            {wallets.map((wallet) => <option key={wallet.adapter.name} value={wallet.adapter.name}>{wallet.adapter.name}</option>)}
          </select>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-2">
        {(["buy", "sell"] as const).map((choice) => (
          <button key={choice} type="button" onClick={() => { setSide(choice); setAmount(""); setMessage(""); }}
            className={`rounded px-4 py-2 text-sm font-semibold ${side === choice ? "bg-lime-300 text-[#15171b]" : "border border-[#4b4f59] text-white"}`}>
            {choice === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <label className="mt-5 block text-sm text-gray-200" htmlFor="model-trade-amount">
        {side === "buy" ? "Spend (SOL)" : "Sell (tokens)"}
      </label>
      <input id="model-trade-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)}
        placeholder={side === "buy" ? "0.1" : "1000"}
        className="mt-2 w-full rounded border border-[#4b4f59] bg-[#181a1f] px-3 py-3 text-white outline-none focus:border-lime-300" />
      <label className="mt-4 block text-sm text-gray-200" htmlFor="model-slippage">Maximum slippage (%)</label>
      <input id="model-slippage" type="number" min="0" max="50" step="0.1" value={slippageInput}
        onChange={(event) => setSlippageInput(event.target.value)}
        className="mt-2 w-full rounded border border-[#4b4f59] bg-[#181a1f] px-3 py-3 text-white outline-none focus:border-lime-300" />
      {!slippageValid && <p className="mt-2 text-xs text-amber-300">Set slippage between 0% and 50%.</p>}
      {quote?.error && <p className="mt-3 text-xs text-amber-300">{quote.error}</p>}
      {quote?.output && quote.output.gtn(0) && market && (
        <div className="mt-4 text-sm text-gray-200">
          <p>Estimated {side === "buy" ? "tokens received" : "SOL received"}: <strong>{formatUnits(BigInt(quote.output.toString()), side === "buy" ? market.decimals : 9, 6)}</strong></p>
          {side === "buy" && quote.maxInput && (
            <p className="mt-1">Maximum SOL debit with slippage: <strong>{formatUnits(BigInt(quote.maxInput.toString()), 9, 9)}</strong>, plus network fee and account rent.</p>
          )}
          {side === "sell" && quote.minOutput && (
            <p className="mt-1">Minimum SOL received with slippage: <strong>{formatUnits(BigInt(quote.minOutput.toString()), 9, 9)}</strong>.</p>
          )}
        </div>
      )}
      <p className="mt-2 text-xs text-gray-400">The quote may change before signing. The wallet signs a Solana mainnet transaction; no trade uses the model-chain RPC.</p>
      <button type="button" disabled={!canSubmit} onClick={() => void submit()}
        className="mt-5 w-full rounded bg-lime-300 px-4 py-3 font-semibold text-[#15171b] disabled:cursor-not-allowed disabled:opacity-40">
        {pending ? "Submitting…" : side === "buy" ? "Buy on mainnet" : "Sell on mainnet"}
      </button>
      {side === "buy" && quote?.input && maxInputAmount >= balances.sol && publicKey && (
        <p className="mt-2 text-xs text-amber-300">Keep enough SOL for the trade and network fee.</p>
      )}
      {message && <p role="status" className="mt-4 break-words text-sm text-gray-200">{message}</p>}
      {signature && <a className="mt-2 block break-all text-xs text-lime-300 underline" href={`https://explorer.solana.com/tx/${signature}?cluster=mainnet-beta`} target="_blank" rel="noopener noreferrer">View mainnet transaction</a>}
      <button type="button" onClick={() => void refresh()} className="mt-5 text-xs text-gray-400 underline hover:text-white">Refresh mainnet state</button>
    </section>
  );
}
