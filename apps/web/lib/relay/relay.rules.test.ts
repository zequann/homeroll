import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homerollAccounts, workerAccountId } from "@homeroll/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sen, senToUnits, unitsToSen } from "../fx";
import { deriveKey, type RelayerSigner } from "../keys";
import type { SignedDelegate } from "../near/rpc";
import { blobId, ExposureLog, type UtcDay, utcDay } from "./exposure";
import { type RelayDeps, type RuleName, relay } from "./relay";

const ROOT = "homeroll.testnet";
const accounts = homerollAccounts(ROOT);
const WORKER = workerAccountId("w-7k2q9x", ROOT);
const SEED = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const decodeRegistry = new Map<string, ReturnType<typeof makeDecoded>>();

function keyForRaw(raw: Uint8Array): string {
  return Buffer.from(raw).toString("hex");
}

function makeDecoded(partial: Partial<SignedDelegate> & { raw: Uint8Array }) {
  const defaults: SignedDelegate = {
    signatureOk: true,
    senderId: WORKER,
    receiverId: accounts.tusdc,
    actions: [
      {
        kind: "functionCall",
        method: "ft_transfer",
        args: new TextEncoder().encode(
          JSON.stringify({ receiver_id: accounts.payout, amount: "1000000" }),
        ),
        gas: 15n * 1_000_000_000_000n,
        depositYocto: 1n,
      },
    ],
    nonce: 10n,
    maxBlockHeight: 2000n,
    publicKey: deriveKey(SEED, WORKER, "worker").publicKey,
    raw: partial.raw,
  };
  return { ok: true as const, delegate: { ...defaults, ...partial, raw: partial.raw } };
}

vi.mock("../near/rpc.js", () => ({
  decodeSignedDelegate: (bytes: Uint8Array) =>
    decodeRegistry.get(keyForRaw(bytes)) ?? { ok: false, reason: "malformed" },
}));

