import { readFileSync } from "node:fs";
import { type AccountId, homerollAccounts } from "@homeroll/shared";
import { adminStep } from "../deploy/deploy.ts";
import { units } from "../fx/index.ts";
import { type AdminSigner, adminSigner, type DerivedKey, deriveKey } from "../keys.ts";
import {
  addFunctionCallAccessKey,
  broadcastAdmin,
  callMethods,
  configureRpc,
  createAccountWithFunctionCallKey,
  type ListedAccount,
  MAX_CALLS_PER_TRANSACTION,
  viewAccountState,
  viewFunction,
} from "../near/rpc.ts";
import {
  type AccountPresence,
  type AdminSeedAction,
  type CompanySnapshot,
  type DemoGoal,
  demoGoal,
  type EmployerRecord,
  type EmployerSeedAction,
  plannedCells,
  planSeed,
  type Schedule,
  type SeedCompany,
  type SeedReport,
} from "./plan.ts";

export type SeedInput = {
  readonly network: "testnet";
  readonly root: AccountId;
  readonly rpcUrl: string;
  readonly adminSecretKey: string | null;
  readonly seedHex: string | null;
};

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses `KEY=VALUE` lines. A line whose trim starts with `#` is a comment. Never logs. */
export function loadEnvLocal(path: string): Readonly<Record<string, string | undefined>> {
  const text = readFileSync(path, "utf8");
  const record: Record<string, string | undefined> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ASSIGN.test(key)) continue;
    record[key] = line.slice(eq + 1).trim();
  }
  return record;
}

export function readSeedEnv(
  env: Readonly<Record<string, string | undefined>>,
):
  | { ok: false; reason: "network_refused" | "root_missing" | "rpc_missing" }
  | { ok: true; input: SeedInput } {
  if (env.NEAR_NETWORK !== "testnet") return { ok: false, reason: "network_refused" };
  const root = env.NEAR_ROOT_ACCOUNT?.trim();
  if (!root) return { ok: false, reason: "root_missing" };
  const rpcUrl = env.NEAR_RPC_URL?.trim();
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

function presence(account: ListedAccount): AccountPresence {
  if (account.kind === "absent") return { kind: "absent" };
  return {
    kind: "present",
    balanceYocto: account.balanceYocto,
    keys: account.keys.map((key) =>
      key.kind === "fullAccess"
        ? { kind: "fullAccess" as const, publicKey: key.publicKey }
        : {
            kind: "functionCall" as const,
            publicKey: key.publicKey,
            receiverId: key.receiverId as AccountId,
            methodNames: key.methodNames,
            allowanceYocto: key.allowanceYocto,
          },
    ),
  };
}

function employerRecord(value: unknown): EmployerRecord | null {
  if (value === null || value === undefined) return { kind: "absent" };
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.onboarding !== "boolean" || typeof row.payee_count !== "number") return null;
  if (typeof row.buffer !== "string" || !/^\d+$/.test(row.buffer)) return null;
  return {
    kind: "present",
    buffer: units(BigInt(row.buffer)),
    onboarding: row.onboarding,
    payeeCount: row.payee_count,
  };
}

