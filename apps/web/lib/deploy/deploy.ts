import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AccountId,
  type HomerollAccounts,
  homerollAccounts,
  workerAccountId,
} from "@homeroll/shared";
import { deriveKey, publicKeyFromSecretKey } from "../keys.ts";
import type { AccountView, CodeHash } from "../near/rpc.ts";
import { broadcastAdmin, storageRegistered, viewAccount, wasmCodeHash } from "../near/rpc.ts";

const adminBrand: unique symbol = Symbol("admin");

export type InitArgs =
  | { admin: AccountId }
  | { admin: AccountId; token: AccountId }
  | { admin: AccountId; token: AccountId; payroll: AccountId };

type AdminStepBody =
  | {
      kind: "deploy";
      account: AccountId;
      wasm: Uint8Array;
      expectedCodeHash: CodeHash;
      initArgs: InitArgs;
      create: boolean;
      fundYocto: bigint;
    }
  | { kind: "createPlain"; account: AccountId; publicKey: string; fundYocto: bigint }
  | { kind: "topUp"; account: AccountId; fundYocto: bigint }
  | { kind: "storageDeposit"; account: AccountId; tusdc: AccountId; depositYocto: bigint }
  | { kind: "mint"; account: AccountId; tusdc: AccountId; amount: bigint }
  | { kind: "createWorker"; name: string; publicKey: string; factory: AccountId };

export type AdminStep = AdminStepBody & { readonly [adminBrand]: "admin" };

export function adminStep(body: AdminStepBody): AdminStep {
  return { ...body, [adminBrand]: "admin" };
}

function deployStep(body: Extract<AdminStepBody, { kind: DeployStep["kind"] }>): DeployStep {
  return adminStep(body) as DeployStep;
}

export type ClobberRefusal = {
  account: AccountId;
  reason: "code_hash" | "foreign_key";
  observedCodeHash: CodeHash | null;
  expectedCodeHash: CodeHash | null;
};

export type BlockReason =
  | "admin_key_missing"
  | "seed_missing"
  | "rpc_unavailable"
  | "insufficient_root_balance"
  | "build_failed"
  | "root_missing";

export type DeployReport =
  | { outcome: "converged"; txHashes: string[] }
  | { outcome: "refused"; refusal: ClobberRefusal }
  | { outcome: "blocked"; reason: BlockReason; planned: AdminStep["kind"][] };

export type DeployInput = {
  network: "testnet";
  root: AccountId;
  rpcUrl: string;
  adminSecretKey: string | null;
  seedHex: string | null;
};

export type DeployStep = Extract<
  AdminStep,
  { kind: "deploy" | "createPlain" | "topUp" | "storageDeposit" }
>;

export type ProofStep = Extract<AdminStep, { kind: "mint" | "createWorker" }>;

export type ReconcileResult =
  | { ok: true; steps: DeployStep[] }
  | { ok: false; refusal: ClobberRefusal };

export type PresentAccount = {
  kind: "present";
  codeHash: CodeHash | null;
  balanceYocto: bigint;
  fullAccessKeys: string[];
};

export type AccountSnapshot = { kind: "absent" } | PresentAccount;

export type ChainSnapshot = {
  rootBalanceYocto: bigint;
  root: AccountSnapshot;
  tusdc: AccountSnapshot;
  payroll: AccountSnapshot;
  pool: AccountSnapshot;
  relayer: AccountSnapshot;
  payout: AccountSnapshot;
  offramp: AccountSnapshot;
  payoutRegistered: boolean;
  offrampRegistered: boolean;
};

export type WasmBundle = {
  tusdc: Uint8Array;
  factory: Uint8Array;
  payroll: Uint8Array;
  pool: Uint8Array;
};

export const CONTRACT_ORDER = ["tusdc", "factory", "payroll", "pool"] as const;

/** cargo-near names the output after the package, `homeroll-tusdc` → `homeroll_tusdc`. */
const CARGO_NEAR_DIR = {
  tusdc: "homeroll_tusdc",
  factory: "homeroll_factory",
  payroll: "homeroll_payroll",
  pool: "homeroll_pool",
} as const;
export type ContractName = (typeof CONTRACT_ORDER)[number];

