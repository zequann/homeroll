import { loadFixtures } from "@homeroll/fixtures";
import { describe, expect, it } from "vitest";
import { createActivityLog } from "@/lib/activity";
import { units } from "@/lib/fx";
import { toPayLines } from "@/lib/payroll";
import { period, type Signer } from "./client";
import { FakeChainClient } from "./fake";
import { recordingActivity } from "./recorded";

const ROOT = "homeroll-test.testnet";
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

function make() {
  const fixtures = loadFixtures(ROOT);
  // The fake records into its own log; the wrapper records into this one, as near mode does
  const inner = new FakeChainClient({ fixtures, now: () => NOW, activity: createActivityLog() });
  const log = createActivityLog();
  const chain = recordingActivity(inner, ROOT, log);
  const owner: Signer = { role: "owner", accountId: fixtures.company.accountId };
  return { fixtures, chain, log, owner };
}

describe("recordingActivity", () => {
  it("records a successful write with its hash and amount", async () => {
    const { fixtures, chain, log, owner } = make();
    const lines = toPayLines(fixtures.timesheet.slice(0, 2));
    const result = await chain.submitRun(owner, period("2026-10"), lines);
    expect(result.ok).toBe(true);
    const [entry] = log.list();
    expect(entry).toMatchObject({
      method: "submit_run",
      from: fixtures.company.accountId,
      to: `payroll.${ROOT}`,
      amount: units(lines.reduce((s, l) => s + l.amount, 0n)),
      txHash: result.txHash,
      failure: null,
    });
  });

  it("records a refused write with the exact error", async () => {
    const { fixtures, chain, log, owner } = make();
    const tampered = toPayLines(fixtures.timesheetTampered);
    await chain.submitRun(owner, period("2026-10"), tampered);
    expect(log.list()[0]?.failure).toMatch(/^ERR_ABOVE_WAGE_CAP:4:w-6b1x4k\./);
  });

  it("records worker transfers, which Rahim's phone lists as sends", async () => {
    const { fixtures, chain, log, owner } = make();
    const rahim = fixtures.workers[0]?.accountId ?? "";
    const run = await chain.submitRun(
      owner,
      period("2026-10"),
      toPayLines(fixtures.timesheet.slice(0, 1)),
    );
    if (!run.ok) throw new Error("run refused");
    await chain.payRun(owner, run.value.runId);
    await chain.ftTransfer(
      { role: "worker", accountId: rahim },
      `payout.${ROOT}`,
      units(1_000_000n),
      "m",
    );
    expect(log.list()[0]).toMatchObject({
      method: "ft_transfer",
      from: rahim,
      to: `payout.${ROOT}`,
    });
  });

  it("passes views through without recording, and clears the log on Reset demo", async () => {
    const { fixtures, chain, log, owner } = make();
    await chain.getEmployer(fixtures.company.accountId);
    expect(log.list()).toHaveLength(0);
    await chain.submitRun(owner, period("2026-10"), toPayLines(fixtures.timesheet.slice(0, 1)));
    await chain.resetDemo();
    expect(log.list()).toHaveLength(0);
  });
});
