import type { Fixtures } from "@homeroll/fixtures";
import { sen, senToUnits } from "@/lib/fx";
import type { PayLine } from "@/lib/near/client";

/**
 * Pay lines from a timesheet. The timesheet stands in for the payroll agent's output (SPEC §8.2)
 * until /api/agents/payroll exists: precomputed net wages, no hours maths.
 */
export function toPayLines(timesheet: Fixtures["timesheet"]): PayLine[] {
  return timesheet.map((l) => ({ accountId: l.accountId, amount: senToUnits(sen(l.amountSen)) }));
}
