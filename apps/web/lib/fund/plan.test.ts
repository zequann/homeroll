import { loadFixtures } from "@homeroll/fixtures";
import { describe, expect, it } from "vitest";
import { sen, senToUnits, units } from "@/lib/fx";
import { companyFloors, type FundSnapshot, fundAccounts, planFund } from "./plan";

const ROOT = "homeroll.testnet";
const fixtures = loadFixtures(ROOT);
const floors = companyFloors(fixtures);
const ESCROW_KEY = "ed25519:11111111111111111111111111111111";
const accounts = fundAccounts(ROOT, ESCROW_KEY);

const met: FundSnapshot = {
  poolCash: floors.poolCash,
  maxBuyerExposure: floors.maxBuyerExposure,
  treasury: floors.treasury,
  funderBalance: units(floors.poolCash + floors.treasury),
  payrollRegistered: true,
  poolRegistered: true,
  funderRegistered: true,
  escrowExists: true,
  escrowRegistered: true,
  escrowBalance: floors.escrowFloat,
};

describe("planFund", () => {
  it("returns no actions when floors are already met", () => {
    expect(planFund(met, floors, accounts)).toEqual([]);
  });

  it("creates escrow with the derived key and makes it a settler in the same plan", () => {
    const actions = planFund(
      { ...met, escrowExists: false, escrowRegistered: false, escrowBalance: units(0n) },
      floors,
      accounts,
    );
    expect(actions.map((a) => a.kind)).toEqual([
      "createEscrow",
      "addSettler",
      "storageDeposit",
      "mintTo",
    ]);
    expect(actions[0]).toMatchObject({
      accountId: "escrow.homeroll.testnet",
      publicKey: ESCROW_KEY,
    });
    expect(actions[3]).toMatchObject({
      accountId: "escrow.homeroll.testnet",
      amount: floors.escrowFloat,
    });
  });

  it("tops escrow up to one payment of every fixture invoice", () => {
    const total = fixtures.invoices.reduce((sum, i) => sum + senToUnits(sen(i.amountSen)), 0n);
    expect(floors.escrowFloat).toBe(total);
    const actions = planFund({ ...met, escrowBalance: units(total - 5n) }, floors, accounts);
    expect(actions).toEqual([
      { kind: "mintTo", accountId: "escrow.homeroll.testnet", tusdc: accounts.tusdc, amount: 5n },
    ]);
  });

  it("plans mint, treasury credit, and pool deposit for an empty chain", () => {
    const snapshot: FundSnapshot = {
      ...met,
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
