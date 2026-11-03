import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACT_ERROR_CODES, parseContractError } from "./errors";

describe("CONTRACT_ERROR_CODES", () => {
  it("matches contracts/common/src/errors.rs exactly, in the same order", () => {
    const rust = readFileSync(
      new URL("../../../contracts/common/src/errors.rs", import.meta.url),
      "utf8",
    );
    const constants = [...rust.matchAll(/pub const (\w+): &str = "(\w+)";/g)];
    for (const [, name, value] of constants) {
      expect(value, `Rust constant ${name}`).toBe(name);
    }
    expect(constants.map(([, name]) => name)).toEqual([...CONTRACT_ERROR_CODES]);
  });
});

describe("parseContractError", () => {
  it("reads a pay-line error from a wrapped RPC message", () => {
    expect(
      parseContractError("Smart contract panicked: ERR_ABOVE_WAGE_CAP:4:w-6b1x4k.homeroll.testnet"),
    ).toEqual({
      code: "ERR_ABOVE_WAGE_CAP",
      line: { index: 4, accountId: "w-6b1x4k.homeroll.testnet" },
    });
  });

  it("reads an error without a pay line", () => {
    expect(parseContractError("Smart contract panicked: ERR_BELOW_BUFFER")).toEqual({
      code: "ERR_BELOW_BUFFER",
    });
  });

  it("returns null for codes our contracts do not use and for protocol errors", () => {
    expect(parseContractError("Smart contract panicked: ERR_SOMETHING_ELSE")).toBeNull();
    expect(parseContractError("InvalidAccessKeyError: ReceiverMismatch")).toBeNull();
  });
});
