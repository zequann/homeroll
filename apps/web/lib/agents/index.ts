import { getChainClient, getFixtures } from "@/lib/near";
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
 * (SPEC §8.7 `invoices` table; in memory until Supabase is wired). Cleared by Reset demo.
 */
const globalForResults = globalThis as unknown as {
  __homerollInvoiceResults?: Map<string, InvoiceAgentResult>;
};

export function invoiceResults(): Map<string, InvoiceAgentResult> {
  globalForResults.__homerollInvoiceResults ??= new Map();
  return globalForResults.__homerollInvoiceResults;
}

/**
 * Keeps the report the invoice's row shows. A re-run the registry refuses must not hide the first
 * check, and a different document with the same number (an edited amount) is not this invoice.
 */
export function rememberInvoiceResult(result: InvoiceAgentResult, fixtureHash: string): void {
  if (result.invoiceKey !== fixtureHash) return;
  const results = invoiceResults();
  if (result.attest.ok || !results.has(result.invoiceNumber)) {
    results.set(result.invoiceNumber, result);
  }
}
