import { getActivityLog } from "@/lib/activity";
import { clearAddedWorkers } from "@/lib/added-workers";
import { clearInvoiceResults } from "@/lib/agents";
import { getMockLedger } from "@/lib/mock/ledger";
import { getChainClient } from "@/lib/near";
import { clearPayouts } from "@/lib/payout/server";
import { resetFakeRelay } from "@/lib/worker-transfer";

/**
 * Reset demo (SPEC §9.6): a fresh demo company on chain, and the off-chain records that belong to
 * the old one (agent results, mock receipts, relayer limits, payout approvals) dropped with it.
 */
export async function resetDemoEverywhere(): Promise<{ employer: string }> {
  const result = await getChainClient().resetDemo();
  await clearInvoiceResults();
  await clearAddedWorkers();
  await getMockLedger().clear();
  resetFakeRelay();
  // Rahim's "Sent to Amma" list reads this log; a fresh company starts with none. With
  // Supabase the shared rows are scoped by employer, so the new company starts empty there too.
  getActivityLog().clear();
  // A fresh company reuses run id 0: an approval for the old run must not pay the new one (R17)
  await clearPayouts();
  return result;
}
