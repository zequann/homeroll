import { homerollAccounts } from "@homeroll/shared";
import { recentActivity } from "@/lib/activity";
import { getEnv } from "@/lib/env";
import { formatUsdc, type Sen, units, unitsToSen } from "@/lib/fx";
import { getChainClient, getFixtures } from "@/lib/near";
import { type Period, period } from "@/lib/near/client";

/** Rahim's phone, as plain data for server components. Same numbers feed the owner satellite, /worker and the landing stage. */
export interface RahimView {
  accountId: string;
  balanceSen: Sen;
  usdcHint: string;
  /** The October wage once the run has paid him. */
  wage: { label: string; amountSen: Sen } | null;
  /** Newest first. */
  sends: { id: number; label: string; amountSen: Sen }[];
}

export const WAGE_LABEL = "October wage · Coffee Factory";

export async function loadRahimView(): Promise<RahimView> {
  const chain = getChainClient();
  const fixtures = getFixtures();
  const rahim = fixtures.workers[0];
  if (!rahim) throw new Error("fixtures have no workers");
  const payrollPeriod: Period = period(fixtures.company.period);
  const { offramp } = homerollAccounts(getEnv().root);

  const [balance, runs, activity] = await Promise.all([
    chain.ftBalanceOf(rahim.accountId),
    chain.getRuns(fixtures.company.accountId, payrollPeriod),
    recentActivity(),
  ]);
  const paid = runs
    ?.flatMap((r) => r.lines)
    .find((l) => l.accountId === rahim.accountId && l.status === "Paid");

  return {
    accountId: rahim.accountId,
    balanceSen: unitsToSen(balance, "nearest"),
    usdcHint: `≈ ${formatUsdc(balance)}`,
    wage: paid ? { label: WAGE_LABEL, amountSen: unitsToSen(paid.amount, "nearest") } : null,
    sends: activity
      .filter((a) => a.method === "ft_transfer" && a.from === rahim.accountId && !a.failure)
      .map((a) => ({
        id: a.id,
        label: a.to === offramp ? "Cash out · DuitNow" : "Sent to Amma",
        amountSen: unitsToSen(units(a.amount ?? 0n), "nearest"),
      })),
  };
}
