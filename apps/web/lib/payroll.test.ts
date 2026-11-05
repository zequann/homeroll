import { loadFixtures } from "@homeroll/fixtures";
import { describe, expect, it } from "vitest";
import { sen, senToUnits, units, unitsToSen } from "@/lib/fx";
import { buildPayLines } from "./payroll";

const ROOT = "homeroll-test.testnet";
const fixtures = loadFixtures(ROOT);

describe("buildPayLines", () => {
  it("returns 40 lines with Rahim first at RM1,950", () => {
    const lines = buildPayLines(fixtures.timesheet);
    expect(lines).toHaveLength(40);
    expect(lines[0]?.accountId).toBe(`w-7k2q9x.${ROOT}`);
    expect(unitsToSen(lines[0]?.amount ?? units(0n), "nearest")).toBe(sen(195_000));
    expect(lines[0]?.amount).toBe(senToUnits(sen(195_000)));
  });
});
