import type { AccountId } from "@homeroll/shared";
import { homerollAccounts, lenderAccountId } from "@homeroll/shared";
import { adminStep, planMint } from "../deploy/deploy.ts";
import { type Units, units } from "../fx/index.ts";
import { type AdminSigner, deriveKey } from "../keys.ts";
import { broadcastAdmin, ftBalanceOf, storageRegistered, viewAccount } from "../near/rpc.ts";

/**
 * The accounts behind private lender deposits (SPEC §8.9): the mock solver with its tUSDC float,
 * and the demo lender's pseudonymous account. Seed and Reset demo run this after `planFund`.
 * Idempotent: a second plan right after applying the first is empty.
 */

/** R16.4: the most testnet tUSDC that can ever leave the solver between two resets. */
export const SOLVER_FLOAT = units(200_000_000_000n);
const TOKEN_STORAGE_DEPOSIT_YOCTO = 10n ** 22n;
/** The solver pays gas for its ft_transfer and the lender for its ft_transfer_call, 100 Tgas. */
const ACCOUNT_FUND_YOCTO = 5n * 10n ** 23n;
/** Below 0.1 NEAR the lender is topped back up to 0.5 NEAR. */
const LENDER_GAS_FLOOR_YOCTO = 10n ** 23n;

export type DepositRouteAccounts = {
  readonly tusdc: AccountId;
  readonly solver: AccountId;
  readonly solverPublicKey: string;
  readonly lender: AccountId;
  readonly lenderPublicKey: string;
};

export type DepositRouteSnapshot = {
  readonly solverExists: boolean;
  readonly solverRegistered: boolean;
  readonly solverBalance: Units;
  readonly lenderExists: boolean;
  readonly lenderRegistered: boolean;
  readonly lenderYocto: bigint;
};

export type DepositRouteAction =
  | {
      readonly kind: "createAccount";
      readonly accountId: AccountId;
      readonly publicKey: string;
      readonly fundYocto: bigint;
    }
  | { readonly kind: "topUpNear"; readonly accountId: AccountId; readonly fundYocto: bigint }
  | { readonly kind: "storageDeposit"; readonly accountId: AccountId; readonly tusdc: AccountId }
  | {
      readonly kind: "mintTo";
      readonly accountId: AccountId;
      readonly tusdc: AccountId;
      readonly amount: Units;
    };

export function depositRouteAccounts(
  root: AccountId,
  lender: AccountId,
  keys: { solverPublicKey: string; lenderPublicKey: string },
): DepositRouteAccounts {
  const accounts = homerollAccounts(root);
  // Names stay off-chain: only a random l-xxxxxx id under the root may hold pool shares here.
  const name = lender.endsWith(`.${root}`) ? lender.slice(0, -(root.length + 1)) : lender;
  return {
    tusdc: accounts.tusdc,
    solver: accounts.solver,
    lender: lenderAccountId(name, root),
    ...keys,
  };
}

/** The same accounts, with the solver's and the lender's keys derived from the server seed (SPEC §12). */
export function derivedDepositRouteAccounts(
  root: AccountId,
  seedHex: string,
  lender: AccountId,
): DepositRouteAccounts {
  return depositRouteAccounts(root, lender, {
    solverPublicKey: deriveKey(seedHex, homerollAccounts(root).solver, "solver").publicKey,
    lenderPublicKey: deriveKey(seedHex, lender, "lender").publicKey,
  });
}

export function planDepositRoute(
  snapshot: DepositRouteSnapshot,
  accounts: DepositRouteAccounts,
): readonly DepositRouteAction[] {
  const actions: DepositRouteAction[] = [];
  const { tusdc } = accounts;
  if (!snapshot.solverExists) {
    actions.push({
      kind: "createAccount",
      accountId: accounts.solver,
      publicKey: accounts.solverPublicKey,
      fundYocto: ACCOUNT_FUND_YOCTO,
    });
  }
  if (!snapshot.solverRegistered) {
    actions.push({ kind: "storageDeposit", accountId: accounts.solver, tusdc });
  }
  if (snapshot.solverBalance < SOLVER_FLOAT) {
    actions.push({
      kind: "mintTo",
      accountId: accounts.solver,
      tusdc,
      amount: units(SOLVER_FLOAT - snapshot.solverBalance),
    });
  }
  if (!snapshot.lenderExists) {
    actions.push({
      kind: "createAccount",
      accountId: accounts.lender,
      publicKey: accounts.lenderPublicKey,
      fundYocto: ACCOUNT_FUND_YOCTO,
    });
  } else if (snapshot.lenderYocto < LENDER_GAS_FLOOR_YOCTO) {
    actions.push({
      kind: "topUpNear",
      accountId: accounts.lender,
      fundYocto: ACCOUNT_FUND_YOCTO - snapshot.lenderYocto,
    });
  }
  if (!snapshot.lenderRegistered) {
    actions.push({ kind: "storageDeposit", accountId: accounts.lender, tusdc });
  }
  return actions;
}

export async function readDepositRouteSnapshot(
  accounts: DepositRouteAccounts,
): Promise<DepositRouteSnapshot> {
  const [solver, solverRegistered, lender, lenderRegistered] = await Promise.all([
    viewAccount(accounts.solver),
    storageRegistered(accounts.tusdc, accounts.solver),
    viewAccount(accounts.lender),
    storageRegistered(accounts.tusdc, accounts.lender),
  ]);
  return {
    solverExists: solver.exists,
    solverRegistered,
    solverBalance: solverRegistered
      ? await ftBalanceOf(accounts.tusdc, accounts.solver)
      : units(0n),
    lenderExists: lender.exists,
    lenderRegistered,
    lenderYocto: lender.balanceYocto,
  };
}

export async function applyDepositRouteAction(
  action: DepositRouteAction,
  admin: AdminSigner,
): Promise<void> {
  switch (action.kind) {
    case "createAccount":
      await broadcastAdmin(
        adminStep({
          kind: "createPlain",
          account: action.accountId,
          publicKey: action.publicKey,
          fundYocto: action.fundYocto,
        }),
        admin,
        "EXECUTED",
      );
      return;
    case "topUpNear":
      await broadcastAdmin(
        adminStep({ kind: "topUp", account: action.accountId, fundYocto: action.fundYocto }),
        admin,
        "EXECUTED",
      );
      return;
    case "storageDeposit":
      await broadcastAdmin(
        adminStep({
          kind: "storageDeposit",
          account: action.accountId,
          tusdc: action.tusdc,
          depositYocto: TOKEN_STORAGE_DEPOSIT_YOCTO,
        }),
        admin,
        "EXECUTED",
      );
      return;
    case "mintTo":
      await broadcastAdmin(
        planMint(homerollAccounts(admin.accountId), action.accountId, action.amount),
        admin,
        "EXECUTED",
      );
      return;
  }
}

/** Applies the plan, then checks that a second plan is empty. */
export async function provisionDepositRoute(
  accounts: DepositRouteAccounts,
  admin: AdminSigner,
): Promise<void> {
  for (const action of planDepositRoute(await readDepositRouteSnapshot(accounts), accounts)) {
    await applyDepositRouteAction(action, admin);
  }
  const left = planDepositRoute(await readDepositRouteSnapshot(accounts), accounts);
  if (left.length > 0) throw new Error("deposit route plan did not converge");
}
