import { addedWorkers } from "@/lib/added-workers";
import { invoiceResults } from "@/lib/agents";
import { getMockLedger } from "@/lib/mock/ledger";
import { getChainClient } from "@/lib/near";
import { payoutStore } from "@/lib/payout/server";
import { resetFakeRelay } from "@/lib/worker-transfer";

/**
 * Reset demo (SPEC §9.6): a fresh demo company on chain, and the off-chain records that belong to
 * the old one (agent results, mock receipts, relayer limits, payout approvals) dropped with it.
 */
export async function resetDemoEverywhere(): Promise<{ employer: string }> {
  const result = await getChainClient().resetDemo();
  invoiceResults().clear();
  addedWorkers().clear();
  getMockLedger().clear();
  resetFakeRelay();
  // A fresh company reuses run id 0: an approval for the old run must not pay the new one (R17)
  payoutStore().clear();
  return result;
}
