import { loadFixtures } from "@homeroll/fixtures";
import { describe, expect, it } from "vitest";
import { createActivityLog } from "@/lib/activity";
import { explain } from "@/lib/errors/explain";
import { formatRm, formatUsdc, sen, units, unitsToSen } from "@/lib/fx";
import { nameOf } from "@/lib/names";
import { toPayLines } from "@/lib/payroll";
import { period } from "./client";
import {
  advanceUnits,
  attestFixtureInvoices,
  key,
  runChainClientSuite,
  signers,
} from "./client.suite";
import { FakeChainClient } from "./fake";

const ROOT = "homeroll-test.testnet";
// 3 Nov 2026, UTC: October is the previous month, so it is open (R14).
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const OCT = period("2026-10");
const rmNearest = (value: bigint) => formatRm(unitsToSen(units(value), "nearest"));

function make(now = NOW) {
  const fixtures = loadFixtures(ROOT);
  const activity = createActivityLog();
  const chain = new FakeChainClient({ fixtures, now: () => now, activity });
  return { chain, fixtures, activity, ...signers(fixtures) };
}

/** As the demo runs it: the invoice agent attests first, then the owner can take advances. */
async function makeAttested(now = NOW) {
  const ctx = make(now);
  await attestFixtureInvoices(ctx.chain, ctx.fixtures);
  return ctx;
}

runChainClientSuite("FakeChainClient", () => ({
  ...make(),
  openPeriod: OCT,
  closedPeriod: period("2026-08"),
}));

describe("the three demo moments on the fake chain", () => {
  it("1. Run payroll pays 40 and Rahim's phone shows RM1,950.00", async () => {
    const { chain, fixtures, owner, agent } = await makeAttested();
    const employer = fixtures.company.accountId;
    await chain.requestAdvance(
      owner,
      key(fixtures, "INV-2026-1043"),
      advanceUnits(fixtures, "INV-2026-1043"),
    );
    const before = await chain.getEmployer(employer);
    expect(rmNearest(before?.treasury ?? 0n)).toBe("RM138,400");

    const submitted = await chain.submitRun(agent, OCT, toPayLines(fixtures.timesheet));
    if (!submitted.ok) throw new Error("submit_run failed");
    const reserved = await chain.getEmployer(employer);
    expect(rmNearest(reserved?.treasury ?? 0n)).toBe("RM60,400");

    const first = await chain.payRun(agent, submitted.value.runId);
    const rahim = fixtures.workers[0]?.accountId ?? "";
    expect(first.ok && first.value.lines[0]).toMatchObject({ accountId: rahim, status: "Paid" });

    let calls = 1;
    for (;;) {
      const next = await chain.payRun(agent, submitted.value.runId);
      if (!next.ok) break;
      calls += 1;
    }
    // max_lines_per_call is 36 (SPEC §7.3): a 40-line run takes two pay_run calls.
    expect(calls).toBe(2);
    const runs = await chain.getRuns(employer, OCT);
    expect(runs?.[0]?.lines.filter((l) => l.status === "Paid")).toHaveLength(40);

    const balance = await chain.ftBalanceOf(rahim);
    expect(formatRm(unitsToSen(balance, "nearest"), { decimals: 2 })).toBe("RM1,950.00");
    expect(formatUsdc(balance)).toBe("464.28 USDC");
  });

  it("2. the tampered timesheet fails at submit_run and nothing is reserved", async () => {
    const { chain, fixtures, agent, activity } = make();
    const employer = fixtures.company.accountId;
    const treasuryBefore = (await chain.getEmployer(employer))?.treasury;

    const result = await chain.submitRun(agent, OCT, toPayLines(fixtures.timesheetTampered));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      kind: "contract",
      error: {
        code: "ERR_ABOVE_WAGE_CAP",
        line: { index: 4, accountId: `w-6b1x4k.${ROOT}` },
      },
    });

    const hafiz = nameOf(`w-6b1x4k.${ROOT}`);
    const { sentence } = explain(
      result.failure.kind === "contract" ? result.failure.error : { code: "ERR_NOT_ADMIN" },
      {
        workerName: hafiz?.displayName,
        possessive: hafiz?.possessive,
        amountSen: sen(1_117_000),
        capSen: sen(290_000),
      },
    );
    expect(sentence).toBe(
      "Line 5, Hafiz Rahman: above wage cap. RM11,170 is more than his RM2,900 cap. Nothing was reserved or paid. Check the timesheet, then run payroll again.",
    );
    expect((await chain.getEmployer(employer))?.treasury).toBe(treasuryBefore);
    expect(await chain.getRuns(employer, OCT)).toEqual([]);
    expect(activity.list()[0]?.failure).toBe(`ERR_ABOVE_WAGE_CAP:4:w-6b1x4k.${ROOT}`);
  });

  it("3. a Grade C advance alone leaves payroll short by RM39,400", async () => {
    const { chain, fixtures, owner, agent } = await makeAttested();
    const employer = fixtures.company.accountId;
    await chain.requestAdvance(
      owner,
      key(fixtures, "INV-2026-1047"),
      advanceUnits(fixtures, "INV-2026-1047"),
    );

    const view = await chain.getEmployer(employer);
    if (!view) throw new Error("no employer");
    expect(rmNearest(view.treasury)).toBe("RM43,600");

    const lines = toPayLines(fixtures.timesheet);
    const total = lines.reduce((s, l) => s + l.amount, 0n);
    expect(rmNearest(total + view.buffer - view.treasury)).toBe("RM39,400");

    const result = await chain.submitRun(agent, OCT, lines);
    expect(!result.ok && result.failure).toEqual({
      kind: "contract",
      error: { code: "ERR_BELOW_BUFFER" },
    });
    expect((await chain.getEmployer(employer))?.treasury).toBe(view.treasury);
    expect(await chain.getRuns(employer, OCT)).toEqual([]);
  });

  it("shows RM64,600 short before any advance, and RM85,600 left after both", async () => {
    const { chain, fixtures, owner } = await makeAttested();
    const employer = fixtures.company.accountId;
    const lines = toPayLines(fixtures.timesheet);
    const total = lines.reduce((s, l) => s + l.amount, 0n);
    const first = await chain.getEmployer(employer);
    if (!first) throw new Error("no employer");
    expect(rmNearest(total + first.buffer - first.treasury)).toBe("RM64,600");

    await chain.requestAdvance(
      owner,
      key(fixtures, "INV-2026-1043"),
      advanceUnits(fixtures, "INV-2026-1043"),
    );
    await chain.requestAdvance(
      owner,
      key(fixtures, "INV-2026-1047"),
      advanceUnits(fixtures, "INV-2026-1047"),
    );
    const after = await chain.getEmployer(employer);
    expect(rmNearest((after?.treasury ?? 0n) - total)).toBe("RM85,600");
  });
});

