import type { Fixtures } from "@homeroll/fixtures";
import type { AccountId } from "@homeroll/shared";
import { homerollAccounts as accountsFor } from "@homeroll/shared";
import { sen, senToUnits, units, type Units } from "../fx/index.ts";
import { adminSigner, type AdminSigner } from "../keys.ts";
import {
  broadcastAdmin,
  callMethod,
  callMethods,
  ftBalanceOf,
  storageRegistered,
  viewFunction,
} from "../near/rpc.ts";
import { adminStep, planMint, readDeployEnv } from "../deploy/deploy.ts";

export type FundSnapshot = {
  readonly poolCash: Units;
  readonly maxBuyerExposure: Units;
  readonly treasury: Units;
  readonly funderBalance: Units;
  readonly payrollRegistered: boolean;
  readonly poolRegistered: boolean;
  readonly funderRegistered: boolean;
};

export type FundFloors = {
  readonly poolCash: Units;
  readonly treasury: Units;
  readonly maxBuyerExposure: Units;
};

export type FundAccounts = {
  readonly funder: AccountId;
  readonly tusdc: AccountId;
  readonly payroll: AccountId;
  readonly pool: AccountId;
  readonly employer: AccountId;
};

export type FundAction =
  | { readonly kind: "storageDeposit"; readonly accountId: AccountId; readonly tusdc: AccountId }
  | { readonly kind: "setMaxBuyerExposure"; readonly pool: AccountId; readonly amount: Units }
  | { readonly kind: "mint"; readonly funder: AccountId; readonly tusdc: AccountId; readonly amount: Units }
  | {
      readonly kind: "creditTreasury";
      readonly payroll: AccountId;
      readonly employer: AccountId;
      readonly tusdc: AccountId;
      readonly amount: Units;
    }
  | { readonly kind: "depositPool"; readonly pool: AccountId; readonly tusdc: AccountId; readonly amount: Units };

const TOKEN_STORAGE_DEPOSIT_YOCTO = 10n ** 22n;
const GAS_FT_CALL = 100n * 1_000_000_000_000n;

export function companyFloors(fixtures: Fixtures): FundFloors {
  const advance = senToUnits(sen(12_000_000));
  return {
    poolCash: advance,
    treasury: senToUnits(sen(fixtures.company.treasurySen)),
    maxBuyerExposure: advance,
  };
}

export function fundAccounts(root: AccountId, ownerLabel = "perabotjaya"): FundAccounts {
  const accounts = accountsFor(root);
  return {
    funder: accounts.root,
    tusdc: accounts.tusdc,
    payroll: accounts.payroll,
    pool: accounts.pool,
    employer: `${ownerLabel}.${root}` as AccountId,
  };
}

export function planFund(
  snapshot: FundSnapshot,
  floors: FundFloors,
  accounts: FundAccounts,
): readonly FundAction[] {
  const actions: FundAction[] = [];
  if (!snapshot.funderRegistered) {
    actions.push({ kind: "storageDeposit", accountId: accounts.funder, tusdc: accounts.tusdc });
  }
  if (!snapshot.payrollRegistered) {
    actions.push({ kind: "storageDeposit", accountId: accounts.payroll, tusdc: accounts.tusdc });
  }
  if (!snapshot.poolRegistered) {
    actions.push({ kind: "storageDeposit", accountId: accounts.pool, tusdc: accounts.tusdc });
  }
  if (snapshot.maxBuyerExposure < floors.maxBuyerExposure) {
    actions.push({
      kind: "setMaxBuyerExposure",
      pool: accounts.pool,
      amount: floors.maxBuyerExposure,
    });
  }

  const treasuryShort =
    floors.treasury > snapshot.treasury ? floors.treasury - snapshot.treasury : 0n;
  const poolShort = floors.poolCash > snapshot.poolCash ? floors.poolCash - snapshot.poolCash : 0n;
  const needed = treasuryShort + poolShort;
  const mintAmount =
    needed > snapshot.funderBalance ? needed - snapshot.funderBalance : 0n;
  if (mintAmount > 0n) {
    actions.push({
      kind: "mint",
      funder: accounts.funder,
      tusdc: accounts.tusdc,
      amount: units(mintAmount),
    });
  }
  if (treasuryShort > 0n) {
    actions.push({
      kind: "creditTreasury",
      payroll: accounts.payroll,
      employer: accounts.employer,
      tusdc: accounts.tusdc,
      amount: units(treasuryShort),
    });
  }
  if (poolShort > 0n) {
    actions.push({
      kind: "depositPool",
      pool: accounts.pool,
      tusdc: accounts.tusdc,
      amount: units(poolShort),
    });
  }
  return actions;
}

export async function readFundSnapshot(accounts: FundAccounts): Promise<FundSnapshot> {
  const [poolRaw, employerRaw, funderBalance, payrollRegistered, poolRegistered, funderRegistered] =
    await Promise.all([
      viewFunction(accounts.pool, "get_pool", {}),
      viewFunction(accounts.payroll, "get_employer", { employer: accounts.employer }),
      ftBalanceOf(accounts.tusdc, accounts.funder),
      storageRegistered(accounts.tusdc, accounts.payroll),
      storageRegistered(accounts.tusdc, accounts.pool),
      storageRegistered(accounts.tusdc, accounts.funder),
    ]);
  const pool = poolRaw as { cash?: string; max_buyer_exposure?: string };
  const employer = employerRaw as { treasury?: string } | null;
  return {
    poolCash: units(BigInt(pool.cash ?? "0")),
    maxBuyerExposure: units(BigInt(pool.max_buyer_exposure ?? "0")),
    treasury: units(BigInt(employer?.treasury ?? "0")),
    funderBalance,
    payrollRegistered,
    poolRegistered,
    funderRegistered,
  };
}

export async function applyFundAction(action: FundAction, admin: AdminSigner): Promise<void> {
  switch (action.kind) {
    case "storageDeposit":
      await broadcastAdmin(
        adminStep({
          kind: "storageDeposit",
          account: action.accountId,
          tusdc: action.tusdc,
          depositYocto: TOKEN_STORAGE_DEPOSIT_YOCTO,
        }),
        admin,
        "FINAL",
      );
      return;
    case "setMaxBuyerExposure":
      await callMethods(admin, action.pool, [
        {
          method: "set_max_buyer_exposure",
          args: { max_buyer_exposure: action.amount.toString() },
        },
      ]);
      return;
    case "mint":
      await broadcastAdmin(planMint(accountsFor(admin.accountId), action.funder, action.amount), admin, "FINAL");
      return;
    case "creditTreasury":
      await callMethod(admin, action.tusdc, {
        method: "ft_transfer_call",
        args: {
          receiver_id: action.payroll,
          amount: action.amount.toString(),
          msg: JSON.stringify({ employer: action.employer }),
        },
        gas: GAS_FT_CALL,
        depositYocto: 1n,
      });
      return;
    case "depositPool":
      await callMethod(admin, action.tusdc, {
        method: "ft_transfer_call",
        args: {
          receiver_id: action.pool,
          amount: action.amount.toString(),
          msg: JSON.stringify({ deposit: {} }),
        },
        gas: GAS_FT_CALL,
        depositYocto: 1n,
      });
      return;
  }
}

export function readFundEnv(env: Readonly<Record<string, string | undefined>>) {
  return readDeployEnv(env);
}
