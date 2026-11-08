import { loadFixtures } from "@homeroll/fixtures";
import { describe, expect, it } from "vitest";
import { createActivityLog } from "@/lib/activity";
import { FAKE_CHAIN_SEED } from "@/lib/demo-keys";
import { sen, senToUnits } from "@/lib/fx";
import { deriveKey } from "@/lib/keys";
import { period, type Signer } from "@/lib/near/client";
import { FakeChainClient } from "@/lib/near/fake";
import { toPayLines } from "@/lib/payroll";
import { createMemoryRowStore } from "@/lib/store/rows";
import {
  approvePayout,
  MOCK_VERIFIER,
  MockConfidentialRail,
  openApproval,
  PayoutStore,
  sealApproval,
} from "./index";
import { type Nep413Payload, newNonce, signNep413 } from "./nep413";

const ROOT = "homeroll-test.testnet";
// 3 Nov 2026, UTC: October is open (R14).
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const OCT = period("2026-10");

async function setup() {
  const fixtures = loadFixtures(ROOT);
  const clock = { now: NOW };
  const chain = new FakeChainClient({
    fixtures,
    now: () => clock.now,
    activity: createActivityLog(),
  });
  const employer = fixtures.company.accountId;
  const owner: Signer = { role: "owner", accountId: employer };
  // Four lines fit the starting treasury without an invoice advance
  const lines = toPayLines(fixtures.timesheet.slice(0, 4));
  const submitted = await chain.submitRun(owner, OCT, lines);
  if (!submitted.ok) throw new Error("fixture run refused");
  const rail = new MockConfidentialRail({
    chain,
    root: ROOT,
    store: new PayoutStore(),
    now: () => clock.now,
  });
  const run = { employer, period: OCT, runId: submitted.value.runId };
  const ownerKey = deriveKey(FAKE_CHAIN_SEED, employer, "owner");
  const agentKey = deriveKey(FAKE_CHAIN_SEED, employer, "payrollAgent");
  const signAs = (key: { secretKey: string }) => (payload: Nep413Payload) =>
    signNep413(employer, key.secretKey, payload);

  /** Quote and generate, as the owner's approval does, and return the payload to sign. */
  async function generated() {
    const quote = await rail.quote(run);
    if (!quote.ok) throw new Error(quote.refusal);
    const intent = await rail.generateIntent({
      type: "swap_transfer",
      standard: "nep413",
      signerId: employer,
      depositAddress: quote.value.quote.depositAddress,
    });
    if (!intent.ok) throw new Error(intent.refusal);
    return {
      depositAddress: quote.value.quote.depositAddress,
      payload: intent.value.intent.payload,
    };
  }
  const submit = (signedData: Awaited<ReturnType<ReturnType<typeof signAs>>>) =>
    rail.submitIntent({ type: "swap_transfer", signedData });

  return {
    fixtures,
    chain,
    clock,
    rail,
    run,
    owner,
    ownerKey,
    agentKey,
    signAs,
    generated,
    submit,
  };
}

/** Rahim's line points somewhere else: the agent's tampering in attack 06. */
function swapRahim(payload: Nep413Payload, rahim: string): Nep413Payload {
  return { ...payload, message: payload.message.replace(rahim, "rahim-wallet.testnet") };
}

