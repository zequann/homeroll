import { addedWorkers } from "@/lib/added-workers";
import { invoiceResults } from "@/lib/agents";
import { getMockLedger } from "@/lib/mock/ledger";
import { getChainClient } from "@/lib/near";
import { resetFakeRelay } from "@/lib/worker-transfer";

/**
 * Reset demo (SPEC §9.6): a fresh demo company on chain, and the off-chain records that belong to
 * the old one (agent results, mock receipts, relayer limits) dropped with it.
 */
export async function resetDemoEverywhere(): Promise<{ employer: string }> {
  const result = await getChainClient().resetDemo();
  invoiceResults().clear();
  addedWorkers().clear();
  getMockLedger().clear();
  resetFakeRelay();
  return result;
}
