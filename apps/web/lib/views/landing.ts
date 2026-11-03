import type { RunFacts } from "@/app/owner/_components/run-state";
import { formatUsdc, type Sen, sen, senToUnits } from "@/lib/fx";
import { getFixtures } from "@/lib/near";
import type { PayLineRow } from "./owner";
import { WAGE_LABEL } from "./rahim";

/**
 * A frozen fixture snapshot, "after October payroll" (design 3.2). Pure arithmetic on the
 * fixtures: it never reads the chain, so the landing page looks the same after any demo run.
 */
export function loadLandingSnapshot() {
  const f = getFixtures();
  const gradeA = f.invoices.find((i) => i.grade === "A");
  if (!gradeA) throw new Error("fixtures have no Grade A invoice");
  const total = sen(f.timesheet.reduce((s, l) => s + l.amountSen, 0));
  const advance = sen(Math.floor((gradeA.amountSen * gradeA.advanceBps) / 10_000));
  const treasury = sen(f.company.treasurySen + advance - total);
  const rahim = f.workers[0];
  if (!rahim) throw new Error("fixtures have no workers");
  const rahimSen = sen(rahim.wageSen);

  const facts: RunFacts = {
    period: f.company.period,
    lineCount: f.timesheet.length,
    totalSen: total,
    treasurySen: treasury,
    bufferSen: sen(f.company.bufferSen),
    heldCount: f.timesheet.length,
    pendingRun: null,
    doneRun: { total, lineCount: f.timesheet.length },
  };

  const rows: PayLineRow[] = f.workers.slice(0, 6).map((w, i) => ({
    accountId: w.accountId,
    name: w.displayName,
    role: w.role,
    netSen: sen(f.timesheet[i]?.amountSen ?? 0),
    capSen: sen(w.capSen),
    status: "Paid",
  }));

  return {
    companyName: f.company.name,
    periodLabel: "October",
    treasurySen: treasury as Sen,
    treasuryUsdc: `≈ ${formatUsdc(senToUnits(treasury))}`,
    bufferSen: sen(f.company.bufferSen),
    facts,
    rows,
    preview: {
      balanceSen: rahimSen,
      usdcHint: `≈ ${formatUsdc(senToUnits(rahimSen))}`,
      wage: { label: WAGE_LABEL, amountSen: rahimSen },
    },
  };
}
