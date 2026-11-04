import { homerollAccounts } from "@homeroll/shared";
import { describe, expect, it } from "vitest";
import type { CodeHash } from "../near/rpc";
import { wasmCodeHash } from "../near/rpc";
import {
  adminStep,
  type ChainSnapshot,
  readDeployEnv,
  reconcile,
  rootCanPay,
  type WasmBundle,
} from "./deploy";

const ROOT = "homeroll.testnet";
const accounts = homerollAccounts(ROOT);
const ADMIN_PK = "ed25519:AdminKeyForTestsOnly";
const RELAYER_PK = "ed25519:RelayerKey";
const PAYOUT_PK = "ed25519:PayoutKey";
const OFFRAMP_PK = "ed25519:OfframpKey";

const wasm: WasmBundle = {
  tusdc: new Uint8Array([1, 2, 3]),
  factory: new Uint8Array([4, 5]),
  payroll: new Uint8Array([6]),
  pool: new Uint8Array([7, 8, 9]),
};

const hashes = {
  tusdc: wasmCodeHash(wasm.tusdc),
  factory: wasmCodeHash(wasm.factory),
  payroll: wasmCodeHash(wasm.payroll),
  pool: wasmCodeHash(wasm.pool),
};

const goals = {
  accounts,
  wasm,
  hashes,
  relayerPublicKey: RELAYER_PK,
  payoutPublicKey: PAYOUT_PK,
  offrampPublicKey: OFFRAMP_PK,
  adminPublicKey: ADMIN_PK,
};

const emptySnapshot = (): ChainSnapshot => ({
  rootBalanceYocto: 100n * 10n ** 24n,
  root: { kind: "absent" },
  tusdc: { kind: "absent" },
  payroll: { kind: "absent" },
  pool: { kind: "absent" },
  relayer: { kind: "absent" },
  payout: { kind: "absent" },
  offramp: { kind: "absent" },
  payoutRegistered: false,
  offrampRegistered: false,
});

