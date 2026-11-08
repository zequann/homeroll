import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActivityLog, recentActivity } from "@/lib/activity";
import { loadAddedWorkers, saveAddedWorker } from "@/lib/added-workers";
import { sen, units } from "@/lib/fx";
import { getMockLedger, type MockReceipt } from "@/lib/mock/ledger";
import { nameOrAccount } from "@/lib/names";
import { getFixtures } from "@/lib/near";
import { pending } from "./background";
import { createMemoryRowStore, type RowStore, resetRowStoreForTests } from "./rows";

/**
 * On Vercel each request can land on a fresh server instance with empty memory. These tests stand
 * in a shared store (a memory store reporting itself as Supabase) and wipe the instance's own
 * memory between writing and reading, as a cold start would.
 */
function sharedStore(): RowStore {
  return { ...createMemoryRowStore(), kind: "supabase" };
}
const g = globalThis as unknown as Record<string, unknown>;
function coldStart() {
  delete g.__homerollAddedWorkers;
  delete g.__homerollActivity;
}

describe("records every server instance sees (SPEC §8.7)", () => {
  beforeEach(() => {
    resetRowStoreForTests(sharedStore());
    coldStart();
  });
  afterEach(() => resetRowStoreForTests());

  it("an added worker's name resolves on another instance after it loads", async () => {
    await saveAddedWorker({
      accountId: "w-zz9zz9.homeroll.testnet",
      displayName: "Made-up Name",
      role: "Sanding",
      capSen: sen(250_000),
    });
    coldStart();
    expect(nameOrAccount("w-zz9zz9.homeroll.testnet")).toBe("w-zz9zz9.homeroll.testnet");
    const added = await loadAddedWorkers();
    expect(added.map((w) => w.displayName)).toEqual(["Made-up Name"]);
    expect(nameOrAccount("w-zz9zz9.homeroll.testnet")).toBe("Made-up Name");
  });

  it("a mock receipt written on one instance is found on another", async () => {
    const receipt = await getMockLedger().record<Extract<MockReceipt, { kind: "duitnow" }>>(
      {
        mock: true,
        kind: "duitnow",
        partner: "Mock partner · DuitNow off-ramp",
        txHash: "tx-1",
        amountSen: sen(20_000),
        rmOutSen: sen(19_900),
        destination: "TNG eWallet •••• 1234",
        at: 1,
      },
      "DN",
    );
    expect(receipt.ref).toMatch(/^DN-SYN-\d{6}$/);
    coldStart();
    expect(await getMockLedger().find(receipt.ref)).toEqual(receipt);
  });

  it("activity, with bigint amounts, is read back newest first", async () => {
    const employer = getFixtures().company.accountId;
    const log = getActivityLog();
    for (const method of ["submit_run", "pay_run"]) {
      log.record({
        at: Date.now(),
        method,
        from: employer,
        to: "payroll.homeroll.testnet",
        amount: units(78_000_000_000n),
        txHash: null,
        failure: null,
      });
    }
    await pending();
    coldStart();
    const rows = await recentActivity();
    expect(rows.map((r) => r.method)).toEqual(["pay_run", "submit_run"]);
    expect(rows[0]?.amount).toBe(78_000_000_000n);
  });
});
