import type { AccountId } from "@homeroll/shared";
import { type Units, units } from "@/lib/fx";
import type { DepositLegQuote, TokenListing } from "@/lib/intents";
import type { ChainClient, LenderView, PoolView, TxFailure } from "@/lib/near/client";

/**
 * Private deposit from any chain (SPEC §8.9). The swap price is a live NEAR Intents dry-run quote
 * or a labelled sample. The Confidential Intents routing and the cross-chain delivery are mocked:
 * solver.<root> sends tUSDC to the lender's pseudonymous account, which then deposits it in the
 * pool for real on testnet. The server prices every deposit itself (hard rule 4).
 */

/** The (chain, symbol) pairs the picker offers, in order, when the live 1Click list has them. */
const PAIRS = [
  { chain: "tron", symbol: "USDT", label: "USDT on Tron" },
  { chain: "eth", symbol: "USDC", label: "USDC on Ethereum" },
  { chain: "base", symbol: "USDC", label: "USDC on Base" },
  { chain: "sol", symbol: "USDC", label: "USDC on Solana" },
  { chain: "eth", symbol: "ETH", label: "ETH on Ethereum" },
  { chain: "btc", symbol: "BTC", label: "BTC on Bitcoin" },
  { chain: "sol", symbol: "SOL", label: "SOL on Solana" },
] as const;

/** Made-up prices in micro-USD per whole token, for sample quotes only. Not market data. */
const SAMPLE_PRICE_MICRO_USD: Record<string, bigint> = {
  "tron:USDT": 1_000_000n,
  "eth:USDC": 1_000_000n,
  "base:USDC": 1_000_000n,
  "sol:USDC": 1_000_000n,
  "eth:ETH": 2_500_000_000n,
  "btc:BTC": 80_000_000_000n,
  "sol:SOL": 100_000_000n,
};
const SAMPLE_DECIMALS: Record<string, number> = {
  "tron:USDT": 6,
  "eth:USDC": 6,
  "base:USDC": 6,
  "sol:USDC": 6,
  "eth:ETH": 18,
  "btc:BTC": 8,
  "sol:SOL": 9,
};
/** Made-up swap cost for sample quotes: 0.10%. */
export const SAMPLE_SWAP_BPS = 10;

export type QuoteSource = "live" | "sample";

export interface DepositAsset {
  /** `chain:symbol`, e.g. `tron:USDT`. */
  key: string;
  label: string;
  symbol: string;
  /** 1Click asset id. Null for a sample asset, which is never sent to 1Click. */
  assetId: string | null;
  decimals: number;
  source: QuoteSource;
}

/** The picker's assets from the live token list, or the labelled sample list when it is down. */
export function depositAssets(tokens: TokenListing[] | null): DepositAsset[] {
  const live = (tokens ?? []).length
    ? PAIRS.flatMap((p) => {
        const t = tokens?.find((x) => x.blockchain === p.chain && x.symbol === p.symbol);
        return t
          ? [
              {
                key: `${p.chain}:${p.symbol}`,
                label: p.label,
                symbol: p.symbol,
                assetId: t.assetId,
                decimals: t.decimals,
                source: "live" as const,
              },
            ]
          : [];
      })
    : [];
  if (live.length > 0) return live;
  return PAIRS.map((p) => {
    const key = `${p.chain}:${p.symbol}`;
    return {
      key,
      label: p.label,
      symbol: p.symbol,
      assetId: null,
      decimals: SAMPLE_DECIMALS[key] ?? 6,
      source: "sample" as const,
    };
  });
}