const CONTRACT_FLOOR_YOCTO = 10n * 10n ** 24n;
const RELAYER_FLOOR_YOCTO = 5n * 10n ** 24n;
const RECEIVER_FLOOR_YOCTO = 1n * 10n ** 24n;
const ROOT_CUSHION_YOCTO = 1n * 10n ** 24n;
const TOKEN_STORAGE_DEPOSIT_YOCTO = 10n ** 22n;

const REPO_ROOT = join(import.meta.dirname, "../../../..");

function initArgsFor(name: ContractName, accounts: HomerollAccounts): InitArgs {
  switch (name) {
    case "tusdc":
      return { admin: accounts.root };
    case "factory":
      return { admin: accounts.root, token: accounts.tusdc };
    case "payroll":
      return { admin: accounts.root, token: accounts.tusdc };
    case "pool":
      return { admin: accounts.root, token: accounts.tusdc, payroll: accounts.payroll };
  }
}

function accountForContract(name: ContractName, accounts: HomerollAccounts): AccountId {
  return name === "factory" ? accounts.factory : accounts[name];
}

function contractDeployStep(
  accountId: AccountId,
  snapshot: AccountSnapshot,
  wasm: Uint8Array,
  expectedHash: CodeHash,
  initArgs: InitArgs,
  goals: { adminPublicKey: string },
): { step?: DeployStep; refusal?: ClobberRefusal } {
  if (snapshot.kind === "absent") {
    return {
      step: deployStep({
        kind: "deploy",
        account: accountId,
        wasm,
        expectedCodeHash: expectedHash,
        initArgs,
        create: true,
        fundYocto: CONTRACT_FLOOR_YOCTO,
      }),
    };
  }
  const { codeHash, fullAccessKeys } = snapshot;
  if (codeHash === expectedHash) return {};
  if (codeHash !== null) {
    return {
      refusal: {
        account: accountId,
        reason: "code_hash",
        observedCodeHash: codeHash,
        expectedCodeHash: expectedHash,
      },
    };
  }
  if (!fullAccessKeys.includes(goals.adminPublicKey)) {
    return {
      refusal: {
        account: accountId,
        reason: "foreign_key",
        observedCodeHash: null,
        expectedCodeHash: expectedHash,
      },
    };
  }
  return {
    step: deployStep({
      kind: "deploy",
      account: accountId,
      wasm,
      expectedCodeHash: expectedHash,
      initArgs,
      create: false,
      fundYocto: 0n,
    }),
  };
}

function plainAccountSteps(
  accountId: AccountId,
  snapshot: AccountSnapshot,
  publicKey: string,
  floorYocto: bigint,
  requireKey: boolean,
): { steps: DeployStep[]; refusal?: ClobberRefusal } {
  if (snapshot.kind === "absent") {
    return {
      steps: [
        deployStep({
          kind: "createPlain",
          account: accountId,
          publicKey,
          fundYocto: floorYocto,
        }),
      ],
    };
  }
  // The relayer signs the outer transaction. A different full-access key cannot.
  if (requireKey && !snapshot.fullAccessKeys.includes(publicKey)) {
    return {
      steps: [],
      refusal: {
        account: accountId,
        reason: "foreign_key",
        observedCodeHash: null,
        expectedCodeHash: null,
      },
    };
  }
  if (snapshot.balanceYocto < floorYocto) {
    return {
      steps: [
        deployStep({
          kind: "topUp",
          account: accountId,
          fundYocto: floorYocto - snapshot.balanceYocto,
        }),
      ],
    };
  }
  return { steps: [] };
}

