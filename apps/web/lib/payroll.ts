import type { Fixtures } from "@homeroll/fixtures";
import { sen, senToUnits } from "@/lib/fx";
import type { ChainClient, PayLine, Period, Signer, Tx, TxFailure } from "@/lib/near/client";

/**
 * Pay lines from a timesheet. The timesheet stands in for the payroll agent's output (SPEC §8.2)
 * until /api/agents/payroll exists: precomputed net wages, no hours maths.
 */
export function toPayLines(timesheet: Fixtures["timesheet"]): PayLine[] {
  return timesheet.map((line) => ({
    accountId: line.accountId,
    amount: senToUnits(sen(line.amountSen)),
  }));
}

export const buildPayLines = toPayLines;

export type ProposedRun =
  | { ok: true; runId: number; submitted: boolean; txHash: string | null }
  | { ok: false; failure: TxFailure; txHash: string | null };

/**
 * One submit for the period. A Pending run is returned as-is, so a retry does not
 * call submit_run again. A Done run falls through to submit_run and the contract
 * rejects with ERR_ALREADY_PAID.
 */
export async function submitOctoberRun(
  chain: ChainClient,
  signer: Signer,
  payrollPeriod: Period,
  lines: PayLine[],
): Promise<ProposedRun> {
  const runs = await chain.getRuns(signer.accountId, payrollPeriod);
  const pending = runs?.find((r) => r.status === "Pending");
  if (pending) {
    return { ok: true, runId: pending.runId, submitted: false, txHash: null };
  }
  const result = await chain.submitRun(signer, payrollPeriod, lines);
  if (!result.ok) return { ok: false, failure: result.failure, txHash: result.txHash };
  return { ok: true, runId: result.value.runId, submitted: true, txHash: result.txHash };
}

/** The route's loop. The owner screen calls payRun once per click. */
export async function payUntilSettled(
  chain: ChainClient,
  signer: Signer,
  runId: number,
): Promise<Tx<import("@/lib/near/client").RunView>> {
  for (;;) {
    const paid = await chain.payRun(signer, runId);
    if (!paid.ok) return paid;
    if (paid.value.status !== "Pending") return paid;
  }
}
