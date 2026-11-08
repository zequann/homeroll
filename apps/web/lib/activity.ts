import { AsyncLocalStorage } from "node:async_hooks";
import type { AccountId } from "@homeroll/shared";
import type { Units } from "@/lib/fx";
import { getFixtures } from "@/lib/near";
import { inBackground, pending } from "@/lib/store/background";
import { rowStore } from "@/lib/store/rows";

/**
 * Activity log the chain clients append to on every call, failed ones too (SPEC §8.7). Held on
 * globalThis so it survives dev hot reload; mirrored to Supabase when configured (below).
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

// Ids carry the time, so rows from several server instances still sort newest first
let seq = 0;
const nextId = () => Date.now() * 1000 + (seq++ % 1000);

/**
 * The app's activity log. Each entry is also written to the shared `activity` table (SPEC §8.7)
 * when Supabase is configured, so every server instance shows the same log.
 */
export function getActivityLog(): ActivityLog {
  if (!globalForActivity.__homerollActivity) {
    const local = createActivityLog();
    globalForActivity.__homerollActivity = {
      record(entry) {
        local.record(entry);
        const stored = local.list()[0];
        const store = rowStore();
        if (!stored || store.kind !== "supabase") return;
        const row = { ...stored, id: nextId() };
        const scope = getFixtures().company.accountId;
        inBackground("activity", () =>
          store.upsert("activity", scope, String(row.id).padStart(17, "0"), row),
        );
      },
      list: () => local.list(),
      clear: () => local.clear(),
    };
  }
  return globalForActivity.__homerollActivity;
}

/** Newest first: from the shared table when Supabase is configured, this instance's log otherwise. */
export async function recentActivity(limit = 200): Promise<ActivityEntry[]> {
  const store = rowStore();
  if (store.kind !== "supabase") return getActivityLog().list().slice(0, limit);
  await pending();
  const rows = await store.list<ActivityEntry>("activity", getFixtures().company.accountId, limit);
  return rows.map((r) => r.data).sort((a, b) => b.id - a.id);
}
