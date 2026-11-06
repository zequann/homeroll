import { type AccountId, type HomerollAccounts, homerollAccounts } from "@homeroll/shared";
import { getEnv } from "@/lib/env";
import type { Units } from "@/lib/fx";
import { deriveKey, type RelayerSigner } from "@/lib/keys";
import { getChainClient, getFixtures } from "@/lib/near";
import type { ChainClient } from "@/lib/near/client";
import { cacheForEmployer, type EmployerCache } from "@/lib/near/demo-company";
import { decodeSignedDelegate, signDelegate } from "@/lib/near/rpc";
import { ExposureLog } from "@/lib/relay/exposure";
import { type RuleName, relay } from "@/lib/relay/relay";

/**
 * A worker's send home or cash out on the fake chain. It signs a real delegate action and passes
 * it through the same `relay()` that `POST /api/relay` uses, so one policy applies everywhere
 * (SPEC §8.3). Only the submit step differs: the fake chain's ft_transfer, not the network.
 */

/**
 * Fake chain only. Controls no account on any network: testnet keys derive from SERVER_KEY_SEED,
 * which this file never reads. It exists so the fake path signs and verifies real signatures.
 */
const FAKE_CHAIN_SEED = "00".repeat(32);
/** The fake chain has no blocks. Fixed values satisfy the nonce and expiry rules in `relay()`. */
const FAKE_BLOCK_HEIGHT = 1_000_000n;
const DELEGATE_TTL_BLOCKS = 100n;
const FT_TRANSFER_GAS = 30n * 1_000_000_000_000n; // the rule 4 cap, until Q8 measures ft_transfer

export interface FakeRelayState {
  exposure: ExposureLog;
  /** Highest nonce used per worker, as the access key would hold it on chain. */
  nonces: Map<AccountId, bigint>;
}

export function createFakeRelayState(): FakeRelayState {
  return { exposure: ExposureLog.memory(), nonces: new Map() };
}

const globalForRelay = globalThis as unknown as {
  __homerollFakeRelay?: EmployerCache<FakeRelayState>;
};

function fakeRelayState(): FakeRelayState {
  globalForRelay.__homerollFakeRelay ??= new Map();
  return cacheForEmployer(
    globalForRelay.__homerollFakeRelay,
    getFixtures().company.accountId,
    createFakeRelayState,
  );
}

/** Reset demo: daily limits and nonces belong to the old demo company. */
export function resetFakeRelay(): void {
  globalForRelay.__homerollFakeRelay ??= new Map();
  globalForRelay.__homerollFakeRelay.set(getFixtures().company.accountId, createFakeRelayState());
}

export type TransferResult =
  | { ok: true; txHash: string }
  | { ok: false; rule: RuleName | "unavailable"; message: string };

const REFUSAL: Record<RuleName, string> = {
  one_action: "That transfer is not one the relayer pays for.",
  receiver_and_method: "That transfer is not one the relayer pays for.",
  deposit_yocto: "That transfer is not one the relayer pays for.",
  prepaid_gas: "That transfer asks for too much gas.",
  token_receiver: "Money can only go to the payout partner or DuitNow.",
  amount_cap: "Each transfer can be at most RM2,000, and RM4,000 a day. Try a smaller amount.",
  known_worker: "This account is not a known worker account.",
  rate_limit: "Too many transfers today. Try again tomorrow.",
};

export async function fakeChainTransfer(
  chain: ChainClient,
  accounts: HomerollAccounts,
  state: FakeRelayState,
  from: AccountId,
  to: AccountId,
  amount: Units,
  memo: string,
): Promise<TransferResult> {
  const worker = deriveKey(FAKE_CHAIN_SEED, from, "worker");
  const relayer: RelayerSigner = deriveKey(FAKE_CHAIN_SEED, accounts.relayer, "relayer");
  const nonce = (state.nonces.get(from) ?? 0n) + 1n;
  const signed = await signDelegate(worker, {
    senderId: from,
    receiverId: accounts.tusdc,
    method: "ft_transfer",
    args: new TextEncoder().encode(
      JSON.stringify({ receiver_id: to, amount: amount.toString(), memo }),
    ),
    gas: FT_TRANSFER_GAS,
    depositYocto: 1n,
    nonce,
    maxBlockHeight: FAKE_BLOCK_HEIGHT + DELEGATE_TTL_BLOCKS,
    publicKey: worker.publicKey,
  });

  const result = await relay(Buffer.from(signed).toString("base64"), {
    accounts,
    now: () => new Date(),
    blockHeight: async () => FAKE_BLOCK_HEIGHT,
    accessKey: async (accountId, publicKey) =>
      publicKey === deriveKey(FAKE_CHAIN_SEED, accountId, "worker").publicKey
        ? { nonce: state.nonces.get(accountId) ?? 0n, permission: "FullAccess" }
        : null,
    exposure: state.exposure,
    relayer,
    submit: async (payable) => {
      // The policy passed; this is where the real path broadcasts the signed delegate.
      const decoded = decodeSignedDelegate(payable.raw);
      if (!decoded.ok) throw new Error("Signed delegate did not decode");
      const tx = await chain.ftTransfer(
        { role: "worker", accountId: decoded.delegate.senderId },
        to,
        amount,
        memo,
      );
      if (!tx.ok) throw new Error("ft_transfer was rejected after the relayer policy passed");
      state.nonces.set(from, nonce);
      return { txHash: tx.txHash };
    },
  });

  if (result.status === 200) return { ok: true, txHash: result.body.txHash };
  if (result.status === 403) {
    return { ok: false, rule: result.body.rule, message: REFUSAL[result.body.rule] };
  }
  return { ok: false, rule: "unavailable", message: "The relayer is unavailable. Try again." };
}

function refusalFromRelay(message: string): TransferResult | null {
  const marker = "relay rejected: ";
  const at = message.indexOf(marker);
  if (at < 0) return null;
  try {
    const body = JSON.parse(message.slice(at + marker.length)) as { rule?: string };
    if (body.rule && body.rule in REFUSAL) {
      const rule = body.rule as RuleName;
      return { ok: false, rule, message: REFUSAL[rule] };
    }
  } catch {
    return { ok: false, rule: "unavailable", message: "The relayer is unavailable. Try again." };
  }
  return { ok: false, rule: "unavailable", message: "The relayer is unavailable. Try again." };
}

/** Fake chain signs locally. Testnet uses the worker key and the same relayer policy. */
export async function workerTransfer(
  from: AccountId,
  to: AccountId,
  amount: Units,
  memo: string,
): Promise<TransferResult> {
  const env = getEnv();
  const chain = getChainClient();
  if (env.chainClient === "fake") {
    return fakeChainTransfer(
      chain,
      homerollAccounts(env.root),
      fakeRelayState(),
      from,
      to,
      amount,
      memo,
    );
  }
  try {
    const tx = await chain.ftTransfer({ role: "worker", accountId: from }, to, amount, memo);
    if (!tx.ok) return { ok: false, rule: "unavailable", message: "The transfer was rejected." };
    return { ok: true, txHash: tx.txHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return (
      refusalFromRelay(message) ?? {
        ok: false,
        rule: "unavailable",
        message: "The relayer is unavailable. Try again.",
      }
    );
  }
}
