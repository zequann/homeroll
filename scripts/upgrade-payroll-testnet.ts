#!/usr/bin/env node
import { readDeployEnv, replaceDeployedPayroll } from "../apps/web/lib/deploy/deploy.ts";
import { configureRpc } from "../apps/web/lib/near/rpc.ts";
import { loadEnvLocal } from "../apps/web/lib/seed/shell.ts";

const envFile = loadEnvLocal("apps/web/.env.local");
const parsed = readDeployEnv({ ...envFile, ...process.env });
if (!parsed.ok) {
  console.log(JSON.stringify({ ok: false, reason: parsed.reason }));
  process.exit(2);
}

configureRpc(parsed.input.rpcUrl);
const report = await replaceDeployedPayroll(parsed.input);
console.log(JSON.stringify(report));
if (report.outcome === "replaced" || report.outcome === "unchanged") process.exit(0);
process.exit(report.outcome === "blocked" ? 2 : 3);
