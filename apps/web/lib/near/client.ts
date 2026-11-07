import type { AccountId, ContractError } from "@homeroll/shared";
import type { Units } from "@/lib/fx";

/**
 * The one way the app talks to NEAR (SPEC §8.8). `FakeChainClient` and `NearChainClient` both
 * implement it and both pass `client.suite.ts`. Names mirror SPEC §7.3 and §7.4.
 *
 * Failures are values: a call the contract or the protocol rejects returns `{ ok: false }`.
 * Only a bug or an unreachable chain throws.
 */

export type { Units };

/** Calendar month a payroll run pays for, exactly YYYY-MM (GLOSSARY: period). */
export type Period = string & { readonly __period: "Period" };

export function period(value: string): Period {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`Not a YYYY-MM period: "${value}"`);
  return value as Period;
}

export type Signer =
  | { role: "owner"; accountId: AccountId }
  /** Signs as the employer with the function-call key: payroll.submit_run and pay_run only (SPEC §6). */
  | { role: "payrollAgent"; accountId: AccountId }
  /** agent.<root> with its function-call key: pool.attest_invoice only (SPEC §6). */
  | { role: "invoiceAgent"; accountId: AccountId }
  /** escrow.<root>, the mock bank that settles invoices when the buyer pays (SPEC §8.6). */
  | { role: "settler"; accountId: AccountId }
  | { role: "worker"; accountId: AccountId }
  | { role: "lender"; accountId: AccountId }
  /** solver.<root>, the mock solver that delivers cross-chain lender deposits (SPEC §8.9). */
  | { role: "solver"; accountId: AccountId };

export type LineStatus = "Reserved" | "Sent" | "Paid" | "Failed" | "Skipped" | "Cancelled";
export type RunStatus = "Pending" | "Done" | "Cancelled";

export interface PayLine {
  accountId: AccountId;
  amount: Units;
}
export interface RunView {
  runId: number;
  period: Period;
  status: RunStatus;
  lines: (PayLine & { status: LineStatus })[];
}
export interface EmployerView {
  treasury: Units;
  buffer: Units;
  onboarding: boolean;
  payeeCount: number;
}
export interface PayeeView {
  accountId: AccountId;
  cap: Units;
  activeFrom: bigint;
}
export type InvoiceStatus = "Attested" | "Advanced" | "Settled" | "Declined";
export type Grade = "A" | "B" | "C" | "D";
export interface InvoiceView {
  /** The invoice hash (SPEC §7.4), hex. */
  invoiceKey: string;
  employer: AccountId;
  amount: Units;
  grade: Grade;
  status: InvoiceStatus;
  advance: Units | null;
  fee: Units | null;
}
/** Arguments of `pool.attest_invoice` (SPEC §7.4). Hashes only; raw invoice data stays off-chain. */
export interface Attestation {
  invoiceKey: string;
  employer: AccountId;
  buyerHash: string;
  amount: Units;
  /** Nanoseconds. */
  dueTs: bigint;
  grade: Grade;
  attestationRef: string;
}
export type SettleOutcome = { settled: true; invoice: InvoiceView } | { settled: false };
export interface PoolView {
  cash: Units;
  outstanding: Units;
  feesEarned: Units;
  /** Shares are not money: a lender's value is shares × (cash + outstanding) / totalShares. */
  totalShares: bigint;
  /** R15: a new lender's first deposit must be at least this. */
  minFirstDeposit: Units;
}
/** `pool.get_lender`. Null means the pool has never seen the account (it is a new lender, R15). */
export interface LenderView {
  shares: bigint;
  /** Assets of a withdrawal still being paid out. */
  pendingAssets: Units | null;
}

export type KeyPermission =
  | { kind: "FullAccess" }
  | {
      kind: "FunctionCall";
      receiverId: AccountId;
      methodNames: string[];
      allowance: bigint | null;
    };
export interface AccessKeyView {
  accountId: AccountId;
  publicKey: string;
  permission: KeyPermission;
}

export type ProtocolFailureName =
  | "RequiresFullAccess"
  | "DepositWithFunctionCall"
  | "ReceiverMismatch"
  | "MethodNameMismatch";

