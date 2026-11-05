import { describe, expect, it } from "vitest";
import { parseEmployer, parseInvoice, parsePayees, parsePool, parseRuns } from "./parse";

const HASH = "abc";

describe("parsePayees", () => {
  it("maps null to an empty list", () => {
    expect(parsePayees(null)).toEqual([]);
  });

  it("throws when cap is a JSON number", () => {
    expect(() => parsePayees([{ account_id: "w-1.testnet", cap: 1, active_from: "0" }])).toThrow(
      /must not be a JSON number/,
    );
  });
});

describe("parseEmployer", () => {
  it("throws when treasury is a JSON number", () => {
    expect(() =>
      parseEmployer({ treasury: 1, buffer: "0", onboarding: false, payee_count: 0 }),
    ).toThrow(/treasury must not be a JSON number/);
  });
});

describe("parseInvoice", () => {
  it("throws when due_ts would be a number on amount field", () => {
    expect(() =>
      parseInvoice(
        {
          employer: "co.testnet",
          amount: 100,
          grade: "A",
          status: "Attested",
          advance: null,
          fee: null,
        },
        HASH,
      ),
    ).toThrow(/amount must not be a JSON number/);
  });
});

describe("parsePool", () => {
  it("maps snake_case pool fields", () => {
    const view = parsePool({
      cash: "1",
      outstanding: "2",
      fees_earned: "3",
      max_buyer_exposure: "4",
      extra: "ignored",
    });
    expect(view).toEqual({
      cash: 1n,
      outstanding: 2n,
      feesEarned: 3n,
    });
  });
});

describe("parseRuns", () => {
  it("accepts run_id as a JSON number", () => {
    const runs = parseRuns([
      {
        run_id: 0,
        period: "2026-10",
        status: "Pending",
        lines: [{ account_id: "w-1.testnet", amount: "1", status: "Reserved" }],
      },
    ]);
    expect(runs?.[0]?.runId).toBe(0);
  });
});
