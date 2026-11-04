import { loadFixtures } from "@homeroll/fixtures";
import { describe, expect, it } from "vitest";
import { createActivityLog } from "@/lib/activity";
import { sen, senToUnits } from "@/lib/fx";
import { period } from "@/lib/near/client";
import { attestFixtureInvoices, key } from "@/lib/near/client.suite";
import { FakeChainClient } from "@/lib/near/fake";
import { proposePayroll } from "./payroll";

const NOW = Date.UTC(2026, 10, 4);
const OCT = period("2026-10");

async function make() {
  const fixtures = loadFixtures("homeroll-test.testnet");
  let now = NOW;
  const chain = new FakeChainClient({
    fixtures,
    now: () => now,
    activity: createActivityLog(),
  });
  const employer = fixtures.company.accountId;
  const owner = { role: "owner", accountId: employer } as const;
  const agent = { role: "payrollAgent", accountId: employer } as const;
  await attestFixtureInvoices(chain, fixtures);
  await chain.requestAdvance(owner, key(fixtures, "INV-2026-1043"), senToUnits(sen(12_000_000)));
  return { fixtures, chain, owner, agent, tick: (ms: number) => (now += ms) };
}

describe("payroll agent proposal (SPEC §8.2)", () => {
  it("proposes all 40 lines, RM78,000, on a fresh company", async () => {
    const { chain, fixtures } = await make();
    const p = await proposePayroll(chain, fixtures, OCT, NOW);
    expect(p.lines).toHaveLength(40);
    expect(p.remainingSen).toBe(7_800_000);
    expect(p.excluded).toEqual([]);
  });

  it("leaves out a removed worker, and the other 39 still run", async () => {
    const { chain, fixtures, owner, agent } = await make();
    const kyaw = fixtures.workers[3]?.accountId ?? "";
    await chain.removePayee(owner, kyaw);
    const p = await proposePayroll(chain, fixtures, OCT, NOW);
    expect(p.lines).toHaveLength(39);
    expect(p.excluded).toEqual([{ accountId: kyaw, reason: "not-a-payee" }]);
    expect((await chain.submitRun(agent, OCT, p.lines)).ok).toBe(true);
  });

  it("proposes only unpaid lines after a run was cancelled part way", async () => {
    const { chain, fixtures, owner, agent } = await make();
    const first = await proposePayroll(chain, fixtures, OCT, NOW);
    const run = await chain.submitRun(agent, OCT, first.lines);
    if (!run.ok) throw new Error("submit_run failed");
    await chain.payRun(agent, run.value.runId);
    await chain.cancelRun(owner, run.value.runId);
    const next = await proposePayroll(chain, fixtures, OCT, NOW);
    expect(next.held).toHaveLength(36);
    expect(next.lines).toHaveLength(4);
    expect((await chain.submitRun(agent, OCT, next.lines)).ok).toBe(true);
  });

  it("holds a re-added worker for 48 hours, then pays the missed wage (R3)", async () => {
    const { chain, fixtures, owner, agent, tick } = await make();
    const kyaw = fixtures.workers[3];
    if (!kyaw) throw new Error("no Kyaw");
    await chain.removePayee(owner, kyaw.accountId);
    const first = await proposePayroll(chain, fixtures, OCT, NOW);
    const run = await chain.submitRun(agent, OCT, first.lines);
    if (!run.ok) throw new Error("submit_run failed");
    await chain.addPayee(owner, kyaw.accountId, senToUnits(sen(kyaw.capSen)));

    const during = await proposePayroll(chain, fixtures, OCT, NOW);
    expect(during.excluded).toEqual([{ accountId: kyaw.accountId, reason: "on-hold" }]);

    const later = tick(48 * 60 * 60 * 1000);
    const after = await proposePayroll(chain, fixtures, OCT, later);
    expect(after.lines.map((l) => l.accountId)).toEqual([kyaw.accountId]);
    expect((await chain.submitRun(agent, OCT, after.lines)).ok).toBe(true);
  });
});
