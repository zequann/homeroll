import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SeedCompany } from "./plan.ts";
import { loadEnvLocal, readSeedEnv, seedCompany } from "./shell.ts";

const SECRET = "ed25519:do-not-print";

function writeEnv(body: string): { path: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "homeroll-seed-"));
  const path = join(dir, "env");
  writeFileSync(path, body);
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loadEnvLocal", () => {
  it("skips a comment line and does not log values", () => {
    const file = writeEnv(
      ["NEAR_NETWORK=testnet", "# NEAR_NETWORK=mainnet", `LOG_ME=${SECRET}`, ""].join("\n"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = loadEnvLocal(file.path);
      expect(env.NEAR_NETWORK).toBe("testnet");
      expect(env.LOG_ME).toBe(SECRET);
      const printed = [log, error, info, warn]
        .flatMap((spy) => spy.mock.calls.flat().map((part) => String(part)))
        .join("\n");
      expect(printed).not.toContain(SECRET);
      expect(printed).not.toContain("NEAR_NETWORK");
    } finally {
      log.mockRestore();
      error.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      file.remove();
    }
  });
});

describe("readSeedEnv", () => {
  it("refuses a network that is not testnet", () => {
    expect(
      readSeedEnv({
        NEAR_NETWORK: "mainnet",
        NEAR_ROOT_ACCOUNT: "homeroll.testnet",
        NEAR_RPC_URL: "https://rpc.testnet.near.org",
      }),
    ).toEqual({ ok: false, reason: "network_refused" });
  });

  it("keeps a blank admin key from the env file as null", () => {
    const file = writeEnv(
      [
        "# comment",
        "NEAR_NETWORK=testnet",
        "NEAR_ROOT_ACCOUNT=homeroll.testnet",
        "NEAR_RPC_URL=https://rpc.testnet.near.org",
        "HOMEROLL_ADMIN_PRIVATE_KEY=",
        "# HOMEROLL_ADMIN_PRIVATE_KEY=ed25519:from-comment",
        "SERVER_KEY_SEED=abc",
      ].join("\n"),
    );
    try {
      const env = loadEnvLocal(file.path);
      expect(readSeedEnv(env)).toEqual({
        ok: true,
        input: {
          network: "testnet",
          root: "homeroll.testnet",
          rpcUrl: "https://rpc.testnet.near.org",
          adminSecretKey: null,
          seedHex: "abc",
        },
      });
    } finally {
      file.remove();
    }
  });

  it("reports a missing root and a missing rpc url", () => {
    expect(readSeedEnv({ NEAR_NETWORK: "testnet" })).toEqual({
      ok: false,
      reason: "root_missing",
    });
    expect(readSeedEnv({ NEAR_NETWORK: "testnet", NEAR_ROOT_ACCOUNT: "homeroll.testnet" })).toEqual(
      { ok: false, reason: "rpc_missing" },
    );
  });
});

describe("seedCompany", () => {
  const company: SeedCompany = {
    employer: "coffeefactory.homeroll.testnet",
    bufferSen: 500_000,
    workers: [],
  };
  const input = {
    network: "testnet" as const,
    root: "homeroll.testnet",
    rpcUrl: "http://127.0.0.1:9",
    adminSecretKey: "ed25519:6En9pQ84iEKgcLgUGSkNQymtBQE8spHSca8PxsphQbPP",
    seedHex: "ab".repeat(32),
  };

  it("blocks a missing admin key before any RPC", async () => {
    await expect(seedCompany({ ...input, adminSecretKey: null }, company)).resolves.toEqual({
      outcome: "blocked",
      reason: "admin_key_missing",
      planned: [],
    });
  });

  it("blocks a missing seed before any RPC", async () => {
    await expect(seedCompany({ ...input, seedHex: null }, company)).resolves.toEqual({
      outcome: "blocked",
      reason: "seed_missing",
      planned: [],
    });
  });
});
