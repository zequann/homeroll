import { proposePayroll } from "@/lib/agents/payroll";
import { unitsToSen } from "@/lib/fx";
import { nameOrAccount } from "@/lib/names";
import { getChainClient, getFixtures, syncLiveCompany } from "@/lib/near";
import { period } from "@/lib/near/client";

/**
 * Payroll agent preview (SPEC §8.2). Read-only: it proposes the run and signs nothing. Names are
 * resolved here, off-chain, for the shared demo company. Run payroll happens in /owner.
 */
export async function POST(): Promise<Response> {
  await syncLiveCompany();
  const fixtures = getFixtures();
  const hours = new Map(fixtures.timesheet.map((l) => [l.accountId, l]));
  const proposal = await proposePayroll(
    getChainClient(),
    fixtures,
    period(fixtures.company.period),
    Date.now(),
  );
  return Response.json({
    period: fixtures.company.period,
    remainingSen: proposal.remainingSen,
    lines: proposal.lines.map((l) => ({
      accountId: l.accountId,
      name: nameOrAccount(l.accountId),
      amountSen: unitsToSen(l.amount, "nearest"),
      baseSen: hours.get(l.accountId)?.baseSen,
      overtimeHours: hours.get(l.accountId)?.overtimeHours,
      overtimeRateSen: hours.get(l.accountId)?.overtimeRateSen,
    })),
    alreadyHeld: proposal.held,
    excluded: proposal.excluded.map((e) => ({ ...e, name: nameOrAccount(e.accountId) })),
  });
}
