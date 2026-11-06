"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addedWorkers, newWorkerAccountId } from "@/lib/added-workers";
import { invoiceAgentDeps, invoiceResults } from "@/lib/agents";
import {
  type InvoiceAgentResult,
  invoiceDocument,
  offerFor,
  runInvoiceAgent,
} from "@/lib/agents/invoice-agent";
import { proposePayroll } from "@/lib/agents/payroll";
import { resetDemoEverywhere } from "@/lib/demo-reset";
import { describeFailure, type FailureView } from "@/lib/describe-failure";
import { getEnv } from "@/lib/env";
import { addTreasury } from "@/lib/fund/plan";
import { parseRm, sen, senToUnits } from "@/lib/fx";
import { adminSigner } from "@/lib/keys";
import { settleWithMockBank } from "@/lib/mock/bank";
import { getChainClient, getFixtures } from "@/lib/near";
import { period } from "@/lib/near/client";
import { configureRpc } from "@/lib/near/rpc";
import { approvePayout as approveWithRail, openApproval, sealApproval } from "@/lib/payout";
import { railFailure } from "@/lib/payout/explain";
import { approvalSecret, ownerSigns, payoutRail } from "@/lib/payout/server";
import { toPayLines } from "@/lib/payroll";
import { requireSigner } from "@/lib/session";

/** Everything these actions return is plain data: strings and numbers, never bigint. */
export type SubmitResult =
  | { ok: true; runId: number; lineCount: number }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "rejected"; failure: FailureView };

export type PayResult =
  | { ok: true; paid: number; total: number; done: boolean; txHash: string }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "rejected"; failure: FailureView };

export type AdvanceResult =
  | { ok: true }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "rejected"; failure: FailureView };

function refresh() {
  revalidatePath("/owner");
  revalidatePath("/worker");
}

/** Owner presses Run payroll: the payroll agent proposes the October run, the contract checks it whole. */
export async function submitPayroll(): Promise<SubmitResult> {
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };

  const chain = getChainClient();
  const fixtures = getFixtures();
  const payrollPeriod = period(fixtures.company.period);
  const { lines } = await proposePayroll(chain, fixtures, payrollPeriod, Date.now());
  const result = await chain.submitRun(session.signer, payrollPeriod, lines);
  refresh();
  if (!result.ok) {
    const failure = await describeFailure(
      chain,
      fixtures.company.accountId,
      result.failure,
      lines,
      fixtures.company.period,
    );
    return { ok: false, reason: "rejected", failure };
  }
  return { ok: true, runId: result.value.runId, lineCount: lines.length };
}

export type ApproveResult =
  /** `approval` is a sealed token the browser hands to each `payNextBatch` (SPEC §8.11). */
  | { ok: true; intentHash: string; approval: string }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "rejected"; failure: FailureView };

/**
 * The owner approves a reserved run's payout (SPEC §8.11): the payout rail quotes the contract's
 * reserved lines, the owner signs the NEP-413 payout intent, and the rail checks it (R17).
 */
export async function approvePayout(runId: unknown): Promise<ApproveResult> {
  const id = z.number().int().nonnegative().parse(runId);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };
  const employer = session.signer.accountId;
  const result = await approveWithRail(
    payoutRail(),
    { employer, period: period(getFixtures().company.period), runId: id },
    ownerSigns(employer),
  );
  refresh();
  if (!result.ok) return { ok: false, reason: "rejected", failure: railFailure(result.refusal) };
  return {
    ok: true,
    intentHash: result.value.approval.intentHash,
    approval: sealApproval(result.value.approval, approvalSecret()),
  };
}

/**
 * One pay_run batch, only with a sealed approval of this run's payout intent (R17). The browser
 * calls it until `done`. The token, not this server's memory, carries the approval.
 */
export async function payNextBatch(runId: unknown, approvalToken: unknown): Promise<PayResult> {
  const id = z.number().int().nonnegative().parse(runId);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };

  const chain = getChainClient();
  const fixtures = getFixtures();
  const approval = openApproval(approvalToken, approvalSecret(), Date.now());
  if (approval?.runId !== id || approval.employer !== session.signer.accountId) {
    return { ok: false, reason: "rejected", failure: railFailure("not-approved") };
  }
  const executed = await payoutRail().execute(approval, session.signer);
  if (!executed.ok)
    return { ok: false, reason: "rejected", failure: railFailure(executed.refusal) };
  const result = executed.value;
  refresh();
  if (!result.ok) {
    const failure = await describeFailure(chain, fixtures.company.accountId, result.failure);
    return { ok: false, reason: "rejected", failure };
  }
  const { lines, status } = result.value;
  return {
    ok: true,
    paid: lines.filter((l) => l.status === "Paid").length,
    total: lines.length,
    done: status !== "Pending",
    txHash: result.txHash,
  };
}

