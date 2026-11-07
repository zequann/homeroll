import type { Fixtures } from "@homeroll/fixtures";
import { homerollAccounts } from "@homeroll/shared";
import { describe, expect, it } from "vitest";
import { sen, senToUnits, units } from "@/lib/fx";
import { toPayLines } from "@/lib/payroll";
import { maxAdvanceBps } from "@/lib/pool-grades";
import type { ChainClient, PayLine, Period, Signer, TxFailure } from "./client";
import { failureText } from "./failure";

/**
 * Behaviour every `ChainClient` must show (SPEC §8.8). `FakeChainClient` runs it now;
 * `NearChainClient` runs the same file against a sandbox or testnet.
 */
export interface SuiteContext {
  chain: ChainClient;
  fixtures: Fixtures;
  /** A period the chain's clock treats as open (R14). */
  openPeriod: Period;
  /** A period the chain's clock treats as closed. */
  closedPeriod: Period;
}

export function signers(f: Fixtures): { owner: Signer; agent: Signer } {
  return {
    owner: { role: "owner", accountId: f.company.accountId },
    agent: { role: "payrollAgent", accountId: f.company.accountId },
  };
}

function fixtureInvoice(f: Fixtures, number: string) {
  const invoice = f.invoices.find((i) => i.number === number);
  if (!invoice) throw new Error(`No fixture invoice ${number}`);
  return invoice;
}

/** The pool's registry key for a fixture invoice: its hash (SPEC §7.4). */
export const key = (f: Fixtures, number: string) => fixtureInvoice(f, number).hash;

export const advanceUnits = (f: Fixtures, number: string) => {
  const invoice = fixtureInvoice(f, number);
  const bps = maxAdvanceBps(invoice.expectedGrade);
  return senToUnits(sen(Math.floor((invoice.amountSen * bps) / 10_000)));
};

/** What the invoice agent does for each demo invoice before the owner can take an advance. */
export async function attestFixtureInvoices(chain: ChainClient, f: Fixtures): Promise<void> {
  const agent: Signer = { role: "invoiceAgent", accountId: homerollAccounts(f.root).agent };
  for (const i of f.invoices) {
    const result = await chain.attestInvoice(agent, {
      invoiceKey: i.hash,
      employer: f.company.accountId,
      buyerHash: i.buyerHash,
      amount: senToUnits(sen(i.amountSen)),
      dueTs: BigInt(Date.parse(i.due)) * 1_000_000n,
      grade: i.expectedGrade,
      attestationRef: "none",
    });
    if (!result.ok) throw new Error(`attest ${i.number} failed: ${JSON.stringify(result.failure)}`);
  }
}

function expectFailureText(result: { ok: boolean; failure?: TxFailure }, text: string) {
  expect(result.ok).toBe(false);
  expect(result.failure && failureText(result.failure)).toBe(text);
}

