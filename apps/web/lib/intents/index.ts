import { z } from "zod";

/**
 * NEAR Intents 1Click quote client (SPEC §8.4), shared by Send home and lender deposits. Always a
 * dry run: mainnet, no funds move, no key needed. NEAR Intents is the technology used, not a
 * partner. Terms: responses are never stored over 24 hours or committed. This holds one in memory.
 */
const QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";
const USDC_ON_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT_ON_TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
/** Dry runs still need syntactically valid addresses. Nothing is ever sent to or from these. */
const DRY_RUN_REFUND = "intents.near";
const DRY_RUN_RECIPIENT = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;

const responseSchema = z.object({
  quote: z.object({ amountIn: z.string().regex(/^\d+$/), amountOut: z.string().regex(/^\d+$/) }),
});

export interface SwapLegQuote {
  /** Cost of the swap leg, in basis points of the amount sent, rounded up. */
  bps: number;
  fetchedAt: number;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const cache = new Map<string, SwapLegQuote>();

/** USDC on NEAR → the partner's settlement asset. Null when the quote is unavailable. */
export async function quoteSwapLeg(
  amountUnits: bigint,
  deps: { fetch: Fetch; now: () => number } = { fetch, now: Date.now },
): Promise<SwapLegQuote | null> {
  if (amountUnits <= 0n) return null;
  const key = amountUnits.toString();
  const cached = cache.get(key);
  if (cached && deps.now() - cached.fetchedAt < CACHE_MS) return cached;

  try {
    const response = await deps.fetch(QUOTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: USDC_ON_NEAR,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: USDT_ON_TRON,
        amount: key,
        refundTo: DRY_RUN_REFUND,
        refundType: "ORIGIN_CHAIN",
        recipient: DRY_RUN_RECIPIENT,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(deps.now() + 10 * 60_000).toISOString(),
      }),
    });
    if (!response.ok) return null;
    const { quote } = responseSchema.parse(await response.json());
    const amountIn = BigInt(quote.amountIn);
    const amountOut = BigInt(quote.amountOut);
    // A quote can come back above 1:1. Show that as free, never as a negative cost.
    const lost = amountIn > amountOut ? amountIn - amountOut : 0n;
    const result: SwapLegQuote = {
      bps: Number((lost * 10_000n + amountIn - 1n) / amountIn),
      fetchedAt: deps.now(),
    };
    cache.clear();
    cache.set(key, result);
    return result;
  } catch {
    return null;
  }
}
