#!/usr/bin/env node
import { provisionDemoCompany } from "../apps/web/lib/near/demo-company.ts";
import { loadEnvLocal, readSeedEnv } from "../apps/web/lib/seed/shell.ts";

const envFile = loadEnvLocal("apps/web/.env.local");
// With Supabase configured, the live company is a row there (as on Vercel), so a reset from the
// command line switches the hosted app too. Without it, the ledger file as before.
for (const key of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "NEAR_ROOT_ACCOUNT"] as const) {
  if (process.env[key] === undefined && envFile[key] !== undefined) process.env[key] = envFile[key];
}
const parsed = readSeedEnv({ ...envFile, ...process.env });
if (!parsed.ok) {
  console.error(JSON.stringify({ outcome: "blocked", reason: parsed.reason }));
  process.exit(2);
}

try {
  const { employer } = await provisionDemoCompany(parsed.input);
  console.log(JSON.stringify({ outcome: "converged", employer }));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(3);
}
