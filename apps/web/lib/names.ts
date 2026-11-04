import { type WorkerNameRecord, workerName } from "@homeroll/fixtures";
import type { AccountId } from "@homeroll/shared";
import { addedWorkers } from "@/lib/added-workers";

/**
 * Off-chain name lookup (SPEC §12, rule R13). The chain only ever sees `w-xxxxxx.<root>`.
 * Call this at render time on the server; never put a name in an account ID, event, log or error.
 */
export function nameOf(accountId: AccountId): WorkerNameRecord | null {
  const added = addedWorkers().get(accountId);
  if (added) return { displayName: added.displayName, possessive: "their" };
  return workerName(accountId);
}

/** The worker's name, or the account ID itself when Homeroll has no name for it. */
export function nameOrAccount(accountId: AccountId): string {
  return nameOf(accountId)?.displayName ?? accountId;
}
