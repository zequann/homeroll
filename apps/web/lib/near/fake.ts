import type { Fixtures } from "@homeroll/fixtures";
import {
  type AccountId,
  type ContractError,
  type ContractErrorCode,
  type HomerollAccounts,
  homerollAccounts,
} from "@homeroll/shared";
import { type ActivityLog, getActivityLog } from "@/lib/activity";
import { sen, senToUnits, type Units, units } from "@/lib/fx";
import type {
  AccessKeyView,
  ChainClient,
  EmployerView,
  InvoiceView,
  LineStatus,
  PayeeView,
  PayLine,
  Period,
  PoolView,
  RunStatus,
  RunView,
  Signer,
  Tx,
  TxFailure,
} from "./client";
import { failureText } from "./failure";

/** Placeholder until Q3 measures the real number (SPEC §7.3). Rahim is line 0, so he is in call 1. */
export const FAKE_MAX_LINES_PER_CALL = 10;
/** The demo floor (SPEC §7.3 initial config). */
const MAX_LINES_PER_RUN = 40;
/** Hard cap on any advance, in code (SPEC §7.4). */
const HARD_MAX_ADVANCE_BPS = 8000n;
const YOCTO_PER_NEAR = 10n ** 24n;

type Grade = InvoiceView["grade"];

interface FakeRunLine extends PayLine {
  status: LineStatus;
}
interface FakeRun {
  period: Period;
  lines: FakeRunLine[];
}
interface FakeInvoice {
  invoiceKey: string;
  employer: AccountId;
  amount: Units;
  grade: Grade;
  status: InvoiceView["status"];
  advanceBps: number;
  feeBps: number;
  advance: Units | null;
  fee: Units | null;
}
interface FakeState {
  employer: AccountId;
  treasury: Units;
  buffer: Units;
  onboarding: boolean;
  payees: Map<AccountId, { cap: Units; activeFrom: bigint }>;
  runs: FakeRun[];
  invoices: Map<string, FakeInvoice>;
  pool: { cash: Units; outstanding: Units; feesEarned: Units };
  balances: Map<AccountId, Units>;
  txCounter: number;
}

export interface FakeChainOptions {
  fixtures: Fixtures;
  /** Milliseconds since the epoch. Injectable so R14 can be tested. */
  now?: () => number;
  activity?: ActivityLog;
}

/**
 * Fixture-backed chain that simulates the payroll and pool rules (SPEC §7.3, §7.4) with the
 * exact error codes. A failing call changes nothing. Protocol checks on access keys (SPEC §6)
 * are not simulated beyond the one `request_advance` case below.
 */
export class FakeChainClient implements ChainClient {
  readonly network = "fake" as const;

  private readonly fixtures: Fixtures;
  private readonly accounts: HomerollAccounts;
  private readonly now: () => number;
  private readonly activity: ActivityLog;
  private state: FakeState;

  constructor(options: FakeChainOptions) {
    this.fixtures = options.fixtures;
    this.accounts = homerollAccounts(options.fixtures.root);
    this.now = options.now ?? Date.now;
    this.activity = options.activity ?? getActivityLog();
    this.state = this.initialState();
  }

  // ---- Views -------------------------------------------------------------------------

  async getEmployer(employer: AccountId): Promise<EmployerView | null> {
    if (employer !== this.state.employer) return null;
    const s = this.state;
    return {
      treasury: s.treasury,
      buffer: s.buffer,
      onboarding: s.onboarding,
      payeeCount: s.payees.size,
    };
  }

  async getPayees(employer: AccountId): Promise<PayeeView[]> {
    if (employer !== this.state.employer) return [];
    return [...this.state.payees].map(([accountId, p]) => ({ accountId, ...p }));
  }

  async getRuns(employer: AccountId, period: Period): Promise<RunView[] | null> {
    if (employer !== this.state.employer) return null;
    return this.state.runs.flatMap((run, runId) =>
      run.period === period ? [toView(run, runId)] : [],
    );
  }

  async getInvoice(invoiceKey: string): Promise<InvoiceView | null> {
    const invoice = this.state.invoices.get(invoiceKey);
    return invoice ? toInvoiceView(invoice) : null;
  }

  async getPool(): Promise<PoolView> {
    return { ...this.state.pool };
  }

