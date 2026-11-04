#!/usr/bin/env node
import { loadEnvLocal, readSeedEnv, seedCompany } from "../apps/web/lib/seed/shell.ts";
import { loadFixtures } from "../fixtures/index.ts";

const envFile = loadEnvLocal("apps/web/.env.local");
const parsed = readSeedEnv({ ...envFile, ...process.env });
if (!parsed.ok) {
  console.error(JSON.stringify({ outcome: "blocked", reason: parsed.reason }));
  process.exit(2);
}

const fixtures = loadFixtures(parsed.input.root);
const report = await seedCompany(parsed.input, {
  employer: fixtures.company.accountId,
  bufferSen: fixtures.company.bufferSen,
  workers: fixtures.workers.map((worker) => ({
    name: worker.name,
    accountId: worker.accountId,
    capSen: worker.capSen,
  })),
});

console.log(
  JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
);
if (report.outcome === "converged") process.exit(0);
if (report.outcome === "blocked") process.exit(2);
process.exit(3);
