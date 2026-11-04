#!/usr/bin/env node
import { units } from "../apps/web/lib/fx/index.ts";
import { proveGaslessTransfer } from "../apps/web/lib/relay/prove.ts";

const adminSecretKey = process.env.HOMEROLL_ADMIN_PRIVATE_KEY?.trim();
const seedHex = process.env.SERVER_KEY_SEED?.trim();
const root = process.env.NEAR_ROOT_ACCOUNT;
const rpcUrl = process.env.NEAR_RPC_URL;
const relayUrl = process.env.HOMEROLL_RELAY_URL ?? "http://127.0.0.1:3000/api/relay";

if (process.env.NEAR_NETWORK !== "testnet" || !adminSecretKey || !seedHex || !root || !rpcUrl) {
  console.log(JSON.stringify({ ok: false, blocked: "admin_key_missing" }));
  process.exit(2);
}

const result = await proveGaslessTransfer({
  network: "testnet",
  root,
  rpcUrl,
  relayUrl,
  adminSecretKey,
  seedHex,
  workerName: "w-7k2q9x",
  amount: units(1_000_000n),
  to: "payout",
});

console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 2);
