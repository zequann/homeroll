import {
  type AccountId,
  homerollAccounts,
  WORKER_NAME_PATTERN,
  workerAccountId,
} from "@homeroll/shared";
import { sen, senToUnits, type Units } from "../fx/index.ts";

declare const adminLane: unique symbol;
declare const employerLane: unique symbol;
declare const workerNameBrand: unique symbol;

/** `^w-[a-z0-9]{6}$`. Produced only by `workerName`. */
export type WorkerName = string & { readonly [workerNameBrand]: "WorkerName" };

export type SeedCompany = {
  readonly employer: AccountId;
  readonly bufferSen: number;
  readonly workers: readonly {
    readonly name: string;
    readonly accountId: AccountId;
    readonly capSen: number;
  }[];
};

/** Public keys only. This module does not import secret key types. */
export type SeedPublicKeys = {
  readonly owner: string;
  readonly payrollAgent: string;
  readonly invoiceAgent: string;
  readonly workerByAccount: ReadonlyMap<AccountId, string>;
};

/**
 * SPEC §6 payroll agent key. `demoGoal` builds it.
 * No argument can widen the methods or the allowance. `canAttachDeposit` is the literal `false`.
 */
export type PayrollFunctionCallKey = {
  readonly role: "payrollAgent";
  readonly publicKey: string;
  readonly receiverId: AccountId;
  readonly methodNames: readonly ["submit_run", "pay_run"];
  readonly allowanceYocto: 1_000_000_000_000_000_000_000_000n;
  readonly canAttachDeposit: false;
};

/** SPEC §6 invoice agent key. One method, 1 NEAR, no deposit. */
export type InvoiceFunctionCallKey = {
  readonly role: "invoiceAgent";
  readonly publicKey: string;
  readonly receiverId: AccountId;
  readonly methodNames: readonly ["attest_invoice"];
  readonly allowanceYocto: 1_000_000_000_000_000_000_000_000n;
  readonly canAttachDeposit: false;
};

export type DemoGoal = {
  readonly root: AccountId;
  readonly factory: AccountId;
  readonly payroll: AccountId;
  readonly pool: AccountId;
  readonly agent: AccountId;
  readonly employer: AccountId;
  readonly ownerPublicKey: string;
  readonly buffer: Units;
  readonly payrollKey: PayrollFunctionCallKey;
  readonly invoiceKey: InvoiceFunctionCallKey;
  readonly workers: readonly WorkerGoal[];
};

export type WorkerGoal = {
  readonly name: WorkerName;
  readonly accountId: AccountId;
  readonly publicKey: string;
  readonly cap: Units;
};

export type AccessKeyView =
  | { readonly kind: "fullAccess"; readonly publicKey: string }
  | {
      readonly kind: "functionCall";
      readonly publicKey: string;
      readonly receiverId: AccountId;
      readonly methodNames: readonly string[];
      readonly allowanceYocto: bigint;
    };

export type AccountPresence =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly balanceYocto: bigint;
      readonly keys: readonly AccessKeyView[];
    };

/** `payroll.get_employer`. This unit does not mint treasury, so treasury is not on this type. */
export type EmployerRecord =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly buffer: Units;
      readonly onboarding: boolean;
      readonly payeeCount: number;
    };

/**
 * Pool has no agent view. `member` means the snapshot author observed membership.
 * The loader cannot observe it and passes `planInsert`. `add_agent` no-ops if the
 * account is already in the set.
 */
export type AgentAllowlist = "member" | "planInsert";

export type CompanySnapshot = {
  readonly rootBalanceYocto: bigint;
  readonly employer: AccountPresence;
  readonly agent: AccountPresence;
  readonly payrollEmployer: EmployerRecord;
  readonly agentAllowlist: AgentAllowlist;
  readonly workers: ReadonlyMap<AccountId, AccountPresence>;
};

type AdminMarked = { readonly [adminLane]: "admin"; readonly lane: "admin" };
type EmployerMarked = { readonly [employerLane]: "employer"; readonly lane: "employer" };

export type CreateEmployer = AdminMarked & {
  readonly kind: "createEmployer";
  readonly accountId: AccountId;
  readonly ownerPublicKey: string;
  readonly fundYocto: bigint;
};

export type FundEmployer = AdminMarked & {
  readonly kind: "fundEmployer";
  readonly accountId: AccountId;
  readonly fundYocto: bigint;
};

