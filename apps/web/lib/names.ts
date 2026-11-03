import { type WorkerNameRecord, workerName } from "@homeroll/fixtures";
import type { AccountId } from "@homeroll/shared";

/**
 * Off-chain name lookup (SPEC §12, rule R13). The chain only ever sees `w-xxxxxx.<root>`.
 * Call this at render time on the server; never put a name in an account ID, event, log or error.
 */
export function nameOf(accountId: AccountId): WorkerNameRecord | null {
  return workerName(accountId);
}

/** The worker's name, or the account ID itself when Homeroll has no name for it. */
export function nameOrAccount(accountId: AccountId): string {
  return workerName(accountId)?.displayName ?? accountId;
}
