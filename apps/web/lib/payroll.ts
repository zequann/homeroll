import type { Fixtures } from "@homeroll/fixtures";
import { sen, senToUnits } from "@/lib/fx";
import type { PayLine } from "@/lib/near/client";

/**
 * Pay lines from a timesheet's net wages (SPEC §8.2: base + overtime × rate, computed in the
 * fixtures loader). `lib/agents/payroll.ts` decides which lines to propose.
 */
export function toPayLines(timesheet: Fixtures["timesheet"]): PayLine[] {
  return timesheet.map((l) => ({ accountId: l.accountId, amount: senToUnits(sen(l.amountSen)) }));
}
