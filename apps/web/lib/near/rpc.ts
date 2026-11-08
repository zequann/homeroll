import { createHash } from "node:crypto";
import { deserialize } from "borsh";
import {
  Account,
  actions,
  baseDecode,
  baseEncode,
  buildDelegateAction,
  type DelegateAction,
  encodeDelegateAction,
  encodeSignedDelegate,
  JsonRpcProvider,
  KeyPairSigner,
  type KeyPairString,
  type SignedDelegate as NearSignedDelegate,
  PublicKey,
  SCHEMA,
} from "near-api-js";
import type { AdminStep } from "../deploy/deploy";
import { type Units, units } from "../fx/index.ts";
import type { AdminSigner, RelayerSigner, WorkerSigner } from "../keys";
import type { PayableBytes } from "../relay/relay";
import { rpcUrls, sendWithRetry } from "./rpc-retry.ts";

export type CodeHash = string & { readonly __codeHash: "CodeHash" };

export type AccountView = {
  exists: boolean;
  codeHash: CodeHash | null;
  balanceYocto: bigint;
  fullAccessKeys: string[];
};

export type KeyView = {
  nonce: bigint;
  permission: "FullAccess" | "FunctionCall";
};

export type DecodedAction =
  | {
      kind: "functionCall";
      method: string;
      args: Uint8Array;
      gas: bigint;
      depositYocto: bigint;
    }
  | { kind: "other" };

export type SignedDelegate = {
  signatureOk: boolean;
  senderId: string;
  receiverId: string;
  actions: DecodedAction[];
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: string;
  raw: Uint8Array;
};

export type DecodeResult =
  | { ok: false; reason: "malformed" }
  | { ok: true; delegate: SignedDelegate };

let rpcUrl = process.env.NEAR_RPC_URL ?? "";

export function configureRpc(url: string): void {
  rpcUrl = url;
}

/**
 * Every provider method ends in `sendJsonRpc`, so overriding it gives reads, view calls and
 * transaction sends the same 429 retry and fallback endpoints (`rpc-retry.ts`).
 */
class RetryingRpcProvider extends JsonRpcProvider {
  private readonly urls: string[];
  private readonly endpoints: Map<string, JsonRpcProvider>;

  // No parameter properties: scripts load this file with node --experimental-strip-types
  constructor(urls: string[]) {
    super({ url: urls[0] ?? "" });
    this.urls = urls;
    // near-api-js's own retries (500, 503, 408, fetch errors) resend the same bytes. Its default of
    // 12 tries with a 1.5x backoff takes ~95 s, so a dead endpoint held a reset for minutes; 4 tries
    // take ~4 s, then rpc-retry moves a read to the next endpoint.
    this.endpoints = new Map(
      urls.map((url) => [
        url,
        new JsonRpcProvider({ url }, { retries: 4, wait: 500, backoff: 1.5 }),
      ]),
    );
  }

  // biome-ignore lint/suspicious/noExplicitAny: forwards near-api-js's generic signature unchanged
  override sendJsonRpc(method: any, params: any): Promise<any> {
    return sendWithRetry(this.urls, String(method), (url) => {
      const endpoint = this.endpoints.get(url);
      if (!endpoint) throw new Error(`No RPC endpoint for ${url}`);
      return endpoint.sendJsonRpc(method, params);
    });
  }
}

let cached: { key: string; provider: RetryingRpcProvider } | null = null;

function provider(): JsonRpcProvider {
  if (!rpcUrl) throw new Error("NEAR_RPC_URL is not set");
  const urls = rpcUrls(rpcUrl);
  const key = urls.join(",");
  if (cached?.key !== key) cached = { key, provider: new RetryingRpcProvider(urls) };
  return cached.provider;
}

/**
 * How long a transaction send waits. "EXECUTED" waits until the transaction and every receipt it
 * started have run, so cross-contract calls (pay_run's transfers, ft_transfer_call into the pool)
 * are done and the next read shows them. It does not wait for the block to be final: about 1.8 s
 * a transaction on testnet against 3.9 s for FINAL (measured 9 Nov 2026). Safe here because
 * near-api-js reads the next nonce at the same optimistic state, and on InvalidNonce it re-signs,
 * which only happens when the first transaction was never included, so nothing runs twice.
 */
export type TxWait = "INCLUDED" | "EXECUTED";
const EXECUTED = "EXECUTED_OPTIMISTIC" as const;
const waitStatus = (wait: TxWait) => (wait === "EXECUTED" ? EXECUTED : "INCLUDED");

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const GAS_DEPLOY_NEW = 200n * 1_000_000_000_000n;
const GAS_CREATE_WORKER = 100n * 1_000_000_000_000n;
const GAS_FUNCTION_CALL = 30n * 1_000_000_000_000n;

