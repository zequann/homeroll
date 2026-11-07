import type { AccountId } from "@homeroll/shared";
import { demoKey, serverSecret } from "@/lib/demo-keys";
import { getEnv } from "@/lib/env";
import { type Sen, units, unitsToSen } from "@/lib/fx";
import { getChainClient } from "@/lib/near";
import { MockConfidentialRail, type OneClickStatus, PayoutStore } from "./index";
import { type Nep413Payload, type SignedData, signNep413 } from "./nep413";

// One store per server process, kept on globalThis so dev hot reload does not drop approvals.
const globalForPayout = globalThis as unknown as { __homerollPayoutStore?: PayoutStore };

export function payoutStore(): PayoutStore {
  globalForPayout.__homerollPayoutStore ??= new PayoutStore();
  return globalForPayout.__homerollPayoutStore;
}

export function payoutRail(): MockConfidentialRail {
  return new MockConfidentialRail({
    chain: getChainClient(),
    root: getEnv().root,
    store: payoutStore(),
    now: Date.now,
  });
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
  const rail = payoutRail();
  const address = rail.latestApproved(employer);
  if (!address) return null;
  const status = await rail.status(address);
  if (!status.ok) return null;
  const { swapDetails, quoteResponse } = status.value;
  const message = JSON.parse(payoutStore().quotes.get(address)?.payload?.message ?? "{}") as {
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
