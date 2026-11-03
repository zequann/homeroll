import type { Fixtures } from "@homeroll/fixtures";
import { describe, expect, it } from "vitest";
import { sen, senToUnits, units } from "@/lib/fx";
import { toPayLines } from "@/lib/payroll";
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

export const advanceUnits = (f: Fixtures, number: string) => {
  const invoice = f.invoices.find((i) => i.number === number);
  if (!invoice) throw new Error(`No fixture invoice ${number}`);
  return senToUnits(sen(Math.floor((invoice.amountSen * invoice.advanceBps) / 10_000)));
};

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
      expect((await chain.getInvoice("INV-2026-1043"))?.status).toBe("Attested");
      expect((await chain.getInvoice("INV-2026-1050"))?.status).toBe("Declined");
    });

    describe("submit_run", () => {
      it("accepts a valid run, reserves its total and returns run 0 (R3, R4, R5, R6)", async () => {
        const { chain, owner, agent, employer, openPeriod, lines, fixtures } = await setup();
        await chain.requestAdvance(owner, "INV-2026-1043", advanceUnits(fixtures, "INV-2026-1043"));
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
        await chain.requestAdvance(owner, "INV-2026-1043", advanceUnits(fixtures, "INV-2026-1043"));
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
        await chain.requestAdvance(owner, "INV-2026-1043", advanceUnits(fixtures, "INV-2026-1043"));
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

    describe("request_advance", () => {
      it("moves cash from the pool to the employer's treasury (R8)", async () => {
        const { chain, owner, employer, fixtures } = await setup();
        const amount = advanceUnits(fixtures, "INV-2026-1047");
        const before = await chain.getEmployer(employer);
        const poolBefore = await chain.getPool();
        const result = await chain.requestAdvance(owner, "INV-2026-1047", amount);
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
          await chain.requestAdvance(owner, "INV-2026-1047", tooMuch),
          "ERR_ADVANCE_ABOVE_CAP",
        );
      });

      it("gives one invoice one advance (R7)", async () => {
        const { chain, owner, fixtures } = await setup();
        const amount = advanceUnits(fixtures, "INV-2026-1043");
        expect((await chain.requestAdvance(owner, "INV-2026-1043", amount)).ok).toBe(true);
        expectFailureText(
          await chain.requestAdvance(owner, "INV-2026-1043", amount),
          "ERR_INVOICE_ALREADY_REGISTERED",
        );
      });

      it("refuses the payroll agent's key at the protocol, before the pool runs", async () => {
        const { chain, agent, fixtures } = await setup();
        const result = await chain.requestAdvance(
          agent,
          "INV-2026-1043",
          advanceUnits(fixtures, "INV-2026-1043"),
        );
        expect(!result.ok && result.failure).toEqual({
          kind: "protocol",
          name: "ReceiverMismatch",
        });
      });
    });

    it("resets to the fixtures", async () => {
      const { chain, owner, employer, fixtures } = await setup();
      await chain.requestAdvance(owner, "INV-2026-1043", advanceUnits(fixtures, "INV-2026-1043"));
      await chain.resetDemo();
      expect((await chain.getInvoice("INV-2026-1043"))?.status).toBe("Attested");
      expect((await chain.getEmployer(employer))?.treasury).toBe(
        senToUnits(sen(fixtures.company.treasurySen)),
      );
    });
  });
}