describe("relay policy", () => {
  let exposure: ExposureLog;
  let submit: ReturnType<typeof vi.fn>;
  let deps: RelayDeps;
  let relayer: RelayerSigner;

  beforeEach(async () => {
    decodeRegistry.clear();
    exposure = ExposureLog.memory();
    relayer = deriveKey(SEED, accounts.relayer, "relayer");
    submit = vi.fn(async (payable: { raw: Uint8Array }) => ({
      txHash: `hash-${keyForRaw(payable.raw).slice(0, 8)}`,
    }));
    deps = {
      accounts,
      now: () => new Date("2026-11-04T12:00:00.000Z"),
      blockHeight: async () => 1000n,
      accessKey: async () => ({ nonce: 5n, permission: "FullAccess" }),
      exposure,
      relayer,
      submit: submit as RelayDeps["submit"],
    };
  });

  function register(partial: Partial<SignedDelegate> & { raw: Uint8Array }) {
    decodeRegistry.set(keyForRaw(partial.raw), makeDecoded(partial));
    return Buffer.from(partial.raw).toString("base64");
  }

  async function refuse(
    rule: RuleName,
    partial: Partial<SignedDelegate> & { raw: Uint8Array },
    useDeps: RelayDeps = deps,
  ) {
    const body = register(partial);
    const result = await relay(body, useDeps);
    expect(result).toEqual({ status: 403, body: { rule } });
    expect(submit).not.toHaveBeenCalled();
  }

  it("refuses malformed base64 as one_action", async () => {
    const result = await relay("%%%", deps);
    expect(result).toEqual({ status: 403, body: { rule: "one_action" } });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses one_action when decode is malformed", async () => {
    const raw = new Uint8Array([9, 9, 9]);
    const result = await relay(Buffer.from(raw).toString("base64"), deps);
    expect(result).toEqual({ status: 403, body: { rule: "one_action" } });
  });

  it("refuses receiver_and_method", async () => {
    const raw = new Uint8Array([1]);
    await refuse("receiver_and_method", { raw, receiverId: accounts.pool });
  });

  it("refuses deposit_yocto", async () => {
    const raw = new Uint8Array([2]);
    await refuse("deposit_yocto", {
      raw,
      actions: [
        {
          kind: "functionCall",
          method: "ft_transfer",
          args: new TextEncoder().encode(
            JSON.stringify({ receiver_id: accounts.payout, amount: "1" }),
          ),
          gas: 1n,
          depositYocto: 2n,
        },
      ],
    });
  });

  it("refuses prepaid_gas", async () => {
    const raw = new Uint8Array([3]);
    await refuse("prepaid_gas", {
      raw,
      actions: [
        {
          kind: "functionCall",
          method: "ft_transfer",
          args: new TextEncoder().encode(
            JSON.stringify({ receiver_id: accounts.payout, amount: "1" }),
          ),
          gas: 31n * 1_000_000_000_000n,
          depositYocto: 1n,
        },
      ],
    });
  });

  it("refuses token_receiver", async () => {
    const raw = new Uint8Array([4]);
    await refuse("token_receiver", {
      raw,
      actions: [
        {
          kind: "functionCall",
          method: "ft_transfer",
          args: new TextEncoder().encode(
            JSON.stringify({ receiver_id: accounts.pool, amount: "1" }),
          ),
          gas: 1n,
          depositYocto: 1n,
        },
      ],
    });
  });

  it("refuses amount_cap when one transfer is too large", async () => {
    const raw = new Uint8Array([5]);
    const huge = senToUnits(sen(200_001));
    expect(unitsToSen(huge, "up")).toBeGreaterThan(200_000);
    await refuse("amount_cap", {
      raw,
      actions: [
        {
          kind: "functionCall",
          method: "ft_transfer",
          args: new TextEncoder().encode(
            JSON.stringify({ receiver_id: accounts.payout, amount: huge.toString() }),
          ),
          gas: 1n,
          depositYocto: 1n,
        },
      ],
    });
  });

  it("refuses amount_cap when the daily total would exceed RM4,000", async () => {
    const day = utcDay(deps.now());
    const priorRaw = new Uint8Array([50]);
    decodeRegistry.set(keyForRaw(priorRaw), makeDecoded({ raw: priorRaw }));
    await exposure.withWorker(WORKER, (book) => {
      book.hold({
        blob: blobId(priorRaw),
        day,
        amount: senToUnits(sen(200_000)),
        maxBlockHeight: 5000n,
      });
      book.land(blobId(priorRaw), "prior-tx");
    });

    const raw = new Uint8Array([6]);
    const second = senToUnits(sen(200_001));
    await refuse("amount_cap", {
      raw,
      actions: [
        {
          kind: "functionCall",
          method: "ft_transfer",
          args: new TextEncoder().encode(
            JSON.stringify({ receiver_id: accounts.payout, amount: second.toString() }),
          ),
          gas: 1n,
          depositYocto: 1n,
        },
      ],
    });
  });

  it("refuses known_worker for a bad signature", async () => {
    const raw = new Uint8Array([7]);
    await refuse("known_worker", { raw, signatureOk: false });
  });

  it("refuses known_worker when maxBlockHeight expired", async () => {
    const raw = new Uint8Array([8]);
    await refuse("known_worker", { raw, maxBlockHeight: 1000n });
  });

  it("refuses known_worker when nonce is already used", async () => {
    const raw = new Uint8Array([9]);
    deps.accessKey = async () => ({ nonce: 10n, permission: "FullAccess" });
    await refuse("known_worker", { raw, nonce: 10n });
  });

  it("refuses known_worker for a function-call key", async () => {
    const raw = new Uint8Array([10]);
    deps.accessKey = async () => ({ nonce: 1n, permission: "FunctionCall" });
    await refuse("known_worker", { raw, nonce: 2n });
  });

  it("refuses rate_limit after twenty relays in the UTC day", async () => {
    const day = utcDay(deps.now()) as UtcDay;
    await exposure.withWorker(WORKER, (book) => {
      for (let i = 0; i < 20; i++) {
        const raw = new Uint8Array([100 + i]);
        book.hold({ blob: blobId(raw), day, amount: 1n, maxBlockHeight: 5000n });
        book.drop(blobId(raw));
      }
    });
    const raw = new Uint8Array([200]);
    await refuse("rate_limit", { raw });
  });

  it("does not submit a held blob twice while the first submit is still running", async () => {
    let releaseSubmit: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    submit.mockImplementation(async () => {
      await gate;
      return { txHash: "once" };
    });
    const raw = new Uint8Array([77, 78]);
    const body = register({ raw });
    const first = relay(body, deps);
    const second = relay(body, deps);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await expect(second).resolves.toEqual({ status: 503, body: { reason: "in_flight" } });
    releaseSubmit();
    await expect(first).resolves.toEqual({ status: 200, body: { txHash: "once" } });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid delegate and submits the original bytes", async () => {
    const raw = new Uint8Array([42, 43, 44]);
    const body = register({ raw });
    const result = await relay(body, deps);
    expect(result.status).toBe(200);
    expect(submit).toHaveBeenCalledTimes(1);
    const call = submit.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("expected submit call");
    expect(Buffer.from(call.raw).equals(Buffer.from(raw))).toBe(true);
  });

  it("replays a landed blob without submitting again", async () => {
    const raw = new Uint8Array([11, 12]);
    const body = register({ raw });
    const first = await relay(body, deps);
    expect(first.status).toBe(200);
    submit.mockClear();
    const second = await relay(body, deps);
    expect(second).toEqual(first);
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not write exposure on a local 403", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-exposure-"));
    const fileLog = ExposureLog.files(dir);
    const raw = new Uint8Array([99]);
    await refuse(
      "deposit_yocto",
      {
        raw,
        actions: [
          {
            kind: "functionCall",
            method: "ft_transfer",
            args: new TextEncoder().encode(
              JSON.stringify({ receiver_id: accounts.payout, amount: "1" }),
            ),
            gas: 1n,
            depositYocto: 0n,
          },
        ],
      },
      { ...deps, exposure: fileLog },
    );
    await expect(readFile(join(dir, `${WORKER}.json`))).rejects.toThrow();
  });
});