export type CreateAgent = AdminMarked & {
  readonly kind: "createAgent";
  readonly accountId: AccountId;
  /** The account's only key. Full-access is not a field on this action. */
  readonly invoiceKey: InvoiceFunctionCallKey;
  readonly fundYocto: bigint;
};

export type RegisterEmployer = AdminMarked & {
  readonly kind: "registerEmployer";
  readonly payroll: AccountId;
  readonly employer: AccountId;
  readonly buffer: Units;
};

export type AddAgent = AdminMarked & {
  readonly kind: "addAgent";
  readonly pool: AccountId;
  readonly agent: AccountId;
};

export type CreateWorker = AdminMarked & {
  readonly kind: "createWorker";
  readonly factory: AccountId;
  readonly name: WorkerName;
  readonly publicKey: string;
};

export type AddPayrollAgentKey = EmployerMarked & {
  readonly kind: "addPayrollAgentKey";
  readonly signer: AccountId;
  readonly key: PayrollFunctionCallKey;
};

export type AddPayees = EmployerMarked & {
  readonly kind: "addPayees";
  readonly signer: AccountId;
  readonly receiver: AccountId;
  readonly payees: readonly { readonly accountId: AccountId; readonly cap: Units }[];
};

export type AdminSeedAction =
  | CreateEmployer
  | FundEmployer
  | CreateAgent
  | RegisterEmployer
  | AddAgent
  | CreateWorker;

export type EmployerSeedAction = AddPayrollAgentKey | AddPayees;

/**
 * Slots, not a list. `employerAccount` is create or fund, never both.
 * `createWorker` contains gaps only, keyed by worker name.
 */
export type Schedule = {
  readonly admin: {
    readonly employerAccount: CreateEmployer | FundEmployer | null;
    readonly createAgent: CreateAgent | null;
    readonly registerEmployer: RegisterEmployer | null;
    readonly addAgent: AddAgent | null;
    readonly createWorker: ReadonlyMap<WorkerName, CreateWorker>;
  };
  readonly employer: {
    readonly addPayrollAgentKey: AddPayrollAgentKey | null;
    readonly addPayees: AddPayees | null;
  };
};

export type SeedRefusal =
  | { readonly reason: "foreign_key"; readonly account: AccountId }
  | {
      readonly reason: "buffer_mismatch";
      readonly account: AccountId;
      readonly observed: Units;
      readonly expected: Units;
    }
  | {
      readonly reason: "onboarding_closed";
      readonly account: AccountId;
      readonly payeeCount: number;
      readonly expectedCount: number;
    }
  | {
      readonly reason: "payee_set_diverged";
      readonly account: AccountId;
      readonly payeeCount: number;
      readonly expectedCount: number;
    };

export type SeedBlockReason =
  | "admin_key_missing"
  | "seed_missing"
  | "network_refused"
  | "root_missing"
  | "rpc_missing"
  | "rpc_unavailable"
  | "insufficient_root_balance"
  | "broadcast_failed";

export type PlannedCell =
  | "employerAccount"
  | "createAgent"
  | "registerEmployer"
  | "addAgent"
  | "addPayrollAgentKey"
  | "addPayees"
  | { readonly createWorker: WorkerName };

/**
 * One union for the planner and the later script.
 * `converged`, `refused`, and `blocked` have no `schedule`.
 * The planner's `converged` uses `txHashes: []`.
 * The planner itself only produces `insufficient_root_balance` on the blocked arm.
 */
export type SeedReport =
  | { readonly outcome: "converged"; readonly txHashes: readonly string[] }
  | { readonly outcome: "ready"; readonly schedule: Schedule }
  | { readonly outcome: "refused"; readonly refusal: SeedRefusal }
  | {
      readonly outcome: "blocked";
      readonly reason: SeedBlockReason;
      readonly planned: readonly PlannedCell[];
    };

const NEAR = 10n ** 24n;
const ACCOUNT_FLOOR_YOCTO = 2n * NEAR;
const ROOT_CUSHION_YOCTO = NEAR;
// create_worker pays from the factory, and the factory is the root: 0.05 + 0.01 NEAR.
const WORKER_CREATE_YOCTO = 6n * 10n ** 22n;
// payroll DEMO_PAYEES. A longer list cannot be one demo run.
const MAX_PAYEES = 40;