export type OwnerCallResult =
  | { ok: true }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "rejected"; failure: FailureView };

/** Cancel run: the owner's key only, the agent's key cannot (SPEC §7.3). */
export async function cancelPayroll(runId: unknown): Promise<OwnerCallResult> {
  const id = z.number().int().nonnegative().parse(runId);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };
  const chain = getChainClient();
  const result = await chain.cancelRun(session.signer, id);
  refresh();
  if (result.ok) return { ok: true };
  const failure = await describeFailure(chain, getFixtures().company.accountId, result.failure);
  return { ok: false, reason: "rejected", failure };
}

/**
 * Pay missed worker: a one-line run for the same period. The contract decides. A re-added worker
 * still on hold comes back as ERR_PAYEE_NOT_ACTIVE.
 */
export async function payMissed(accountId: unknown): Promise<OwnerCallResult> {
  const account = z.string().parse(accountId);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };
  const chain = getChainClient();
  const fixtures = getFixtures();
  const lines = toPayLines(fixtures.timesheet.filter((l) => l.accountId === account));
  if (lines.length !== 1) throw new Error("That account has no line on this timesheet");
  const payrollPeriod = period(fixtures.company.period);
  const submitted = await chain.submitRun(session.signer, payrollPeriod, lines);
  if (submitted.ok) {
    // The one-line run is paid like any other: the owner's payout intent first (R17)
    const employer = session.signer.accountId;
    const rail = payoutRail();
    const run = { employer, period: payrollPeriod, runId: submitted.value.runId };
    const approved = await approveWithRail(rail, run, ownerSigns(employer));
    if (!approved.ok) {
      refresh();
      return { ok: false, reason: "rejected", failure: railFailure(approved.refusal) };
    }
    const executed = await rail.execute(approved.value.approval, session.signer);
    refresh();
    if (!executed.ok)
      return { ok: false, reason: "rejected", failure: railFailure(executed.refusal) };
    if (executed.value.ok) return { ok: true };
    const failure = await describeFailure(
      chain,
      fixtures.company.accountId,
      executed.value.failure,
    );
    return { ok: false, reason: "rejected", failure };
  }
  refresh();
  const failure = await describeFailure(
    chain,
    fixtures.company.accountId,
    submitted.failure,
    lines,
    fixtures.company.period,
  );
  return { ok: false, reason: "rejected", failure };
}

const newPayeeSchema = z.object({
  // Letters, spaces and common name punctuation only: this demo stores synthetic names (rule 1)
  name: z
    .string()
    .trim()
    .regex(/^[\p{L} .'-]{2,60}$/u),
  role: z.string().trim().min(2).max(40),
  cap: z.string().trim(),
});

export type AddPayeeResult = OwnerCallResult | { ok: false; reason: "invalid"; message: string };

/** Add payee: the server picks a random account; the name stays off-chain (rule R13). */
export async function addPayee(input: unknown): Promise<AddPayeeResult> {
  const parsed = newPayeeSchema.safeParse(input);
  const capSen = parsed.success ? parseRm(parsed.data.cap) : null;
  if (!parsed.success || capSen === null || capSen <= 0) {
    return {
      ok: false,
      reason: "invalid",
      message: "Enter a made-up name, a role, and a wage cap in RM, like 2600.",
    };
  }
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };
  const chain = getChainClient();
  const accountId = newWorkerAccountId(getEnv().root);
  const result = await chain.addPayee(session.signer, accountId, senToUnits(capSen));
  if (!result.ok) {
    const failure = await describeFailure(chain, getFixtures().company.accountId, result.failure);
    return { ok: false, reason: "rejected", failure };
  }
  addedWorkers().set(accountId, {
    accountId,
    displayName: parsed.data.name,
    role: parsed.data.role,
    capSen,
  });
  refresh();
  return { ok: true };
}

/** Add a removed worker back with their old wage cap. After onboarding the hold applies (R3). */
export async function addPayeeBack(accountId: unknown): Promise<OwnerCallResult> {
  const account = z.string().parse(accountId);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };
  const fixtures = getFixtures();
  const capSen =
    fixtures.workers.find((w) => w.accountId === account)?.capSen ??
    addedWorkers().get(account)?.capSen;
  if (capSen === undefined) throw new Error("Unknown worker");
  const chain = getChainClient();
  const result = await chain.addPayee(session.signer, account, senToUnits(sen(capSen)));
  refresh();
  if (result.ok) return { ok: true };
  const failure = await describeFailure(chain, fixtures.company.accountId, result.failure);
  return { ok: false, reason: "rejected", failure };
}

