import { describe, expect, it } from "vitest";
import {
  type AccountPresence,
  type CompanySnapshot,
  type DemoGoal,
  demoGoal,
  planSeed,
  type SeedReport,
  workerName,
} from "./plan.ts";

const ROOT = "homeroll.testnet";
const EMPLOYER = "coffeefactory.homeroll.testnet";
const OWNER = "ed25519:owner";
const PAYROLL = "ed25519:payroll";
const INVOICE = "ed25519:invoice";
const RAHIM = "ed25519:w-7k2q9x";
const HAFIZ = "ed25519:w-6b1x4k";
const STRANGER = "ed25519:stranger";
const NEAR = 10n ** 24n;

function goal(): DemoGoal {
  return demoGoal(
    {
      employer: EMPLOYER,
      bufferSen: 500_000,
      workers: [
        { name: "w-7k2q9x", accountId: "w-7k2q9x.homeroll.testnet", capSen: 195_000 },
        { name: "w-6b1x4k", accountId: "w-6b1x4k.homeroll.testnet", capSen: 180_000 },
      ],
    },
    {
      owner: OWNER,
      payrollAgent: PAYROLL,
      invoiceAgent: INVOICE,
      workerByAccount: new Map([
        ["w-7k2q9x.homeroll.testnet", RAHIM],
        ["w-6b1x4k.homeroll.testnet", HAFIZ],
      ]),
    },
    ROOT,
  );
}

function nothingOnChain(): CompanySnapshot {
  return {
    rootBalanceYocto: 100n * NEAR,
    employer: { kind: "absent" },
    agent: { kind: "absent" },
    payrollEmployer: { kind: "absent" },
    agentAllowlist: "planInsert",
    workers: new Map(),
  };
}

function companyComplete(built: DemoGoal): CompanySnapshot {
  const workers = new Map<string, AccountPresence>();
  for (const worker of built.workers) {
    workers.set(worker.accountId, {
      kind: "present",
      balanceYocto: 5n * 10n ** 22n,
      keys: [{ kind: "fullAccess", publicKey: worker.publicKey }],
    });
  }
  return {
    // An empty plan converges before the root cushion is consulted.
    rootBalanceYocto: 0n,
    employer: {
      kind: "present",
      balanceYocto: 2n * NEAR,
      keys: [
        { kind: "fullAccess", publicKey: built.ownerPublicKey },
        {
          kind: "functionCall",
          publicKey: built.payrollKey.publicKey,
          receiverId: built.payroll,
          methodNames: [...built.payrollKey.methodNames],
          // Gas spends the allowance. A spent key is still the payroll key.
          allowanceYocto: 1n,
        },
      ],
    },
    agent: {
      kind: "present",
      balanceYocto: 2n * NEAR,
      keys: [
        {
          kind: "functionCall",
          publicKey: built.invoiceKey.publicKey,
          receiverId: built.pool,
          methodNames: [...built.invoiceKey.methodNames],
          allowanceYocto: built.invoiceKey.allowanceYocto,
        },
      ],
    },
    payrollEmployer: {
      kind: "present",
      buffer: built.buffer,
      onboarding: false,
      payeeCount: built.workers.length,
    },
    agentAllowlist: "member",
    workers,
  };
}

function workerPresent(built: DemoGoal, name: string, publicKey: string): CompanySnapshot {
  const worker = built.workers.find((item) => item.name === workerName(name));
  if (!worker) throw new Error(`No worker ${name} on the goal`);
  const workers = new Map(nothingOnChain().workers);
  workers.set(worker.accountId, {
    kind: "present",
    balanceYocto: 5n * 10n ** 22n,
    keys: [{ kind: "fullAccess", publicKey }],
  });
  return { ...nothingOnChain(), workers };
}

function expectNoSchedule(report: SeedReport): void {
  expect("schedule" in report).toBe(false);
}

