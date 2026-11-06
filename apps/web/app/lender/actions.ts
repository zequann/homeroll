"use server";

import { homerollAccounts } from "@homeroll/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  type DepositAsset,
  DepositLimiter,
  type DepositQuote,
  type DepositRefusal,
  depositAssets,
  MAX_DEPOSITS_PER_HOUR,
  MockDeposit,
  parseAssetAmount,
  priceDeposit,
} from "@/lib/deposit";
import { getEnv } from "@/lib/env";
import { explain, explainProtocol } from "@/lib/errors/explain";
import { formatUsdc } from "@/lib/fx";
import { listTokens, quoteDepositLeg } from "@/lib/intents";
import { getChainClient, getFixtures } from "@/lib/near";
import type { TxFailure } from "@/lib/near/client";
import { requireSigner } from "@/lib/session";

// One limiter per server process, kept across hot reloads (R16.2, SPEC §18).
const globalForDeposit = globalThis as unknown as { __homerollDepositLimiter?: DepositLimiter };
globalForDeposit.__homerollDepositLimiter ??= new DepositLimiter();
const limiter = globalForDeposit.__homerollDepositLimiter;

const requestSchema = z.object({
  assetKey: z.string().max(40),
  amount: z.string().max(40),
});

/** A quote as the browser sees it: display strings only. The server re-prices on deposit. */
export interface DepositQuoteView {
  assetKey: string;
  amount: string;
  amountOut: string;
  source: "live" | "sample";
  confidential: boolean;
}

export type DepositResult =
  | {
      ok: true;
      amountOut: string;
      lender: string;
      deliveryTxHash: string;
      depositTxHash: string;
    }
  | { ok: false; message: string };

async function assets(): Promise<DepositAsset[]> {
  return depositAssets(getEnv().intentsQuotes === "live" ? await listTokens() : null);
}

/** The server's own price for what the browser asked: asset and amount in, nothing else. */
async function price(raw: unknown): Promise<DepositQuote | null> {
  const { assetKey, amount } = requestSchema.parse(raw);
  const asset = (await assets()).find((a) => a.key === assetKey);
  if (!asset) return null;
  const amountIn = parseAssetAmount(amount, asset.decimals);
  if (amountIn === null || amountIn <= 0n) return null;
  return priceDeposit(asset, amountIn, {
    live: getEnv().intentsQuotes === "live",
    quoteLeg: (assetId, value) => quoteDepositLeg(assetId, value),
  });
}

/** For the deposit form, as the amount changes. A dry-run quote; moves nothing. */
export async function priceLenderDeposit(raw: unknown): Promise<DepositQuoteView | null> {
  const quote = await price(raw);
  if (!quote) return null;
  const { assetKey, amount } = requestSchema.parse(raw);
  return {
    assetKey,
    amount,
    amountOut: formatUsdc(quote.amountOut),
    source: quote.swap.source,
    confidential: quote.swap.confidential,
  };
}

function refusalText(refusal: DepositRefusal, now: number): string {
  switch (refusal.reason) {
    case "no-quote":
      return "There is no price for that amount right now. Nothing was sent.";
    case "above-limit":
      return `The mock solver delivers at most ${formatUsdc(refusal.max)} per deposit. Try a smaller amount. Nothing was sent.`;
    case "below-first-minimum":
      return `A first deposit must be at least ${formatUsdc(refusal.min)}. Nothing was sent.`;
    case "rate-limited": {
      const minutes = Math.max(1, Math.ceil((refusal.retryAt - now) / 60_000));
      return `The mock solver takes ${MAX_DEPOSITS_PER_HOUR} deposits an hour from one lender. Try again in ${minutes} min. Nothing was sent.`;
    }
    case "solver-empty":
      return "The mock solver's float is used up. Reset demo tops it up. Nothing was sent.";
  }
}

function failureSentence(failure: TxFailure): string {
  return failure.kind === "protocol"
    ? explainProtocol(failure.name).sentence
    : explain(failure.error).sentence;
}

/** Private deposit (SPEC §8.9): mock routing and delivery, then a real pool deposit. */
export async function depositPrivately(raw: unknown): Promise<DepositResult> {
  const session = await requireSigner("lender");
  if (!session.connected) return { ok: false, message: "Connect the lender wallet to deposit." };
  // Only the demo lender's pseudonymous account, never an account the browser names
  const lender = getFixtures().lender.accountId;
  if (session.signer.accountId !== lender) {
    return { ok: false, message: "Connect the lender wallet to deposit." };
  }

  const quote = await price(raw);
  if (!quote) return { ok: false, message: "Enter an amount like 1,000 or 0.5. Nothing was sent." };

  const now = Date.now();
  const outcome = await MockDeposit.execute(quote, lender, {
    chain: getChainClient(),
    solver: homerollAccounts(getEnv().root).solver,
    limiter,
    now: Date.now,
  });
  if (!outcome.ok) {
    if ("refusal" in outcome) return { ok: false, message: refusalText(outcome.refusal, now) };
    const kept = outcome.deliveryTxHash ? " The tUSDC is in your account." : " Nothing was sent.";
    return { ok: false, message: `${failureSentence(outcome.failure)}${kept}` };
  }
  revalidatePath("/lender");
  return {
    ok: true,
    amountOut: formatUsdc(outcome.receipt.amountOut),
    lender: outcome.receipt.lender,
    deliveryTxHash: outcome.receipt.deliveryTxHash,
    depositTxHash: outcome.receipt.depositTxHash,
  };
}
