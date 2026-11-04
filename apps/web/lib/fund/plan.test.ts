import { loadFixtures } from "@homeroll/fixtures";
import { describe, expect, it } from "vitest";
import { sen, senToUnits, units } from "@/lib/fx";
import { companyFloors, fundAccounts, planFund, type FundSnapshot } from "./plan";

const ROOT = "homeroll.testnet";
const fixtures = loadFixtures(ROOT);
const floors = companyFloors(fixtures);
const accounts = fundAccounts(ROOT);

describe("planFund", () => {
  it("returns no actions when floors are already met", () => {
    const snapshot: FundSnapshot = {
      poolCash: floors.poolCash,
      maxBuyerExposure: floors.maxBuyerExposure,
      treasury: floors.treasury,
      funderBalance: units(floors.poolCash + floors.treasury),
      payrollRegistered: true,
      poolRegistered: true,
      funderRegistered: true,
    };
    expect(planFund(snapshot, floors, accounts)).toEqual([]);
  });

  it("plans mint, treasury credit, and pool deposit for an empty chain", () => {
    const snapshot: FundSnapshot = {
      poolCash: units(0n),
      maxBuyerExposure: units(0n),
      treasury: units(0n),
      funderBalance: units(0n),
      payrollRegistered: false,
      poolRegistered: false,
      funderRegistered: false,
    };
    const actions = planFund(snapshot, floors, accounts);
    expect(actions[0]?.kind).toBe("storageDeposit");
    expect(actions.some((a) => a.kind === "mint")).toBe(true);
    expect(actions.some((a) => a.kind === "creditTreasury")).toBe(true);
    expect(actions.some((a) => a.kind === "depositPool")).toBe(true);
    const mint = actions.find((a) => a.kind === "mint");
    expect(mint?.kind === "mint" && mint.amount).toBe(floors.poolCash + floors.treasury);
  });

  it("uses senToUnits for the RM18,400 treasury floor", () => {
    expect(floors.treasury).toBe(senToUnits(sen(fixtures.company.treasurySen)));
    expect(floors.poolCash).toBe(senToUnits(sen(12_000_000)));
  });
});
