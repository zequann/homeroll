import { describe, expect, it } from "vitest";
import { loadFixtures, workerName } from "./index";

const ROOT = "homeroll-test.testnet";
const f = loadFixtures(ROOT);
const sum = (xs: { amountSen?: number; wageSen?: number }[]) =>
  xs.reduce((s, x) => s + (x.amountSen ?? x.wageSen ?? 0), 0);

describe("fixtures", () => {
  it("has 40 workers that net to RM78,000", () => {
    expect(f.workers).toHaveLength(40);
    expect(sum(f.workers)).toBe(7_800_000);
    expect(sum(f.timesheet)).toBe(7_800_000);
  });

  it("names six workers who net to RM11,750", () => {
    expect(sum(f.workers.slice(0, 6))).toBe(1_175_000);
  });

  it("puts Rahim first and Hafiz at index 4", () => {
    expect(f.workers[0]?.accountId).toBe(`w-7k2q9x.${ROOT}`);
    expect(f.workers[0]?.displayName).toBe("Rahim Uddin");
    expect(f.workers[4]?.accountId).toBe(`w-6b1x4k.${ROOT}`);
    expect(f.timesheet[4]?.accountId).toBe(`w-6b1x4k.${ROOT}`);
  });

  it("changes only Hafiz's line in the tampered timesheet", () => {
    const changed = f.timesheet.flatMap((line, i) =>
      line.amountSen === f.timesheetTampered[i]?.amountSen ? [] : [i],
    );
    expect(changed).toEqual([4]);
    expect(f.timesheetTampered[4]?.amountSen).toBe(1_924_000);
  });

  it("keeps every wage at or under its wage cap", () => {
    expect(f.workers.every((w) => w.wageSen <= w.capSen)).toBe(true);
  });

  it("builds account IDs from the root it is given", () => {
    expect(f.company.accountId).toBe(`perabotjaya.${ROOT}`);
    expect(f.lender.accountId).toBe(`seri-capital.${ROOT}`);
  });

  it("resolves names off-chain and nowhere else", () => {
    expect(workerName(`w-6b1x4k.${ROOT}`)).toEqual({
      displayName: "Hafiz Rahman",
      possessive: "his",
    });
    expect(workerName(`rahim-wallet.${ROOT}`)).toBeNull();
  });

  it("has the three invoices from SPEC §4", () => {
    expect(f.invoices.map((i) => [i.number, i.grade, i.amountSen])).toEqual([
      ["INV-2026-1043", "A", 15_000_000],
      ["INV-2026-1047", "C", 4_200_000],
      ["INV-2026-1050", "D", 3_680_000],
    ]);
  });
});