describe("reconcile", () => {
  it("plans deploy steps in tusdc, factory, payroll, pool order for absent accounts", () => {
    const plan = reconcile(emptySnapshot(), goals);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const deployAccounts = plan.steps.filter((s) => s.kind === "deploy").map((s) => s.account);
    expect(deployAccounts).toEqual([
      accounts.tusdc,
      accounts.root,
      accounts.payroll,
      accounts.pool,
    ]);
    const tusdcDeploy = plan.steps.find((s) => s.kind === "deploy" && s.account === accounts.tusdc);
    expect(tusdcDeploy?.kind === "deploy" && tusdcDeploy.create).toBe(true);
    expect(tusdcDeploy?.kind === "deploy" && tusdcDeploy.initArgs).toEqual({
      admin: accounts.root,
    });
    const factoryDeploy = plan.steps.find(
      (s) => s.kind === "deploy" && s.account === accounts.root,
    );
    expect(factoryDeploy?.kind === "deploy" && factoryDeploy.initArgs).toEqual({
      admin: accounts.root,
      token: accounts.tusdc,
    });
  });

  it("returns no deploy step when code hash matches", () => {
    const snap = emptySnapshot();
    snap.tusdc = {
      kind: "present",
      codeHash: hashes.tusdc,
      balanceYocto: 10n * 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.root = {
      kind: "present",
      codeHash: hashes.factory,
      balanceYocto: 10n * 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.payroll = {
      kind: "present",
      codeHash: hashes.payroll,
      balanceYocto: 10n * 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.pool = {
      kind: "present",
      codeHash: hashes.pool,
      balanceYocto: 10n * 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.relayer = {
      kind: "present",
      codeHash: null,
      balanceYocto: 5n * 10n ** 24n,
      fullAccessKeys: [],
    };
    snap.payout = { kind: "present", codeHash: null, balanceYocto: 10n ** 24n, fullAccessKeys: [] };
    snap.offramp = {
      kind: "present",
      codeHash: null,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [],
    };
    snap.payoutRegistered = true;
    snap.offrampRegistered = true;

    const plan = reconcile(snap, goals);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps).toEqual([]);
  });

  it("refuses a foreign code hash with no steps", () => {
    const snap = emptySnapshot();
    snap.tusdc = {
      kind: "present",
      codeHash: "deadbeef" as CodeHash,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    const plan = reconcile(snap, goals);
    expect(plan).toEqual({
      ok: false,
      refusal: {
        account: accounts.tusdc,
        reason: "code_hash",
        observedCodeHash: "deadbeef",
        expectedCodeHash: hashes.tusdc,
      },
    });
  });

  it("refuses when our admin key is missing on an empty account", () => {
    const snap = emptySnapshot();
    snap.tusdc = { kind: "present", codeHash: null, balanceYocto: 0n, fullAccessKeys: [] };
    const plan = reconcile(snap, goals);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal.reason).toBe("foreign_key");
  });

  it("topUps only the shortfall below the floor", () => {
    const snap = emptySnapshot();
    snap.tusdc = {
      kind: "present",
      codeHash: hashes.tusdc,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.root = {
      kind: "present",
      codeHash: hashes.factory,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.payroll = {
      kind: "present",
      codeHash: hashes.payroll,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.pool = {
      kind: "present",
      codeHash: hashes.pool,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.relayer = {
      kind: "present",
      codeHash: null,
      balanceYocto: 5n * 10n ** 24n - 1n,
      fullAccessKeys: [RELAYER_PK],
    };
    snap.payout = {
      kind: "present",
      codeHash: null,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [PAYOUT_PK],
    };
    snap.offramp = {
      kind: "present",
      codeHash: null,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [OFFRAMP_PK],
    };
    snap.payoutRegistered = true;
    snap.offrampRegistered = true;

    const plan = reconcile(snap, goals);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps).toEqual([
      adminStep({ kind: "topUp", account: accounts.relayer, fundYocto: 1n }),
    ]);
  });

  it("converges on a second snapshot with our hashes", () => {
    const first = reconcile(emptySnapshot(), goals);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const snap = emptySnapshot();
    snap.root = {
      kind: "present",
      codeHash: hashes.factory,
      balanceYocto: 50n * 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.tusdc = {
      kind: "present",
      codeHash: hashes.tusdc,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.payroll = {
      kind: "present",
      codeHash: hashes.payroll,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.pool = {
      kind: "present",
      codeHash: hashes.pool,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [ADMIN_PK],
    };
    snap.relayer = {
      kind: "present",
      codeHash: null,
      balanceYocto: 5n * 10n ** 24n,
      fullAccessKeys: [RELAYER_PK],
    };
    snap.payout = {
      kind: "present",
      codeHash: null,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [PAYOUT_PK],
    };
    snap.offramp = {
      kind: "present",
      codeHash: null,
      balanceYocto: 10n ** 24n,
      fullAccessKeys: [OFFRAMP_PK],
    };
    snap.payoutRegistered = true;
    snap.offrampRegistered = true;

    const second = reconcile(snap, goals);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.steps).toEqual([]);
  });
});

describe("rootCanPay", () => {
  it("blocks when the root balance is below need", () => {
    const snap = emptySnapshot();
    snap.rootBalanceYocto = 1n;
    const plan = reconcile(snap, goals);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(rootCanPay(snap, plan.steps)).toBe(false);
  });

  it("passes when the root holds exactly the cushion plus steps", () => {
    const snap = emptySnapshot();
    const plan = reconcile(snap, goals);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    let need = 1n * 10n ** 24n;
    for (const step of plan.steps) {
      if (step.kind === "deploy" || step.kind === "createPlain" || step.kind === "topUp") {
        need += step.fundYocto;
      }
      if (step.kind === "storageDeposit") need += step.depositYocto;
    }
    snap.rootBalanceYocto = need;
    expect(rootCanPay(snap, plan.steps)).toBe(true);
  });
});

describe("readDeployEnv", () => {
  it("refuses non-testnet networks", () => {
    expect(readDeployEnv({})).toEqual({ ok: false, reason: "network_refused" });
    expect(
      readDeployEnv({
        NEAR_NETWORK: "mainnet",
        NEAR_ROOT_ACCOUNT: ROOT,
        NEAR_RPC_URL: "https://example.com",
      }),
    ).toEqual({ ok: false, reason: "network_refused" });
  });

  it("maps an empty admin key to null", () => {
    const env = readDeployEnv({
      NEAR_NETWORK: "testnet",
      NEAR_ROOT_ACCOUNT: ROOT,
      NEAR_RPC_URL: "https://test.rpc.fastnear.com",
      HOMEROLL_ADMIN_PRIVATE_KEY: "",
      SERVER_KEY_SEED: "abc",
    });
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.input.adminSecretKey).toBeNull();
    expect(env.input.seedHex).toBe("abc");
  });
});
