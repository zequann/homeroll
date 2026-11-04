"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { invoiceAgentDeps, invoiceResults } from "@/lib/agents";
import {
  type InvoiceAgentResult,
  invoiceDocument,
  offerFor,
  runInvoiceAgent,
} from "@/lib/agents/invoice-agent";
import { resetDemoEverywhere } from "@/lib/demo-reset";
import { describeFailure, type FailureView } from "@/lib/describe-failure";
import { sen, senToUnits } from "@/lib/fx";
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
  const lines = toPayLines(fixtures.timesheet);
  const result = await chain.submitRun(
    payrollAgentSigner(),
    period(fixtures.company.period),
    lines,
  );
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
