/**
 * Every Homeroll account ID, built from the root account (SPEC §6). The root comes from
 * NEAR_ROOT_ACCOUNT; nothing else may hard-code an account ID.
 */

export type AccountId = string;

// NEAR account ID rules: 2-64 chars; parts of lowercase letters and digits, joined by "."
// and separated inside a part by single "-" or "_".
const ACCOUNT_ID_PATTERN = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

/** Pseudonymous worker name, generated randomly by the server (SPEC §7.2, rule R13). */
export const WORKER_NAME_PATTERN = /^w-[a-z0-9]{6}$/;

export interface HomerollAccounts {
  root: AccountId;
  /** The factory contract lives on the root itself. */
  factory: AccountId;
  tusdc: AccountId;
  pool: AccountId;
  payroll: AccountId;
  /** Invoice agent identity: function-call key only. */
  agent: AccountId;
  relayer: AccountId;
  /** Mock bank that settles invoices. */
  escrow: AccountId;
  /** Mock remittance partner. */
  payout: AccountId;
  /** Mock DuitNow off-ramp. */
  offramp: AccountId;
  /** Mock solver for cross-chain lender deposits (P1). */
  solver: AccountId;
}

export function isValidAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID_PATTERN.test(id);
}

export function homerollAccounts(root: AccountId): HomerollAccounts {
  assertValidAccountId(root);
  return {
    root,
    factory: root,
    tusdc: subAccount("tusdc", root),
    pool: subAccount("pool", root),
    payroll: subAccount("payroll", root),
    agent: subAccount("agent", root),
    relayer: subAccount("relayer", root),
    escrow: subAccount("escrow", root),
    payout: subAccount("payout", root),
    offramp: subAccount("offramp", root),
    solver: subAccount("solver", root),
  };
}

export function workerAccountId(name: string, root: AccountId): AccountId {
  if (!WORKER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid worker name "${name}": expected ${WORKER_NAME_PATTERN}`);
  }
  return subAccount(name, root);
}

function subAccount(name: string, parent: AccountId): AccountId {
  const id = `${name}.${parent}`;
  assertValidAccountId(id);
  return id;
}

function assertValidAccountId(id: string): void {
  if (!isValidAccountId(id)) {
    throw new Error(`Invalid NEAR account ID "${id}"`);
  }
}
