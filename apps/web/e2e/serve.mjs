// Builds and serves the app for Playwright on the fake chain. `next build` rewrites the tracked
// next-env.d.ts to point at production types; this puts it back so the tree stays clean.
// E2E_SKIP_BUILD=1 reuses the last build for a quicker rerun.
import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const port = process.env.E2E_PORT ?? "3100";
if (process.env.E2E_SKIP_BUILD !== "1") {
  const envTypes = readFileSync("next-env.d.ts", "utf8");
  try {
    execSync("pnpm exec next build", { stdio: "inherit" });
  } finally {
    writeFileSync("next-env.d.ts", envTypes);
  }
}
const server = spawn("pnpm", ["exec", "next", "start", "-p", port], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