describe("payout rail (SPEC §8.11)", () => {
  it("quotes the contract's reserved lines as one transfer intent each, with 1Click field names", async () => {
    const { rail, run, generated, fixtures } = await setup();
    const { depositAddress, payload } = await generated();
    expect(depositAddress).toMatch(/^mock:[0-9a-f]{40}$/);
    expect(payload.recipient).toBe(MOCK_VERIFIER);
    expect(Buffer.from(payload.nonce, "base64")).toHaveLength(32);
    const message = JSON.parse(payload.message);
    expect(message.signer_id).toBe(run.employer);
    expect(message.intents).toHaveLength(4);
    expect(message.intents[0]).toEqual({
      intent: "transfer",
      receiver_id: fixtures.workers[0]?.accountId,
      tokens: { [`nep141:tusdc.${ROOT}`]: senToUnits(sen(195_000)).toString() },
      memo: "payroll 2026-10",
    });
    const status = await rail.status(depositAddress);
    expect(status.ok && status.value).toMatchObject({
      mock: true,
      testnetOnly: true,
      status: "PENDING_DEPOSIT",
    });
  });

  it("pays the run only after the owner's signed approval, then reports SUCCESS with the hashes", async () => {
    const { rail, run, owner, ownerKey, signAs, chain, fixtures } = await setup();
    expect(rail.approvedPayout(run)).toBeNull();
    const approved = await approvePayout(rail, run, signAs(ownerKey));
    if (!approved.ok) throw new Error(approved.refusal);
    const { approval } = approved.value;
    const { depositAddress } = approval;
    expect(rail.approvedPayout(run)).toBe(depositAddress);

    for (;;) {
      const batch = await rail.execute(approval, owner);
      if (!batch.ok || !batch.value.ok) throw new Error("execute failed");
      if (batch.value.value.status !== "Pending") break;
    }
    const status = await rail.status(depositAddress);
    expect(status.ok && status.value.status).toBe("SUCCESS");
    expect(status.ok && status.value.swapDetails.nearTxHashes).toHaveLength(1);
    expect(status.ok && status.value.swapDetails.intentHashes).toEqual([approval.intentHash]);
    const rahim = fixtures.workers[0]?.accountId ?? "";
    expect(await chain.ftBalanceOf(rahim)).toBe(senToUnits(sen(195_000)));
    expect(rail.approvedPayout(run)).toBeNull();
  });

  it("pays only as the employer whose owner approved", async () => {
    const { rail, run, ownerKey, signAs } = await setup();
    const approved = await approvePayout(rail, run, signAs(ownerKey));
    if (!approved.ok) throw new Error(approved.refusal);
    const stranger: Signer = { role: "owner", accountId: `someone.${ROOT}` };
    expect(await rail.execute(approved.value.approval, stranger)).toEqual({
      ok: false,
      refusal: "not-approved",
    });
  });

  it("reuses an accepted, unfinished approval instead of asking the owner again", async () => {
    const { rail, run, ownerKey, signAs } = await setup();
    const first = await approvePayout(rail, run, signAs(ownerKey));
    const again = await approvePayout(rail, run, async () => {
      throw new Error("the owner was asked to sign twice");
    });
    expect(again.ok && again.value.reused).toBe(true);
    expect(again.ok && first.ok && again.value.approval.intentHash).toBe(
      first.ok ? first.value.approval.intentHash : "",
    );
  });

  it("refuses to quote a run with nothing reserved", async () => {
    const { rail, run } = await setup();
    expect(await rail.quote({ ...run, runId: 9 })).toEqual({
      ok: false,
      refusal: "run-not-pending",
    });
  });

  it("generates only for the run's own employer", async () => {
    const { rail, run } = await setup();
    const quote = await rail.quote(run);
    if (!quote.ok) throw new Error(quote.refusal);
    const result = await rail.generateIntent({
      type: "swap_transfer",
      standard: "nep413",
      signerId: `someone.${ROOT}`,
      depositAddress: quote.value.quote.depositAddress,
    });
    expect(result).toEqual({ ok: false, refusal: "signer-mismatch" });
  });
});

describe("R17: the payout intent checks", () => {
  it("R17.1: refuses an intent with a nonce this rail never issued", async () => {
    const { generated, signAs, ownerKey, submit } = await setup();
    const { payload } = await generated();
    const signed = await signAs(ownerKey)({
      ...payload,
      nonce: newNonce(() => new Uint8Array(32).fill(9)),
    });
    expect(await submit(signed)).toEqual({ ok: false, refusal: "unknown-intent" });
  });

  it("R17.2: accepts a signed intent once; a replay is refused", async () => {
    const { generated, signAs, ownerKey, submit } = await setup();
    const signed = await signAs(ownerKey)((await generated()).payload);
    expect((await submit(signed)).ok).toBe(true);
    expect(await submit(signed)).toEqual({ ok: false, refusal: "nonce-used" });
  });

  it("R17.3: refuses an intent after its 10-minute deadline", async () => {
    const { generated, signAs, ownerKey, submit, clock } = await setup();
    const signed = await signAs(ownerKey)((await generated()).payload);
    clock.now += 10 * 60_000 + 1;
    expect(await submit(signed)).toEqual({ ok: false, refusal: "deadline-passed" });
  });

  it("R17.4: refuses a payload changed after the owner signed it", async () => {
    const { generated, signAs, ownerKey, submit, fixtures } = await setup();
    const signed = await signAs(ownerKey)((await generated()).payload);
    const tampered = {
      ...signed,
      payload: swapRahim(signed.payload, fixtures.workers[0]?.accountId ?? ""),
    };
    expect(await submit(tampered)).toEqual({ ok: false, refusal: "bad-signature" });
  });

  it("R17.5: refuses the payroll agent's function-call key, and any key not on the account", async () => {
    const { generated, signAs, agentKey, submit, run } = await setup();
    const { payload } = await generated();
    expect(await submit(await signAs(agentKey)(payload))).toEqual({
      ok: false,
      refusal: "not-owner-key",
    });
    const stranger = deriveKey(FAKE_CHAIN_SEED, `stranger.${ROOT}`, "owner");
    expect(await submit(await signNep413(run.employer, stranger.secretKey, payload))).toEqual({
      ok: false,
      refusal: "not-owner-key",
    });
  });

  it("R17.6: refuses a payload the owner signed that is not the one generated", async () => {
    const { generated, signAs, ownerKey, submit, fixtures } = await setup();
    const { payload } = await generated();
    const resigned = await signAs(ownerKey)(
      swapRahim(payload, fixtures.workers[0]?.accountId ?? ""),
    );
    expect(await submit(resigned)).toEqual({ ok: false, refusal: "payload-changed" });
  });

  it("R17.7: refuses an intent once the contract's reserved lines have changed", async () => {
    const { generated, signAs, ownerKey, submit, chain, owner, run } = await setup();
    const signed = await signAs(ownerKey)((await generated()).payload);
    await chain.cancelRun(owner, run.runId);
    expect(await submit(signed)).toEqual({ ok: false, refusal: "run-changed" });
  });

  it("refuses malformed signed data", async () => {
    const { rail } = await setup();
    expect(
      await rail.submitIntent({ type: "swap_transfer", signedData: { standard: "x" } as never }),
    ).toEqual({
      ok: false,
      refusal: "unknown-intent",
    });
  });
});

