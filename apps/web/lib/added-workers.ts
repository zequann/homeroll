import { randomInt } from "node:crypto";
import { type AccountId, workerAccountId } from "@homeroll/shared";
import type { Sen } from "@/lib/fx";
import { getFixtures } from "@/lib/near";
import { rowStore } from "@/lib/store/rows";

/**
 * Workers the owner added in this demo: the off-chain `workers` table (SPEC §8.7), Supabase when
 * configured, memory otherwise. The only place the name ↔ account link lives (rule R13).
 */
export interface AddedWorker {
  accountId: AccountId;
  displayName: string;
  role: string;
  capSen: Sen;
}

const scope = () => getFixtures().company.accountId;

// The last rows read, so name lookups at render time stay synchronous (lib/names). Every load and
// save refreshes it; a page loads before it renders names.
const globalForWorkers = globalThis as unknown as {
  __homerollAddedWorkers?: Map<string, Map<AccountId, AddedWorker>>;
};
function cache(): Map<AccountId, AddedWorker> {
  globalForWorkers.__homerollAddedWorkers ??= new Map();
  const all = globalForWorkers.__homerollAddedWorkers;
  let rows = all.get(scope());
  if (!rows) {
    rows = new Map();
    all.set(scope(), rows);
  }
  return rows;
}

/** Reads this demo company's added workers from the shared store, oldest last. */
export async function loadAddedWorkers(): Promise<AddedWorker[]> {
  const rows = await rowStore().list<AddedWorker>("workers", scope());
  const current = cache();
  current.clear();
  for (const { data } of rows) current.set(data.accountId, data);
  return rows.map((r) => r.data);
}

export async function saveAddedWorker(worker: AddedWorker): Promise<void> {
  await rowStore().upsert("workers", scope(), worker.accountId, worker);
  cache().set(worker.accountId, worker);
}

export async function clearAddedWorkers(): Promise<void> {
  await rowStore().clear("workers", scope());
  cache().clear();
}

/** From the last load or save in this instance. Load first on any page that shows names. */
export function cachedAddedWorker(accountId: AccountId): AddedWorker | undefined {
  return cache().get(accountId);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random on purpose, never derived from the name (SPEC §7.2, rule R13). */
export function newWorkerAccountId(root: AccountId): AccountId {
  let name = "w-";
  for (let i = 0; i < 6; i += 1) name += ALPHABET[randomInt(ALPHABET.length)];
  return workerAccountId(name, root);
}