describe("planSeed", () => {
  it("plans an empty chain as ready, with register on the admin lane and payees signed by the employer", () => {
    const built = goal();
    const report = planSeed(nothingOnChain(), built);

    expect(report.outcome).toBe("ready");
    if (report.outcome !== "ready") return;

    expect(report.schedule.admin.registerEmployer).toMatchObject({
      lane: "admin",
      kind: "registerEmployer",
      payroll: built.payroll,
      employer: built.employer,
      buffer: built.buffer,
    });
    expect(report.schedule.employer.addPayees).toMatchObject({
      lane: "employer",
      kind: "addPayees",
      signer: built.employer,
      receiver: built.payroll,
    });
    expect(report.schedule.employer.addPayees?.payees.map((payee) => payee.accountId)).toEqual([
      "w-7k2q9x.homeroll.testnet",
      "w-6b1x4k.homeroll.testnet",
    ]);
    expect(report.schedule.admin.createWorker.size).toBe(built.workers.length);
  });

  it("reports a complete company as converged and omits the schedule", () => {
    const built = goal();
    const report = planSeed(companyComplete(built), built);

    expect(report).toEqual({ outcome: "converged", txHashes: [] });
    expectNoSchedule(report);
  });

  it("leaves w-7k2q9x out of createWorker when that account already has our full-access key", () => {
    const built = goal();
    const report = planSeed(workerPresent(built, "w-7k2q9x", RAHIM), built);

    expect(report.outcome).toBe("ready");
    if (report.outcome !== "ready") return;

    expect(report.schedule.admin.createWorker.has(workerName("w-7k2q9x"))).toBe(false);
    expect(report.schedule.admin.createWorker.get(workerName("w-6b1x4k"))).toMatchObject({
      kind: "createWorker",
      lane: "admin",
      name: workerName("w-6b1x4k"),
      publicKey: HAFIZ,
      factory: built.factory,
    });
  });

  it("refuses w-7k2q9x when our full-access key is absent and omits the schedule", () => {
    const built = goal();
    const report = planSeed(workerPresent(built, "w-7k2q9x", STRANGER), built);

    expect(report).toEqual({
      outcome: "refused",
      refusal: { reason: "foreign_key", account: "w-7k2q9x.homeroll.testnet" },
    });
    expectNoSchedule(report);
  });

  it("refuses a stranger full-access key on the employer and omits the schedule", () => {
    const built = goal();
    const snapshot = nothingOnChain();
    const report = planSeed(
      {
        ...snapshot,
        employer: {
          kind: "present",
          balanceYocto: 5n * NEAR,
          keys: [
            { kind: "fullAccess", publicKey: built.ownerPublicKey },
            { kind: "fullAccess", publicKey: STRANGER },
          ],
        },
      },
      built,
    );

    expect(report).toEqual({
      outcome: "refused",
      refusal: { reason: "foreign_key", account: built.employer },
    });
    expectNoSchedule(report);
  });

  it("refuses an existing agent account that does not hold the invoice key", () => {
    const built = goal();
    const report = planSeed(
      {
        ...nothingOnChain(),
        agent: { kind: "present", balanceYocto: 2n * NEAR, keys: [] },
      },
      built,
    );

    expect(report).toEqual({
      outcome: "refused",
      refusal: { reason: "foreign_key", account: built.agent },
    });
    expectNoSchedule(report);
  });

  it("refuses a present employer that does not hold the owner key", () => {
    const built = goal();
    const report = planSeed(
      {
        ...nothingOnChain(),
        employer: { kind: "present", balanceYocto: 2n * NEAR, keys: [] },
      },
      built,
    );

    expect(report).toEqual({
      outcome: "refused",
      refusal: { reason: "foreign_key", account: built.employer },
    });
    expectNoSchedule(report);
  });

  it("refuses any full-access key on the agent account and omits the schedule", () => {
    const built = goal();
    const snapshot = nothingOnChain();
    const report = planSeed(
      {
        ...snapshot,
        agent: {
          kind: "present",
          balanceYocto: 2n * NEAR,
          keys: [
            {
              kind: "functionCall",
              publicKey: built.invoiceKey.publicKey,
              receiverId: built.invoiceKey.receiverId,
              methodNames: [...built.invoiceKey.methodNames],
              allowanceYocto: built.invoiceKey.allowanceYocto,
            },
            { kind: "fullAccess", publicKey: STRANGER },
          ],
        },
      },
      built,
    );

    expect(report).toEqual({
      outcome: "refused",
      refusal: { reason: "foreign_key", account: built.agent },
    });
    expectNoSchedule(report);
  });
});
