import { randomInt } from "node:crypto";
import type { Sen } from "@/lib/fx";
import { getFixtures } from "@/lib/near";
import { type RowStore, rowStore } from "@/lib/store/rows";

/**
 * Receipts from the mock partners (SPEC §8.6, the `mock_ledger` table of §8.7): Supabase when
 * configured, memory otherwise (lib/store/rows). Synthetic references only.
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
  record<R extends MockReceipt>(receipt: Omit<R, "ref">, prefix: string): Promise<R>;
  /** Newest first. */
  list(): Promise<MockReceipt[]>;
  find(ref: string): Promise<MockReceipt | null>;
  clear(): Promise<void>;
}

/** Receipts of one demo employer, in the shared `mock_ledger` table (SPEC §8.7). */
export function createMockLedger(store: RowStore, scope: string): MockLedger {
  return {
    async record(receipt, prefix) {
      // Random, not a counter: several server instances write receipts at once
      const ref = `${prefix}-SYN-${String(randomInt(1_000_000)).padStart(6, "0")}`;
      const full = { ...receipt, ref } as unknown as MockReceipt;
      await store.upsert("mock_ledger", scope, ref, full);
      return full as never;
    },
    async list() {
      return (await store.list<MockReceipt>("mock_ledger", scope)).map((r) => r.data);
    },
    find: (ref) => store.get<MockReceipt>("mock_ledger", scope, ref),
    clear: () => store.clear("mock_ledger", scope),
  };
}

export function getMockLedger(): MockLedger {
  return createMockLedger(rowStore(), getFixtures().company.accountId);
}
