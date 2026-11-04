import { createHash } from "node:crypto";
import { deserialize } from "borsh";
import {
  Account,
  actions,
  baseDecode,
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
import { type Units, units } from "../fx";
import type { AdminSigner, RelayerSigner, WorkerSigner } from "../keys";
import type { PayableBytes } from "../relay/relay";

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

function provider(): JsonRpcProvider {
  if (!rpcUrl) throw new Error("NEAR_RPC_URL is not set");
  return new JsonRpcProvider({ url: rpcUrl });
}

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const GAS_DEPLOY_NEW = 200n * 1_000_000_000_000n;
const GAS_CREATE_WORKER = 100n * 1_000_000_000_000n;

function mapActions(actionsList: DelegateAction["actions"]): DecodedAction[] {
  return actionsList.map((action) => {
    if (action.functionCall) {
      return {
        kind: "functionCall" as const,
        method: action.functionCall.methodName,
        args: action.functionCall.args,
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

function adminAccount(admin: AdminSigner): Account {
  return new Account(
    admin.accountId,
    provider(),
    KeyPairSigner.fromSecretKey(admin.secretKey as KeyPairString),
  );
}

export async function broadcastAdmin(
  step: AdminStep,
  admin: AdminSigner,
): Promise<{ txHash: string }> {
  const account = adminAccount(admin);
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
        waitUntil: "INCLUDED",
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
        waitUntil: "INCLUDED",
      });
      return { txHash: outcome.transaction_outcome.id };
    }
    case "topUp": {
      const outcome = await account.signAndSendTransaction({
        receiverId: step.account,
        actions: [actions.transfer(step.fundYocto)],
        waitUntil: "INCLUDED",
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
        waitUntil: "INCLUDED",
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
        waitUntil: "INCLUDED",
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
        waitUntil: "INCLUDED",
      });
      return { txHash: outcome.transaction_outcome.id };
    }
  }
}

export function wasmCodeHash(wasm: Uint8Array): CodeHash {
  return createHash("sha256").update(wasm).digest("hex") as CodeHash;
}
