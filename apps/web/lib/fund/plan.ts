import type { Fixtures } from "@homeroll/fixtures";
import type { AccountId } from "@homeroll/shared";
import { homerollAccounts as accountsFor } from "@homeroll/shared";
import { adminStep, planMint, readDeployEnv } from "../deploy/deploy.ts";
import { sen, senToUnits, type Units, units } from "../fx/index.ts";
import type { AdminSigner } from "../keys.ts";
import {
  broadcastAdmin,
  callMethod,
  callMethods,
  ftBalanceOf,
  storageRegistered,
  viewAccount,
  viewFunction,
} from "../near/rpc.ts";
import { maxAdvanceBps } from "../pool-grades.ts";

export type FundSnapshot = {
  readonly poolCash: Units;
  readonly maxBuyerExposure: Units;
  readonly treasury: Units;
  readonly funderBalance: Units;
  readonly payrollRegistered: boolean;
  readonly poolRegistered: boolean;
  readonly funderRegistered: boolean;
  readonly escrowExists: boolean;
  readonly escrowRegistered: boolean;
  readonly escrowBalance: Units;
};

export type FundFloors = {
  readonly poolCash: Units;
  readonly treasury: Units;
  readonly maxBuyerExposure: Units;
  /** The mock buyer's payment lands in escrow before escrow settles, so escrow holds it ahead. */
  readonly escrowFloat: Units;
};

export type FundAccounts = {
  readonly funder: AccountId;
  readonly tusdc: AccountId;
  readonly payroll: AccountId;
  readonly pool: AccountId;
  readonly employer: AccountId;
  readonly escrow: AccountId;
  readonly escrowPublicKey: string;
};

export type FundAction =
  | { readonly kind: "createEscrow"; readonly accountId: AccountId; readonly publicKey: string }
  | { readonly kind: "addSettler"; readonly pool: AccountId; readonly accountId: AccountId }
  | { readonly kind: "storageDeposit"; readonly accountId: AccountId; readonly tusdc: AccountId }
  | { readonly kind: "setMaxBuyerExposure"; readonly pool: AccountId; readonly amount: Units }
  | {
      readonly kind: "mint";
      readonly funder: AccountId;
      readonly tusdc: AccountId;
      readonly amount: Units;
    }
  | {
      readonly kind: "mintTo";
      readonly accountId: AccountId;
      readonly tusdc: AccountId;
      readonly amount: Units;
    }
  | {
      readonly kind: "creditTreasury";
      readonly payroll: AccountId;
      readonly employer: AccountId;
      readonly tusdc: AccountId;
      readonly amount: Units;
    }
  | {
      readonly kind: "depositPool";
      readonly pool: AccountId;
      readonly tusdc: AccountId;
      readonly amount: Units;
    };

const TOKEN_STORAGE_DEPOSIT_YOCTO = 10n ** 22n;
const GAS_FT_CALL = 100n * 1_000_000_000_000n;
// Escrow pays gas for its own settle calls, 200 Tgas each.
const ESCROW_FUND_YOCTO = 2n * 10n ** 24n;

export function companyFloors(fixtures: Fixtures): FundFloors {
  // Each invoice's largest advance at its demo grade: RM120,000 (A), RM25,200 (C), none (D)
  const advances = fixtures.invoices.map((i) =>
    senToUnits(sen(Math.floor((i.amountSen * maxAdvanceBps(i.expectedGrade)) / 10_000))),
  );
  const invoices = fixtures.invoices.reduce((sum, i) => sum + senToUnits(sen(i.amountSen)), 0n);
  return {
    // The demo takes the Grade C advance first ("Short by RM39,400"), then Grade A: both must fit
    poolCash: units(advances.reduce((sum, a) => sum + a, 0n)),
    treasury: senToUnits(sen(fixtures.company.treasurySen)),
    // Each invoice has its own buyer, so the per-buyer limit needs the largest single advance (R11)
    maxBuyerExposure: units(advances.reduce((max, a) => (a > max ? a : max), 0n)),
    escrowFloat: units(invoices),
  };
}