export type TxFailure =
  | { kind: "contract"; error: ContractError }
  | { kind: "protocol"; name: ProtocolFailureName };

export type Tx<T> =
  | { ok: true; txHash: string; value: T }
  | { ok: false; txHash: string | null; failure: TxFailure };

export interface ChainClient {
  readonly network: "fake" | "testnet";

  // Views
  getEmployer(employer: AccountId): Promise<EmployerView | null>;
  getPayees(employer: AccountId): Promise<PayeeView[]>;
  /** `null` for an unknown employer, `[]` when it has no run for `period`. Oldest run first. */
  getRuns(employer: AccountId, period: Period): Promise<RunView[] | null>;
  getInvoice(invoiceKey: string): Promise<InvoiceView | null>;
  getPool(): Promise<PoolView>;
  getLender(accountId: AccountId): Promise<LenderView | null>;
  ftBalanceOf(accountId: AccountId): Promise<Units>;
  getAccessKeys(accountId: AccountId): Promise<AccessKeyView[]>;

  // Calls
  submitRun(signer: Signer, period: Period, lines: PayLine[]): Promise<Tx<{ runId: number }>>;
  payRun(signer: Signer, runId: number): Promise<Tx<RunView>>;
  /** Owner's key only. During onboarding a payee is active at once, after it the 48-hour hold applies (R3). */
  addPayee(signer: Signer, accountId: AccountId, cap: Units): Promise<Tx<PayeeView>>;
  /** Owner's key only. Their lines not yet sent are skipped by `pay_run`. */
  removePayee(signer: Signer, accountId: AccountId): Promise<Tx<null>>;
  /** Owner's key only. Every `Reserved` line becomes `Cancelled` and its money returns to the treasury. */
  cancelRun(signer: Signer, runId: number): Promise<Tx<RunView>>;
  /** Invoice agent registers a checked invoice (R7, R10). */
  attestInvoice(signer: Signer, attestation: Attestation): Promise<Tx<InvoiceView>>;
  requestAdvance(signer: Signer, invoiceKey: string, amount: Units): Promise<Tx<InvoiceView>>;
  /**
   * The mock bank forwards the buyer's payment (`ft_transfer_call` with `{"settle":…}`): the pool
   * keeps advance + fee and sends the rest to the employer's treasury (SPEC §7.4, R10).
   *
   * The pool has two kinds of no here. An unknown settler panics in `ft_on_transfer` with
   * `ERR_NOT_SETTLER`: a failed Tx (near mode reads it from the receipts, since the token refunds
   * and the outer call succeeds). An invoice that is not advanced, or a payment below advance +
   * fee, is refunded with no error at all: `{ settled: false }` on a successful Tx.
   */
  settleInvoice(signer: Signer, invoiceKey: string, paid: Units): Promise<Tx<SettleOutcome>>;
  /** Worker transfer to payout.<root> or offramp.<root>. In near mode it goes through the relayer (SPEC §8.3). */
  ftTransfer(signer: Signer, receiverId: AccountId, amount: Units, memo: string): Promise<Tx<null>>;
  /**
   * Mock delivery of a cross-chain deposit (SPEC §8.9): solver.<root> sends tUSDC to a lender's
   * account. Only `lib/deposit` calls it, after the R16 checks.
   */
  deliverFromSolver(lender: AccountId, amount: Units): Promise<Tx<null>>;
  /**
   * The lender's `ft_transfer_call(pool, amount, {"deposit":{}})`. `shares: 0n` means the pool
   * refunded it with no error. A new lender's deposit below the floor fails with
   * `ERR_DEPOSIT_TOO_SMALL` (R15), read from the receipts as in `settleInvoice`.
   */
  depositToPool(signer: Signer, amount: Units): Promise<Tx<{ shares: bigint }>>;
  /** SPEC §9.6. Fake restores fixtures; near runs provisionDemoCompany. resetDemoEverywhere calls this. */
  resetDemo(): Promise<{ employer: AccountId }>;
}
