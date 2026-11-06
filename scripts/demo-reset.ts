#!/usr/bin/env node
import { provisionDemoCompany } from "../apps/web/lib/near/demo-company.ts";
import { loadEnvLocal, readSeedEnv } from "../apps/web/lib/seed/shell.ts";

const parsed = readSeedEnv({ ...loadEnvLocal("apps/web/.env.local"), ...process.env });
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