/** "1,250.5" in a token with `decimals` → base units. Null if it is not a plain decimal. No floats. */
export function parseAssetAmount(text: string, decimals: number): bigint | null {
  const clean = text.trim().replaceAll(",", "");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(clean);
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export interface DepositQuote {
  mock: true;
  asset: DepositAsset;
  amountIn: bigint;
  /** USDC on NEAR, delivered as the same number of tUSDC base units. */
  amountOut: Units;
  swap: { label: "Swap · NEAR Intents"; source: QuoteSource; confidential: boolean };
  routing: { label: "Confidential routing · Confidential Intents"; mock: true };
  delivery: { label: "Delivered as tUSDC on testnet"; mock: true };
}

function quote(
  asset: DepositAsset,
  amountIn: bigint,
  amountOut: bigint,
  source: QuoteSource,
  confidential: boolean,
): DepositQuote {
  return {
    mock: true,
    asset,
    amountIn,
    amountOut: units(amountOut),
    swap: { label: "Swap · NEAR Intents", source, confidential },
    routing: { label: "Confidential routing · Confidential Intents", mock: true },
    delivery: { label: "Delivered as tUSDC on testnet", mock: true },
  };
}

/** Made-up price × amount, minus the made-up 0.10%, rounded down. */
export function sampleDepositQuote(asset: DepositAsset, amountIn: bigint): DepositQuote {
  const price = SAMPLE_PRICE_MICRO_USD[asset.key] ?? 0n;
  const gross = (amountIn * price) / 10n ** BigInt(asset.decimals);
  return quote(
    asset,
    amountIn,
    (gross * BigInt(10_000 - SAMPLE_SWAP_BPS)) / 10_000n,
    "sample",
    false,
  );
}

export type QuoteLeg = (assetId: string, amountIn: bigint) => Promise<DepositLegQuote | null>;

/** The live dry-run quote when asked for and reachable, otherwise a labelled sample. */
export async function priceDeposit(
  asset: DepositAsset,
  amountIn: bigint,
  deps: { live: boolean; quoteLeg: QuoteLeg },
): Promise<DepositQuote> {
  if (deps.live && asset.assetId) {
    const leg = await deps.quoteLeg(asset.assetId, amountIn);
    if (leg) return quote(asset, leg.amountIn, leg.amountOut, "live", leg.confidential);
  }
  return sampleDepositQuote(asset, amountIn);
}

// ---- R16: the mock solver's limits (server policy, like the relayer's) ----------------------

/** R16.1: at most 50,000 USDC per deposit. */
export const MAX_DEPOSIT = units(50_000_000_000n);
/** R16.2: at most 3 deposits per lender per hour. */
export const MAX_DEPOSITS_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

export type DepositRefusal =
  | { reason: "no-quote" }
  | { reason: "above-limit"; max: Units }
  | { reason: "below-first-minimum"; min: Units }
  | { reason: "rate-limited"; retryAt: number }
  | { reason: "solver-empty" };

/** Delivery times per lender, in memory on this server instance (SPEC §18). */
export class DepositLimiter {
  private readonly times = new Map<AccountId, number[]>();

  /** When the lender may deposit again, or null if they may now. */
  retryAt(lender: AccountId, now: number): number | null {
    const recent = (this.times.get(lender) ?? []).filter((t) => now - t < HOUR_MS);
    this.times.set(lender, recent);
    const oldest = recent[0];
    return recent.length >= MAX_DEPOSITS_PER_HOUR && oldest !== undefined ? oldest + HOUR_MS : null;
  }

  record(lender: AccountId, now: number): void {
    this.times.set(lender, [...(this.times.get(lender) ?? []), now]);
  }
}

export interface DepositCheck {
  quote: DepositQuote;
  /** `get_lender`: null for a new lender. */
  lender: LenderView | null;
  pool: PoolView;
  solverBalance: Units;
  retryAt: number | null;
}

/** Every R16 check, before the solver sends anything. Null means the deposit may go ahead. */
export function checkDeposit(c: DepositCheck): DepositRefusal | null {
  const amount = c.quote.amountOut;
  if (amount <= 0n) return { reason: "no-quote" };
  // R16.1: per-deposit limit
  if (amount > MAX_DEPOSIT) return { reason: "above-limit", max: MAX_DEPOSIT };
  // R16.3: R15 checked ahead of the solver, so a refused first deposit never strands its float
  if (c.lender === null && amount < c.pool.minFirstDeposit) {
    return { reason: "below-first-minimum", min: c.pool.minFirstDeposit };
  }
  // R16.2: per-lender rate limit
  if (c.retryAt !== null) return { reason: "rate-limited", retryAt: c.retryAt };
  // R16.4: the float is all that can ever leave the solver
  if (c.solverBalance < amount) return { reason: "solver-empty" };
  return null;
}

export interface DepositReceipt {
  mock: true;
  lender: AccountId;
  amountOut: Units;
  shares: bigint;
  deliveryTxHash: string;
  depositTxHash: string;
  quote: DepositQuote;
}

export type DepositOutcome =
  | { ok: true; receipt: DepositReceipt }
  | { ok: false; refusal: DepositRefusal }
  /** The chain said no. After a delivered but refused deposit, the tUSDC stays with the lender. */
  | { ok: false; failure: TxFailure; deliveryTxHash: string | null };

export interface DepositDeps {
  chain: ChainClient;
  solver: AccountId;
  limiter: DepositLimiter;
  now: () => number;
}

/** Mock delivery, then the lender's real pool deposit (SPEC §8.9). */
export const MockDeposit = {
  async execute(
    quote: DepositQuote,
    lender: AccountId,
    deps: DepositDeps,
  ): Promise<DepositOutcome> {
    const { chain } = deps;
    const [lenderView, pool, solverBalance] = await Promise.all([
      chain.getLender(lender),
      chain.getPool(),
      chain.ftBalanceOf(deps.solver),
    ]);
    const refusal = checkDeposit({
      quote,
      lender: lenderView,
      pool,
      solverBalance,
      retryAt: deps.limiter.retryAt(lender, deps.now()),
    });
    if (refusal) return { ok: false, refusal };

    const delivered = await chain.deliverFromSolver(lender, quote.amountOut);
    if (!delivered.ok) return { ok: false, failure: delivered.failure, deliveryTxHash: null };
    deps.limiter.record(lender, deps.now());

    const deposited = await chain.depositToPool(
      { role: "lender", accountId: lender },
      quote.amountOut,
    );
    if (!deposited.ok) {
      return { ok: false, failure: deposited.failure, deliveryTxHash: delivered.txHash };
    }
    return {
      ok: true,
      receipt: {
        mock: true,
        lender,
        amountOut: quote.amountOut,
        shares: deposited.value.shares,
        deliveryTxHash: delivered.txHash,
        depositTxHash: deposited.txHash,
        quote,
      },
    };
  },
};

/** What `shares` of the pool are worth at current NAV, rounded down. */
export function sharesValue(shares: bigint, pool: PoolView): Units {
  if (pool.totalShares === 0n) return units(0n);
  return units((shares * (pool.cash + pool.outstanding)) / pool.totalShares);
}
