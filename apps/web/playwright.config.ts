import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * End-to-end tests on the fake chain (SPEC §14). One production server and one test at a time,
 * because the fake chain is a single in-memory demo company that every page shares. Each spec
 * file starts with Reset demo, so files do not depend on each other's order.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Steady layouts: the app turns its own motion down when the browser asks it to
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://localhost:${PORT}`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    env: { E2E_PORT: String(PORT), CHAIN_CLIENT: "fake", INTENTS_QUOTES: "sample" },
  },
});
