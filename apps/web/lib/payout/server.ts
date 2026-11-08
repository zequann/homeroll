import type { AccountId } from "@homeroll/shared";
import { demoKey, serverSecret } from "@/lib/demo-keys";
import { getEnv } from "@/lib/env";
import { type Sen, units, unitsToSen } from "@/lib/fx";
import { getChainClient, getFixtures } from "@/lib/near";
import { rowStore } from "@/lib/store/rows";
import { MockConfidentialRail, type OneClickStatus, PayoutStore } from "./index";
import { type Nep413Payload, type SignedData, signNep413 } from "./nep413";

/**
 * A fresh store per request, loaded from the shared rows (Supabase, or memory locally). Never one
 * per process: two requests on one instance would overwrite each other's in-memory records.
 */
function newPayoutStore(): PayoutStore {
  return new PayoutStore(rowStore(), () => getFixtures().company.accountId);
}

export async function payoutRail(
  store: PayoutStore = newPayoutStore(),
): Promise<MockConfidentialRail> {
  await store.load();
  return new MockConfidentialRail({
    chain: getChainClient(),
    root: getEnv().root,
    store,
    now: Date.now,
  });
}

/** Reset demo: the old company's quotes and nonces. */
export async function clearPayouts(): Promise<void> {
  await newPayoutStore().clear();
}

/** The owner's NEP-413 signature, made with the owner's demo key behind "Demo mode" (D7). */
export function ownerSigns(employer: AccountId): (payload: Nep413Payload) => Promise<SignedData> {
  return (payload) => signNep413(employer, demoKey(employer, "owner").secretKey, payload);
}

/** The owner's payout panel: the employer's latest approved payout, as plain data. */
export interface PayoutPanelView {
  status: OneClickStatus;
  intentHash: string;
  /** `pay_run` hashes: public testnet transfers in this build. */
  nearTxHashes: string[];
  lineCount: number;
  amountSen: Sen;
}

export async function loadPayoutPanel(employer: AccountId): Promise<PayoutPanelView | null> {
  const store = newPayoutStore();
  const rail = await payoutRail(store);
  const address = rail.latestApproved(employer);
  if (!address) return null;
  const status = await rail.status(address);
  if (!status.ok) return null;
  const { swapDetails, quoteResponse } = status.value;
  const message = JSON.parse(store.quotes.get(address)?.payload?.message ?? "{}") as {
    intents?: unknown[];
  };
  return {
    status: status.value.status,
    intentHash: swapDetails.intentHashes[0] ?? "",
    nearTxHashes: swapDetails.nearTxHashes,
    lineCount: message.intents?.length ?? 0,
    amountSen: unitsToSen(units(BigInt(quoteResponse.quote.amountOut)), "nearest"),
  };
}

/** The key that seals payout approvals (SPEC §8.11), derived from the server seed. */
export function approvalSecret(): Uint8Array {
  return serverSecret("payout-approval");
}
