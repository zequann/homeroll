import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type AccountId, homerollAccounts } from "@homeroll/shared";
import { z } from "zod";
import type { ChainClient, PayLine, Period, RunView, Signer, Tx } from "@/lib/near/client";
import {
  intentHashOf,
  type Nep413Payload,
  newNonce,
  type SignedData,
  verifyNep413,
} from "./nep413";

/**
 * Confidential payout rail (SPEC §8.11): the only code that knows about intents. The mock speaks
 * 1Click's field names in confidential mode, checks the owner's NEP-413 approval (R17), then has
 * the payroll contract pay. The confidential layer is simulated: payouts are public testnet
 * transfers. Every response says `mock: true`.
 */

/** Production verifies at intents.near. This string is no account, so nothing can be sent to it. */
export const MOCK_VERIFIER = "homeroll-mock-intents";
const DEADLINE_MS = 10 * 60_000;

/** 1Click's status values that this rail uses. */
export type OneClickStatus = "PENDING_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

export interface TransferIntent {
  intent: "transfer";
  receiver_id: AccountId;
  tokens: Record<string, string>;
  memo: string;
}

export interface PayrollRunRef {
  employer: AccountId;
  period: Period;
  runId: number;
}

export interface QuoteResponse {
  mock: true;
  correlationId: string;
  timestamp: string;
  quoteRequest: {
    depositType: "CONFIDENTIAL_INTENTS";
    recipientType: "CONFIDENTIAL_INTENTS";
    originAsset: string;
    destinationAsset: string;
    amount: string;
    refundTo: AccountId;
    /** Homeroll's own field: 1Click has no payroll runs. */
    payrollRun: { period: Period; runId: number };
  };
  quote: {
    /** `mock:<hex>`. Not an account: nobody can send funds to it. */
    depositAddress: string;
    amountIn: string;
    amountOut: string;
    deadline: string;
    timeEstimate: number;
  };
}

export interface GenerateIntentRequest {
  type: "swap_transfer";
  standard: "nep413";
  signerId: AccountId;
  depositAddress: string;
}
export interface GenerateIntentResponse {
  mock: true;
  intent: { standard: "nep413"; payload: Nep413Payload };
  correlationId: string;
}
export interface SubmitIntentRequest {
  type: "swap_transfer";
  signedData: SignedData;
}
export interface SubmitIntentResponse {
  mock: true;
  intentHash: string;
  correlationId: string;
}
export interface StatusResponse {
  mock: true;
  /** Real 1Click returns only shield and unshield hashes; these are public testnet payouts. */
  testnetOnly: true;
  correlationId: string;
  status: OneClickStatus;
  updatedAt: string;
  quoteResponse: QuoteResponse;
  swapDetails: {
    intentHashes: string[];
    nearTxHashes: string[];
    originChainTxHashes: [];
    destinationChainTxHashes: [];
    amountIn: string;
    amountOut: string;
  };
}

/** Why the rail said no. R17's checks are the ones from submit-intent (SPEC §8.11). */
export type RailRefusal =
  | "unknown-quote"
  | "run-not-pending"
  | "signer-mismatch"
  | "unknown-intent"
  | "nonce-used"
  | "deadline-passed"
  | "bad-signature"
  | "not-owner-key"
  | "payload-changed"
  | "run-changed"
  | "not-approved";

export type RailResult<T> = { ok: true; value: T } | { ok: false; refusal: RailRefusal };

const ok = <T>(value: T): RailResult<T> => ({ ok: true, value });
const refuse = <T>(refusal: RailRefusal): RailResult<T> => ({ ok: false, refusal });

export interface PayoutRail {
  quote(run: PayrollRunRef): Promise<RailResult<QuoteResponse>>;
  generateIntent(req: GenerateIntentRequest): Promise<RailResult<GenerateIntentResponse>>;
  submitIntent(req: SubmitIntentRequest): Promise<RailResult<SubmitIntentResponse>>;
  status(depositAddress: string): Promise<RailResult<StatusResponse>>;
}

interface QuoteRecord {
  response: QuoteResponse;
  run: PayrollRunRef;
  lines: PayLine[];
  deadlineMs: number;
  status: OneClickStatus;
  /** What generate-intent returned, so submit can tell a changed payload. */
  payload: Nep413Payload | null;
  intentHash: string | null;
  nearTxHashes: string[];
  updatedAt: number;
}