/** 40 payees would be one transaction. Callers send at most this many. */
// 30 Tgas each. Ten calls would equal the 300 Tgas transaction cap.
export const MAX_CALLS_PER_TRANSACTION = 8;

function mapActions(actionsList: DelegateAction["actions"]): DecodedAction[] {
  return actionsList.map((action) => {
    if (action.functionCall) {
      return {
        kind: "functionCall" as const,
        method: action.functionCall.methodName,
        // borsh returns a plain Array. TextDecoder only accepts a typed array.
        args: Uint8Array.from(action.functionCall.args),
        gas: action.functionCall.gas,
        depositYocto: action.functionCall.deposit,
      };
    }
    return { kind: "other" as const };
  });
}

function permissionKind(permission: unknown): "FullAccess" | "FunctionCall" {
  if (permission === "FullAccess") return "FullAccess";
  if (typeof permission === "object" && permission !== null && "FullAccess" in permission) {
    return "FullAccess";
  }
  return "FunctionCall";
}

export function decodeSignedDelegate(bytes: Uint8Array): DecodeResult {
  try {
    const signed = deserialize(SCHEMA.SignedDelegate, bytes) as NearSignedDelegate;
    const { delegateAction, signature } = signed;
    const payload = encodeDelegateAction(delegateAction);
    const hash = createHash("sha256").update(payload).digest();
    // borsh returns plain enums. PublicKey.from restores verify().
    const publicKey = PublicKey.from(delegateAction.publicKey);
    const rawSignature =
      signature.ed25519Signature?.data ?? (signature as { data?: Uint8Array }).data;
    if (!rawSignature) return { ok: false, reason: "malformed" };
    const signatureOk = publicKey.verify(hash, Uint8Array.from(rawSignature));
    return {
      ok: true,
      delegate: {
        signatureOk,
        senderId: delegateAction.senderId,
        receiverId: delegateAction.receiverId,
        actions: mapActions(delegateAction.actions),
        nonce: delegateAction.nonce,
        maxBlockHeight: delegateAction.maxBlockHeight,
        publicKey: publicKey.toString(),
        raw: bytes,
      },
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export async function blockHeight(): Promise<bigint> {
  const status = await provider().viewNodeStatus();
  return BigInt(status.sync_info.latest_block_height);
}

function viewCodeHash(codeHashBase58: string | undefined): CodeHash | null {
  if (!codeHashBase58) return null;
  const hex = Buffer.from(baseDecode(codeHashBase58)).toString("hex");
  if (hex === ZERO_HASH) return null;
  return hex as CodeHash;
}

export async function viewAccount(accountId: string): Promise<AccountView> {
  try {
    const view = await provider().viewAccount({ accountId });
    const keys = await provider().viewAccessKeyList({ accountId });
    const fullAccessKeys = keys.keys
      .filter((k) => permissionKind(k.access_key.permission) === "FullAccess")
      .map((k) => k.public_key);
    return {
      exists: true,
      codeHash: viewCodeHash(view.code_hash),
      balanceYocto: view.amount,
      fullAccessKeys,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("UnknownAccount")) {
      return { exists: false, codeHash: null, balanceYocto: 0n, fullAccessKeys: [] };
    }
    throw err;
  }
}

export async function accessKey(accountId: string, publicKey: string): Promise<KeyView | null> {
  try {
    const view = await provider().viewAccessKey({
      accountId,
      publicKey: PublicKey.from(publicKey),
    });
    return { nonce: view.nonce, permission: permissionKind(view.permission) };
  } catch {
    return null;
  }
}

export async function storageRegistered(tusdc: string, accountId: string): Promise<boolean> {
  try {
    const result = await provider().callFunction({
      contractId: tusdc,
      method: "storage_balance_of",
      args: { account_id: accountId },
    });
    return result !== null && result !== undefined;
  } catch {
    return false;
  }
}

export async function ftBalanceOf(tusdc: string, accountId: string): Promise<Units> {
  const result = await provider().callFunction({
    contractId: tusdc,
    method: "ft_balance_of",
    args: { account_id: accountId },
  });
  return units(BigInt(String(result)));
}

export type UnsignedDelegate = {
  senderId: string;
  receiverId: string;
  method: string;
  args: Uint8Array;
  gas: bigint;
  depositYocto: bigint;
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: string;
};

export async function signDelegate(
  worker: WorkerSigner,
  action: UnsignedDelegate,
): Promise<Uint8Array> {
  const signer = KeyPairSigner.fromSecretKey(worker.secretKey as KeyPairString);
  const parsedArgs = JSON.parse(new TextDecoder().decode(action.args)) as Record<string, unknown>;
  const delegateAction = buildDelegateAction({
    senderId: action.senderId,
    receiverId: action.receiverId,
    actions: [actions.functionCall(action.method, parsedArgs, action.gas, action.depositYocto)],
    nonce: action.nonce,
    maxBlockHeight: action.maxBlockHeight,
    publicKey: PublicKey.from(action.publicKey),
  });
  const { signedDelegate } = await signer.signDelegateAction(delegateAction);
  return encodeSignedDelegate(signedDelegate);
}

export async function submitDelegate(
  payable: PayableBytes,
  relayer: RelayerSigner,
): Promise<{ txHash: string }> {
  const signed = deserialize(SCHEMA.SignedDelegate, payable.raw) as NearSignedDelegate;
  const account = new Account(
    relayer.accountId,
    provider(),
    KeyPairSigner.fromSecretKey(relayer.secretKey as KeyPairString),
  );
  const outcome = await account.signAndSendTransaction({
    receiverId: signed.delegateAction.senderId,
    actions: [actions.signedDelegate(signed)],
    waitUntil: "INCLUDED",
  });
  return { txHash: outcome.transaction_outcome.id };
}

function signingAccount(signer: {
  readonly accountId: string;
  readonly secretKey: string;
}): Account {
  return new Account(
    signer.accountId,
    provider(),
    KeyPairSigner.fromSecretKey(signer.secretKey as KeyPairString),
  );
}

export async function broadcastAdmin(
  step: AdminStep,
  admin: AdminSigner,
  wait: TxWait = "INCLUDED",
): Promise<{ txHash: string }> {
  const waitUntil = waitStatus(wait);
  const account = signingAccount(admin);
  switch (step.kind) {
    case "deploy": {
      const adminPub = await KeyPairSigner.fromSecretKey(
        admin.secretKey as KeyPairString,
      ).getPublicKey();
      const call = actions.functionCall("new", step.initArgs, GAS_DEPLOY_NEW, 0n);
      const deployActions = step.create
        ? [
            actions.createAccount(),
            actions.transfer(step.fundYocto),
            actions.addFullAccessKey(adminPub),
            actions.deployContract(step.wasm),
            call,
          ]
        : [actions.deployContract(step.wasm), call];
      const outcome = await account.signAndSendTransaction({
        receiverId: step.account,
        actions: deployActions,
        waitUntil,
      });
      return { txHash: outcome.transaction_outcome.id };
    }
    case "createPlain": {
      const outcome = await account.signAndSendTransaction({
        receiverId: step.account,
        actions: [
          actions.createAccount(),
          actions.addFullAccessKey(PublicKey.from(step.publicKey)),
          actions.transfer(step.fundYocto),
        ],
        waitUntil,
      });
      return { txHash: outcome.transaction_outcome.id };
    }
    case "topUp": {
      const outcome = await account.signAndSendTransaction({
        receiverId: step.account,
        actions: [actions.transfer(step.fundYocto)],
        waitUntil,
      });
      return { txHash: outcome.transaction_outcome.id };
    }
    case "storageDeposit": {
      const outcome = await account.signAndSendTransaction({
        receiverId: step.tusdc,
        actions: [
          actions.functionCall(
            "storage_deposit",
            { account_id: step.account, registration_only: true },
            GAS_DEPLOY_NEW,
            step.depositYocto,
          ),
        ],
        waitUntil,
      });
      return { txHash: outcome.transaction_outcome.id };
    }
    case "mint": {
      const outcome = await account.signAndSendTransaction({
        receiverId: step.tusdc,
        actions: [
          actions.functionCall(
            "mint",
            { account_id: step.account, amount: step.amount.toString() },
            GAS_DEPLOY_NEW,
            0n,
          ),
        ],
        waitUntil,
      });
      return { txHash: outcome.transaction_outcome.id };
    }
    case "replaceWasm": {
      // The parent created this account and added the admin key. Only that key,
      // signing as the account itself, can replace the code. No `new` call.
      const outcome = await signingAccount({
        accountId: step.account,
        secretKey: admin.secretKey,
      }).signAndSendTransaction({
        receiverId: step.account,
        actions: [actions.deployContract(step.wasm)],
        waitUntil,
      });
      return { txHash: outcome.transaction_outcome.id };
    }
    case "createWorker": {
      const outcome = await account.signAndSendTransaction({
        receiverId: step.factory,
        actions: [
          actions.functionCall(
            "create_worker",
            { name: step.name, public_key: step.publicKey },
            GAS_CREATE_WORKER,
            0n,
          ),
        ],
        waitUntil,
      });
      return { txHash: outcome.transaction_outcome.id };
    }
  }
}

export type ListedKey =
  | { readonly kind: "fullAccess"; readonly publicKey: string }
  | {
      readonly kind: "functionCall";
      readonly publicKey: string;
      readonly receiverId: string;
      readonly methodNames: readonly string[];
      readonly allowanceYocto: bigint;
    };

export type ListedAccount =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly balanceYocto: bigint;
      readonly keys: readonly ListedKey[];
    };

type FunctionCallKeyFields = {
  readonly publicKey: string;
  readonly receiverId: string;
  readonly methodNames: readonly string[];
  readonly allowanceYocto: bigint;
};

type TxSigner = { readonly accountId: string; readonly secretKey: string };

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    names.push(item);
  }
  return names;
}