describe("approval tokens: the accepted intent between requests (SPEC §8.11)", () => {
  const secret = new Uint8Array(32).fill(1);
  async function approved() {
    const ctx = await setup();
    const result = await approvePayout(ctx.rail, ctx.run, ctx.signAs(ctx.ownerKey));
    if (!result.ok) throw new Error(result.refusal);
    return { ...ctx, approval: result.value.approval };
  }

  it("opens what this server sealed, until it expires", async () => {
    const { approval } = await approved();
    const token = sealApproval(approval, secret);
    expect(openApproval(token, secret, NOW)).toEqual(approval);
    expect(openApproval(token, secret, approval.expiresAt + 1)).toBeNull();
  });

  it("refuses a token sealed with another secret, a changed run id, or garbage", async () => {
    const { approval } = await approved();
    const token = sealApproval(approval, secret);
    expect(openApproval(token, new Uint8Array(32).fill(2), NOW)).toBeNull();
    const [body, seal] = token.split(".");
    const changed = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body ?? "", "base64url").toString()), runId: 7 }),
    ).toString("base64url");
    expect(openApproval(`${changed}.${seal}`, secret, NOW)).toBeNull();
    for (const junk of [null, 42, "", "a.b", `${token}.x`, "x".repeat(3_000)]) {
      expect(openApproval(junk, secret, NOW)).toBeNull();
    }
  });

  it("lets another server instance, with no memory of the quote, pay the approved run", async () => {
    const { chain, run, owner, approval } = await approved();
    const token = sealApproval(approval, secret);
    // A second instance: same chain and secret, empty store
    const elsewhere = new MockConfidentialRail({
      chain,
      root: ROOT,
      store: new PayoutStore(),
      now: () => NOW,
    });
    const opened = openApproval(token, secret, NOW);
    if (!opened) throw new Error("token did not open");
    const batch = await elsewhere.execute(opened, owner);
    expect(batch.ok && batch.value.ok && batch.value.value.status).toBe("Done");
    expect((await chain.getRuns(run.employer, run.period))?.[0]?.status).toBe("Done");
  });
});

describe("a shared payout store: several server instances (Vercel)", () => {
  async function twoInstances() {
    const base = await setup();
    const shared = createMemoryRowStore();
    const instance = () => {
      const store = new PayoutStore(shared, () => base.run.employer);
      const rail = new MockConfidentialRail({
        chain: base.chain,
        root: ROOT,
        store,
        now: () => NOW,
      });
      return { store, rail };
    };
    const a = instance();
    const quote = await a.rail.quote(base.run);
    if (!quote.ok) throw new Error(quote.refusal);
    const { depositAddress } = quote.value.quote;
    const intent = await a.rail.generateIntent({
      type: "swap_transfer",
      standard: "nep413",
      signerId: base.run.employer,
      depositAddress,
    });
    if (!intent.ok) throw new Error(intent.refusal);
    const signed = await base.signAs(base.ownerKey)(intent.value.intent.payload);
    return { ...base, instance, a, depositAddress, signed };
  }

  it("an approval accepted on one instance shows on another, and its replay is refused there", async () => {
    const { instance, a, depositAddress, signed } = await twoInstances();
    expect((await a.rail.submitIntent({ type: "swap_transfer", signedData: signed })).ok).toBe(
      true,
    );
    const b = instance();
    await b.store.load();
    const status = await b.rail.status(depositAddress);
    expect(status.ok && status.value.status).toBe("PROCESSING");
    expect(await b.rail.submitIntent({ type: "swap_transfer", signedData: signed })).toEqual({
      ok: false,
      refusal: "nonce-used",
    });
  });

  it("R17.2: two instances accepting the same signed intent at once, exactly one wins", async () => {
    const { instance, signed } = await twoInstances();
    const b = instance();
    const c = instance();
    await Promise.all([b.store.load(), c.store.load()]);
    const results = await Promise.all(
      [b, c].map((x) => x.rail.submitIntent({ type: "swap_transfer", signedData: signed })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, refusal: "nonce-used" }]);
  });
});
