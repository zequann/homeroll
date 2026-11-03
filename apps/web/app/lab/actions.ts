"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { describeFailure, type FailureView } from "@/lib/describe-failure";
import { formatRm, type Sen, unitsToSen } from "@/lib/fx";
import { nameOrAccount } from "@/lib/names";
import { getChainClient, getFixtures } from "@/lib/near";
import { period } from "@/lib/near/client";
import { toPayLines } from "@/lib/payroll";
import { payrollAgentSigner } from "@/lib/session";

export interface AttackResult {
  /** What the agent proposed to the contract, in words. */
  proposed: string;
  failure: FailureView;
  treasuryBefore: Sen;
  treasuryAfter: Sen;
}

/**
 * Runs an attack against the current demo company. The server signs as the payroll agent, the
 * same function-call key the Run payroll button uses (SPEC §8.2), so no wallet is needed.
 */
export async function runAttack(id: unknown): Promise<AttackResult> {
  const attack = z.enum(["02", "01"]).parse(id);
  const chain = getChainClient();
  const fixtures = getFixtures();
  const employer = fixtures.company.accountId;
  const periodId = period(fixtures.company.period);

  let lines = toPayLines(fixtures.timesheet);
  let flagged = 0;
  if (attack === "02") {
    // Someone edited the attendance file: Hafiz's line now claims 900 overtime hours.
    lines = toPayLines(fixtures.timesheetTampered);
    flagged = lines.findIndex((l, i) => l.amount !== toPayLines(fixtures.timesheet)[i]?.amount);
  } else {
    // A message asks to pay Rahim somewhere new. The agent swaps the account on line 1.
    lines = lines.map((l, i) => (i === 0 ? { ...l, accountId: "rahim-wallet.testnet" } : l));
  }

  const before = await chain.getEmployer(employer);
  const result = await chain.submitRun(payrollAgentSigner(), periodId, lines);
  const after = await chain.getEmployer(employer);
  revalidatePath("/owner");
  revalidatePath("/lab");
  if (result.ok || !before || !after) {
    throw new Error("Attack was expected to fail at submit_run");
  }

  const line = lines[flagged];
  const who = line ? nameOrAccount(line.accountId) : "";
  const proposed = `October run, ${lines.length} pay lines. Line ${flagged + 1}, ${who}: ${
    line ? formatRm(unitsToSen(line.amount, "nearest"), { decimals: 2 }) : ""
  }.`;

  return {
    proposed,
    failure: await describeFailure(chain, employer, result.failure, lines, fixtures.company.period),
    treasuryBefore: unitsToSen(before.treasury, "nearest"),
    treasuryAfter: unitsToSen(after.treasury, "nearest"),
  };
}