/** Quotes and used nonces, in memory per server instance (SPEC §18). Reset demo clears it. */
export class PayoutStore {
  readonly quotes = new Map<string, QuoteRecord>();
  readonly usedNonces = new Set<string>();

  clear(): void {
    this.quotes.clear();
    this.usedNonces.clear();
  }
}

const signedDataSchema = z.object({
  standard: z.literal("nep413"),
  payload: z.object({
    message: z.string().max(20_000),
    nonce: z.string().max(64),
    recipient: z.string().max(64),
    callbackUrl: z.string().nullable().optional(),
  }),
  public_key: z.string().max(100),
  signature: z.string().max(200),
});

/** The three chain calls the rail makes: read the run, read the employer's keys, pay. */
export type RailChain = Pick<ChainClient, "getRuns" | "getAccessKeys" | "payRun">;

export interface RailDeps {
  chain: RailChain;
  root: AccountId;
  store: PayoutStore;
  now: () => number;
  random?: (n: number) => Uint8Array;
}

export class MockConfidentialRail implements PayoutRail {
  constructor(private readonly deps: RailDeps) {}

  private get token(): string {
    return `nep141:${homerollAccounts(this.deps.root).tusdc}`;
  }

  private random(n: number): Uint8Array {
    return (this.deps.random ?? randomBytes)(n);
  }

  async quote(run: PayrollRunRef): Promise<RailResult<QuoteResponse>> {
    // The lines come from the contract's run, never from the agent or the browser
    const lines = await this.reservedLines(run);
    if (!lines || lines.length === 0) return refuse("run-not-pending");
    const now = this.deps.now();
    const total = lines.reduce((sum, l) => sum + l.amount, 0n).toString();
    const response: QuoteResponse = {
      mock: true,
      correlationId: randomUUID(),
      timestamp: new Date(now).toISOString(),
      quoteRequest: {
        depositType: "CONFIDENTIAL_INTENTS",
        recipientType: "CONFIDENTIAL_INTENTS",
        originAsset: this.token,
        destinationAsset: this.token,
        amount: total,
        refundTo: run.employer,
        payrollRun: { period: run.period, runId: run.runId },
      },
      quote: {
        depositAddress: `mock:${Buffer.from(this.random(20)).toString("hex")}`,
        amountIn: total,
        amountOut: total,
        deadline: new Date(now + DEADLINE_MS).toISOString(),
        timeEstimate: 10,
      },
    };
    this.deps.store.quotes.set(response.quote.depositAddress, {
      response,
      run,
      lines,
      deadlineMs: now + DEADLINE_MS,
      status: "PENDING_DEPOSIT",
      payload: null,
      intentHash: null,
      nearTxHashes: [],
      updatedAt: now,
    });
    return ok(response);
  }

  async generateIntent(req: GenerateIntentRequest): Promise<RailResult<GenerateIntentResponse>> {
    const record = this.deps.store.quotes.get(req.depositAddress);
    if (!record) return refuse("unknown-quote");
    if (req.signerId !== record.run.employer) return refuse("signer-mismatch");
    if (record.status !== "PENDING_DEPOSIT") return refuse("nonce-used");
    if (this.deps.now() > record.deadlineMs) return refuse("deadline-passed");
    // One transfer intent per reserved line, in run order
    const intents: TransferIntent[] = record.lines.map((l) => ({
      intent: "transfer",
      receiver_id: l.accountId,
      tokens: { [this.token]: l.amount.toString() },
      memo: `payroll ${record.run.period}`,
    }));
    record.payload = {
      message: JSON.stringify({
        signer_id: record.run.employer,
        deadline: new Date(record.deadlineMs).toISOString(),
        intents,
      }),
      nonce: newNonce((n) => this.random(n)),
      recipient: MOCK_VERIFIER,
    };
    return ok({
      mock: true,
      intent: { standard: "nep413", payload: record.payload },
      correlationId: record.response.correlationId,
    });
  }

