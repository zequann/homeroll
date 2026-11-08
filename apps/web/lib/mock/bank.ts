import type { Invoice } from "@homeroll/fixtures";
import { homerollAccounts } from "@homeroll/shared";
import { getEnv } from "@/lib/env";
import { sen, senToUnits, units, unitsToSen } from "@/lib/fx";
import { getChainClient } from "@/lib/near";
import { getMockLedger, type MockReceipt } from "./ledger";

type BankReceipt = Extract<MockReceipt, { kind: "bank" }>;

/**
 * Mock bank and escrow (SPEC §8.6): the buyer pays the invoice in full into escrow, and
 * `escrow.<root>` settles it on the pool. A licensed bank escrow replaces this in production.
 */
export async function settleWithMockBank(invoice: Invoice): Promise<BankReceipt | null> {
  const chain = getChainClient();
  const { escrow } = homerollAccounts(getEnv().root);
  const paid = senToUnits(sen(invoice.amountSen));
  const before = await chain.getInvoice(invoice.hash);
  const result = await chain.settleInvoice(
    { role: "settler", accountId: escrow },
    invoice.hash,
    paid,
  );
  if (!result.ok) throw new Error(`Settling ${invoice.number} was rejected`);
  // The pool refunded the payment: already settled, or never advanced. No receipt, no money moved.
  if (!result.value.settled || !before?.advance || !before.fee) return null;
  // What the owner receives rounds down, so what the pool keeps rounds up (SPEC §10)
  const owedSen = unitsToSen(units(before.advance + before.fee), "up");
  return await getMockLedger().record<BankReceipt>(
    {
      mock: true,
      kind: "bank",
      partner: "Mock bank · escrow",
      txHash: result.txHash,
      invoiceNumber: invoice.number,
      paidSen: sen(invoice.amountSen),
      ownerGetsSen: sen(invoice.amountSen - owedSen),
      at: Date.now(),
    },
    "BANK",
  );
}