export function fundAccounts(
  root: AccountId,
  escrowPublicKey: string,
  ownerLabel = "coffeefactory",
): FundAccounts {
  const accounts = accountsFor(root);
  return {
    funder: accounts.root,
    tusdc: accounts.tusdc,
    payroll: accounts.payroll,
    pool: accounts.pool,
    employer: `${ownerLabel}.${root}` as AccountId,
    escrow: accounts.escrow,
    escrowPublicKey,
  };
}

export function planFund(
  snapshot: FundSnapshot,
  floors: FundFloors,
  accounts: FundAccounts,
): readonly FundAction[] {
  const actions: FundAction[] = [];
  if (!snapshot.escrowExists) {
    actions.push({
      kind: "createEscrow",
      accountId: accounts.escrow,
      publicKey: accounts.escrowPublicKey,
    });
    // The pool has no settler view. add_settler is idempotent, so it rides with account creation.
    actions.push({ kind: "addSettler", pool: accounts.pool, accountId: accounts.escrow });
  }
  if (!snapshot.escrowRegistered) {
    actions.push({ kind: "storageDeposit", accountId: accounts.escrow, tusdc: accounts.tusdc });
  }
  if (snapshot.escrowBalance < floors.escrowFloat) {
    actions.push({
      kind: "mintTo",
      accountId: accounts.escrow,
      tusdc: accounts.tusdc,
      amount: units(floors.escrowFloat - snapshot.escrowBalance),
    });
  }
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
  const mintAmount = needed > snapshot.funderBalance ? needed - snapshot.funderBalance : 0n;
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
  const [
    poolRaw,
    employerRaw,
    funderBalance,
    payrollRegistered,
    poolRegistered,
    funderRegistered,
    escrow,
    escrowRegistered,
  ] = await Promise.all([
    viewFunction(accounts.pool, "get_pool", {}),
    viewFunction(accounts.payroll, "get_employer", { employer: accounts.employer }),
    ftBalanceOf(accounts.tusdc, accounts.funder),
    storageRegistered(accounts.tusdc, accounts.payroll),
    storageRegistered(accounts.tusdc, accounts.pool),
    storageRegistered(accounts.tusdc, accounts.funder),
    viewAccount(accounts.escrow),
    storageRegistered(accounts.tusdc, accounts.escrow),
  ]);
  const escrowBalance = escrowRegistered
    ? await ftBalanceOf(accounts.tusdc, accounts.escrow)
    : units(0n);
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
    escrowExists: escrow.exists,
    escrowRegistered,
    escrowBalance,
  };
}

export async function applyFundAction(action: FundAction, admin: AdminSigner): Promise<void> {
  switch (action.kind) {
    case "createEscrow":
      await broadcastAdmin(
        adminStep({
          kind: "createPlain",
          account: action.accountId,
          publicKey: action.publicKey,
          fundYocto: ESCROW_FUND_YOCTO,
        }),
        admin,
        "FINAL",
      );
      return;
    case "addSettler":
      await callMethods(admin, action.pool, [
        { method: "add_settler", args: { account_id: action.accountId } },
      ]);
      return;
    case "mintTo":
      await broadcastAdmin(
        planMint(accountsFor(admin.accountId), action.accountId, action.amount),
        admin,
        "FINAL",
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
      await broadcastAdmin(
        planMint(accountsFor(admin.accountId), action.funder, action.amount),
        admin,
        "FINAL",
      );
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

/** Mints testnet tUSDC to the admin if needed, then credits one employer's payroll treasury. */
export async function addTreasury(
  admin: AdminSigner,
  employer: AccountId,
  amount: Units,
): Promise<void> {
  const { tusdc, payroll } = accountsFor(admin.accountId);
  if (!(await storageRegistered(tusdc, admin.accountId))) {
    await applyFundAction({ kind: "storageDeposit", accountId: admin.accountId, tusdc }, admin);
  }
  const balance = await ftBalanceOf(tusdc, admin.accountId);
  if (balance < amount) {
    await applyFundAction(
      { kind: "mint", funder: admin.accountId, tusdc, amount: units(amount - balance) },
      admin,
    );
  }
  await applyFundAction({ kind: "creditTreasury", payroll, employer, tusdc, amount }, admin);
}
