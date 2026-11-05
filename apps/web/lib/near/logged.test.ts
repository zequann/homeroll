import { homerollAccounts } from "@homeroll/shared";
import { describe, expect, it, vi } from "vitest";
import { createActivityLog } from "@/lib/activity";
import { units } from "@/lib/fx";
import type { ChainClient, Signer } from "./client";
import { withActivityLog } from "./logged";

const accounts = homerollAccounts("homeroll-test.testnet");
const signer: Signer = { role: "payrollAgent", accountId: `perabotjaya.${accounts.root}` };

function make(inner: Partial<ChainClient>) {
  const log = createActivityLog();
  return { log, chain: withActivityLog(inner as ChainClient, accounts, log, () => 7) };
}

describe("activity log around a chain client (SPEC §9.1)", () => {
  it("records a successful call with its hash", async () => {
    const { chain, log } = make({
      payRun: vi.fn(async () => ({ ok: true, txHash: "abc", value: {} })) as never,
    });
    await chain.payRun(signer, 0);
    expect(log.list()[0]).toMatchObject({
      method: "pay_run",
      to: accounts.payroll,
      txHash: "abc",
      failure: null,
      at: 7,
    });
  });

  it("records a rejection with the exact error, and still returns it", async () => {
    const failure = { kind: "contract", error: { code: "ERR_RUN_COMPLETE" } } as const;
    const { chain, log } = make({
      payRun: vi.fn(async () => ({ ok: false, txHash: null, failure })) as never,
    });
    const result = await chain.payRun(signer, 0);
    expect(result.ok).toBe(false);
    expect(log.list()[0]?.failure).toBe("ERR_RUN_COMPLETE");
  });

  it("records a call that throws, then rethrows it", async () => {
    const { chain, log } = make({
      ftTransfer: vi.fn(async () => {
        throw new Error('relay rejected: {"rule":"amount_cap"}');
      }) as never,
    });
    await expect(chain.ftTransfer(signer, accounts.payout, units(5n), "m")).rejects.toThrow(
      "relay",
    );
    expect(log.list()[0]).toMatchObject({ method: "ft_transfer", to: accounts.payout, amount: 5n });
  });

  it("leaves views alone", async () => {
    const getPool = vi.fn(async () => ({
      cash: units(1n),
      outstanding: units(0n),
      feesEarned: units(0n),
    }));
    const { chain, log } = make({ getPool });
    await chain.getPool();
    expect(getPool).toHaveBeenCalled();
    expect(log.list()).toEqual([]);
  });
});