  async submitIntent(req: SubmitIntentRequest): Promise<RailResult<SubmitIntentResponse>> {
    const parsed = signedDataSchema.safeParse(req.signedData);
    if (!parsed.success) return refuse("unknown-intent");
    const signed = parsed.data as SignedData;
    const { store } = this.deps;
    // R17.1: a nonce this rail issued
    const record = [...store.quotes.values()].find(
      (r) => r.payload?.nonce === signed.payload.nonce,
    );
    if (!record?.payload) return refuse("unknown-intent");
    // R17.2: each nonce once, so a signed intent cannot be replayed
    if (store.usedNonces.has(signed.payload.nonce)) return refuse("nonce-used");
    // R17.3: before the deadline
    if (this.deps.now() > record.deadlineMs) return refuse("deadline-passed");
    // R17.4: the signature covers exactly these bytes
    if (!verifyNep413(signed)) return refuse("bad-signature");
    // R17.5: only a full-access key of the employer approves; the agent's function-call key cannot
    const keys = await this.deps.chain.getAccessKeys(record.run.employer);
    const owner = keys.find((k) => k.publicKey === signed.public_key);
    if (owner?.permission.kind !== "FullAccess") return refuse("not-owner-key");
    // R17.6: the payload generate-intent returned, unchanged
    if (!samePayload(signed.payload, record.payload)) return refuse("payload-changed");
    // R17.7: the contract's reserved lines are still the ones in the intent
    const lines = await this.reservedLines(record.run);
    if (!lines || !sameLines(lines, record.lines)) return refuse("run-changed");

    store.usedNonces.add(signed.payload.nonce);
    record.status = "PROCESSING";
    record.intentHash = intentHashOf(signed.payload);
    record.updatedAt = this.deps.now();
    return ok({
      mock: true,
      intentHash: record.intentHash,
      correlationId: record.response.correlationId,
    });
  }

  async status(depositAddress: string): Promise<RailResult<StatusResponse>> {
    const record = this.deps.store.quotes.get(depositAddress);
    if (!record) return refuse("unknown-quote");
    return ok({
      mock: true,
      testnetOnly: true,
      correlationId: record.response.correlationId,
      status: record.status,
      updatedAt: new Date(record.updatedAt).toISOString(),
      quoteResponse: record.response,
      swapDetails: {
        intentHashes: record.intentHash ? [record.intentHash] : [],
        nearTxHashes: [...record.nearTxHashes],
        originChainTxHashes: [],
        destinationChainTxHashes: [],
        amountIn: record.response.quote.amountIn,
        amountOut: record.response.quote.amountOut,
      },
    });
  }

  /** The accepted, unfinished payout for a run: the app calls pay_run only when there is one. */
  approvedPayout(run: Pick<PayrollRunRef, "employer" | "runId">): string | null {
    for (const [address, r] of this.deps.store.quotes) {
      if (
        r.status === "PROCESSING" &&
        r.run.employer === run.employer &&
        r.run.runId === run.runId
      ) {
        return address;
      }
    }
    return null;
  }

  /** The employer's most recent approved payout, whatever its status, for the owner's panel. */
  latestApproved(employer: AccountId): string | null {
    let latest: { address: string; at: number } | null = null;
    for (const [address, r] of this.deps.store.quotes) {
      if (r.run.employer !== employer || !r.intentHash) continue;
      if (!latest || r.updatedAt >= latest.at) latest = { address, at: r.updatedAt };
    }
    return latest?.address ?? null;
  }

  /**
   * The executor: one `pay_run` batch for a run whose payout intent the rail accepted. Only a
   * `VerifiedApproval` reaches it, so it works on any server instance. The contract pays only what
   * it reserved; this instance's record, if it has one, keeps the hash for status.
   */
  async execute(approval: VerifiedApproval, signer: Signer): Promise<RailResult<Tx<RunView>>> {
    // The executor signs as the employer whose owner approved the payout, and no one else
    if (signer.accountId !== approval.employer) return refuse("not-approved");
    const paid = await this.deps.chain.payRun(signer, approval.runId);
    const record = this.deps.store.quotes.get(approval.depositAddress);
    if (record && paid.ok) {
      record.nearTxHashes.push(paid.txHash);
      record.status = statusOf(paid.value);
      record.updatedAt = this.deps.now();
    }
    return ok(paid);
  }

