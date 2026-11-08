import { homerollAccounts } from "@homeroll/shared";
import type { RunFacts } from "@/app/owner/_components/run-state";
import { recentActivity } from "@/lib/activity";
import { loadAddedWorkers } from "@/lib/added-workers";
import { loadInvoiceResults } from "@/lib/agents";
import { type AdvanceOffer, type InvoiceAgentResult, offerFor } from "@/lib/agents/invoice-agent";
import { proposePayroll } from "@/lib/agents/payroll";
import { getEnv } from "@/lib/env";
import { truncateMiddle } from "@/lib/format";
import { formatUsdc, type Sen, sen, units, unitsToSen } from "@/lib/fx";
import { nameOrAccount } from "@/lib/names";
import { getChainClient, getFixtures } from "@/lib/near";
import type { AccessKeyView, Grade, LineStatus } from "@/lib/near/client";
import { period } from "@/lib/near/client";

export type PayLineStatus =
  | "Ready"
  | "Reserved"
  | "Sending"
  | "Paid"
  | "Skipped"
  | "Failed"
  | "Cancelled"
  | "On hold"
  | "Removed";

export interface PayLineRow {
  accountId: string;
  name: string;
  role: string;
  netSen: Sen;
  /** Overtime hours in the net wage, from the timesheet (SPEC §8.2). */
  overtimeHours?: number;
  capSen: Sen;
  status: PayLineStatus;
  /** A failed, skipped or cancelled line that can be paid in a new one-line run (SPEC §7.3). */
  missed?: boolean;
}

export interface PayeeRow {
  accountId: string;
  name: string;
  role: string;
  capSen: Sen;
  status: "Active" | "On hold" | "Removed";
  /** Milliseconds since the epoch when the 48-hour hold ends. */
  activeFromMs: number | null;
}

export interface InvoiceRow {
  number: string;
  buyer: string;
  amountSen: Sen;
  due: string;
  /** "Unchecked" until the invoice agent attests it on the pool. */
  status: "Unchecked" | "Attested" | "Advanced" | "Settled" | "Declined";
  /** The grade the pool holds, once attested. */
  grade: Grade | null;
  /** The agent's last run on this invoice: checks, grade, what the model said. */
  agent: InvoiceAgentResult | null;
  /** The pool's offer for this grade (advance, fee, what each side gets). */
  offer: AdvanceOffer | null;
  /** Taken advance and fee, once advanced. */
  advanceSen: Sen | null;
  feeSen: Sen | null;
}

export interface KeyRow {
  title: string;
  accountId: string;
  kind: "FullAccess" | "FunctionCall";
  receiver: string | null;
  methods: string[];
  allowance: string | null;
  cannot: string;
}

export interface ActivityRow {
  id: number;
  when: string;
  /** The button that started it, e.g. "Run payroll". */
  button: string | null;
  method: string;
  from: string;
  to: string;
  usdc: string | null;
  rmHint: Sen | null;
  failure: string | null;
  txHash: string | null;
  /** NearBlocks testnet page for the transaction. Null on the fake chain, whose hashes are made up. */
  explorerUrl: string | null;
}

/** The owner console's tabs. Invoices and agent keys are read from chain only on their own tab. */
export type OwnerTab = "pay-lines" | "invoices" | "workers" | "agent-keys" | "activity";

export interface OwnerView {
  mode: "fake" | "testnet";
  companyName: string;
  accountId: string;
  periodLabel: string;
  treasurySen: Sen;
  treasuryUsdc: string;
  bufferSen: Sen;
  facts: RunFacts;
  payLines: PayLineRow[];
  payees: PayeeRow[];
  onboarding: boolean;
  invoices: InvoiceRow[];
  keys: KeyRow[];
  activity: ActivityRow[];
  /** SPEC §9.1 dashboard figures. Read only on the Invoices tab (free RPCs rate-limit bursts). */
  figures: { advancedSen: Sen; poolCashSen: Sen } | null;
}

const STATUS_WORD: Record<LineStatus, PayLineStatus> = {
  Reserved: "Reserved",
  Sent: "Sending",
  Paid: "Paid",
  Failed: "Failed",
  Skipped: "Skipped",
  Cancelled: "Cancelled",
};

const time = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Kuala_Lumpur",
});