function allowanceYocto(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function functionCallFields(
  permission: unknown,
): Omit<FunctionCallKeyFields, "publicKey"> | "full" {
  // An unreadable permission is reported as full access so a foreign key is refused.
  if (permission === "FullAccess") return "full";
  if (typeof permission !== "object" || permission === null) return "full";
  if ("FullAccess" in permission || "GasKeyFullAccess" in permission) return "full";
  const record = permission as Record<string, unknown>;
  const inner = record.FunctionCall ?? record.GasKeyFunctionCall;
  if (typeof inner !== "object" || inner === null) return "full";
  const fields = inner as Record<string, unknown>;
  const receiverId = fields.receiver_id ?? fields.receiverId;
  const methodNames = stringList(fields.method_names ?? fields.methodNames);
  if (typeof receiverId !== "string" || receiverId === "" || methodNames === null) return "full";
  return { receiverId, methodNames, allowanceYocto: allowanceYocto(fields.allowance) };
}

function parseListedKey(item: unknown): ListedKey {
  if (typeof item !== "object" || item === null)
    throw new Error("access key entry is not an object");
  const row = item as { public_key?: unknown; access_key?: { permission?: unknown } };
  if (typeof row.public_key !== "string" || row.public_key === "") {
    throw new Error("access key entry has no public key");
  }
  const fields = functionCallFields(row.access_key?.permission);
  if (fields === "full") return { kind: "fullAccess", publicKey: row.public_key };
  return { kind: "functionCall", publicKey: row.public_key, ...fields };
}

function parseListedKeys(raw: unknown): readonly ListedKey[] {
  if (typeof raw !== "object" || raw === null || !("keys" in raw) || !Array.isArray(raw.keys)) {
    throw new Error("access key list is missing keys");
  }
  return raw.keys.map(parseListedKey);
}

/** Balance plus every access key. `viewAccount` keeps full-access keys only. */
export async function viewAccountState(accountId: string): Promise<ListedAccount> {
  let balanceYocto: bigint;
  try {
    balanceYocto = (await provider().viewAccount({ accountId })).amount;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("UnknownAccount")) return { kind: "absent" };
    throw err;
  }
  // Two RPC calls, not three: Reset demo checks 43 accounts this way, twice, on rate-limited RPCs
  const listed = await provider().viewAccessKeyList({ accountId });
  return { kind: "present", balanceYocto, keys: parseListedKeys(listed) };
}

