"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { describeFailure, type FailureView } from "@/lib/describe-failure";
import { sen, senToUnits } from "@/lib/fx";
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

export async function takeAdvance(invoiceNumber: unknown): Promise<AdvanceResult> {
  const fixtures = getFixtures();
  const invoice = fixtures.invoices.find((i) => i.number === z.string().parse(invoiceNumber));
  if (!invoice) throw new Error("Unknown invoice");
  const session = await requireSigner("owner");
  if (!session.connected) return { ok: false, reason: "not-connected" };

  const chain = getChainClient();
  const advance = sen(Math.floor((invoice.amountSen * invoice.advanceBps) / 10_000));
  const result = await chain.requestAdvance(session.signer, invoice.number, senToUnits(advance));
  refresh();
  if (!result.ok) {
    const failure = await describeFailure(chain, fixtures.company.accountId, result.failure);
    return { ok: false, reason: "rejected", failure };
  }
  return { ok: true };
}

/** Reset demo (SPEC §9.6). In fake mode it restores the fixtures and nothing else. */
export async function resetDemo(): Promise<void> {
  await getChainClient().resetDemo();
  revalidatePath("/", "layout");
}
