import type { Fixtures } from "@homeroll/fixtures";
import type { AccountId } from "@homeroll/shared";
import { type Sen, sen, senToUnits } from "@/lib/fx";
import type { ChainClient, PayLine, Period, RunView } from "@/lib/near/client";

/**
 * Payroll agent (SPEC §8.2): turns the period's timesheet into the pay lines it proposes. It leaves
 * out people the contract would refuse, so one removed worker does not block 39 others; the
 * contract still checks whatever is sent. Timesheets hold net wages for now, with no hours maths.
 */

export type ExcludedReason = "not-a-payee" | "on-hold";

export interface PayrollProposal {
  /** Lines to submit now. */
  lines: PayLine[];
  remainingSen: Sen;
  /** Everyone who already holds the period (Reserved, Sent or Paid). */
  held: AccountId[];
  heldSen: Sen;
  excluded: { accountId: AccountId; reason: ExcludedReason }[];
}

/** A payee holds a period while a line of theirs is Reserved, Sent or Paid (SPEC §7.3). */
export function holdersOf(runs: RunView[]): Set<AccountId> {
  return new Set(
    runs.flatMap((r) =>
      r.lines
        .filter((l) => l.status === "Reserved" || l.status === "Sent" || l.status === "Paid")
        .map((l) => l.accountId),
    ),
  );
}

export async function proposePayroll(
  chain: ChainClient,
  fixtures: Fixtures,
  period: Period,
  nowMs: number,
): Promise<PayrollProposal> {
  const employer = fixtures.company.accountId;
  const [payees, runs] = await Promise.all([
    chain.getPayees(employer),
    chain.getRuns(employer, period),
  ]);
  const payeeBy = new Map(payees.map((p) => [p.accountId, p]));
  const holders = holdersOf(runs ?? []);
  const nowNs = BigInt(nowMs) * 1_000_000n;

  const proposal: PayrollProposal = {
    lines: [],
    remainingSen: sen(0),
    held: [],
    heldSen: sen(0),
    excluded: [],
  };
  for (const line of fixtures.timesheet) {
    const { accountId, amountSen } = line;
    if (holders.has(accountId)) {
      proposal.held.push(accountId);
      proposal.heldSen = sen(proposal.heldSen + amountSen);
      continue;
    }
    const payee = payeeBy.get(accountId);
    if (!payee) {
      proposal.excluded.push({ accountId, reason: "not-a-payee" });
    } else if (nowNs < payee.activeFrom) {
      proposal.excluded.push({ accountId, reason: "on-hold" });
    } else {
      proposal.lines.push({ accountId, amount: senToUnits(sen(amountSen)) });
      proposal.remainingSen = sen(proposal.remainingSen + amountSen);
    }
  }
  return proposal;
}