export async function viewFunction(
  contractId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return provider().callFunction({ contractId, method, args });
}

function functionCallKeyAction(key: FunctionCallKeyFields) {
  return actions.addFunctionCallAccessKey(
    PublicKey.from(key.publicKey),
    key.receiverId,
    [...key.methodNames],
    key.allowanceYocto,
  );
}

/**
 * Creates the account with this function-call key as its only key, then funds it.
 * Method names come from `key.methodNames`.
 */
export async function createAccountWithFunctionCallKey(
  signer: TxSigner,
  accountId: string,
  key: FunctionCallKeyFields,
  fundYocto: bigint,
): Promise<{ txHash: string }> {
  const outcome = await signingAccount(signer).signAndSendTransaction({
    receiverId: accountId,
    actions: [actions.createAccount(), functionCallKeyAction(key), actions.transfer(fundYocto)],
    waitUntil: EXECUTED,
  });
  return { txHash: outcome.transaction_outcome.id };
}

/** Adds one function-call key. Method names come from `key.methodNames`. */
export async function addFunctionCallAccessKey(
  signer: TxSigner,
  accountId: string,
  key: FunctionCallKeyFields,
): Promise<{ txHash: string }> {
  const outcome = await signingAccount(signer).signAndSendTransaction({
    receiverId: accountId,
    actions: [functionCallKeyAction(key)],
    waitUntil: EXECUTED,
  });
  return { txHash: outcome.transaction_outcome.id };
}

