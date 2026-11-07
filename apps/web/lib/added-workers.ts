import { randomInt } from "node:crypto";
import { type AccountId, workerAccountId } from "@homeroll/shared";
import type { Sen } from "@/lib/fx";
import { getFixtures } from "@/lib/near";
import { cacheForEmployer, type EmployerCache } from "@/lib/near/demo-company";

/**
 * Workers the owner added in this demo: the off-chain half of the `workers` table (SPEC §8.7), in
 * memory until Supabase is wired. The only place the name ↔ account link lives (rule R13).
 */
export interface AddedWorker {
  accountId: AccountId;
  displayName: string;
  role: string;
  capSen: Sen;
}

const globalForWorkers = globalThis as unknown as {
  __homerollAddedWorkers?: EmployerCache<Map<AccountId, AddedWorker>>;
};

export function addedWorkers(): Map<AccountId, AddedWorker> {
  globalForWorkers.__homerollAddedWorkers ??= new Map();
  return cacheForEmployer(
    globalForWorkers.__homerollAddedWorkers,
    getFixtures().company.accountId,
    () => new Map(),
  );
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random on purpose, never derived from the name (SPEC §7.2, rule R13). */
export function newWorkerAccountId(root: AccountId): AccountId {
  let name = "w-";
  for (let i = 0; i < 6; i += 1) name += ALPHABET[randomInt(ALPHABET.length)];
  return workerAccountId(name, root);
}
