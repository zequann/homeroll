import { AsyncLocalStorage } from "node:async_hooks";
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
  /** The button that started it ("Run payroll", "Take advance"), when a server action set one. */
  action: string | null;
}

// The button behind the current request. Each request runs in its own async context, so a label
// set at the top of a server action covers every call it makes, and no other request.
const currentAction = new AsyncLocalStorage<string>();

/** Labels everything this server action records with the button that started it. */
export function labelAction(button: string): void {
  currentAction.enterWith(button);
}

export interface ActivityLog {
  record(entry: Omit<ActivityEntry, "id" | "action"> & { action?: string | null }): void;
  /** Newest first. */
  list(): ActivityEntry[];
  clear(): void;
}

export function createActivityLog(): ActivityLog {
  let entries: ActivityEntry[] = [];
  let next = 1;
  return {
    record(entry) {
      const action = entry.action ?? currentAction.getStore() ?? null;
      entries = [{ ...entry, action, id: next++ }, ...entries];
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