export function runChainClientSuite(
  label: string,
  make: () => SuiteContext | Promise<SuiteContext>,
) {
  describe(`ChainClient: ${label}`, () => {
    const setup = async () => {
      const ctx = await make();
      await attestFixtureInvoices(ctx.chain, ctx.fixtures);
      const { owner, agent } = signers(ctx.fixtures);
      const employer = ctx.fixtures.company.accountId;
      return { ...ctx, owner, agent, employer, lines: toPayLines(ctx.fixtures.timesheet) };
    };

    it("starts from the fixtures", async () => {
      const { chain, employer, fixtures } = await setup();
      const view = await chain.getEmployer(employer);
      expect(view?.payeeCount).toBe(40);
      expect(view?.onboarding).toBe(true);
      expect(await chain.getEmployer(`nobody.${fixtures.root}`)).toBeNull();
      expect((await chain.getInvoice(key(fixtures, "INV-2026-1043")))?.status).toBe("Attested");
      expect((await chain.getInvoice(key(fixtures, "INV-2026-1050")))?.status).toBe("Declined");
    });

    describe("submit_run", () => {
      it("accepts a valid run, reserves its total and returns run 0 (R3, R4, R5, R6)", async () => {
        const { chain, owner, agent, employer, openPeriod, lines, fixtures } = await setup();
        await chain.requestAdvance(
          owner,
          key(fixtures, "INV-2026-1043"),
          advanceUnits(fixtures, "INV-2026-1043"),
        );
        const before = await chain.getEmployer(employer);
        const result = await chain.submitRun(agent, openPeriod, lines);
        expect(result.ok && result.value.runId).toBe(0);
        const after = await chain.getEmployer(employer);
        const total = lines.reduce((s, l) => s + l.amount, 0n);
        expect(before && after && before.treasury - after.treasury).toBe(total);
        expect(after?.onboarding).toBe(false);
        const runs = await chain.getRuns(employer, openPeriod);
        expect(runs?.[0]?.status).toBe("Pending");
        expect(runs?.[0]?.lines.every((l) => l.status === "Reserved")).toBe(true);
      });

      it("rejects a caller that is not the employer", async () => {
        const { chain, openPeriod, lines } = await setup();
        const worker: Signer = { role: "worker", accountId: lines[0]?.accountId ?? "" };
        expectFailureText(await chain.submitRun(worker, openPeriod, lines), "ERR_NOT_EMPLOYER");
      });

      it("rejects more lines than the run limit", async () => {
        const { chain, agent, openPeriod, lines } = await setup();
        const result = await chain.submitRun(agent, openPeriod, [...lines, ...lines.slice(0, 1)]);
        expectFailureText(result, "ERR_TOO_MANY_LINES");
      });

      it("rejects a closed period (R14)", async () => {
        const { chain, agent, closedPeriod, lines } = await setup();
        expectFailureText(await chain.submitRun(agent, closedPeriod, lines), "ERR_PERIOD_NOT_OPEN");
      });

      it("rejects an account that is not a payee, naming its line (R3)", async () => {
        const { chain, agent, openPeriod, lines } = await setup();
        const forged = [
          { ...(lines[0] as PayLine), accountId: "rahim-wallet.testnet" },
          ...lines.slice(1),
        ];
        const result = await chain.submitRun(agent, openPeriod, forged);
        expectFailureText(result, "ERR_PAYEE_NOT_ACTIVE:0:rahim-wallet.testnet");
      });

      it("rejects a wage above the wage cap, naming its line, and changes nothing (R4)", async () => {
        const { chain, agent, employer, openPeriod, fixtures } = await setup();
        const before = await chain.getEmployer(employer);
        const result = await chain.submitRun(
          agent,
          openPeriod,
          toPayLines(fixtures.timesheetTampered),
        );
        expectFailureText(result, `ERR_ABOVE_WAGE_CAP:4:w-6b1x4k.${fixtures.root}`);
        expect(await chain.getEmployer(employer)).toEqual(before);
        expect(await chain.getRuns(employer, openPeriod)).toEqual([]);
      });

      it("rejects a payee listed twice, naming the later line (R5)", async () => {
        const { chain, agent, openPeriod, lines } = await setup();
        const result = await chain.submitRun(agent, openPeriod, [
          ...lines.slice(0, 3),
          lines[1] as PayLine,
        ]);
        expectFailureText(result, `ERR_DUPLICATE_PAYEE:3:${lines[1]?.accountId}`);
      });

      it("rejects a payee who already holds the period (R5)", async () => {
        const { chain, owner, agent, openPeriod, lines, fixtures } = await setup();
        await chain.requestAdvance(
          owner,
          key(fixtures, "INV-2026-1043"),
          advanceUnits(fixtures, "INV-2026-1043"),
        );
        expect((await chain.submitRun(agent, openPeriod, lines)).ok).toBe(true);
        const again = await chain.submitRun(agent, openPeriod, lines.slice(0, 2));
        expectFailureText(again, `ERR_ALREADY_PAID:0:${lines[0]?.accountId}`);
      });

      it("rejects a run that would leave the treasury below the buffer, reserving nothing (R6)", async () => {
        const { chain, agent, employer, openPeriod, lines } = await setup();
        const before = await chain.getEmployer(employer);
        expectFailureText(await chain.submitRun(agent, openPeriod, lines), "ERR_BELOW_BUFFER");
        expect(await chain.getEmployer(employer)).toEqual(before);
      });
    });

    describe("pay_run", () => {
      it("pays reserved lines in calls until the run is done, then refuses (R3)", async () => {
        const { chain, owner, agent, employer, openPeriod, lines, fixtures } = await setup();
        await chain.requestAdvance(
          owner,
          key(fixtures, "INV-2026-1043"),
          advanceUnits(fixtures, "INV-2026-1043"),
        );
        const submitted = await chain.submitRun(agent, openPeriod, lines);
        if (!submitted.ok) throw new Error("submit_run failed");
        const { runId } = submitted.value;

        const first = await chain.payRun(agent, runId);
        expect(first.ok && first.value.lines[0]?.status).toBe("Paid");
        expect(await chain.ftBalanceOf(lines[0]?.accountId ?? "")).toBe(lines[0]?.amount);

        for (let i = 0; i < 10; i++) {
          const next = await chain.payRun(agent, runId);
          if (!next.ok) break;
        }
        const runs = await chain.getRuns(employer, openPeriod);
        expect(runs?.[0]?.status).toBe("Done");
        expectFailureText(await chain.payRun(agent, runId), "ERR_RUN_COMPLETE");
        expectFailureText(await chain.payRun(agent, 99), "ERR_RUN_NOT_FOUND");
      });
    });

    describe("owner-only payee and run methods", () => {
      const NEW_PAYEE = "w-abc123";

      it("adds a payee at once during onboarding, once the list has room (R3, R15)", async () => {
        const { chain, owner, fixtures } = await setup();
        const account = `${NEW_PAYEE}.${fixtures.root}`;
        expectFailureText(await chain.addPayee(owner, account, units(1n)), "ERR_TOO_MANY_PAYEES");
        const first = fixtures.workers[0]?.accountId ?? "";
        expect((await chain.removePayee(owner, first)).ok).toBe(true);
        const added = await chain.addPayee(owner, account, units(1n));
        expect(added.ok && added.value.activeFrom > 0n).toBe(true);
        expect((await chain.getPayees(fixtures.company.accountId)).length).toBe(40);
      });

      it("skips a payee removed before payment and returns the money (R3)", async () => {
        const { chain, owner, agent, employer, fixtures, openPeriod, lines } = await setup();
        await chain.requestAdvance(
          owner,
          key(fixtures, "INV-2026-1043"),
          advanceUnits(fixtures, "INV-2026-1043"),
        );
        const submitted = await chain.submitRun(agent, openPeriod, lines);
        if (!submitted.ok) throw new Error("submit_run failed");
        const first = lines[0];
        if (!first) throw new Error("no lines");
        await chain.removePayee(owner, first.accountId);
        const before = await chain.getEmployer(employer);
        const paid = await chain.payRun(agent, submitted.value.runId);
        expect(paid.ok && paid.value.lines[0]?.status).toBe("Skipped");
        expect((await chain.getEmployer(employer))?.treasury).toBe(
          (before?.treasury ?? 0n) + first.amount,
        );
      });

      it("holds a payee added after the first run (R3)", async () => {
        const { chain, owner, agent, fixtures, openPeriod, lines } = await setup();
        await chain.requestAdvance(
          owner,
          key(fixtures, "INV-2026-1043"),
          advanceUnits(fixtures, "INV-2026-1043"),
        );
        const first = lines[0];
        if (!first) throw new Error("no lines");
        const submitted = await chain.submitRun(agent, openPeriod, lines.slice(1));
        if (!submitted.ok) throw new Error("submit_run failed");
        await chain.removePayee(owner, first.accountId);
        const back = await chain.addPayee(owner, first.accountId, units(first.amount));
        expect(back.ok).toBe(true);
        const line = [first];
        const held = await chain.submitRun(agent, openPeriod, line);
        expect(!held.ok && held.failure.kind === "contract" && held.failure.error.code).toBe(
          "ERR_PAYEE_NOT_ACTIVE",
        );
      });

      it("cancels reserved lines and returns their money", async () => {
        const { chain, owner, agent, employer, fixtures, openPeriod, lines } = await setup();
        await chain.requestAdvance(
          owner,
          key(fixtures, "INV-2026-1043"),
          advanceUnits(fixtures, "INV-2026-1043"),
        );
        const before = await chain.getEmployer(employer);
        const submitted = await chain.submitRun(agent, openPeriod, lines);
        if (!submitted.ok) throw new Error("submit_run failed");
        const cancelled = await chain.cancelRun(owner, submitted.value.runId);
        expect(cancelled.ok && cancelled.value.status).toBe("Cancelled");
        expect((await chain.getEmployer(employer))?.treasury).toBe(before?.treasury);
        expectFailureText(await chain.cancelRun(owner, submitted.value.runId), "ERR_RUN_COMPLETE");
        // A cancelled line does not hold the period, so the same people can be paid again
        expect((await chain.submitRun(agent, openPeriod, lines)).ok).toBe(true);
      });

      it("refuses the payroll agent's key at the protocol on all three (SPEC §6)", async () => {
        const { chain, agent, fixtures } = await setup();
        const account = fixtures.workers[0]?.accountId ?? "";
        const expected = { kind: "protocol", name: "MethodNameMismatch" };
        for (const result of [
          await chain.addPayee(agent, account, units(1n)),
          await chain.removePayee(agent, account),
          await chain.cancelRun(agent, 0),
        ]) {
          expect(!result.ok && result.failure).toEqual(expected);
        }
      });

      it("reports an unknown payee and an unknown run", async () => {
        const { chain, owner } = await setup();
        expectFailureText(await chain.removePayee(owner, "nobody.testnet"), "ERR_UNKNOWN_PAYEE");
        expectFailureText(await chain.cancelRun(owner, 99), "ERR_RUN_NOT_FOUND");
      });
    });

    describe("attest_invoice", () => {
      it("refuses a second registration of the same invoice (R7)", async () => {
        const { chain, fixtures } = await setup();
        await expect(attestFixtureInvoices(chain, fixtures)).rejects.toThrow("attest");
      });

      it("only lets registered agents attest (R10)", async () => {
        const { chain, owner, fixtures } = await setup();
        const result = await chain.attestInvoice(owner, {
          invoiceKey: "ab".repeat(32),
          employer: fixtures.company.accountId,
          buyerHash: "cd".repeat(32),
          amount: units(1n),
          dueTs: 0n,
          grade: "A",
          attestationRef: "none",
        });
        expectFailureText(result, "ERR_NOT_AGENT");
      });
    });

    describe("settle", () => {
      it("repays advance + fee to the pool and forwards the rest to the treasury", async () => {
        const { chain, owner, employer, fixtures } = await setup();
        const k = key(fixtures, "INV-2026-1043");
        await chain.requestAdvance(owner, k, advanceUnits(fixtures, "INV-2026-1043"));
        const before = await chain.getEmployer(employer);
        const escrow: Signer = {
          role: "settler",
          accountId: homerollAccounts(fixtures.root).escrow,
        };
        const result = await chain.settleInvoice(escrow, k, senToUnits(sen(15_000_000)));
        expect(result.ok && result.value).toMatchObject({
          settled: true,
          invoice: { status: "Settled" },
        });
        const rest = (await chain.getEmployer(employer))?.treasury ?? 0n;
        // RM150,000 − RM120,000 advance − RM1,800 fee = RM28,200 to the owner (SPEC §4)
        expect(rest - (before?.treasury ?? 0n)).toBe(senToUnits(sen(2_820_000)));
        expect((await chain.getPool()).outstanding).toBe(0n);
      });

      it("refunds a payment below advance + fee with no error, and settles nothing", async () => {
        const { chain, owner, fixtures } = await setup();
        const k = key(fixtures, "INV-2026-1043");
        await chain.requestAdvance(owner, k, advanceUnits(fixtures, "INV-2026-1043"));
        const poolBefore = await chain.getPool();
        const escrow: Signer = {
          role: "settler",
          accountId: homerollAccounts(fixtures.root).escrow,
        };
        const result = await chain.settleInvoice(escrow, k, senToUnits(sen(12_000_000)));
        expect(result.ok && result.value).toEqual({ settled: false });
        expect((await chain.getInvoice(k))?.status).toBe("Advanced");
        expect(await chain.getPool()).toEqual(poolBefore);
      });

      it("refunds settlement of an invoice that was never advanced", async () => {
        const { chain, fixtures } = await setup();
        const escrow: Signer = {
          role: "settler",
          accountId: homerollAccounts(fixtures.root).escrow,
        };
        const k = key(fixtures, "INV-2026-1043");
        const result = await chain.settleInvoice(escrow, k, senToUnits(sen(15_000_000)));
        expect(result.ok && result.value).toEqual({ settled: false });
        expect((await chain.getInvoice(k))?.status).toBe("Attested");
      });

      it("only lets settlers settle (R10)", async () => {
        const { chain, owner, fixtures } = await setup();
        const k = key(fixtures, "INV-2026-1043");
        expectFailureText(await chain.settleInvoice(owner, k, units(1n)), "ERR_NOT_SETTLER");
      });
    });

    describe("request_advance", () => {
      it("moves cash from the pool to the employer's treasury (R8)", async () => {
        const { chain, owner, employer, fixtures } = await setup();
        const amount = advanceUnits(fixtures, "INV-2026-1047");
        const before = await chain.getEmployer(employer);
        const poolBefore = await chain.getPool();
        const result = await chain.requestAdvance(owner, key(fixtures, "INV-2026-1047"), amount);
        expect(result.ok && result.value.status).toBe("Advanced");
        expect((await chain.getEmployer(employer))?.treasury).toBe(
          (before?.treasury ?? 0n) + amount,
        );
        expect((await chain.getPool()).cash).toBe(poolBefore.cash - amount);
      });

      it("rejects an advance above the grade cap (R8)", async () => {
        const { chain, owner, fixtures } = await setup();
        const tooMuch = units(advanceUnits(fixtures, "INV-2026-1047") + 1_000_000n);
        expectFailureText(
          await chain.requestAdvance(owner, key(fixtures, "INV-2026-1047"), tooMuch),
          "ERR_ADVANCE_ABOVE_CAP",
        );
      });

      it("answers ERR_NOT_EMPLOYER for an invoice not in the registry", async () => {
        const { chain, owner } = await setup();
        expectFailureText(
          await chain.requestAdvance(owner, "ff".repeat(32), units(1n)),
          "ERR_NOT_EMPLOYER",
        );
      });

      it("checks invoice status before the caller, as the pool does", async () => {
        const { chain, owner, fixtures } = await setup();
        const k = key(fixtures, "INV-2026-1043");
        const amount = advanceUnits(fixtures, "INV-2026-1043");
        await chain.requestAdvance(owner, k, amount);
        const stranger: Signer = { role: "owner", accountId: `stranger.${fixtures.root}` };
        expectFailureText(
          await chain.requestAdvance(stranger, k, amount),
          "ERR_INVOICE_ALREADY_REGISTERED",
        );
      });

      it("gives one invoice one advance (R7)", async () => {
        const { chain, owner, fixtures } = await setup();
        const amount = advanceUnits(fixtures, "INV-2026-1043");
        expect((await chain.requestAdvance(owner, key(fixtures, "INV-2026-1043"), amount)).ok).toBe(
          true,
        );
        expectFailureText(
          await chain.requestAdvance(owner, key(fixtures, "INV-2026-1043"), amount),
          "ERR_INVOICE_ALREADY_REGISTERED",
        );
      });

      it("refuses the payroll agent's key at the protocol, before the pool runs", async () => {
        const { chain, agent, fixtures } = await setup();
        const result = await chain.requestAdvance(
          agent,
          key(fixtures, "INV-2026-1043"),
          advanceUnits(fixtures, "INV-2026-1043"),
        );
        expect(!result.ok && result.failure).toEqual({
          kind: "protocol",
          name: "ReceiverMismatch",
        });
      });
    });

    describe("lender deposit (SPEC §8.9)", () => {
      const lenderSigner = (accountId: string): Signer => ({ role: "lender", accountId });

      it("mints shares at current NAV for tUSDC the solver delivered", async () => {
        const { chain, fixtures } = await setup();
        const lender = fixtures.lender.accountId;
        const amount = units(1_000_000_000n);
        const pool = await chain.getPool();
        const before = (await chain.getLender(lender))?.shares ?? 0n;

        expect((await chain.deliverFromSolver(lender, amount)).ok).toBe(true);
        expect(await chain.ftBalanceOf(lender)).toBe(amount);
        const result = await chain.depositToPool(lenderSigner(lender), amount);

        const minted = (amount * pool.totalShares) / (pool.cash + pool.outstanding);
        expect(result.ok && result.value.shares).toBe(minted);
        expect((await chain.getLender(lender))?.shares).toBe(before + minted);
        expect((await chain.getPool()).cash).toBe(pool.cash + amount);
        expect(await chain.ftBalanceOf(lender)).toBe(0n);
      });

      it("refuses a new lender's first deposit below the floor and keeps their tUSDC (R15)", async () => {
        const { chain, fixtures } = await setup();
        const newcomer = `l-zz0001.${fixtures.root}`;
        const { minFirstDeposit, cash } = await chain.getPool();
        const short = units(minFirstDeposit - 1n);
        await chain.deliverFromSolver(newcomer, short);

        const result = await chain.depositToPool(lenderSigner(newcomer), short);
        expectFailureText(result, "ERR_DEPOSIT_TOO_SMALL");
        expect(await chain.getLender(newcomer)).toBeNull();
        expect(await chain.ftBalanceOf(newcomer)).toBe(short);
        expect((await chain.getPool()).cash).toBe(cash);
      });

      it("makes a new lender of a first deposit at the floor (R15)", async () => {
        const { chain, fixtures } = await setup();
        const newcomer = `l-zz0002.${fixtures.root}`;
        const { minFirstDeposit } = await chain.getPool();
        await chain.deliverFromSolver(newcomer, minFirstDeposit);
        const result = await chain.depositToPool(lenderSigner(newcomer), minFirstDeposit);
        expect(result.ok && result.value.shares > 0n).toBe(true);
        expect((await chain.getLender(newcomer))?.shares).toBeGreaterThan(0n);
      });
    });

    it("resets to the fixtures", async () => {
      const { chain, owner, employer, fixtures } = await setup();
      await chain.requestAdvance(
        owner,
        key(fixtures, "INV-2026-1043"),
        advanceUnits(fixtures, "INV-2026-1043"),
      );
      await chain.resetDemo();
      // A fresh demo company starts with an empty registry: the invoice agent attests again.
      expect(await chain.getInvoice(key(fixtures, "INV-2026-1043"))).toBeNull();
      expect((await chain.getEmployer(employer))?.treasury).toBe(
        senToUnits(sen(fixtures.company.treasurySen)),
      );
    });
  });
}
