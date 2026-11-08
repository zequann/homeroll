import type { AccountId } from "@homeroll/shared";
import { type Sen, sen, senToUnits } from "@/lib/fx";
import type { MockLedger, MockReceipt } from "@/lib/mock/ledger";

/**
 * Cash out (SPEC §8.5): the worker's tUSDC goes to offramp.<root>; the mock off-ramp returns a
 * DuitNow reference in RM. A licensed off-ramp replaces `MockDuitNow` behind `CashoutRoute`.
 */

export const CASHOUT_DESTINATIONS = [
  { key: "tng", label: "TNG eWallet", masked: "•••• 2208" },
  { key: "bank", label: "Bank account", masked: "•••• 5130" },
] as const;
export type CashoutDestination = (typeof CASHOUT_DESTINATIONS)[number]["key"];

/** Assumed off-ramp fee, labelled in the UI: 0.5%, rounded up. */
export const ASSUMED_CASHOUT_BPS = 50;

export function cashoutQuote(amountSen: Sen): { feeSen: Sen; rmOutSen: Sen; bps: number } {
  const fee = sen(Math.ceil((amountSen * ASSUMED_CASHOUT_BPS) / 10_000));
  // Amounts a user receives round down (SPEC §10): fee rounds up, so the rest is floored
  return { feeSen: fee, rmOutSen: sen(amountSen - fee), bps: ASSUMED_CASHOUT_BPS };
}

export type Transfer = (to: AccountId, amount: bigint, memo: string) => Promise<{ txHash: string }>;

export interface CashoutRoute {
  execute(
    transfer: Transfer,
    offramp: AccountId,
    amountSen: Sen,
    destination: CashoutDestination,
  ): Promise<Extract<MockReceipt, { kind: "duitnow" }>>;
}

export function mockDuitNow(ledger: MockLedger, now: () => number = Date.now): CashoutRoute {
  return {
    async execute(transfer, offramp, amountSen, destination) {
      const { txHash } = await transfer(offramp, senToUnits(amountSen), `cash-out:${destination}`);
      const dest = CASHOUT_DESTINATIONS.find((d) => d.key === destination);
      return await ledger.record<Extract<MockReceipt, { kind: "duitnow" }>>(
        {
          mock: true,
          kind: "duitnow",
          partner: "Mock partner · DuitNow off-ramp",
          txHash,
          amountSen,
          rmOutSen: cashoutQuote(amountSen).rmOutSen,
          destination: dest ? `${dest.label} ${dest.masked}` : destination,
          at: now(),
        },
        "DN",
      );
    },
  };
}
