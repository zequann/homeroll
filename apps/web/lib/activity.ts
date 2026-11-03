import type { AccountId } from "@homeroll/shared";
import type { Units } from "@/lib/fx";

/**
 * In-memory activity log the fake chain appends to on every call, failed ones too (SPEC §8.7:
 * Supabase replaces it later). Held on globalThis so it survives dev hot reload.
 */
export interface ActivityEntry {
  id: number;
  at: number;
  method: string;
  from: AccountId;
  to: AccountId;
  amount: Units | null;
  txHash: string | null;
  /** `null` on success, otherwise the exact contract or protocol error text. */
  failure: string | null;
}

export interface ActivityLog {
  record(entry: Omit<ActivityEntry, "id">): void;
  /** Newest first. */
  list(): ActivityEntry[];
  clear(): void;
}

export function createActivityLog(): ActivityLog {
  let entries: ActivityEntry[] = [];
  let next = 1;
  return {
    record(entry) {
      entries = [{ ...entry, id: next++ }, ...entries];
    },
    list: () => entries,
    clear() {
      entries = [];
    },
  };
}

const globalForActivity = globalThis as unknown as { __homerollActivity?: ActivityLog };

export function getActivityLog(): ActivityLog {
  globalForActivity.__homerollActivity ??= createActivityLog();
  return globalForActivity.__homerollActivity;
}
