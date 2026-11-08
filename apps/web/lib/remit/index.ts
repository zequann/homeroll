import type { AccountId } from "@homeroll/shared";
import { feeSen, type Sen, sen, senToTaka, senToUnits } from "@/lib/fx";
import type { MockLedger, MockReceipt } from "@/lib/mock/ledger";

/**
 * Send home (SPEC §8.4). The swap leg is a live NEAR Intents dry-run quote or a labelled made-up
 * sample, as `swap.source` says. The payout leg is always the mock partner's assumed fee.
 */

export type SwapSource = "live" | "sample";

export interface RemitQuote {
  mock: true;
  corridor: "MY-BD";
  amountSen: Sen;
  swap: { label: "Swap · NEAR Intents"; bps: number; feeSen: Sen; source: SwapSource };
  payout: { label: "Payout in BDT · partner, assumed 1.0% incl. FX"; bps: number; feeSen: Sen };
  /** Taka the family receives, rounded down. */
  takaOut: number;
  /** All-in cost as basis points of the amount sent. */
  totalBps: number;
}

export interface RemitRoute {
  quote(amountSen: Sen): RemitQuote;
}

/** Made-up swap leg, in basis points: 0.10%. Not a live quote. */
export const SAMPLE_SWAP_BPS = 10;
/** Assumed partner fee including FX margin: 1.0% (SPEC §8.4, labelled as an assumption). */
export const ASSUMED_PAYOUT_BPS = 100;

export function quoteWithSwap(amountSen: Sen, swapBps: number, source: SwapSource): RemitQuote {
  const swapFee = feeSen(amountSen, swapBps);
  const payoutFee = feeSen(amountSen, ASSUMED_PAYOUT_BPS);
  return {
    mock: true,
    corridor: "MY-BD",
    amountSen,
    swap: { label: "Swap · NEAR Intents", bps: swapBps, feeSen: swapFee, source },
    payout: {
      label: "Payout in BDT · partner, assumed 1.0% incl. FX",
      bps: ASSUMED_PAYOUT_BPS,
      feeSen: payoutFee,
    },
    takaOut: senToTaka(sen(amountSen - swapFee - payoutFee)),
    totalBps: swapBps + ASSUMED_PAYOUT_BPS,
  };
}

export const SampleQuote: RemitRoute = {
  quote: (amountSen) => quoteWithSwap(amountSen, SAMPLE_SWAP_BPS, "sample"),
};

/** World Bank Remittance Prices Worldwide, Q3 2025, sending USD 200 (SPEC §4). */
export const BENCHMARKS = [
  { label: "Malaysia → Bangladesh average", bps: 751 },
  { label: "Money transfer operators", bps: 603 },
  { label: "Banks", bps: 1237 },
] as const;

export function benchmarkTaka(amountSen: Sen, bps: number): number {
  return senToTaka(sen(amountSen - feeSen(amountSen, bps)));
}

export interface RemitReceipt {
  mock: true;
  txHash: string;
  ref: string;
  takaOut: number;
  quote: RemitQuote;
}

/** The token transfer to payout.<root>: in P0 a worker delegate action through the relayer. */
export type Transfer = (to: AccountId, amount: bigint, memo: string) => Promise<{ txHash: string }>;

/** Mock partner: moves the tokens to payout.<root>; the BDT receipt is made up. */
export const MockRoute = {
  async execute(
    transfer: Transfer,
    payoutAccount: AccountId,
    quote: RemitQuote,
    ledger: MockLedger,
    maskedWallet: string,
  ): Promise<RemitReceipt> {
    const { txHash } = await transfer(
      payoutAccount,
      senToUnits(quote.amountSen),
      `send-home:${quote.corridor}`,
    );
    const receipt = await ledger.record<Extract<MockReceipt, { kind: "payout" }>>(
      {
        mock: true,
        kind: "payout",
        partner: "Mock partner · bKash payout",
        txHash,
        amountSen: quote.amountSen,
        takaOut: quote.takaOut,
        swapBps: quote.swap.bps,
        swapSource: quote.swap.source,
        maskedWallet,
        at: Date.now(),
      },
      "BKASH",
    );
    return { mock: true, txHash, ref: receipt.ref, takaOut: quote.takaOut, quote };
  },
};
