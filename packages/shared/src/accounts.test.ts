import { describe, expect, it } from "vitest";
import { homerollAccounts, isValidAccountId, workerAccountId } from "./accounts";

describe("homerollAccounts", () => {
  it("builds every account from the root, with the factory on the root itself", () => {
    expect(homerollAccounts("homeroll.testnet")).toEqual({
      root: "homeroll.testnet",
      factory: "homeroll.testnet",
      tusdc: "tusdc.homeroll.testnet",
      pool: "pool.homeroll.testnet",
      payroll: "payroll.homeroll.testnet",
      agent: "agent.homeroll.testnet",
      relayer: "relayer.homeroll.testnet",
      escrow: "escrow.homeroll.testnet",
      payout: "payout.homeroll.testnet",
      offramp: "offramp.homeroll.testnet",
      solver: "solver.homeroll.testnet",
    });
  });

  it("rejects an invalid root", () => {
    expect(() => homerollAccounts("Homeroll.testnet")).toThrow("Invalid NEAR account ID");
    expect(() => homerollAccounts("")).toThrow("Invalid NEAR account ID");
  });

  it("rejects a root too long to hold its sub-accounts", () => {
    const root = `${"a".repeat(56)}.testnet`; // 64 chars: valid alone, not with "tusdc."
    expect(isValidAccountId(root)).toBe(true);
    expect(() => homerollAccounts(root)).toThrow("Invalid NEAR account ID");
  });
});

describe("workerAccountId", () => {
  it("puts a pseudonymous worker under the root", () => {
    expect(workerAccountId("w-7k2q9x", "homeroll.testnet")).toBe("w-7k2q9x.homeroll.testnet");
  });

  it.each(["rahim", "w-7k2q9", "w-7k2q9x1", "w-7K2Q9X", "w_7k2q9x"])(
    "rejects %s, which is not a random w-xxxxxx name (R13)",
    (name) => {
      expect(() => workerAccountId(name, "homeroll.testnet")).toThrow("Invalid worker name");
    },
  );
});

describe("isValidAccountId", () => {
  it.each(["homeroll.testnet", "w-7k2q9x.homeroll.testnet", "a1", "my_app.near"])(
    "accepts %s",
    (id) => {
      expect(isValidAccountId(id)).toBe(true);
    },
  );

  it.each([
    "a",
    "a".repeat(65),
    "UPPER.testnet",
    "double--dash.testnet",
    "-leading.testnet",
    "trailing-.testnet",
    "two..dots",
    ".testnet",
  ])("rejects %s", (id) => {
    expect(isValidAccountId(id)).toBe(false);
  });
});