export async function removePayee(accountId: unknown): Promise<OwnerCallResult> {
  const account = z.string().parse(accountId);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };
  const chain = getChainClient();
  const result = await chain.removePayee(session.signer, account);
  refresh();
  if (result.ok) return { ok: true };
  const failure = await describeFailure(chain, getFixtures().company.accountId, result.failure);
  return { ok: false, reason: "rejected", failure };
}

export type CheckResult =
  | { ok: true; result: InvoiceAgentResult }
  | { ok: false; reason: "not-connected" };

/**
 * Owner uploads an invoice: the invoice agent extracts, checks, grades and attests it (SPEC §8.1).
 * In this build the "upload" is the demo company's own generated document.
 */
export async function checkInvoice(invoiceNumber: unknown): Promise<CheckResult> {
  const invoice = fixtureInvoice(invoiceNumber);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };

  const deps = invoiceAgentDeps();
  const result = await runInvoiceAgent(deps, invoiceDocument(deps.fixtures, invoice));
  // Keep the first successful check: a re-run that the registry refuses must not hide it
  if (result.attest.ok || !invoiceResults().has(invoice.number)) {
    invoiceResults().set(invoice.number, result);
  }
  refresh();
  return { ok: true, result };
}

export async function takeAdvance(invoiceNumber: unknown): Promise<AdvanceResult> {
  const invoice = fixtureInvoice(invoiceNumber);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };

  const chain = getChainClient();
  const fixtures = getFixtures();
  const onChain = await chain.getInvoice(invoice.hash);
  if (!onChain) throw new Error("Check the invoice with the agent first");
  // The owner takes the pool's full offer for the grade the pool holds
  const offer = offerFor(sen(invoice.amountSen), onChain.grade);
  const result = await chain.requestAdvance(
    session.signer,
    invoice.hash,
    senToUnits(offer?.advanceSen ?? sen(0)),
  );
  refresh();
  if (!result.ok) {
    const failure = await describeFailure(chain, fixtures.company.accountId, result.failure);
    return { ok: false, reason: "rejected", failure };
  }
  return { ok: true };
}

export type BuyerPaidResult =
  | { ok: true; ref: string; ownerGetsSen: number }
  | { ok: false; reason: "not-connected" | "refunded" };

/** Mock bank: the buyer pays the invoice in full and escrow settles it on the pool (SPEC §8.6). */
export async function buyerPaid(invoiceNumber: unknown): Promise<BuyerPaidResult> {
  const invoice = fixtureInvoice(invoiceNumber);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };
  const receipt = await settleWithMockBank(invoice);
  refresh();
  revalidatePath("/lender");
  if (!receipt) return { ok: false, reason: "refunded" };
  return { ok: true, ref: receipt.ref, ownerGetsSen: receipt.ownerGetsSen };
}

const FUND_SEN = sen(2_000_000);

/** Adds RM20,000 of testnet tUSDC to this company's payroll treasury. */
export async function fundTreasury(): Promise<OwnerCallResult> {
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };
  if (getEnv().chainClient !== "near") {
    return {
      ok: false,
      reason: "rejected",
      failure: {
        sentence: "Adding tUSDC runs against testnet.",
        code: "FAKE_CHAIN",
        ruleCaption: null,
        shortfallSen: null,
      },
    };
  }
  const rpc = process.env.NEAR_RPC_URL;
  if (rpc) configureRpc(rpc);
  const admin = adminSigner(getEnv().root, process.env.HOMEROLL_ADMIN_PRIVATE_KEY?.trim() ?? null);
  if (!admin) {
    return {
      ok: false,
      reason: "rejected",
      failure: {
        sentence: "The server has no admin key, so it cannot mint tUSDC.",
        code: "NO_ADMIN",
        ruleCaption: null,
        shortfallSen: null,
      },
    };
  }
  try {
    await addTreasury(admin, getFixtures().company.accountId, senToUnits(FUND_SEN));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "rejected",
      failure: { sentence: message, code: "FUND_FAILED", ruleCaption: null, shortfallSen: null },
    };
  }
  refresh();
  return { ok: true };
}

/** Reset demo (SPEC §9.6). In fake mode it restores the fixtures and clears off-chain records. */
export async function resetDemo(): Promise<void> {
  await resetDemoEverywhere();
  revalidatePath("/", "layout");
}

function fixtureInvoice(invoiceNumber: unknown) {
  const number = z.string().parse(invoiceNumber);
  const invoice = getFixtures().invoices.find((i) => i.number === number);
  if (!invoice) throw new Error("Unknown invoice");
  return invoice;
}
