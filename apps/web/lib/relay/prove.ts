import { homerollAccounts, workerAccountId } from "@homeroll/shared";
import { type DeployInput, deployHomeroll, planCreateWorker, planMint } from "../deploy/deploy";
import { type Units } from "../fx";
import { deriveKey } from "../keys";
import {
  accessKey,
  blockHeight,
  broadcastAdmin,
  configureRpc,
  ftBalanceOf,
  signDelegate,
  viewAccount,
} from "../near/rpc";

export type ProofInput = {
  network: "testnet";
  root: DeployInput["root"];
  rpcUrl: string;
  relayUrl: string;
  adminSecretKey: string;
  seedHex: string;
  workerName: string;
  amount: Units;
  to: "payout" | "offramp";
};

export type ProofResult =
  | {
      ok: true;
      txHash: string;
      worker: string;
      workerBalanceBeforeYocto: string;
      workerBalanceAfterYocto: string;
      relayerBalanceBeforeYocto: string;
      relayerBalanceAfterYocto: string;
    }
  | { ok: false; status: 403; rule: string }
  | {
      ok: false;
      blocked:
        | "admin_key_missing"
        | "seed_missing"
        | "deploy_refused"
        | "deploy_blocked"
        | "foreign_worker_key"
        | "insufficient_root_balance"
        | "relay_unreachable"
        | "balance_unreadable";
    };

const MIN_ROOT_BEFORE_CREATE = 2n * 10n ** 23n;

export async function proveGaslessTransfer(input: ProofInput): Promise<ProofResult> {
  configureRpc(input.rpcUrl);
  const accounts = homerollAccounts(input.root);
  const worker = workerAccountId(input.workerName, input.root);
  const relayerAccount = accounts.relayer;

  const deploy = await deployHomeroll({
    network: "testnet",
    root: input.root,
    rpcUrl: input.rpcUrl,
    adminSecretKey: input.adminSecretKey,
    seedHex: input.seedHex,
  });
  if (deploy.outcome === "refused") {
    return { ok: false, blocked: "deploy_refused" };
  }
  if (deploy.outcome === "blocked") {
    return { ok: false, blocked: "deploy_blocked" };
  }

  const workerKey = deriveKey(input.seedHex, worker, "worker");
  const workerView = await viewAccount(worker);
  const admin = { role: "admin" as const, accountId: input.root, secretKey: input.adminSecretKey };

  if (!workerView.exists) {
    const rootView = await viewAccount(input.root);
    if (rootView.balanceYocto < MIN_ROOT_BEFORE_CREATE) {
      return { ok: false, blocked: "insufficient_root_balance" };
    }
    await broadcastAdmin(planCreateWorker(accounts, input.workerName, workerKey.publicKey), admin);
  } else if (!workerView.fullAccessKeys.includes(workerKey.publicKey)) {
    return { ok: false, blocked: "foreign_worker_key" };
  }

  const balance = await ftBalanceOf(accounts.tusdc, worker);
  if (balance < input.amount) {
    await broadcastAdmin(planMint(accounts, worker, input.amount - balance), admin);
  }

  let workerBefore: bigint;
  let relayerBefore: bigint;
  try {
    workerBefore = (await viewAccount(worker)).balanceYocto;
    relayerBefore = (await viewAccount(relayerAccount)).balanceYocto;
  } catch {
    return { ok: false, blocked: "balance_unreadable" };
  }

  const height = await blockHeight();
  const key = await accessKey(worker, workerKey.publicKey);
  const nonce = (key?.nonce ?? 0n) + 1n;
  const destination = input.to === "payout" ? accounts.payout : accounts.offramp;
  const args = new TextEncoder().encode(
    JSON.stringify({ receiver_id: destination, amount: input.amount.toString() }),
  );
  const signed = await signDelegate(workerKey, {
    senderId: worker,
    receiverId: accounts.tusdc,
    method: "ft_transfer",
    args,
    gas: 15n * 1_000_000_000_000n,
    depositYocto: 1n,
    nonce,
    maxBlockHeight: height + 120n,
    publicKey: workerKey.publicKey,
  });
  const signedDelegate = Buffer.from(signed).toString("base64");

  let response: Response;
  try {
    response = await fetch(input.relayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedDelegate }),
    });
  } catch {
    return { ok: false, blocked: "relay_unreachable" };
  }

  const payload = (await response.json()) as { txHash?: string; rule?: string };
  if (response.status === 403 && payload.rule) {
    return { ok: false, status: 403, rule: payload.rule };
  }
  if (response.status !== 200 || !payload.txHash) {
    return { ok: false, blocked: "relay_unreachable" };
  }

  let workerAfter: bigint;
  let relayerAfter: bigint;
  try {
    workerAfter = (await viewAccount(worker)).balanceYocto;
    relayerAfter = (await viewAccount(relayerAccount)).balanceYocto;
  } catch {
    return { ok: false, blocked: "balance_unreadable" };
  }

  return {
    ok: true,
    txHash: payload.txHash,
    worker,
    workerBalanceBeforeYocto: workerBefore.toString(),
    workerBalanceAfterYocto: workerAfter.toString(),
    relayerBalanceBeforeYocto: relayerBefore.toString(),
    relayerBalanceAfterYocto: relayerAfter.toString(),
  };
}
