import { z } from "zod";
import { getEnv } from "@/lib/env";

/**
 * NEAR Intents 1Click client (SPEC §8.4), shared by Send home and lender deposits (§8.9). Quotes
 * are always dry runs: mainnet, no funds move. NEAR Intents is the technology used, not a partner.
 * Terms: responses are never stored over 24 hours or committed. This holds them in memory.
 */
const BASE_URL = "https://1click.chaindefuser.com/v0";
export const USDC_ON_NEAR =
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT_ON_TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
/** Dry runs still need syntactically valid addresses. Nothing is ever sent to or from these. */
const DRY_RUN_REFUND = "intents.near";
const DRY_RUN_RECIPIENT = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const DRY_RUN_NEAR_RECIPIENT = "intents.near";

const CACHE_MS = 60_000;
const TOKENS_CACHE_MS = 5 * 60_000;
/** After 1Click refuses a confidential quote, ask for public ones only, for this long. */
const CONFIDENTIAL_RETRY_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;

const quoteSchema = z.object({
  quote: z.object({ amountIn: z.string().regex(/^\d+$/), amountOut: z.string().regex(/^\d+$/) }),
});
const tokensSchema = z.array(
  z.object({
    assetId: z.string().min(1),
    blockchain: z.string().min(1),
    symbol: z.string().min(1),
    decimals: z.number().int().min(0).max(30),
  }),
);

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export interface IntentsDeps {
  fetch: Fetch;
  now: () => number;
  /** 1Click partner key, sent as X-API-Key. Null or absent: unauthenticated. */
  apiKey?: string | null;
}

function defaultDeps(): IntentsDeps {
  return { fetch, now: Date.now, apiKey: getEnv().oneClickApiKey };
}

function headers(apiKey: string | null | undefined): Record<string, string> {
  return apiKey
    ? { "Content-Type": "application/json", "X-API-Key": apiKey }
    : { "Content-Type": "application/json" };
}

type RawQuote = { amountIn: bigint; amountOut: bigint };

/** One dry-run quote. Null when 1Click refuses, answers badly or cannot be reached. */
async function postQuote(
  body: Record<string, unknown>,
  deps: IntentsDeps,
): Promise<RawQuote | null> {
  try {
    const response = await deps.fetch(`${BASE_URL}/quote`, {
      method: "POST",
      headers: headers(deps.apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        ...body,
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        deadline: new Date(deps.now() + 10 * 60_000).toISOString(),
      }),
    });
    if (!response.ok) return null;
    const { quote } = quoteSchema.parse(await response.json());
    return { amountIn: BigInt(quote.amountIn), amountOut: BigInt(quote.amountOut) };
  } catch {
    return null;
  }
}

// ---- Send home: the swap leg -------------------------------------------------------------

export interface SwapLegQuote {
  /** Cost of the swap leg, in basis points of the amount sent, rounded up. */
  bps: number;
  fetchedAt: number;
}

const swapCache = new Map<string, SwapLegQuote>();

/** USDC on NEAR → the partner's settlement asset. Null when the quote is unavailable. */
export async function quoteSwapLeg(
  amountUnits: bigint,
  deps: IntentsDeps = defaultDeps(),
): Promise<SwapLegQuote | null> {
  if (amountUnits <= 0n) return null;
  const key = amountUnits.toString();
  const cached = swapCache.get(key);
  if (cached && deps.now() - cached.fetchedAt < CACHE_MS) return cached;

  const quote = await postQuote(
    {
      originAsset: USDC_ON_NEAR,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDT_ON_TRON,
      amount: key,
      refundTo: DRY_RUN_REFUND,
      refundType: "ORIGIN_CHAIN",
      recipient: DRY_RUN_RECIPIENT,
      recipientType: "DESTINATION_CHAIN",
    },
    deps,
  );
  if (!quote || quote.amountIn <= 0n) return null;
  // A quote can come back above 1:1. Show that as free, never as a negative cost.
  const lost = quote.amountIn > quote.amountOut ? quote.amountIn - quote.amountOut : 0n;
  const result: SwapLegQuote = {
    bps: Number((lost * 10_000n + quote.amountIn - 1n) / quote.amountIn),
    fetchedAt: deps.now(),
  };
  swapCache.clear();
  swapCache.set(key, result);
  return result;
}

// ---- Lender deposits: token list and the swap into USDC on NEAR ---------------------------

export interface TokenListing {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
}

let tokensCache: { tokens: TokenListing[]; fetchedAt: number } | null = null;

/** Every asset 1Click can swap (`GET /v0/tokens`, no key needed). Null when unavailable. */
export async function listTokens(
  deps: IntentsDeps = defaultDeps(),
): Promise<TokenListing[] | null> {
  if (tokensCache && deps.now() - tokensCache.fetchedAt < TOKENS_CACHE_MS)
    return tokensCache.tokens;
  try {
    const response = await deps.fetch(`${BASE_URL}/tokens`, {
      method: "GET",
      headers: headers(deps.apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const tokens = tokensSchema.parse(await response.json());
    tokensCache = { tokens, fetchedAt: deps.now() };
    return tokens;
  } catch {
    return null;
  }
}

export interface DepositLegQuote {
  amountIn: bigint;
  /** USDC on NEAR, 6 decimals: the same base units as tUSDC. */
  amountOut: bigint;
  /** 1Click accepted `"confidentiality": "basic"` for this dry run (SPEC §8.9, Q9). */
  confidential: boolean;
  fetchedAt: number;
}

const depositCache = new Map<string, DepositLegQuote>();
let confidentialRefusedAt: number | null = null;

/**
 * Any asset → USDC on NEAR, `EXACT_INPUT`. With a partner key it asks for a confidential dry run
 * first and falls back to a public one if 1Click refuses. `refundType: "INTENTS"` lets one
 * placeholder refund account serve every origin chain.
 */
export async function quoteDepositLeg(
  originAsset: string,
  amountIn: bigint,
  deps: IntentsDeps = defaultDeps(),
): Promise<DepositLegQuote | null> {
  if (amountIn <= 0n) return null;
  const key = `${originAsset}:${amountIn}`;
  const cached = depositCache.get(key);
  if (cached && deps.now() - cached.fetchedAt < CACHE_MS) return cached;

  const body = {
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC_ON_NEAR,
    amount: amountIn.toString(),
    refundTo: DRY_RUN_REFUND,
    refundType: "INTENTS",
    recipient: DRY_RUN_NEAR_RECIPIENT,
    recipientType: "DESTINATION_CHAIN",
  };
  const tryConfidential =
    Boolean(deps.apiKey) &&
    (confidentialRefusedAt === null || deps.now() - confidentialRefusedAt >= CONFIDENTIAL_RETRY_MS);

  let quote: RawQuote | null = null;
  let confidential = false;
  if (tryConfidential) {
    quote = await postQuote({ ...body, confidentiality: "basic" }, deps);
    confidential = quote !== null;
    if (!quote) confidentialRefusedAt = deps.now();
  }
  quote ??= await postQuote(body, deps);
  if (!quote || quote.amountIn !== amountIn) return null;

  const result: DepositLegQuote = {
    amountIn,
    amountOut: quote.amountOut,
    confidential,
    fetchedAt: deps.now(),
  };
  depositCache.clear();
  depositCache.set(key, result);
  return result;
}

/** Tests only: forget cached tokens and quotes. */
export function resetIntentsCache(): void {
  swapCache.clear();
  depositCache.clear();
  tokensCache = null;
  confidentialRefusedAt = null;
}