export function reconcile(
  snapshot: ChainSnapshot,
  goals: {
    accounts: HomerollAccounts;
    wasm: WasmBundle;
    hashes: Record<"tusdc" | "factory" | "payroll" | "pool", CodeHash>;
    relayerPublicKey: string;
    payoutPublicKey: string;
    offrampPublicKey: string;
    adminPublicKey: string;
  },
): ReconcileResult {
  const steps: DeployStep[] = [];

  for (const name of CONTRACT_ORDER) {
    const accountId = accountForContract(name, goals.accounts);
    const snap =
      name === "factory"
        ? snapshot.root
        : snapshot[name === "tusdc" ? "tusdc" : name === "payroll" ? "payroll" : "pool"];
    const result = contractDeployStep(
      accountId,
      snap,
      goals.wasm[name],
      goals.hashes[name],
      initArgsFor(name, goals.accounts),
      goals,
    );
    if (result.refusal) return { ok: false, refusal: result.refusal };
    if (result.step) steps.push(result.step);
  }

  const relayer = plainAccountSteps(
    goals.accounts.relayer,
    snapshot.relayer,
    goals.relayerPublicKey,
    RELAYER_FLOOR_YOCTO,
    true,
  );
  if (relayer.refusal) return { ok: false, refusal: relayer.refusal };
  steps.push(...relayer.steps);
  for (const plain of [
    plainAccountSteps(
      goals.accounts.payout,
      snapshot.payout,
      goals.payoutPublicKey,
      RECEIVER_FLOOR_YOCTO,
      false,
    ),
    plainAccountSteps(
      goals.accounts.offramp,
      snapshot.offramp,
      goals.offrampPublicKey,
      RECEIVER_FLOOR_YOCTO,
      false,
    ),
  ]) {
    steps.push(...plain.steps);
  }

  if (!snapshot.payoutRegistered) {
    steps.push(
      deployStep({
        kind: "storageDeposit",
        account: goals.accounts.payout,
        tusdc: goals.accounts.tusdc,
        depositYocto: TOKEN_STORAGE_DEPOSIT_YOCTO,
      }),
    );
  }
  if (!snapshot.offrampRegistered) {
    steps.push(
      deployStep({
        kind: "storageDeposit",
        account: goals.accounts.offramp,
        tusdc: goals.accounts.tusdc,
        depositYocto: TOKEN_STORAGE_DEPOSIT_YOCTO,
      }),
    );
  }

  return { ok: true, steps };
}

export function rootCanPay(snapshot: ChainSnapshot, steps: readonly DeployStep[]): boolean {
  let need = ROOT_CUSHION_YOCTO;
  for (const step of steps) {
    if (step.kind === "deploy") need += step.fundYocto;
    if (step.kind === "createPlain") need += step.fundYocto;
    if (step.kind === "topUp") need += step.fundYocto;
    if (step.kind === "storageDeposit") need += step.depositYocto;
  }
  return snapshot.rootBalanceYocto >= need;
}

export function contractWasmPath(name: ContractName): string {
  const dir = CARGO_NEAR_DIR[name];
  return join("contracts/target/near", dir, `${dir}.wasm`);
}

function readWasmBundle(): WasmBundle | null {
  const read = (crate: ContractName) => {
    try {
      return readFileSync(join(REPO_ROOT, contractWasmPath(crate)));
    } catch {
      return null;
    }
  };
  const tusdc = read("tusdc");
  const factory = read("factory");
  const payroll = read("payroll");
  const pool = read("pool");
  if (!tusdc || !factory || !payroll || !pool) return null;
  return { tusdc, factory, payroll, pool };
}

async function loadSnapshot(
  accounts: HomerollAccounts,
): Promise<ChainSnapshot | "rpc_unavailable" | "root_missing"> {
  try {
    const rootView = await viewAccount(accounts.root);
    if (!rootView.exists) return "root_missing";
    const [tusdc, payroll, pool, relayer, payout, offramp, payoutRegistered, offrampRegistered] =
      await Promise.all([
        viewAccount(accounts.tusdc),
        viewAccount(accounts.payroll),
        viewAccount(accounts.pool),
        viewAccount(accounts.relayer),
        viewAccount(accounts.payout),
        viewAccount(accounts.offramp),
        storageRegistered(accounts.tusdc, accounts.payout),
        storageRegistered(accounts.tusdc, accounts.offramp),
      ]);
    const toSnap = (v: AccountView): AccountSnapshot =>
      v.exists
        ? {
            kind: "present",
            codeHash: v.codeHash,
            balanceYocto: v.balanceYocto,
            fullAccessKeys: v.fullAccessKeys,
          }
        : { kind: "absent" };
    return {
      rootBalanceYocto: rootView.balanceYocto,
      root: toSnap(rootView),
      tusdc: toSnap(tusdc),
      payroll: toSnap(payroll),
      pool: toSnap(pool),
      relayer: toSnap(relayer),
      payout: toSnap(payout),
      offramp: toSnap(offramp),
      payoutRegistered,
      offrampRegistered,
    };
  } catch {
    return "rpc_unavailable";
  }
}