  async ftBalanceOf(accountId: AccountId): Promise<Units> {
    return this.state.balances.get(accountId) ?? units(0n);
  }

  async getAccessKeys(accountId: AccountId): Promise<AccessKeyView[]> {
    const allowance = YOCTO_PER_NEAR;
    if (accountId === this.state.employer) {
      return [
        { accountId, publicKey: "ed25519:fake-owner-key", permission: { kind: "FullAccess" } },
        {
          accountId,
          publicKey: "ed25519:fake-payroll-agent-key",
          permission: {
            kind: "FunctionCall",
            receiverId: this.accounts.payroll,
            methodNames: ["submit_run", "pay_run"],
            allowance,
          },
        },
      ];
    }
    if (accountId === this.accounts.agent) {
      return [
        {
          accountId,
          publicKey: "ed25519:fake-invoice-agent-key",
          permission: {
            kind: "FunctionCall",
            receiverId: this.accounts.pool,
            methodNames: ["attest_invoice"],
            allowance,
          },
        },
      ];
    }
    return [];
  }

  // ---- Calls -------------------------------------------------------------------------

  async submitRun(
    signer: Signer,
    period: Period,
    lines: PayLine[],
  ): Promise<Tx<{ runId: number }>> {
    const s = this.state;
    const total = lines.reduce((sum, l) => sum + l.amount, 0n);
    const fail = (failure: TxFailure) =>
      this.reject("submit_run", signer, this.accounts.payroll, units(total), failure);

    if (!this.isEmployer(signer)) return fail(rejectCode("ERR_NOT_EMPLOYER"));

    // Checks 1 to 7 of SPEC §7.3, in order. Each check finishes for every line before the next.
    // 1: line limit
    if (lines.length > MAX_LINES_PER_RUN) return fail(rejectCode("ERR_TOO_MANY_LINES"));
    // R14: period is the current or previous UTC month, written exactly YYYY-MM
    if (!this.isOpenPeriod(period)) return fail(rejectCode("ERR_PERIOD_NOT_OPEN"));

    const nowNs = BigInt(this.now()) * 1_000_000n;
    // R3: every payee exists and is past its hold
    const inactive = lines.findIndex((l) => {
      const payee = s.payees.get(l.accountId);
      return !payee || nowNs < payee.activeFrom;
    });
    if (inactive >= 0) return fail(rejectLine("ERR_PAYEE_NOT_ACTIVE", inactive, lines));

    // R4: wage <= wage cap
    const overCap = lines.findIndex((l) => l.amount > (s.payees.get(l.accountId)?.cap ?? 0n));
    if (overCap >= 0) return fail(rejectLine("ERR_ABOVE_WAGE_CAP", overCap, lines));

    // R5: each account once per run; the error names the later of the two lines
    const seen = new Set<AccountId>();
    const duplicate = lines.findIndex((l) => {
      if (seen.has(l.accountId)) return true;
      seen.add(l.accountId);
      return false;
    });
    if (duplicate >= 0) return fail(rejectLine("ERR_DUPLICATE_PAYEE", duplicate, lines));

    // R5: a payee holds the period while any run has a Reserved, Sent or Paid line for them
    const held = lines.findIndex((l) => this.holdsPeriod(l.accountId, period));
    if (held >= 0) return fail(rejectLine("ERR_ALREADY_PAID", held, lines));

    // R6: treasury stays above the buffer
    if (s.treasury < s.buffer || total > s.treasury - s.buffer) {
      return fail(rejectCode("ERR_BELOW_BUFFER"));
    }

    // 8: reserve
    s.treasury = units(s.treasury - total);
    s.runs.push({ period, lines: lines.map((l) => ({ ...l, status: "Reserved" })) });
    s.onboarding = false;
    const runId = s.runs.length - 1;
    const txHash = this.nextTxHash();
    this.log("submit_run", signer, this.accounts.payroll, units(total), txHash, null);
    return { ok: true, txHash, value: { runId } };
  }

