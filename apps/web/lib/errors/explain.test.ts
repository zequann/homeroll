import { CONTRACT_ERROR_CODES } from "@homeroll/shared";
import { describe, expect, it } from "vitest";
import { sen } from "@/lib/fx";
import { explain, explainProtocol } from "./explain";

const ROOT = "homeroll-test.testnet";

describe("explain", () => {
  it("has a sentence for every contract error code", () => {
    for (const code of CONTRACT_ERROR_CODES) {
      const { sentence } = explain({ code });
      expect(sentence.length, code).toBeGreaterThan(10);
      expect(sentence, code).not.toMatch(/ERR_/);
    }
  });

  it("explains the tampered timesheet in plain English", () => {
    const { sentence, ruleCaption } = explain(
      { code: "ERR_ABOVE_WAGE_CAP", line: { index: 4, accountId: `w-6b1x4k.${ROOT}` } },
      {
        workerName: "Hafiz Rahman",
        possessive: "his",
        amountSen: sen(1_924_000),
        capSen: sen(290_000),
      },
    );
    expect(sentence).toBe(
      "Line 5, Hafiz Rahman: above wage cap. RM19,240 is more than his RM2,900 cap. Nothing was reserved or paid. Check the timesheet, then run payroll again.",
    );
    expect(ruleCaption).toBe("Rule R4: wage ≤ wage cap. Enforced by the payroll contract.");
  });

  it("explains the fake new account message", () => {
    const { sentence } = explain({
      code: "ERR_PAYEE_NOT_ACTIVE",
      line: { index: 0, accountId: "rahim-wallet.testnet" },
    });
    expect(sentence).toBe(
      "Line 1: rahim-wallet.testnet is not a payee. Nothing was reserved or paid.",
    );
  });

  it("explains a short treasury with the shortfall", () => {
    const { sentence, ruleCaption } = explain(
      { code: "ERR_BELOW_BUFFER" },
      { shortfallSen: sen(3_940_000) },
    );
    expect(sentence).toBe(
      "Short by RM39,400. Nothing was reserved or paid. Take an advance on another invoice, then run payroll again.",
    );
    expect(ruleCaption).toBe("Rule R6: the treasury stays above the buffer.");
  });

  it("says who rejected a protocol failure", () => {
    expect(explainProtocol("DepositWithFunctionCall").sentence).toMatch(/^NEAR rejected this/);
  });
});
