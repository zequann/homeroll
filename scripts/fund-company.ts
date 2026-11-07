#!/usr/bin/env node
import {
  derivedDepositRouteAccounts,
  provisionDepositRoute,
} from "../apps/web/lib/fund/deposit-route.ts";
import {
  applyFundAction,
  companyFloors,
  fundAccounts,
  planFund,
  readFundEnv,
  readFundSnapshot,
} from "../apps/web/lib/fund/plan.ts";
import { adminSigner, deriveKey } from "../apps/web/lib/keys.ts";
import { configureRpc } from "../apps/web/lib/near/rpc.ts";
import { loadEnvLocal } from "../apps/web/lib/seed/shell.ts";
import { loadFixtures } from "../fixtures/index.ts";
import { homerollAccounts } from "../packages/shared/src/index.ts";

const env = readFundEnv({ ...loadEnvLocal("apps/web/.env.local"), ...process.env });
if (!env.ok) {
  console.log(JSON.stringify({ ok: false, reason: env.reason }));
  process.exit(2);
}

configureRpc(env.input.rpcUrl);
const admin = adminSigner(env.input.root, env.input.adminSecretKey);
if (!admin) {
  console.log(JSON.stringify({ ok: false, reason: "admin_key_missing" }));
  process.exit(2);
}

if (!env.input.seedHex) {
  console.log(JSON.stringify({ ok: false, reason: "seed_missing" }));
  process.exit(2);
}

const fixtures = loadFixtures(env.input.root);
const floors = companyFloors(fixtures);
const escrow = homerollAccounts(env.input.root).escrow;
const accounts = fundAccounts(
  env.input.root,
  deriveKey(env.input.seedHex, escrow, "escrow").publicKey,
  fixtures.company.ownerLabel,
);

let actions = planFund(await readFundSnapshot(accounts), floors, accounts);
for (const action of actions) await applyFundAction(action, admin);
actions = planFund(await readFundSnapshot(accounts), floors, accounts);
if (actions.length > 0) {
  throw new Error("fund plan did not converge");
}
// The mock solver's float and the demo lender's account, for private deposits (SPEC §8.9)
await provisionDepositRoute(
  derivedDepositRouteAccounts(env.input.root, env.input.seedHex, fixtures.lender.accountId),
  admin,
);
console.log(JSON.stringify({ ok: true, actions: 0 }));
