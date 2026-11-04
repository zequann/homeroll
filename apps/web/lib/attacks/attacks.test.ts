import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoiceAgentDeps } from "@/lib/agents";
import { invoiceDocument, runInvoiceAgent } from "@/lib/agents/invoice-agent";
import { sen, senToUnits } from "@/lib/fx";
import { getChainClient, getFixtures } from "@/lib/near";
import { ATTACK_IDS, runAttack } from "./index";

// lib/session reads cookies at call time; attacks only use its payroll agent signer.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

/** October is open on this date (R14), and the fake chain reads Date.now. */
const NOW = new Date("2026-11-04T12:00:00.000Z");

describe("the five attacks (SPEC §11), through the code the lab runs", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    await getChainClient().resetDemo();
  });
  afterEach(() => vi.useRealTimers());

  it.each(ATTACK_IDS)("attack %s is refused and moves no money on a fresh company", async (id) => {
    const result = await runAttack(id);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.money.afterSen).toBe(result.money.beforeSen);
  });

  it("02 names Hafiz's line with the exact error", async () => {
    const { failures } = await runAttack("02");
    expect(failures[0]?.code).toMatch(/^ERR_ABOVE_WAGE_CAP:4:w-6b1x4k\./);
    expect(failures[0]?.sentence).toContain("Hafiz Rahman");
  });

  it("01 refuses an account that is not a payee", async () => {
    const { failures } = await runAttack("01");
    expect(failures[0]?.code).toBe("ERR_PAYEE_NOT_ACTIVE:0:rahim-wallet.testnet");
  });

  it("03 is refused by the pool registry", async () => {
    const { failures, stoppedBy } = await runAttack("03");
    expect(failures[0]?.code).toBe("ERR_INVOICE_ALREADY_REGISTERED");
    expect(stoppedBy).toBe("Pool contract");
  });

  it("04 keeps grade A and the pool refuses a 100% advance", async () => {
    const { failures, notes } = await runAttack("04");
    expect(failures.map((f) => f.code)).toEqual(["ERR_ADVANCE_ABOVE_CAP"]);
    expect(notes.join(" ")).toContain("Not a grade");
  });

  it("05 shows the three protocol errors in order, labelled as simulated", async () => {
    const { failures, simulated, stoppedBy } = await runAttack("05");
    expect(failures.map((f) => f.code)).toEqual([
      "InvalidAccessKeyError: DepositWithFunctionCall",
      "InvalidAccessKeyError: ReceiverMismatch",
      "InvalidAccessKeyError: MethodNameMismatch",
    ]);
    expect(simulated).toBe(true);
    expect(stoppedBy).toBe("NEAR protocol");
  });

  it("still refuses every attack after the invoice was already advanced", async () => {
    const deps = invoiceAgentDeps();
    const fixtures = getFixtures();
    const invoice = fixtures.invoices[0];
    if (!invoice) throw new Error("no invoice");
    await runInvoiceAgent(deps, invoiceDocument(fixtures, invoice));
    await deps.chain.requestAdvance(
      { role: "owner", accountId: fixtures.company.accountId },
      invoice.hash,
      senToUnits(sen(12_000_000)),
    );
    for (const id of ATTACK_IDS) {
      const result = await runAttack(id);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.money.afterSen).toBe(result.money.beforeSen);
    }
  });
});
