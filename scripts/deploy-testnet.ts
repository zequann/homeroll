#!/usr/bin/env node
import { deployHomeroll, readDeployEnv } from "../apps/web/lib/deploy/deploy.ts";
import { configureRpc } from "../apps/web/lib/near/rpc.ts";

const envResult = readDeployEnv(process.env);
if (!envResult.ok) {
  console.error(JSON.stringify({ outcome: "blocked", reason: envResult.reason }));
  process.exit(2);
}

configureRpc(envResult.input.rpcUrl);
const report = await deployHomeroll(envResult.input);
console.log(JSON.stringify(report));
if (report.outcome === "converged") process.exit(0);
if (report.outcome === "blocked") process.exit(2);
process.exit(3);