describe("FakeChainClient clock (R14)", () => {
  it("closes October once November is over", async () => {
    const { chain, fixtures, agent } = make(Date.UTC(2026, 11, 1, 0, 0, 1));
    const result = await chain.submitRun(agent, OCT, toPayLines(fixtures.timesheet));
    expect(!result.ok && result.failure).toEqual({
      kind: "contract",
      error: { code: "ERR_PERIOD_NOT_OPEN" },
    });
  });

  it("keeps October open on 30 Nov", async () => {
    const { chain, fixtures, agent } = make(Date.UTC(2026, 10, 30, 23, 59, 59));
    const result = await chain.submitRun(agent, OCT, toPayLines(fixtures.timesheet.slice(0, 1)));
    expect(result.ok).toBe(true);
  });
});

describe("activity log", () => {
  it("records successes and failures with the exact error text", async () => {
    const { chain, fixtures, owner, agent, activity } = await makeAttested();
    await chain.requestAdvance(
      owner,
      key(fixtures, "INV-2026-1043"),
      advanceUnits(fixtures, "INV-2026-1043"),
    );
    await chain.submitRun(agent, OCT, toPayLines(fixtures.timesheetTampered));
    const [latest, earlier] = activity.list();
    expect(latest?.method).toBe("submit_run");
    expect(latest?.failure).toMatch(/^ERR_ABOVE_WAGE_CAP:4:/);
    expect(earlier?.method).toBe("request_advance");
    expect(earlier?.failure).toBeNull();
    expect(earlier?.txHash).toMatch(/^fake-tx-/);
  });

  it("is cleared by a reset", async () => {
    const { chain, owner, fixtures, activity } = await makeAttested();
    await chain.requestAdvance(
      owner,
      key(fixtures, "INV-2026-1043"),
      advanceUnits(fixtures, "INV-2026-1043"),
    );
    await chain.resetDemo();
    expect(activity.list()).toEqual([]);
  });
});