/** Contract calls with no attached deposit. At most `MAX_CALLS_PER_TRANSACTION` calls. */
export async function callMethods(
  signer: TxSigner,
  receiverId: string,
  calls: readonly { readonly method: string; readonly args: Record<string, unknown> }[],
): Promise<{ txHash: string }> {
  if (calls.length === 0) throw new Error("no calls");
  if (calls.length > MAX_CALLS_PER_TRANSACTION) {
    throw new Error(`at most ${MAX_CALLS_PER_TRANSACTION} calls per transaction`);
  }
  const outcome = await signingAccount(signer).signAndSendTransaction({
    receiverId,
    actions: calls.map((call) =>
      actions.functionCall(call.method, call.args, GAS_FUNCTION_CALL, 0n),
    ),
    waitUntil: EXECUTED,
  });
  return { txHash: outcome.transaction_outcome.id };
}

export async function transferNear(
  signer: { accountId: string; secretKey: string },
  receiverId: string,
  yocto: bigint,
): Promise<{ txHash: string }> {
  if (yocto <= 0n) throw new Error("transfer amount must be positive");
  const outcome = await signingAccount(signer).signAndSendTransaction({
    receiverId,
    actions: [actions.transfer(yocto)],
    waitUntil: EXECUTED,
  });
  return { txHash: outcome.transaction_outcome.id };
}

export async function callMethod(
  signer: { accountId: string; secretKey: string },
  receiverId: string,
  call: { method: string; args: Record<string, unknown>; gas: bigint; depositYocto: bigint },
): Promise<{ txHash: string }> {
  const outcome = await signingAccount(signer).signAndSendTransaction({
    receiverId,
    actions: [actions.functionCall(call.method, call.args, call.gas, call.depositYocto)],
    waitUntil: EXECUTED,
  });
  return { txHash: outcome.transaction_outcome.id };
}

/**
 * Like `callMethod`, plus the failures of receipts after the first. A panic in a callee such as
 * `ft_on_transfer` is refunded by the token, so the transaction itself still succeeds.
 */
export async function callMethodWithReceipts(
  signer: { accountId: string; secretKey: string },
  receiverId: string,
  call: { method: string; args: Record<string, unknown>; gas: bigint; depositYocto: bigint },
): Promise<{ txHash: string; receiptFailures: string[] }> {
  const outcome = await signingAccount(signer).signAndSendTransaction({
    receiverId,
    actions: [actions.functionCall(call.method, call.args, call.gas, call.depositYocto)],
    waitUntil: EXECUTED,
  });
  const receiptFailures: string[] = [];
  for (const receipt of outcome.receipts_outcome) {
    const status = receipt.outcome.status;
    if (typeof status === "object" && status !== null && "Failure" in status) {
      receiptFailures.push(JSON.stringify(status.Failure));
    }
  }
  return { txHash: outcome.transaction_outcome.id, receiptFailures };
}

export async function accessKeyList(accountId: string): Promise<unknown> {
  return provider().viewAccessKeyList({ accountId });
}

export function wasmCodeHash(wasm: Uint8Array): CodeHash {
  return createHash("sha256").update(wasm).digest("hex") as CodeHash;
}

/**
 * NEP-413: signs a message the way a wallet's signMessage does (SPEC §8.11). near-api-js does the
 * hashing here; lib/payout checks the result with its own hash, so the two must agree.
 */
export async function signNep413Message(
  accountId: string,
  secretKey: string,
  payload: { message: string; recipient: string; nonce: Uint8Array; callbackUrl?: string },
): Promise<{ publicKey: string; signature: string }> {
  const signed = await KeyPairSigner.fromSecretKey(secretKey as KeyPairString).signNep413Message(
    accountId,
    payload,
  );
  return {
    publicKey: signed.publicKey.toString(),
    signature: `ed25519:${baseEncode(signed.signature)}`,
  };
}

/** True when `signature` (`ed25519:<base58>`) is `publicKey`'s signature over `message`. */
export function verifyEd25519(publicKey: string, message: Uint8Array, signature: string): boolean {
  try {
    if (!publicKey.startsWith("ed25519:") || !signature.startsWith("ed25519:")) return false;
    const bytes = baseDecode(signature.slice("ed25519:".length));
    if (bytes.length !== 64) return false;
    return PublicKey.fromString(publicKey).verify(message, bytes);
  } catch {
    return false;
  }
}

export function base58(bytes: Uint8Array): string {
  return baseEncode(bytes);
}
