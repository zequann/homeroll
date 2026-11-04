import { homerollAccounts } from "@homeroll/shared";
import type { RunFacts } from "@/app/owner/_components/run-state";
import { getActivityLog } from "@/lib/activity";
import { invoiceResults } from "@/lib/agents";
import { type AdvanceOffer, type InvoiceAgentResult, offerFor } from "@/lib/agents/invoice-agent";
import { getEnv } from "@/lib/env";
import { truncateMiddle } from "@/lib/format";
import { formatUsdc, type Sen, sen, senToUnits, units, unitsToSen } from "@/lib/fx";
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
  | "Cancelled";

export interface PayLineRow {
  accountId: string;
  name: string;
  role: string;
  netSen: Sen;
  capSen: Sen;
  status: PayLineStatus;
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
  method: string;
  from: string;
  to: string;
  usdc: string | null;
  rmHint: Sen | null;
  failure: string | null;
}

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
  invoices: InvoiceRow[];
  keys: KeyRow[];
  activity: ActivityRow[];
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

export async function loadOwnerView(): Promise<OwnerView> {
  const chain = getChainClient();
  const fixtures = getFixtures();
  const employer = fixtures.company.accountId;
  const payrollPeriod = period(fixtures.company.period);
  const accounts = homerollAccounts(getEnv().root);

  const [employerView, runs, ownerKeys, agentKeys, ...invoiceViews] = await Promise.all([
    chain.getEmployer(employer),
    chain.getRuns(employer, payrollPeriod),
    chain.getAccessKeys(employer),
    chain.getAccessKeys(accounts.agent),
    ...fixtures.invoices.map((i) => chain.getInvoice(i.hash)),
  ]);
  if (!employerView) throw new Error(`The chain does not know ${employer}`);

  // The line status of a worker is their line in the newest run that has one.
  const statusByAccount = new Map<string, LineStatus>();
  for (const run of runs ?? [])
    for (const l of run.lines) statusByAccount.set(l.accountId, l.status);

  const payLines: PayLineRow[] = fixtures.workers.map((w, i) => {
    const line = fixtures.timesheet[i];
    const status = statusByAccount.get(w.accountId);
    return {
      accountId: w.accountId,
      name: nameOrAccount(w.accountId),
      role: w.role,
      netSen: sen(line?.amountSen ?? 0),
      capSen: sen(w.capSen),
      status: status ? STATUS_WORD[status] : "Ready",
    };
  });

  const totalUnits = fixtures.timesheet.reduce((s, l) => s + senToUnits(sen(l.amountSen)), 0n);
  const held = [...statusByAccount.values()].filter(
    (s) => s === "Reserved" || s === "Sent" || s === "Paid",
  ).length;
  const pending = runs?.find((r) => r.status === "Pending");
  const done = runs?.find((r) => r.status === "Done");

  const facts: RunFacts = {
    period: fixtures.company.period,
    lineCount: fixtures.timesheet.length,
    totalSen: unitsToSen(units(totalUnits), "nearest"),
    treasurySen: unitsToSen(employerView.treasury, "nearest"),
    bufferSen: unitsToSen(employerView.buffer, "nearest"),
    heldCount: held,
    pendingRun: pending
      ? {
          runId: pending.runId,
          paid: pending.lines.filter((l) => l.status !== "Reserved").length,
          total: pending.lines.length,
        }
      : null,
    doneRun: done
      ? {
          total: unitsToSen(units(done.lines.reduce((s, l) => s + l.amount, 0n)), "nearest"),
          lineCount: done.lines.length,
        }
      : null,
  };

  const results = invoiceResults();
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
    invoices,
    keys: [...agentKeysFor(ownerKeys), ...agentKeysFor(agentKeys)],
    activity: getActivityLog()
      .list()
      .map((a) => ({
        id: a.id,
        when: time.format(a.at),
        method: a.method,
        from: truncateMiddle(a.from),
        to: truncateMiddle(a.to),
        usdc: a.amount === null ? null : formatUsdc(units(a.amount)),
        rmHint: a.amount === null ? null : unitsToSen(units(a.amount), "nearest"),
        failure: a.failure,
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
