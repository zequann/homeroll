"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addedWorkers, newWorkerAccountId } from "@/lib/added-workers";
import { invoiceAgentDeps, rememberInvoiceResult } from "@/lib/agents";
import {
  type InvoiceAgentResult,
  invoiceDocumentFromPdf,
  offerFor,
  runInvoiceAgent,
} from "@/lib/agents/invoice-agent";
import { proposePayroll } from "@/lib/agents/payroll";
import { checkUploadedInvoice, type UploadOutcome } from "@/lib/agents/upload";
import { resetDemoEverywhere } from "@/lib/demo-reset";
import { describeFailure, type FailureView } from "@/lib/describe-failure";
import { getEnv } from "@/lib/env";
import { parseRm, sen, senToUnits } from "@/lib/fx";
import { settleWithMockBank } from "@/lib/mock/bank";
import { getChainClient, getFixtures } from "@/lib/near";
import { period } from "@/lib/near/client";
import { toPayLines } from "@/lib/payroll";
import { payrollAgentSigner, requireSigner } from "@/lib/session";

/** Everything these actions return is plain data: strings and numbers, never bigint. */
export type SubmitResult =
  | { ok: true; runId: number; lineCount: number }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "rejected"; failure: FailureView };

export type PayResult =
  | { ok: true; paid: number; total: number; done: boolean }
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
  const result = await chain.submitRun(payrollAgentSigner(), payrollPeriod, lines);
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

/** One pay_run call. The browser calls it until `done`. */
export async function payNextBatch(runId: unknown): Promise<PayResult> {
  const id = z.number().int().nonnegative().parse(runId);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };

  const chain = getChainClient();
  const fixtures = getFixtures();
  const result = await chain.payRun(payrollAgentSigner(), id);
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
 * Pay missed worker: a one-line run for the same period, through the agent's key (SPEC §8.2). The
 * contract decides: a re-added worker still on hold comes back as ERR_PAYEE_NOT_ACTIVE.
 */
export async function payMissed(accountId: unknown): Promise<OwnerCallResult> {
  const account = z.string().parse(accountId);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };
  const chain = getChainClient();
  const fixtures = getFixtures();
  const lines = toPayLines(fixtures.timesheet.filter((l) => l.accountId === account));
  if (lines.length !== 1) throw new Error("That account has no line on this timesheet");
  const agent = payrollAgentSigner();
  const submitted = await chain.submitRun(agent, period(fixtures.company.period), lines);
  if (submitted.ok) {
    const paid = await chain.payRun(agent, submitted.value.runId);
    refresh();
    if (paid.ok) return { ok: true };
    const failure = await describeFailure(chain, fixtures.company.accountId, paid.failure);
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
 * In this build the "upload" is the demo company's own generated PDF, read through its text layer.
 */
export async function checkInvoice(invoiceNumber: unknown): Promise<CheckResult> {
  const invoice = fixtureInvoice(invoiceNumber);
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };

  const deps = invoiceAgentDeps();
  const result = await runInvoiceAgent(deps, await invoiceDocumentFromPdf(deps.fixtures, invoice));
  rememberInvoiceResult(result, invoice.hash);
  refresh();
  return { ok: true, result };
}

/** Owner uploads an invoice PDF (SPEC §9.1). See `lib/agents/upload.ts` for what is checked. */
export async function uploadInvoice(form: FormData): Promise<UploadOutcome> {
  const file = form.get("file");
  if (!(file instanceof File)) {
    return { ok: false, reason: "not-a-pdf", message: "Choose a PDF invoice to upload." };
  }
  const session = await requireSigner("owner");
  if (!session.connected) {
    return { ok: false, reason: "unreadable", message: "Connect the owner wallet to upload." };
  }
  const deps = invoiceAgentDeps();
  const outcome = await checkUploadedInvoice(deps, new Uint8Array(await file.arrayBuffer()));
  if (outcome.ok) {
    const fixture = deps.fixtures.invoices.find((i) => i.number === outcome.result.invoiceNumber);
    if (fixture) rememberInvoiceResult(outcome.result, fixture.hash);
  }
  refresh();
  return outcome;
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