export async function loadOwnerView(tab: OwnerTab = "pay-lines"): Promise<OwnerView> {
  const chain = getChainClient();
  const fixtures = getFixtures();
  const employer = fixtures.company.accountId;
  const payrollPeriod = period(fixtures.company.period);
  const accounts = homerollAccounts(getEnv().root);

  // Each chain read once per page, and only what the open tab shows (free RPCs rate-limit bursts)
  const none = Promise.resolve([] as AccessKeyView[]);
  const [
    employerView,
    runs,
    payeeViews,
    ownerKeys,
    agentKeys,
    invoiceViews,
    pool,
    added,
    results,
    activityRows,
  ] = await Promise.all([
    chain.getEmployer(employer),
    chain.getRuns(employer, payrollPeriod),
    chain.getPayees(employer),
    tab === "agent-keys" ? chain.getAccessKeys(employer) : none,
    tab === "agent-keys" ? chain.getAccessKeys(accounts.agent) : none,
    tab === "invoices"
      ? Promise.all(fixtures.invoices.map((i) => chain.getInvoice(i.hash)))
      : Promise.resolve(fixtures.invoices.map(() => null)),
    // The Invoices tab's figures; no other tab pays for this read
    tab === "invoices" ? chain.getPool() : Promise.resolve(null),
    // Off-chain: the owner's added workers, so their names resolve below (lib/names)
    loadAddedWorkers(),
    tab === "invoices" ? loadInvoiceResults() : Promise.resolve(new Map()),
    tab === "activity" ? recentActivity() : Promise.resolve([]),
  ]);
  if (!employerView) throw new Error(`The chain does not know ${employer}`);

  // The line status of a worker is their line in the newest run that has one.
  const statusByAccount = new Map<string, LineStatus>();
  for (const run of runs ?? [])
    for (const l of run.lines) statusByAccount.set(l.accountId, l.status);

  const nowMs = Date.now();
  const proposal = await proposePayroll(chain, fixtures, payrollPeriod, nowMs, {
    payees: payeeViews,
    runs,
  });
  const excluded = new Map(proposal.excluded.map((e) => [e.accountId, e.reason]));

  const payLines: PayLineRow[] = fixtures.workers.map((w, i) => {
    const line = fixtures.timesheet[i];
    const lineStatus = statusByAccount.get(w.accountId);
    const reason = excluded.get(w.accountId);
    const unpaid =
      lineStatus === "Failed" || lineStatus === "Skipped" || lineStatus === "Cancelled";
    const status: PayLineStatus =
      reason === "not-a-payee"
        ? "Removed"
        : reason === "on-hold"
          ? "On hold"
          : lineStatus
            ? STATUS_WORD[lineStatus]
            : "Ready";
    return {
      accountId: w.accountId,
      name: nameOrAccount(w.accountId),
      role: w.role,
      netSen: sen(line?.amountSen ?? 0),
      overtimeHours: line?.overtimeHours ?? 0,
      capSen: sen(w.capSen),
      status,
      missed: unpaid && reason !== "not-a-payee",
    };
  });

  const payeeBy = new Map(payeeViews.map((p) => [p.accountId, p]));
  const nowNs = BigInt(nowMs) * 1_000_000n;
  const toPayeeRow = (accountId: string, role: string, capSen: Sen): PayeeRow => {
    const onChain = payeeBy.get(accountId);
    const onHold = onChain !== undefined && nowNs < onChain.activeFrom;
    return {
      accountId,
      name: nameOrAccount(accountId),
      role,
      capSen: onChain ? unitsToSen(onChain.cap, "nearest") : capSen,
      status: !onChain ? "Removed" : onHold ? "On hold" : "Active",
      activeFromMs: onHold ? Number(onChain.activeFrom / 1_000_000n) : null,
    };
  };
  const payees: PayeeRow[] = [
    ...added.map((w) => toPayeeRow(w.accountId, w.role, w.capSen)),
    ...fixtures.workers.map((w) => toPayeeRow(w.accountId, w.role, sen(w.capSen))),
  ];

  const pending = runs?.find((r) => r.status === "Pending");
  const doneRuns = runs?.filter((r) => r.status === "Done") ?? [];
  const paidLines = (runs ?? []).flatMap((r) => r.lines).filter((l) => l.status === "Paid");
  const missedCount = [...statusByAccount.values()].filter(
    (l) => l === "Failed" || l === "Skipped" || l === "Cancelled",
  ).length;

  const facts: RunFacts = {
    period: fixtures.company.period,
    lineCount: proposal.lines.length + proposal.held.length,
    totalSen: proposal.remainingSen,
    periodTotalSen: sen(proposal.remainingSen + proposal.heldSen),
    treasurySen: unitsToSen(employerView.treasury, "nearest"),
    bufferSen: unitsToSen(employerView.buffer, "nearest"),
    heldCount: proposal.held.length,
    pendingRun: pending
      ? {
          runId: pending.runId,
          paid: pending.lines.filter((l) => l.status !== "Reserved").length,
          total: pending.lines.length,
        }
      : null,
    // Done only when nothing is left to propose. A missed worker past their hold shows Run payroll.
    doneRun:
      doneRuns.length > 0 && proposal.lines.length === 0 && !pending
        ? {
            total: unitsToSen(units(paidLines.reduce((s, l) => s + l.amount, 0n)), "nearest"),
            lineCount: paidLines.length,
            missed: missedCount,
          }
        : null,
  };

  const invoices: InvoiceRow[] = fixtures.invoices.map((inv, i) => {
    const onChain = invoiceViews[i] ?? null;
    const grade = onChain?.grade ?? null;
    return {
      number: inv.number,
      buyer: inv.buyer,
      amountSen: sen(inv.amountSen),
      due: inv.due,
      status: onChain?.status ?? "Unchecked",
      grade,
      agent: results.get(inv.number) ?? null,
      offer: grade ? offerFor(sen(inv.amountSen), grade) : null,
      advanceSen: onChain?.advance ? unitsToSen(onChain.advance, "nearest") : null,
      feeSen: onChain?.fee ? unitsToSen(onChain.fee, "nearest") : null,
    };
  });

  return {
    mode: chain.network === "fake" ? "fake" : "testnet",
    companyName: fixtures.company.name,
    accountId: employer,
    periodLabel: "October",
    treasurySen: facts.treasurySen,
    treasuryUsdc: `≈ ${formatUsdc(employerView.treasury)}`,
    bufferSen: facts.bufferSen,
    facts,
    payLines,
    payees,
    onboarding: employerView.onboarding,
    figures: pool
      ? {
          advancedSen: unitsToSen(
            units(
              invoiceViews.reduce(
                (sum, i) => sum + (i?.status === "Advanced" && i.advance ? i.advance : 0n),
                0n,
              ),
            ),
            "nearest",
          ),
          poolCashSen: unitsToSen(pool.cash, "nearest"),
        }
      : null,
    invoices,
    keys: [...agentKeysFor(ownerKeys), ...agentKeysFor(agentKeys)],
    activity: activityRows.map((a) => ({
      id: a.id,
      when: time.format(a.at),
      button: a.action,
      method: a.method,
      from: truncateMiddle(a.from),
      to: truncateMiddle(a.to),
      usdc: a.amount === null ? null : formatUsdc(units(a.amount)),
      rmHint: a.amount === null ? null : unitsToSen(units(a.amount), "nearest"),
      failure: a.failure,
      txHash: a.txHash,
      explorerUrl:
        chain.network === "testnet" && a.txHash
          ? `https://testnet.nearblocks.io/txns/${a.txHash}`
          : null,
    })),
  };
}

const CANNOT: Record<string, string> = {
  FullAccess: "Nothing is held back. This key stays on the server and never reaches the browser.",
  submit_run:
    "Call tusdc at all. Call add_payee, remove_payee, update_cap, withdraw or cancel_run. Attach any deposit, so it can never satisfy ft_transfer's 1-yocto requirement.",
  attest_invoice: "Request advances, change the grade table, or move pool funds.",
};

function agentKeysFor(keys: AccessKeyView[]): KeyRow[] {
  return keys.map((k) => {
    if (k.permission.kind === "FullAccess") {
      return {
        title: "Owner key",
        accountId: k.accountId,
        kind: "FullAccess",
        receiver: null,
        methods: [],
        allowance: null,
        cannot: CANNOT.FullAccess ?? "",
      };
    }
    const first = k.permission.methodNames[0] ?? "";
    return {
      title: first === "attest_invoice" ? "Invoice agent" : "Payroll agent",
      accountId: k.accountId,
      kind: "FunctionCall",
      receiver: k.permission.receiverId,
      methods: k.permission.methodNames,
      allowance:
        k.permission.allowance === null ? null : `${k.permission.allowance / 10n ** 24n} NEAR`,
      cannot: CANNOT[first] ?? "",
    };
  });
}
