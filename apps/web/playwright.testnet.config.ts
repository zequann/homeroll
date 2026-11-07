import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const PORT = Number(process.env.E2E_PORT ?? 3101);
// Specs read this to skip resets they do not need: each Reset demo is a burst of RPC calls
process.env.E2E_CHAIN = "testnet";

/**
 * The same browser tests against NEAR testnet: real contracts and transactions, testnet tokens
 * only. Slower, because each Reset demo provisions a fresh company on chain. The lender deposit
 * test stays on the fake chain, since live quotes change from one second to the next.
 */
export default defineConfig({
  ...base,
  timeout: 900_000,
  expect: { timeout: 180_000 },
  grepInvert: /private deposit/,
  use: { ...base.use, baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://localhost:${PORT}`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    env: { E2E_PORT: String(PORT), CHAIN_CLIENT: "near" },
  },
});
