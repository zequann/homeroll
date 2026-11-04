import { proposePayroll } from "@/lib/agents/payroll";
import { unitsToSen } from "@/lib/fx";
import { nameOrAccount } from "@/lib/names";
import { getChainClient, getFixtures } from "@/lib/near";
import { period } from "@/lib/near/client";
import { requireSigner } from "@/lib/session";

/**
 * Payroll agent preview (SPEC §8.2). Read-only: it proposes the run and signs nothing. Names are
 * resolved here, off-chain, so it needs the owner's demo session. Run payroll happens in /owner.
 */
export async function POST(): Promise<Response> {
  const session = await requireSigner("owner");
  if (!session.connected) return Response.json({ reason: "not_connected" }, { status: 401 });

  const fixtures = getFixtures();
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
    })),
    alreadyHeld: proposal.held,
    excluded: proposal.excluded.map((e) => ({ ...e, name: nameOrAccount(e.accountId) })),
  });
}
