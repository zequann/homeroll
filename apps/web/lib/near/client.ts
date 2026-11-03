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
  | { role: "worker"; accountId: AccountId }
  | { role: "lender"; accountId: AccountId };

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
export interface InvoiceView {
  invoiceKey: string;
  employer: AccountId;
  amount: Units;
  grade: "A" | "B" | "C" | "D";
  status: InvoiceStatus;
  advance: Units | null;
  fee: Units | null;
}
export interface PoolView {
  cash: Units;
  outstanding: Units;
  feesEarned: Units;
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
  ftBalanceOf(accountId: AccountId): Promise<Units>;
  getAccessKeys(accountId: AccountId): Promise<AccessKeyView[]>;

  // Calls
  submitRun(signer: Signer, period: Period, lines: PayLine[]): Promise<Tx<{ runId: number }>>;
  payRun(signer: Signer, runId: number): Promise<Tx<RunView>>;
  requestAdvance(signer: Signer, invoiceKey: string, amount: Units): Promise<Tx<InvoiceView>>;
  /** Worker transfer to payout.<root> or offramp.<root>. In near mode it goes through the relayer (SPEC §8.3). */
  ftTransfer(signer: Signer, receiverId: AccountId, amount: Units, memo: string): Promise<Tx<null>>;
  /** SPEC §9.6. Fake restores fixtures; near calls the on-chain dev's /api/demo route. */
  resetDemo(): Promise<{ employer: AccountId }>;
}
