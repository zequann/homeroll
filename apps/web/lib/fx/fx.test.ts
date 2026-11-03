import { describe, expect, it } from "vitest";
import {
  feeSen,
  formatRm,
  formatTaka,
  formatUsdc,
  parseRm,
  sen,
  senToTaka,
  senToUnits,
  units,
  unitsToSen,
} from "./index";

const rm = (n: number) => sen(n * 100);

describe("senToUnits and unitsToSen", () => {
  it("shows the demo balances to the sen when rounding to nearest", () => {
    for (const amount of [18_400, 138_400, 43_600, 60_400]) {
      expect(unitsToSen(senToUnits(rm(amount)), "nearest")).toBe(rm(amount));
    }
  });

  it("would show RM18,399.99 if the balance were rounded down", () => {
    expect(unitsToSen(senToUnits(rm(18_400)), "down")).toBe(sen(1_839_999));
  });

  it("rounds a shortfall to exactly RM39,400", () => {
    const needed = senToUnits(rm(78_000)) + senToUnits(rm(5_000));
    const have = senToUnits(rm(18_400)) + senToUnits(sen(2_520_000));
    expect(formatRm(unitsToSen(units(needed - have), "nearest"))).toBe("RM39,400");
  });

  it("rounds up when asked, for fees", () => {
    expect(unitsToSen(senToUnits(rm(18_400)), "up")).toBe(rm(18_400));
    expect(unitsToSen(units(2_382n), "up")).toBe(sen(2));
  });
});

describe("formatting", () => {
  it("formats RM whole or with sen", () => {
    expect(formatRm(rm(39_400))).toBe("RM39,400");
    expect(formatRm(rm(1_950), { decimals: 2 })).toBe("RM1,950.00");
    expect(formatRm(sen(195_050))).toBe("RM1,950.50");
    expect(formatRm(sen(195_050), { decimals: 0 })).toBe("RM1,950.50");
  });

  it("shows Rahim's RM1,950 as 464.28 USDC", () => {
    expect(formatUsdc(senToUnits(rm(1_950)))).toBe("464.28 USDC");
    expect(formatUsdc(senToUnits(rm(18_400)))).toBe("4,380.95 USDC");
  });

  it("formats taka", () => {
    expect(formatTaka(22_628)).toBe("৳22,628");
  });

  it("parses what a person types", () => {
    expect(parseRm("800")).toBe(sen(80_000));
    expect(parseRm("12.5")).toBe(sen(1_250));
    expect(parseRm("1.234")).toBeNull();
    expect(parseRm("-5")).toBeNull();
    expect(parseRm("")).toBeNull();
  });
});

describe("send home maths", () => {
  it("gives ৳22,628 for RM800 after a 0.10% swap leg and a 1.0% payout fee", () => {
    const amount = rm(800);
    const net = amount - feeSen(amount, 10) - feeSen(amount, 100);
    expect(feeSen(amount, 10)).toBe(80);
    expect(net).toBe(79_120);
    expect(senToTaka(sen(net))).toBe(22_628);
  });

  it("gives ৳21,161 at the 7.51% average", () => {
    const amount = rm(800);
    expect(senToTaka(sen(amount - feeSen(amount, 751)))).toBe(21_161);
  });
});
