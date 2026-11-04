import { type HomerollAccounts, WORKER_NAME_PATTERN, workerAccountId } from "@homeroll/shared";
import { type Units, units, unitsToSen } from "../fx";
import type { RelayerSigner } from "../keys";
import { decodeSignedDelegate, type SignedDelegate } from "../near/rpc";
import { blobId, type ExposureLog, utcDay } from "./exposure";

const payableBrand: unique symbol = Symbol("payable");

export type PayableBytes = {
  readonly raw: Uint8Array;
  readonly [payableBrand]: "payable";
};

function payable(raw: Uint8Array): PayableBytes {
  return { raw, [payableBrand]: "payable" };
}

const RULES = [
  { name: "one_action" },
  { name: "receiver_and_method" },
  { name: "deposit_yocto" },
  { name: "prepaid_gas" },
  { name: "token_receiver" },
  { name: "amount_cap" },
  { name: "known_worker" },
  { name: "rate_limit" },
] as const;

export type RuleName = (typeof RULES)[number]["name"];

export function ruleNames(): readonly RuleName[] {
  return RULES.map((rule) => rule.name);
}

const MAX_INNER_GAS = 30n * 1_000_000_000_000n;
const ONE_YOCTO = 1n;
const PER_TRANSFER_SEN = 200_000;
const PER_DAY_SEN = 400_000;
const MAX_RELAYS_PER_WORKER_PER_UTC_DAY = 20;

export type RelayResponse =
  | { status: 200; body: { txHash: string } }
  | { status: 403; body: { rule: RuleName } }
  | {
      status: 503;
      body: {
        reason:
          | "relayer_key_missing"
          | "network_refused"
          | "rpc_unavailable"
          | "in_flight"
          | "nonce_used_without_receipt";
      };
    };

export type RelayDeps = {
  accounts: HomerollAccounts;
  now: () => Date;
  blockHeight: () => Promise<bigint>;
  accessKey: (
    accountId: string,
    publicKey: string,
  ) => Promise<{ nonce: bigint; permission: "FullAccess" | "FunctionCall" } | null>;
  exposure: ExposureLog;
  relayer: RelayerSigner;
  submit: (payable: PayableBytes, relayer: RelayerSigner) => Promise<{ txHash: string }>;
};

type FtArgs = { receiverId: string; amount: Units };

type RuleContext = {
  decoded: { ok: false; reason: "malformed" } | { ok: true; delegate: SignedDelegate };
  ft: FtArgs | null;
  amountParseOk: boolean;
  accounts: HomerollAccounts;
  blockHeight: bigint;
  spentUnits: bigint;
  relayCount: number;
  key: { nonce: bigint; permission: "FullAccess" | "FunctionCall" } | null;
  checkKey: boolean;
  checkCaps: boolean;
};

function parseFtArgs(args: Uint8Array): { ft: FtArgs | null; amountParseOk: boolean } {
  try {
    const json = JSON.parse(new TextDecoder().decode(args)) as {
      receiver_id?: unknown;
      amount?: unknown;
    };
    if (typeof json.receiver_id !== "string") return { ft: null, amountParseOk: false };
    if (typeof json.amount !== "string" || !/^\d+$/.test(json.amount)) {
      return { ft: { receiverId: json.receiver_id, amount: 0n as Units }, amountParseOk: false };
    }
    return {
      ft: { receiverId: json.receiver_id, amount: BigInt(json.amount) as Units },
      amountParseOk: true,
    };
  } catch {
    return { ft: null, amountParseOk: false };
  }
}

function workerNameForSender(senderId: string, root: string): string | null {
  const suffix = `.${root}`;
  if (!senderId.endsWith(suffix)) return null;
  const name = senderId.slice(0, -suffix.length);
  if (!WORKER_NAME_PATTERN.test(name)) return null;
  try {
    if (workerAccountId(name, root) !== senderId) return null;
    return name;
  } catch {
    return null;
  }
}

function firstFailure(ctx: RuleContext): RuleName | null {
  const delegate = ctx.decoded.ok ? ctx.decoded.delegate : null;

  // Rule 1
  if (!ctx.decoded.ok) return "one_action";
  if (delegate!.actions.length !== 1) return "one_action";
  const action = delegate!.actions[0];
  if (!action || action.kind !== "functionCall") return "one_action";

  // Rule 2
  if (delegate!.receiverId !== ctx.accounts.tusdc || action.method !== "ft_transfer") {
    return "receiver_and_method";
  }

  // Rule 3
  if (action.depositYocto !== ONE_YOCTO) return "deposit_yocto";

  // Rule 4
  if (action.gas > MAX_INNER_GAS) return "prepaid_gas";

  // Rule 5
  if (
    !ctx.ft ||
    (ctx.ft.receiverId !== ctx.accounts.payout && ctx.ft.receiverId !== ctx.accounts.offramp)
  ) {
    return "token_receiver";
  }

  if (ctx.checkCaps) {
    // Rule 6
    if (!ctx.amountParseOk) return "amount_cap";
    if (unitsToSen(ctx.ft.amount, "up") > PER_TRANSFER_SEN) return "amount_cap";
    if (unitsToSen(units(ctx.spentUnits + ctx.ft.amount), "up") > PER_DAY_SEN) return "amount_cap";
  }

  // Rule 7 — signature and account id before the access-key view
  if (!delegate!.signatureOk) return "known_worker";
  if (workerNameForSender(delegate!.senderId, ctx.accounts.root) === null) return "known_worker";

  if (ctx.checkKey) {
    if (ctx.key === null || ctx.key.permission !== "FullAccess") return "known_worker";
    if (delegate!.nonce <= ctx.key.nonce) return "known_worker";
    if (delegate!.nonce > ctx.blockHeight * 1_000_000n) return "known_worker";
    if (delegate!.maxBlockHeight <= ctx.blockHeight) return "known_worker";
  }

  if (ctx.checkCaps) {
    // Rule 8
    if (ctx.relayCount > MAX_RELAYS_PER_WORKER_PER_UTC_DAY) return "rate_limit";
  }

  return null;
}

function decodeBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(Buffer.from(text, "base64"));
  } catch {
    return null;
  }
}

function isInvalidNonce(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("InvalidNonce") || msg.includes("invalid nonce");
}

function isPreInclusionReject(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("NotAllowedError") || msg.includes("InvalidTransaction") || msg.includes("Expired")
  );
}

function baseContext(
  decoded: RuleContext["decoded"],
  ft: FtArgs | null,
  amountParseOk: boolean,
  accounts: HomerollAccounts,
  blockHeight: bigint,
): RuleContext {
  return {
    decoded,
    ft,
    amountParseOk,
    accounts,
    blockHeight,
    spentUnits: 0n,
    relayCount: 0,
    key: null,
    checkKey: false,
    checkCaps: false,
  };
}

export async function relay(signedDelegateBase64: string, deps: RelayDeps): Promise<RelayResponse> {
  const raw = decodeBase64(signedDelegateBase64);
  if (raw === null) {
    return { status: 403, body: { rule: "one_action" } };
  }

  const decoded = decodeSignedDelegate(raw);
  let blockHeight: bigint;
  try {
    blockHeight = await deps.blockHeight();
  } catch {
    return { status: 503, body: { reason: "rpc_unavailable" } };
  }

  const actionArgs =
    decoded.ok && decoded.delegate.actions[0]?.kind === "functionCall"
      ? decoded.delegate.actions[0].args
      : new Uint8Array();
  const { ft, amountParseOk } = parseFtArgs(actionArgs);
  const ctx = baseContext(decoded, ft, amountParseOk, deps.accounts, blockHeight);

  const beforeKey = firstFailure(ctx);
  if (beforeKey) return { status: 403, body: { rule: beforeKey } };

  if (!decoded.ok) return { status: 403, body: { rule: "one_action" } };
  const delegate = decoded.delegate;

  let keyView: RuleContext["key"] = null;
  try {
    keyView = await deps.accessKey(delegate.senderId, delegate.publicKey);
  } catch {
    return { status: 503, body: { reason: "rpc_unavailable" } };
  }

  const withKey = { ...ctx, key: keyView, checkKey: true };
  const afterKey = firstFailure(withKey);
  if (afterKey) return { status: 403, body: { rule: afterKey } };

  const day = utcDay(deps.now());
  const id = blobId(raw);

  type Next = "replay" | "in_flight" | "recover" | "submit" | "reject";
  const flow: { next: Next; replayHash: string | null; rejectRule: RuleName | null } = {
    next: "submit",
    replayHash: null,
    rejectRule: null,
  };

  await deps.exposure.withWorker(delegate.senderId, (book) => {
    const existing = book.find(id);
    if (existing?.phase === "landed" && existing.txHash) {
      flow.next = "replay";
      flow.replayHash = existing.txHash;
      return;
    }
    if (existing?.phase === "held") {
      if (deps.exposure.inFlight.has(id)) {
        flow.next = "in_flight";
        return;
      }
      // Claim the blob before this lock releases. Otherwise a second request resubmits it.
      deps.exposure.inFlight.add(id);
      flow.next = "recover";
      return;
    }

    const capCtx: RuleContext = {
      ...withKey,
      checkCaps: true,
      spentUnits: book.spentUnits(day, blockHeight),
      relayCount: book.relayCount(day) + 1,
    };
    const capFail = firstFailure(capCtx);
    if (capFail) {
      flow.next = "reject";
      flow.rejectRule = capFail;
      return;
    }
    if (!ft) {
      flow.next = "reject";
      flow.rejectRule = "token_receiver";
      return;
    }
    book.hold({ blob: id, day, amount: ft.amount, maxBlockHeight: delegate.maxBlockHeight });
    deps.exposure.inFlight.add(id);
    flow.next = "submit";
  });

  if (flow.next === "replay" && flow.replayHash)
    return { status: 200, body: { txHash: flow.replayHash } };
  if (flow.next === "in_flight") return { status: 503, body: { reason: "in_flight" } };
  if (flow.next === "reject" && flow.rejectRule)
    return { status: 403, body: { rule: flow.rejectRule } };

  try {
    const { txHash } = await deps.submit(payable(raw), deps.relayer);
    await deps.exposure.withWorker(delegate.senderId, (book) => book.land(id, txHash));
    return { status: 200, body: { txHash } };
  } catch (err) {
    if (isInvalidNonce(err)) {
      return { status: 503, body: { reason: "nonce_used_without_receipt" } };
    }
    if (isPreInclusionReject(err)) {
      await deps.exposure.withWorker(delegate.senderId, (book) => book.drop(id));
    }
    return { status: 503, body: { reason: "rpc_unavailable" } };
  } finally {
    deps.exposure.inFlight.delete(id);
  }
}