  /** Quote, generate, sign, submit: the owner's approval of a reserved run (SPEC §8.11, steps 2–5). */
  async approve(
    run: PayrollRunRef,
    sign: (payload: Nep413Payload) => Promise<SignedData>,
  ): Promise<RailResult<{ approval: VerifiedApproval; reused: boolean }>> {
    const expiresAt = this.deps.now() + DEADLINE_MS;
    const existing = this.approvedPayout(run);
    const existingHash = existing ? this.deps.store.quotes.get(existing)?.intentHash : null;
    if (existing && existingHash) {
      const approval = verified({
        ...run,
        depositAddress: existing,
        intentHash: existingHash,
        expiresAt,
      });
      return ok({ approval, reused: true });
    }
    const quoted = await this.quote(run);
    if (!quoted.ok) return quoted;
    const { depositAddress } = quoted.value.quote;
    const generated = await this.generateIntent({
      type: "swap_transfer",
      standard: "nep413",
      signerId: run.employer,
      depositAddress,
    });
    if (!generated.ok) return generated;
    const signedData = await sign(generated.value.intent.payload);
    const submitted = await this.submitIntent({ type: "swap_transfer", signedData });
    if (!submitted.ok) return submitted;
    const approval = verified({
      ...run,
      depositAddress,
      intentHash: submitted.value.intentHash,
      expiresAt,
    });
    return ok({ approval, reused: false });
  }

  private async reservedLines(run: PayrollRunRef): Promise<PayLine[] | null> {
    const runs = await this.deps.chain.getRuns(run.employer, run.period);
    const view = runs?.find((r) => r.runId === run.runId);
    if (view?.status !== "Pending") return null;
    return view.lines
      .filter((l) => l.status === "Reserved")
      .map(({ accountId, amount }) => ({ accountId, amount }));
  }
}

function samePayload(a: Nep413Payload, b: Nep413Payload): boolean {
  return (
    a.message === b.message &&
    a.nonce === b.nonce &&
    a.recipient === b.recipient &&
    (a.callbackUrl ?? null) === (b.callbackUrl ?? null)
  );
}

function sameLines(a: PayLine[], b: PayLine[]): boolean {
  return (
    a.length === b.length &&
    a.every((l, i) => l.accountId === b[i]?.accountId && l.amount === b[i]?.amount)
  );
}

function statusOf(run: RunView): OneClickStatus {
  if (run.status === "Pending") return "PROCESSING";
  if (run.status === "Cancelled") return "REFUNDED";
  return run.lines.some((l) => l.status === "Failed") ? "FAILED" : "SUCCESS";
}

/** The owner's approval of a reserved run: see `MockConfidentialRail.approve`. */
export function approvePayout(
  rail: MockConfidentialRail,
  run: PayrollRunRef,
  sign: (payload: Nep413Payload) => Promise<SignedData>,
): Promise<RailResult<{ approval: VerifiedApproval; reused: boolean }>> {
  return rail.approve(run, sign);
}

// ---- Approval tokens: the accepted intent, carried between requests --------------------------

/** What the rail accepted: an owner-signed payout intent for one reserved run. */
export interface PayoutApproval {
  employer: AccountId;
  period: Period;
  runId: number;
  depositAddress: string;
  intentHash: string;
  /** Milliseconds since the epoch: as long as the payout intent's own deadline. */
  expiresAt: number;
}

declare const verifiedBrand: unique symbol;
/** An approval this rail made, or one whose seal it checked. `execute` takes nothing else. */
export type VerifiedApproval = PayoutApproval & { readonly [verifiedBrand]: true };

function verified(approval: PayoutApproval): VerifiedApproval {
  return approval as VerifiedApproval;
}

const approvalSchema = z.object({
  employer: z.string().min(2).max(64),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  runId: z.number().int().nonnegative(),
  depositAddress: z.string().startsWith("mock:").max(80),
  intentHash: z.string().min(1).max(64),
  expiresAt: z.number().int().positive(),
});

function tag(body: string, secret: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(`homeroll/v1/payout-approval/${body}`).digest();
}

/**
 * The approval as a token for the browser to carry to each pay batch, so a payout survives a
 * different server instance answering the next request. HMAC-SHA256 with a server secret.
 */
export function sealApproval(approval: VerifiedApproval, secret: Uint8Array): string {
  const body = Buffer.from(JSON.stringify(approval)).toString("base64url");
  return `${body}.${tag(body, secret).toString("base64url")}`;
}

/** The approval inside a token, if this server sealed it and it has not expired. Else null. */
export function openApproval(
  token: unknown,
  secret: Uint8Array,
  now: number,
): VerifiedApproval | null {
  if (typeof token !== "string" || token.length > 2_000) return null;
  const [body, seal, extra] = token.split(".");
  if (!body || !seal || extra !== undefined) return null;
  const expected = tag(body, secret);
  const given = Buffer.from(seal, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = approvalSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
    if (now > parsed.expiresAt) return null;
    return verified({ ...parsed, period: parsed.period as Period });
  } catch {
    return null;
  }
}