export async function deployHomeroll(input: DeployInput): Promise<DeployReport> {
  if (input.adminSecretKey === null) {
    return { outcome: "blocked", reason: "admin_key_missing", planned: [] };
  }
  if (input.seedHex === null) {
    return { outcome: "blocked", reason: "seed_missing", planned: [] };
  }

  try {
    execSync("pnpm build:contracts", { cwd: REPO_ROOT, stdio: "pipe" });
  } catch {
    return { outcome: "blocked", reason: "build_failed", planned: [] };
  }

  const wasm = readWasmBundle();
  if (!wasm) {
    return { outcome: "blocked", reason: "build_failed", planned: [] };
  }

  const accounts = homerollAccounts(input.root);
  const snapshot = await loadSnapshot(accounts);
  if (snapshot === "rpc_unavailable") {
    return { outcome: "blocked", reason: "rpc_unavailable", planned: [] };
  }
  if (snapshot === "root_missing") {
    return { outcome: "blocked", reason: "root_missing", planned: [] };
  }

  const adminPublicKey = publicKeyFromSecretKey(input.adminSecretKey);
  const relayerPublicKey = deriveKey(input.seedHex, accounts.relayer, "relayer").publicKey;
  const payoutPublicKey = deriveKey(input.seedHex, accounts.payout, "payout").publicKey;
  const offrampPublicKey = deriveKey(input.seedHex, accounts.offramp, "offramp").publicKey;
  const hashes = {
    tusdc: wasmCodeHash(wasm.tusdc),
    factory: wasmCodeHash(wasm.factory),
    payroll: wasmCodeHash(wasm.payroll),
    pool: wasmCodeHash(wasm.pool),
  };

  const plan = reconcile(snapshot, {
    accounts,
    wasm,
    hashes,
    relayerPublicKey,
    payoutPublicKey,
    offrampPublicKey,
    adminPublicKey,
  });
  if (!plan.ok) {
    return { outcome: "refused", refusal: plan.refusal };
  }

  const plannedKinds = plan.steps.map((s) => s.kind);
  if (!rootCanPay(snapshot, plan.steps)) {
    return { outcome: "blocked", reason: "insufficient_root_balance", planned: plannedKinds };
  }

  if (plan.steps.length === 0) {
    return { outcome: "converged", txHashes: [] };
  }

  const admin = { role: "admin" as const, accountId: input.root, secretKey: input.adminSecretKey };
  const txHashes: string[] = [];
  try {
    for (const step of plan.steps) {
      const { txHash } = await broadcastAdmin(step, admin);
      txHashes.push(txHash);
    }
  } catch {
    return { outcome: "blocked", reason: "rpc_unavailable", planned: plannedKinds };
  }

  return { outcome: "converged", txHashes };
}

export function readDeployEnv(
  env: Readonly<Record<string, string | undefined>>,
):
  | { ok: false; reason: "network_refused" | "root_missing" | "rpc_missing" }
  | { ok: true; input: DeployInput } {
  if (env.NEAR_NETWORK !== "testnet") {
    return { ok: false, reason: "network_refused" };
  }
  const root = env.NEAR_ROOT_ACCOUNT;
  if (!root) return { ok: false, reason: "root_missing" };
  const rpcUrl = env.NEAR_RPC_URL;
  if (!rpcUrl) return { ok: false, reason: "rpc_missing" };
  const adminRaw = env.HOMEROLL_ADMIN_PRIVATE_KEY?.trim();
  const seedRaw = env.SERVER_KEY_SEED?.trim();
  return {
    ok: true,
    input: {
      network: "testnet",
      root,
      rpcUrl,
      adminSecretKey: adminRaw ? adminRaw : null,
      seedHex: seedRaw ? seedRaw : null,
    },
  };
}

export function planCreateWorker(
  accounts: HomerollAccounts,
  name: string,
  publicKey: string,
): ProofStep {
  workerAccountId(name, accounts.root);
  return adminStep({
    kind: "createWorker",
    name,
    publicKey,
    factory: accounts.factory,
  }) as ProofStep;
}

export function planMint(accounts: HomerollAccounts, worker: AccountId, amount: bigint): ProofStep {
  if (amount <= 0n) throw new Error("mint amount must be positive");
  return adminStep({
    kind: "mint",
    account: worker,
    tusdc: accounts.tusdc,
    amount,
  }) as ProofStep;
}

export type _AccountViewUsedBySnapshot = AccountView;
