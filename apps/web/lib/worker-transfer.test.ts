import { loadFixtures } from "@homeroll/fixtures";
import { homerollAccounts } from "@homeroll/shared";
import { describe, expect, it } from "vitest";
import { createActivityLog } from "@/lib/activity";
import { sen, senToUnits, units } from "@/lib/fx";
import { attestFixtureInvoices, key } from "@/lib/near/client.suite";
import { FakeChainClient } from "@/lib/near/fake";
import { toPayLines } from "@/lib/payroll";
import { period } from "./near/client";
import { createFakeRelayState, fakeChainTransfer } from "./worker-transfer";

const ROOT = "homeroll-test.testnet";
const accounts = homerollAccounts(ROOT);
const rm = (r: number) => senToUnits(sen(r * 100));

/** Rahim with his October wage, paid the way the demo pays it. */
async function paidRahim() {
  const fixtures = loadFixtures(ROOT);
  const chain = new FakeChainClient({
    fixtures,
    now: () => Date.UTC(2026, 10, 3),
    activity: createActivityLog(),
  });
  const employer = fixtures.company.accountId;
  await attestFixtureInvoices(chain, fixtures);
  await chain.requestAdvance(
    { role: "owner", accountId: employer },
    key(fixtures, "INV-2026-1043"),
    rm(120_000),
  );
  const agent = { role: "payrollAgent", accountId: employer } as const;
  const run = await chain.submitRun(agent, period("2026-10"), toPayLines(fixtures.timesheet));
  if (!run.ok) throw new Error("run was rejected");
  await chain.payRun(agent, run.value.runId);
  const rahim = fixtures.workers[0]?.accountId;
  if (!rahim) throw new Error("no Rahim");
  return { chain, rahim, state: createFakeRelayState() };
}

describe("fake-chain transfers go through the real relayer policy", () => {
  it("sends Rahim's RM800 home and moves the tokens", async () => {
    const { chain, rahim, state } = await paidRahim();
    const before = await chain.ftBalanceOf(rahim);
    const result = await fakeChainTransfer(
      chain,
      accounts,
      state,
      rahim,
      accounts.payout,
      rm(800),
      "send-home",
    );
    expect(result.ok).toBe(true);
    expect(before - (await chain.ftBalanceOf(rahim))).toBe(rm(800));
  });

  it("uses a fresh nonce, so two equal transfers both land", async () => {
    const { chain, rahim, state } = await paidRahim();
    for (const _ of [1, 2]) {
      const r = await fakeChainTransfer(
        chain,
        accounts,
        state,
        rahim,
        accounts.offramp,
        rm(100),
        "cash-out",
      );
      expect(r.ok).toBe(true);
    }
    expect(await chain.ftBalanceOf(rahim)).toBe(rm(1_950) - 2n * rm(100));
  });

  it("refuses more than RM2,000 at once and moves nothing (rule 6)", async () => {
    const { chain, rahim, state } = await paidRahim();
    const before = await chain.ftBalanceOf(rahim);
    const result = await fakeChainTransfer(
      chain,
      accounts,
      state,
      rahim,
      accounts.payout,
      rm(2_001),
      "send-home",
    );
    expect(result).toMatchObject({ ok: false, rule: "amount_cap" });
    expect(await chain.ftBalanceOf(rahim)).toBe(before);
  });

  it("refuses any destination but payout and offramp (rule 5)", async () => {
    const { chain, rahim, state } = await paidRahim();
    const result = await fakeChainTransfer(
      chain,
      accounts,
      state,
      rahim,
      "attacker.testnet",
      units(1n),
      "x",
    );
    expect(result).toMatchObject({ ok: false, rule: "token_receiver" });
  });

  it("refuses a sender that is not a worker account (rule 7)", async () => {
    const { chain, state } = await paidRahim();
    const result = await fakeChainTransfer(
      chain,
      accounts,
      state,
      `stranger.${ROOT}`,
      accounts.payout,
      units(1n),
      "x",
    );
    expect(result).toMatchObject({ ok: false, rule: "known_worker" });
  });
});
