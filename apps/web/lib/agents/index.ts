import { getChainClient, getFixtures } from "@/lib/near";
import { rowStore } from "@/lib/store/rows";
import { MockInference } from "./inference";
import type { InvoiceAgentDeps, InvoiceAgentResult } from "./invoice-agent";
import { mockMyInvois } from "./myinvois";

/** The invoice agent as the server runs it: mock model (D12), mock MyInvois, the configured chain. */
export function invoiceAgentDeps(): InvoiceAgentDeps {
  const fixtures = getFixtures();
  return {
    chain: getChainClient(),
    fixtures,
    inference: new MockInference(),
    myinvois: mockMyInvois(fixtures),
  };
}

/**
 * The agent's last result per invoice number: check results, grade and what the model said
 * (SPEC §8.7 `invoices` table): Supabase when configured, memory otherwise. Scoped by the demo
 * employer, so a Reset demo starts on none.
 */
const scope = () => getFixtures().company.accountId;

export async function loadInvoiceResults(): Promise<Map<string, InvoiceAgentResult>> {
  const rows = await rowStore().list<InvoiceAgentResult>("invoices", scope());
  return new Map(rows.map((r) => [r.key, r.data]));
}

export async function saveInvoiceResult(result: InvoiceAgentResult): Promise<void> {
  await rowStore().upsert("invoices", scope(), result.invoiceNumber, result);
}

export async function clearInvoiceResults(): Promise<void> {
  await rowStore().clear("invoices", scope());
}

/**
 * Keeps the report the invoice's row shows. A re-run the registry refuses must not hide the first
 * check, and a different document with the same number (an edited amount) is not this invoice.
 */
export async function rememberInvoiceResult(
  result: InvoiceAgentResult,
  fixtureHash: string,
): Promise<void> {
  if (result.invoiceKey !== fixtureHash) return;
  if (result.attest.ok) return saveInvoiceResult(result);
  const existing = await rowStore().get<InvoiceAgentResult>(
    "invoices",
    scope(),
    result.invoiceNumber,
  );
  if (!existing) await saveInvoiceResult(result);
}