  async payRun(signer: Signer, runId: number): Promise<Tx<RunView>> {
    const s = this.state;
    const run = s.runs[runId];
    const fail = (failure: TxFailure) =>
      this.reject("pay_run", signer, this.accounts.payroll, null, failure);

    if (!this.isEmployer(signer)) return fail(rejectCode("ERR_NOT_EMPLOYER"));
    if (!run) return fail(rejectCode("ERR_RUN_NOT_FOUND"));
    if (!run.lines.some((l) => l.status === "Reserved"))
      return fail(rejectCode("ERR_RUN_COMPLETE"));

    const nowNs = BigInt(this.now()) * 1_000_000n;
    let paid = 0n;
    for (const line of run.lines
      .filter((l) => l.status === "Reserved")
      .slice(0, FAKE_MAX_LINES_PER_CALL)) {
      const payee = s.payees.get(line.accountId);
      if (!payee || nowNs < payee.activeFrom) {
        // R3: a payee removed or on hold before payment is skipped and the money returns
        line.status = "Skipped";
        s.treasury = units(s.treasury + line.amount);
        continue;
      }
      // The real contract goes Sent, then Paid in a callback. The fake settles in one step.
      line.status = "Paid";
      s.balances.set(line.accountId, units((s.balances.get(line.accountId) ?? 0n) + line.amount));
      paid += line.amount;
    }
    const txHash = this.nextTxHash();
    this.log("pay_run", signer, this.accounts.payroll, units(paid), txHash, null);
    return { ok: true, txHash, value: toView(run, runId) };
  }

  async requestAdvance(
    signer: Signer,
    invoiceKey: string,
    amount: Units,
  ): Promise<Tx<InvoiceView>> {
    const s = this.state;
    const invoice = s.invoices.get(invoiceKey);
    if (!invoice) throw new Error(`Unknown invoice "${invoiceKey}"`);
    const fail = (failure: TxFailure) =>
      this.reject("request_advance", signer, this.accounts.pool, amount, failure);

    // The payroll agent's key may only call payroll.*; NEAR rejects pool.* before our code runs.
    if (signer.role === "payrollAgent") return fail({ kind: "protocol", name: "ReceiverMismatch" });
    // Only the invoice's employer may ask for the advance
    if (signer.role !== "owner" || signer.accountId !== invoice.employer) {
      return fail(rejectCode("ERR_NOT_EMPLOYER"));
    }
    // R7: one invoice, one advance. A declined invoice has a cap of zero (R8).
    if (invoice.status === "Declined") return fail(rejectCode("ERR_ADVANCE_ABOVE_CAP"));
    if (invoice.status !== "Attested") return fail(rejectCode("ERR_INVOICE_ALREADY_REGISTERED"));
    // R8: advance <= invoice * min(grade cap, 80%)
    if (amount > maxAdvance(invoice)) return fail(rejectCode("ERR_ADVANCE_ABOVE_CAP"));
    if (s.pool.cash < amount) return fail(rejectCode("ERR_POOL_INSUFFICIENT"));

    s.pool.cash = units(s.pool.cash - amount);
    s.pool.outstanding = units(s.pool.outstanding + amount);
    s.treasury = units(s.treasury + amount);
    invoice.status = "Advanced";
    invoice.advance = amount;
    invoice.fee = units((amount * BigInt(invoice.feeBps) + 9_999n) / 10_000n);
    const txHash = this.nextTxHash();
    this.log("request_advance", signer, this.accounts.pool, amount, txHash, null);
    return { ok: true, txHash, value: toInvoiceView(invoice) };
  }

  async ftTransfer(
    signer: Signer,
    receiverId: AccountId,
    amount: Units,
    _memo: string,
  ): Promise<Tx<null>> {
    const s = this.state;
    const balance = s.balances.get(signer.accountId) ?? units(0n);
    // An overdraft is a caller bug (the UI checks first), not one of our contract errors.
    if (amount <= 0n || amount > balance) {
      throw new Error(`ft_transfer: ${signer.accountId} cannot send that amount`);
    }
    s.balances.set(signer.accountId, units(balance - amount));
    s.balances.set(receiverId, units((s.balances.get(receiverId) ?? 0n) + amount));
    const txHash = this.nextTxHash();
    this.log("ft_transfer", signer, receiverId, amount, txHash, null);
    return { ok: true, txHash, value: null };
  }

  async resetDemo(): Promise<{ employer: AccountId }> {
    this.state = this.initialState();
    this.activity.clear();
    return { employer: this.state.employer };
  }

  // ---- Internals ---------------------------------------------------------------------

