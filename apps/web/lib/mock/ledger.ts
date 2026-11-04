import type { Sen } from "@/lib/fx";

/**
 * Receipts from the mock partners (SPEC §8.6, the `mock_ledger` table of §8.7). In memory until
 * Supabase is wired; kept on globalThis so dev hot reload does not drop it. Synthetic references only.
 */

export type MockReceipt =
  | {
      mock: true;
      kind: "payout";
      partner: "Mock partner · bKash payout";
      ref: string;
      txHash: string;
      amountSen: Sen;
      takaOut: number;
      swapBps: number;
      swapSource: "live" | "sample";
      maskedWallet: string;
      at: number;
    }
  | {
      mock: true;
      kind: "duitnow";
      partner: "Mock partner · DuitNow off-ramp";
      ref: string;
      txHash: string;
      amountSen: Sen;
      rmOutSen: Sen;
      destination: string;
      at: number;
    }
  | {
      mock: true;
      kind: "bank";
      partner: "Mock bank · escrow";
      ref: string;
      txHash: string;
      invoiceNumber: string;
      paidSen: Sen;
      ownerGetsSen: Sen;
      at: number;
    };

export interface MockLedger {
  record<R extends MockReceipt>(receipt: Omit<R, "ref">, prefix: string): R;
  list(): MockReceipt[];
  clear(): void;
}

function createMockLedger(): MockLedger {
  let receipts: MockReceipt[] = [];
  let next = 1;
  return {
    record(receipt, prefix) {
      const ref = `${prefix}-SYN-${String(next++).padStart(6, "0")}`;
      const full = { ...receipt, ref } as unknown as MockReceipt;
      receipts = [full, ...receipts];
      return full as never;
    },
    list: () => receipts,
    clear() {
      receipts = [];
    },
  };
}

const globalForLedger = globalThis as unknown as { __homerollMockLedger?: MockLedger };

export function getMockLedger(): MockLedger {
  globalForLedger.__homerollMockLedger ??= createMockLedger();
  return globalForLedger.__homerollMockLedger;
}
