import { describe, expect, it } from "vitest";
import { units } from "@/lib/fx";
import {
  type DepositRouteSnapshot,
  depositRouteAccounts,
  planDepositRoute,
  SOLVER_FLOAT,
} from "./deposit-route";

const ROOT = "homeroll.testnet";
const LENDER = `l-4f9t2c.${ROOT}`;
const accounts = depositRouteAccounts(ROOT, LENDER, {
  solverPublicKey: "ed25519:solver-made-up",
  lenderPublicKey: "ed25519:lender-made-up",
});
const ready: DepositRouteSnapshot = {
  solverExists: true,
  solverRegistered: true,
  solverBalance: SOLVER_FLOAT,
  lenderExists: true,
  lenderRegistered: true,
  lenderYocto: 5n * 10n ** 23n,
};

describe("planDepositRoute", () => {
  it("does nothing when the solver and the lender are ready", () => {
    expect(planDepositRoute(ready, accounts)).toEqual([]);
  });

  it("creates both accounts on an empty chain and fills the solver's float", () => {
    const actions = planDepositRoute(
      {
        solverExists: false,
        solverRegistered: false,
        solverBalance: units(0n),
        lenderExists: false,
        lenderRegistered: false,
        lenderYocto: 0n,
      },
      accounts,
    );
    expect(actions.map((a) => [a.kind, a.accountId])).toEqual([
      ["createAccount", "solver.homeroll.testnet"],
      ["storageDeposit", "solver.homeroll.testnet"],
      ["mintTo", "solver.homeroll.testnet"],
      ["createAccount", LENDER],
      ["storageDeposit", LENDER],
    ]);
    expect(actions[0]).toMatchObject({ publicKey: "ed25519:solver-made-up" });
    expect(actions[3]).toMatchObject({ publicKey: "ed25519:lender-made-up" });
  });

  it("tops the float back up to 200,000 tUSDC, not beyond (R16.4)", () => {
    const actions = planDepositRoute(
      { ...ready, solverBalance: units(SOLVER_FLOAT - 7n) },
      accounts,
    );
    expect(actions).toEqual([
      { kind: "mintTo", accountId: accounts.solver, tusdc: accounts.tusdc, amount: 7n },
    ]);
  });

  it("gives the lender gas money when it runs low", () => {
    const actions = planDepositRoute({ ...ready, lenderYocto: 10n ** 22n }, accounts);
    expect(actions).toEqual([
      { kind: "topUpNear", accountId: LENDER, fundYocto: 5n * 10n ** 23n - 10n ** 22n },
    ]);
  });

  it("refuses a lender account that is not a pseudonymous l-xxxxxx under the root", () => {
    const keys = { solverPublicKey: "ed25519:a", lenderPublicKey: "ed25519:b" };
    expect(() => depositRouteAccounts(ROOT, `seri-capital.${ROOT}`, keys)).toThrow(
      "Invalid lender name",
    );
    expect(() => depositRouteAccounts(ROOT, "l-4f9t2c.elsewhere.testnet", keys)).toThrow();
  });
});
