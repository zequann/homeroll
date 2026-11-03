import type { AccountId } from "@homeroll/shared";
import { feeSen, type Sen, sen, senToTaka, senToUnits } from "@/lib/fx";
import type { ChainClient, Signer } from "@/lib/near/client";

/**
 * Send home (SPEC §8.4). Every number here is a sample: no Intents call is made and no quote is
 * stored (1Click terms). The UI labels the swap leg "Sample quote" and the payout "Mock partner".
 */

export interface RemitQuote {
  mock: true;
  corridor: "MY-BD";
  amountSen: Sen;
  swap: { label: "Swap · NEAR Intents"; bps: number; feeSen: Sen };
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

export const SampleQuote: RemitRoute = {
  quote(amountSen) {
    const swapFee = feeSen(amountSen, SAMPLE_SWAP_BPS);
    const payoutFee = feeSen(amountSen, ASSUMED_PAYOUT_BPS);
    return {
      mock: true,
      corridor: "MY-BD",
      amountSen,
      swap: { label: "Swap · NEAR Intents", bps: SAMPLE_SWAP_BPS, feeSen: swapFee },
      payout: {
        label: "Payout in BDT · partner, assumed 1.0% incl. FX",
        bps: ASSUMED_PAYOUT_BPS,
        feeSen: payoutFee,
      },
      takaOut: senToTaka(sen(amountSen - swapFee - payoutFee)),
      totalBps: SAMPLE_SWAP_BPS + ASSUMED_PAYOUT_BPS,
    };
  },
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
  takaOut: number;
  quote: RemitQuote;
}

/** Mock partner: moves the tokens to payout.<root>; the BDT receipt is made up. */
export const MockRoute = {
  async execute(
    chain: ChainClient,
    signer: Signer,
    payoutAccount: AccountId,
    quote: RemitQuote,
  ): Promise<RemitReceipt> {
    const result = await chain.ftTransfer(
      signer,
      payoutAccount,
      senToUnits(quote.amountSen),
      `send-home:${quote.corridor}`,
    );
    if (!result.ok) throw new Error("Mock payout transfer was rejected");
    return { mock: true, txHash: result.txHash, takaOut: quote.takaOut, quote };
  },
};
