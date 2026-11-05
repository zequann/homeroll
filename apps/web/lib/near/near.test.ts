import { describe, expect, it } from "vitest";
import { txFailureFromMessage } from "./near";

describe("txFailureFromMessage", () => {
  // The texts near-api-js 7.4 throws for a rejected function-call key (lib/rpc-errors).
  it.each([
    [
      "Access key receiver payroll.homeroll.testnet does not match transaction receiver pool.homeroll.testnet",
      "ReceiverMismatch",
    ],
    ["Access key does not allow method ft_transfer", "MethodNameMismatch"],
    ["Access key requires full access", "RequiresFullAccess"],
    ["Deposit is not allowed with function call", "DepositWithFunctionCall"],
    ['{"InvalidAccessKeyError":"DepositWithFunctionCall"}', "DepositWithFunctionCall"],
  ])("reads %s as a protocol rejection", (message, name) => {
    expect(txFailureFromMessage(message)).toEqual({ kind: "protocol", name });
  });

  it("reads a contract panic with its line suffix", () => {
    expect(
      txFailureFromMessage(
        "Smart contract panicked: ERR_ABOVE_WAGE_CAP:4:w-6b1x4k.homeroll.testnet",
      ),
    ).toEqual({
      kind: "contract",
      error: {
        code: "ERR_ABOVE_WAGE_CAP",
        line: { index: 4, accountId: "w-6b1x4k.homeroll.testnet" },
      },
    });
  });

  it("rethrows anything else", () => {
    expect(() => txFailureFromMessage("RPC unreachable")).toThrow("RPC unreachable");
  });
});