const ADMIN_SLOT_ORDER = [
  "employerAccount",
  "createAgent",
  "registerEmployer",
  "addAgent",
] as const;
const EMPLOYER_SLOT_ORDER = ["addPayrollAgentKey", "addPayees"] as const;

type AdminSingleton = Omit<Schedule["admin"], "createWorker">;
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _adminOrder: AssertSame<(typeof ADMIN_SLOT_ORDER)[number], keyof AdminSingleton> = true;
const _employerOrder: AssertSame<(typeof EMPLOYER_SLOT_ORDER)[number], keyof Schedule["employer"]> =
  true;
void _adminOrder;
void _employerOrder;

// The lane symbols exist only in the type. Callers outside this file cannot name them.
function markAdmin<T extends { readonly lane: "admin" }>(action: T): T & AdminMarked {
  return action as T & AdminMarked;
}

function markEmployer<T extends { readonly lane: "employer" }>(action: T): T & EmployerMarked {
  return action as T & EmployerMarked;
}

export function workerName(name: string): WorkerName {
  if (!WORKER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid worker name "${name}": expected ${WORKER_NAME_PATTERN}`);
  }
  return name as WorkerName;
}

/** Drops display names. Caps and buffer become `Units` via `sen` and `senToUnits`. */
export function demoGoal(company: SeedCompany, keys: SeedPublicKeys, root: AccountId): DemoGoal {
  if (company.workers.length > MAX_PAYEES) {
    throw new Error(`Payroll accepts at most ${MAX_PAYEES} payees, got ${company.workers.length}`);
  }
  const accounts = homerollAccounts(root);
  const workers = company.workers.map((worker) => {
    const name = workerName(worker.name);
    const accountId = workerAccountId(name, root);
    if (worker.accountId !== accountId) {
      throw new Error(`Worker ${name} account id is ${worker.accountId}, expected ${accountId}`);
    }
    const publicKey = keys.workerByAccount.get(worker.accountId);
    if (publicKey === undefined || publicKey === "") {
      throw new Error(`Worker ${name} has no public key`);
    }
    return {
      name,
      accountId,
      publicKey,
      cap: senToUnits(sen(worker.capSen)),
    };
  });
  const payrollKey: PayrollFunctionCallKey = {
    role: "payrollAgent",
    publicKey: keys.payrollAgent,
    receiverId: accounts.payroll,
    methodNames: ["submit_run", "pay_run"],
    allowanceYocto: 1_000_000_000_000_000_000_000_000n,
    canAttachDeposit: false,
  };
  const invoiceKey: InvoiceFunctionCallKey = {
    role: "invoiceAgent",
    publicKey: keys.invoiceAgent,
    receiverId: accounts.pool,
    methodNames: ["attest_invoice"],
    allowanceYocto: 1_000_000_000_000_000_000_000_000n,
    canAttachDeposit: false,
  };
  return {
    root: accounts.root,
    factory: accounts.factory,
    payroll: accounts.payroll,
    pool: accounts.pool,
    agent: accounts.agent,
    employer: company.employer,
    ownerPublicKey: keys.owner,
    buffer: senToUnits(sen(company.bufferSen)),
    payrollKey,
    invoiceKey,
    workers,
  };
}

function sameMethods(observed: readonly string[], expected: readonly string[]): boolean {
  if (observed.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (observed[index] !== expected[index]) return false;
  }
  return true;
}

function payrollKeyMatches(key: AccessKeyView, goal: DemoGoal): boolean {
  return (
    key.kind === "functionCall" &&
    key.publicKey === goal.payrollKey.publicKey &&
    key.receiverId === goal.payrollKey.receiverId &&
    sameMethods(key.methodNames, goal.payrollKey.methodNames)
  );
}

function invoiceKeyMatches(key: AccessKeyView, goal: DemoGoal): boolean {
  return (
    key.kind === "functionCall" &&
    key.publicKey === goal.invoiceKey.publicKey &&
    key.receiverId === goal.invoiceKey.receiverId &&
    sameMethods(key.methodNames, goal.invoiceKey.methodNames)
  );
}

/** First foreign key wins. Slots are not built after this returns. */
function foreignKey(snapshot: CompanySnapshot, goal: DemoGoal): SeedRefusal | null {
  const { employer } = snapshot;
  if (employer.kind === "present") {
    // The root cannot add a key to an account that already exists. Payees need the owner key.
    const ownerHeld = employer.keys.some(
      (key) => key.kind === "fullAccess" && key.publicKey === goal.ownerPublicKey,
    );
    if (!ownerHeld) return { reason: "foreign_key", account: goal.employer };
    for (const key of employer.keys) {
      if (key.kind === "fullAccess" && key.publicKey !== goal.ownerPublicKey) {
        return { reason: "foreign_key", account: goal.employer };
      }
      if (
        key.kind === "functionCall" &&
        key.publicKey === goal.payrollKey.publicKey &&
        !payrollKeyMatches(key, goal)
      ) {
        return { reason: "foreign_key", account: goal.employer };
      }
    }
  }

  const { agent } = snapshot;
  if (agent.kind === "present") {
    // No later slot can add the invoice key. An account with no full-access key cannot add one.
    const invoiceHeld = agent.keys.some((key) => invoiceKeyMatches(key, goal));
    if (!invoiceHeld) return { reason: "foreign_key", account: goal.agent };
    for (const key of agent.keys) {
      if (key.kind === "fullAccess" || !invoiceKeyMatches(key, goal)) {
        return { reason: "foreign_key", account: goal.agent };
      }
    }
  }

  for (const worker of goal.workers) {
    const presence = snapshot.workers.get(worker.accountId);
    if (presence === undefined || presence.kind === "absent") continue;
    const ours = presence.keys.some(
      (key) => key.kind === "fullAccess" && key.publicKey === worker.publicKey,
    );
    if (!ours) return { reason: "foreign_key", account: worker.accountId };
  }
  return null;
}

function payrollRecordRefusal(snapshot: CompanySnapshot, goal: DemoGoal): SeedRefusal | null {
  const record = snapshot.payrollEmployer;
  if (record.kind !== "present") return null;
  if (record.buffer !== goal.buffer) {
    return {
      reason: "buffer_mismatch",
      account: goal.employer,
      observed: record.buffer,
      expected: goal.buffer,
    };
  }
  // add_payee would restart the hold. This unit does not call submit_run.
  if (!record.onboarding && record.payeeCount !== goal.workers.length) {
    return {
      reason: "onboarding_closed",
      account: goal.employer,
      payeeCount: record.payeeCount,
      expectedCount: goal.workers.length,
    };
  }
  // No remove_payee in this unit.
  if (record.payeeCount > goal.workers.length) {
    return {
      reason: "payee_set_diverged",
      account: goal.employer,
      payeeCount: record.payeeCount,
      expectedCount: goal.workers.length,
    };
  }
  return null;
}

function payrollKeyHeld(snapshot: CompanySnapshot, goal: DemoGoal): boolean {
  if (snapshot.employer.kind !== "present") return false;
  return snapshot.employer.keys.some((key) => payrollKeyMatches(key, goal));
}

function scheduleFor(snapshot: CompanySnapshot, goal: DemoGoal): Schedule {
  const record = snapshot.payrollEmployer;
  const held = payrollKeyHeld(snapshot, goal);
  const employerAccount = employerAccountSlot(snapshot, goal, held);
  const createAgent =
    snapshot.agent.kind === "absent"
      ? markAdmin({
          lane: "admin" as const,
          kind: "createAgent" as const,
          accountId: goal.agent,
          invoiceKey: goal.invoiceKey,
          fundYocto: ACCOUNT_FLOOR_YOCTO,
        })
      : null;
  const registerEmployer =
    record.kind === "absent"
      ? markAdmin({
          lane: "admin" as const,
          kind: "registerEmployer" as const,
          payroll: goal.payroll,
          employer: goal.employer,
          buffer: goal.buffer,
        })
      : null;
  const addAgent =
    snapshot.agentAllowlist === "planInsert"
      ? markAdmin({
          lane: "admin" as const,
          kind: "addAgent" as const,
          pool: goal.pool,
          agent: goal.agent,
        })
      : null;
  const createWorker = new Map<WorkerName, CreateWorker>();
  for (const worker of goal.workers) {
    const presence = snapshot.workers.get(worker.accountId);
    if (presence !== undefined && presence.kind === "present") continue;
    createWorker.set(
      worker.name,
      markAdmin({
        lane: "admin" as const,
        kind: "createWorker" as const,
        factory: goal.factory,
        name: worker.name,
        publicKey: worker.publicKey,
      }),
    );
  }
  const addPayrollAgentKey = held
    ? null
    : markEmployer({
        lane: "employer" as const,
        kind: "addPayrollAgentKey" as const,
        signer: goal.employer,
        key: goal.payrollKey,
      });
  const payeeCount = record.kind === "present" ? record.payeeCount : 0;
  const onboardingOpen = record.kind === "absent" || record.onboarding;
  // get_employer returns a count, not ids. add_payee replaces a cap while onboarding is open.
  const addPayees =
    onboardingOpen && payeeCount < goal.workers.length
      ? markEmployer({
          lane: "employer" as const,
          kind: "addPayees" as const,
          signer: goal.employer,
          receiver: goal.payroll,
          payees: goal.workers.map((worker) => ({
            accountId: worker.accountId,
            cap: worker.cap,
          })),
        })
      : null;
  return {
    admin: { employerAccount, createAgent, registerEmployer, addAgent, createWorker },
    employer: { addPayrollAgentKey, addPayees },
  };
}

function employerAccountSlot(
  snapshot: CompanySnapshot,
  goal: DemoGoal,
  payrollHeld: boolean,
): CreateEmployer | FundEmployer | null {
  if (snapshot.employer.kind === "absent") {
    return markAdmin({
      lane: "admin" as const,
      kind: "createEmployer" as const,
      accountId: goal.employer,
      ownerPublicKey: goal.ownerPublicKey,
      fundYocto: ACCOUNT_FLOOR_YOCTO,
    });
  }
  if (!payrollHeld && snapshot.employer.balanceYocto < ACCOUNT_FLOOR_YOCTO) {
    return markAdmin({
      lane: "admin" as const,
      kind: "fundEmployer" as const,
      accountId: goal.employer,
      fundYocto: ACCOUNT_FLOOR_YOCTO - snapshot.employer.balanceYocto,
    });
  }
  return null;
}

function scheduleEmpty(schedule: Schedule): boolean {
  return (
    schedule.admin.employerAccount === null &&
    schedule.admin.createAgent === null &&
    schedule.admin.registerEmployer === null &&
    schedule.admin.addAgent === null &&
    schedule.admin.createWorker.size === 0 &&
    schedule.employer.addPayrollAgentKey === null &&
    schedule.employer.addPayees === null
  );
}

function rootNeed(schedule: Schedule): bigint {
  let need = ROOT_CUSHION_YOCTO;
  if (schedule.admin.employerAccount) need += schedule.admin.employerAccount.fundYocto;
  if (schedule.admin.createAgent) need += schedule.admin.createAgent.fundYocto;
  need += BigInt(schedule.admin.createWorker.size) * WORKER_CREATE_YOCTO;
  return need;
}

/**
 * Pure. No RPC. A foreign key returns `refused` before any slot is built.
 */
export function planSeed(snapshot: CompanySnapshot, goal: DemoGoal): SeedReport {
  const foreign = foreignKey(snapshot, goal);
  if (foreign) return { outcome: "refused", refusal: foreign };
  const recordRefusal = payrollRecordRefusal(snapshot, goal);
  if (recordRefusal) return { outcome: "refused", refusal: recordRefusal };

  const schedule = scheduleFor(snapshot, goal);
  if (scheduleEmpty(schedule)) return { outcome: "converged", txHashes: [] };
  if (snapshot.rootBalanceYocto < rootNeed(schedule)) {
    return {
      outcome: "blocked",
      reason: "insufficient_root_balance",
      planned: plannedCells(schedule),
    };
  }
  return { outcome: "ready", schedule };
}

/** Names of the filled slots, in broadcast order. Worker gaps are sorted by name. */
export function plannedCells(schedule: Schedule): readonly PlannedCell[] {
  const cells: PlannedCell[] = [];
  for (const slot of ADMIN_SLOT_ORDER) {
    if (schedule.admin[slot] !== null) cells.push(slot);
  }
  const names = [...schedule.admin.createWorker.keys()].sort();
  for (const name of names) cells.push({ createWorker: name });
  for (const slot of EMPLOYER_SLOT_ORDER) {
    if (schedule.employer[slot] !== null) cells.push(slot);
  }
  return cells;
}