  private initialState(): FakeState {
    const { company, workers, invoices, lender } = this.fixtures;
    return {
      employer: company.accountId,
      treasury: senToUnits(sen(company.treasurySen)),
      buffer: senToUnits(sen(company.bufferSen)),
      onboarding: true,
      payees: new Map(
        workers.map((w) => [w.accountId, { cap: senToUnits(sen(w.capSen)), activeFrom: 0n }]),
      ),
      runs: [],
      invoices: new Map(
        invoices.map((i) => [
          i.number,
          {
            invoiceKey: i.number,
            employer: company.accountId,
            amount: senToUnits(sen(i.amountSen)),
            grade: i.grade,
            status: i.grade === "D" ? "Declined" : "Attested",
            advanceBps: i.advanceBps,
            feeBps: i.feeBps,
            advance: null,
            fee: null,
          },
        ]),
      ),
      pool: {
        cash: units(BigInt(lender.depositUsdc) * 1_000_000n),
        outstanding: units(0n),
        feesEarned: units(0n),
      },
      balances: new Map(),
      txCounter: 0,
    };
  }

  private isEmployer(signer: Signer): boolean {
    return (
      (signer.role === "owner" || signer.role === "payrollAgent") &&
      signer.accountId === this.state.employer
    );
  }

  private isOpenPeriod(value: string): boolean {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
    const now = new Date(this.now());
    const current = monthKey(now.getUTCFullYear(), now.getUTCMonth());
    const previous = monthKey(now.getUTCFullYear(), now.getUTCMonth() - 1);
    return value === current || value === previous;
  }

  private holdsPeriod(accountId: AccountId, period: Period): boolean {
    return this.state.runs.some(
      (run) =>
        run.period === period &&
        run.lines.some(
          (l) =>
            l.accountId === accountId &&
            (l.status === "Reserved" || l.status === "Sent" || l.status === "Paid"),
        ),
    );
  }

  private nextTxHash(): string {
    this.state.txCounter += 1;
    return `fake-tx-${this.state.txCounter.toString(16).padStart(6, "0")}`;
  }

  private log(
    method: string,
    signer: Signer,
    to: AccountId,
    amount: Units | null,
    txHash: string | null,
    failure: TxFailure | null,
  ): void {
    this.activity.record({
      at: this.now(),
      method,
      from: signer.accountId,
      to,
      amount,
      txHash,
      failure: failure ? failureText(failure) : null,
    });
  }

  /** A rejected call is logged like any other and changes nothing. */
  private reject(
    method: string,
    signer: Signer,
    to: AccountId,
    amount: Units | null,
    failure: TxFailure,
  ): Tx<never> {
    this.log(method, signer, to, amount, null, failure);
    return { ok: false, txHash: null, failure };
  }
}

function rejectCode(code: ContractErrorCode): TxFailure {
  return { kind: "contract", error: { code } };
}

function rejectLine(code: ContractErrorCode, index: number, lines: PayLine[]): TxFailure {
  const accountId = lines[index]?.accountId;
  if (accountId === undefined) throw new Error("rejectLine: index out of range");
  const error: ContractError = { code, line: { index, accountId } };
  return { kind: "contract", error };
}

function monthKey(year: number, monthIndex: number): string {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function runStatus(run: FakeRun): RunStatus {
  if (run.lines.some((l) => l.status === "Reserved")) return "Pending";
  if (run.lines.some((l) => l.status === "Cancelled")) return "Cancelled";
  return "Done";
}

function toView(run: FakeRun, runId: number): RunView {
  return {
    runId,
    period: run.period,
    status: runStatus(run),
    lines: run.lines.map((l) => ({ ...l })),
  };
}

function maxAdvance(invoice: FakeInvoice): Units {
  const bps = BigInt(invoice.advanceBps);
  const capped = bps < HARD_MAX_ADVANCE_BPS ? bps : HARD_MAX_ADVANCE_BPS;
  return units((invoice.amount * capped) / 10_000n);
}

function toInvoiceView(i: FakeInvoice): InvoiceView {
  return {
    invoiceKey: i.invoiceKey,
    employer: i.employer,
    amount: i.amount,
    grade: i.grade,
    status: i.status,
    advance: i.advance,
    fee: i.fee,
  };
}