export async function loadCompanySnapshot(
  goal: DemoGoal,
  rpcUrl: string,
): Promise<CompanySnapshot | "rpc_unavailable" | "root_missing"> {
  configureRpc(rpcUrl);
  let root: ListedAccount;
  let employer: ListedAccount;
  let agent: ListedAccount;
  let rawEmployer: unknown;
  const workers = new Map<AccountId, AccountPresence>();
  for (let attempt = 0; ; attempt++) {
    try {
      root = await viewAccountState(goal.root);
      employer = await viewAccountState(goal.employer);
      agent = await viewAccountState(goal.agent);
      for (const worker of goal.workers) {
        workers.set(worker.accountId, presence(await viewAccountState(worker.accountId)));
      }
      rawEmployer = await viewFunction(goal.payroll, "get_employer", { employer: goal.employer });
      break;
    } catch {
      if (attempt >= 2) return "rpc_unavailable";
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  if (root.kind === "absent") return "root_missing";
  const payrollEmployer = employerRecord(rawEmployer);
  if (!payrollEmployer) return "rpc_unavailable";
  return {
    rootBalanceYocto: root.balanceYocto,
    employer: presence(employer),
    agent: presence(agent),
    payrollEmployer,
    agentAllowlist: "planInsert",
    workers,
  };
}

function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

async function signAdmin(action: AdminSeedAction, admin: AdminSigner): Promise<string> {
  switch (action.kind) {
    case "createEmployer": {
      const { txHash } = await broadcastAdmin(
        adminStep({
          kind: "createPlain",
          account: action.accountId,
          publicKey: action.ownerPublicKey,
          fundYocto: action.fundYocto,
        }),
        admin,
        "FINAL",
      );
      return txHash;
    }
    case "fundEmployer": {
      const { txHash } = await broadcastAdmin(
        adminStep({ kind: "topUp", account: action.accountId, fundYocto: action.fundYocto }),
        admin,
        "FINAL",
      );
      return txHash;
    }
    case "createAgent": {
      const { txHash } = await createAccountWithFunctionCallKey(
        admin,
        action.accountId,
        action.invoiceKey,
        action.fundYocto,
      );
      return txHash;
    }
    case "registerEmployer": {
      const { txHash } = await callMethods(admin, action.payroll, [
        {
          method: "register_employer",
          args: { employer: action.employer, buffer: action.buffer.toString() },
        },
      ]);
      return txHash;
    }
    case "addAgent": {
      const { txHash } = await callMethods(admin, action.pool, [
        { method: "add_agent", args: { account_id: action.agent } },
      ]);
      return txHash;
    }
    case "createWorker": {
      const { txHash } = await broadcastAdmin(
        adminStep({
          kind: "createWorker",
          name: action.name,
          publicKey: action.publicKey,
          factory: action.factory,
        }),
        admin,
        "FINAL",
      );
      return txHash;
    }
  }
}

async function signOwner(
  action: EmployerSeedAction,
  owner: DerivedKey<"owner">,
): Promise<readonly string[]> {
  switch (action.kind) {
    case "addPayrollAgentKey": {
      const { txHash } = await addFunctionCallAccessKey(owner, action.signer, action.key);
      return [txHash];
    }
    case "addPayees": {
      const hashes: string[] = [];
      for (const group of chunks(action.payees, MAX_CALLS_PER_TRANSACTION)) {
        const { txHash } = await callMethods(
          owner,
          action.receiver,
          group.map((payee) => ({
            method: "add_payee",
            args: { account_id: payee.accountId, cap: payee.cap.toString() },
          })),
        );
        hashes.push(txHash);
      }
      return hashes;
    }
  }
}

function adminActions(schedule: Schedule): AdminSeedAction[] {
  const actions: AdminSeedAction[] = [];
  if (schedule.admin.employerAccount) actions.push(schedule.admin.employerAccount);
  if (schedule.admin.createAgent) actions.push(schedule.admin.createAgent);
  if (schedule.admin.registerEmployer) actions.push(schedule.admin.registerEmployer);
  if (schedule.admin.addAgent) actions.push(schedule.admin.addAgent);
  for (const name of [...schedule.admin.createWorker.keys()].sort()) {
    const action = schedule.admin.createWorker.get(name);
    if (action) actions.push(action);
  }
  return actions;
}

function employerActions(schedule: Schedule): EmployerSeedAction[] {
  const actions: EmployerSeedAction[] = [];
  if (schedule.employer.addPayrollAgentKey) actions.push(schedule.employer.addPayrollAgentKey);
  if (schedule.employer.addPayees) actions.push(schedule.employer.addPayees);
  return actions;
}

export async function broadcastSchedule(
  schedule: Schedule,
  signers: {
    readonly admin: AdminSigner;
    readonly owner: DerivedKey<"owner">;
  },
): Promise<readonly string[]> {
  const hashes: string[] = [];
  for (const action of adminActions(schedule)) {
    hashes.push(await signAdmin(action, signers.admin));
  }
  for (const action of employerActions(schedule)) {
    hashes.push(...(await signOwner(action, signers.owner)));
  }
  return hashes;
}

function blocked(reason: "admin_key_missing" | "seed_missing"): SeedReport {
  return { outcome: "blocked", reason, planned: [] };
}

export async function seedCompany(input: SeedInput, company: SeedCompany): Promise<SeedReport> {
  const admin = adminSigner(input.root, input.adminSecretKey);
  if (!admin) return blocked("admin_key_missing");
  if (input.seedHex === null) return blocked("seed_missing");

  const owner = deriveKey(input.seedHex, company.employer, "owner");
  const accounts = homerollAccounts(input.root);
  const workerByAccount = new Map<AccountId, string>();
  for (const worker of company.workers) {
    workerByAccount.set(
      worker.accountId,
      deriveKey(input.seedHex, worker.accountId, "worker").publicKey,
    );
  }
  const goal = demoGoal(
    company,
    {
      owner: owner.publicKey,
      payrollAgent: deriveKey(input.seedHex, company.employer, "payrollAgent").publicKey,
      invoiceAgent: deriveKey(input.seedHex, accounts.agent, "invoiceAgent").publicKey,
      workerByAccount,
    },
    input.root,
  );

  const snapshot = await loadCompanySnapshot(goal, input.rpcUrl);
  if (snapshot === "rpc_unavailable" || snapshot === "root_missing") {
    return { outcome: "blocked", reason: snapshot, planned: [] };
  }
  const report = planSeed(snapshot, goal);
  if (report.outcome !== "ready") return report;

  let txHashes: readonly string[];
  try {
    txHashes = await broadcastSchedule(report.schedule, { admin, owner });
  } catch {
    return {
      outcome: "blocked",
      reason: "broadcast_failed",
      planned: plannedCells(report.schedule),
    };
  }

  const again = await loadCompanySnapshot(goal, input.rpcUrl);
  if (again === "rpc_unavailable" || again === "root_missing") {
    return { outcome: "blocked", reason: again, planned: plannedCells(report.schedule) };
  }
  // The loader cannot read pool membership, so it passes planInsert.
  // This broadcast sent add_agent and waited until FINAL.
  // Planning that follow-up as planInsert would stay ready on addAgent.
  const judged = planSeed(
    report.schedule.admin.addAgent ? { ...again, agentAllowlist: "member" } : again,
    goal,
  );
  if (judged.outcome === "converged") return { outcome: "converged", txHashes };
  if (judged.outcome === "refused") return judged;
  if (judged.outcome === "ready") {
    return {
      outcome: "blocked",
      reason: "broadcast_failed",
      planned: plannedCells(judged.schedule),
    };
  }
  return { outcome: "blocked", reason: "broadcast_failed", planned: judged.planned };
}
