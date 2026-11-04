import { describe, expect, it } from "vitest";
import { checkAccessKey } from "./access-key";
import type { KeyPermission } from "./client";

const payrollAgent: KeyPermission = {
  kind: "FunctionCall",
  receiverId: "payroll.homeroll-test.testnet",
  methodNames: ["submit_run", "pay_run"],
  allowance: 10n ** 24n,
};
const call = (receiverId: string, methodName: string, depositYocto = 0n) => ({
  receiverId,
  actions: [{ type: "FunctionCall" as const, methodName, depositYocto }],
});

describe("function-call key checks (SPEC §6, R1, R2)", () => {
  it("allows payroll.submit_run", () => {
    expect(checkAccessKey(payrollAgent, call("payroll.homeroll-test.testnet", "submit_run"))).toBe(
      null,
    );
  });
  it("05a: tusdc.ft_transfer with 1 yocto → DepositWithFunctionCall (checked before receiver)", () => {
    expect(
      checkAccessKey(payrollAgent, call("tusdc.homeroll-test.testnet", "ft_transfer", 1n)),
    ).toBe("DepositWithFunctionCall");
  });
  it("05b: the same call with no deposit → ReceiverMismatch", () => {
    expect(checkAccessKey(payrollAgent, call("tusdc.homeroll-test.testnet", "ft_transfer"))).toBe(
      "ReceiverMismatch",
    );
  });
  it("05c: payroll.add_payee → MethodNameMismatch", () => {
    expect(checkAccessKey(payrollAgent, call("payroll.homeroll-test.testnet", "add_payee"))).toBe(
      "MethodNameMismatch",
    );
  });
  it("two actions or a plain transfer → RequiresFullAccess", () => {
    const tx = call("payroll.homeroll-test.testnet", "submit_run");
    expect(checkAccessKey(payrollAgent, { ...tx, actions: [...tx.actions, ...tx.actions] })).toBe(
      "RequiresFullAccess",
    );
    expect(
      checkAccessKey(payrollAgent, {
        receiverId: "x.testnet",
        actions: [{ type: "Transfer", depositYocto: 1n }],
      }),
    ).toBe("RequiresFullAccess");
  });
});
