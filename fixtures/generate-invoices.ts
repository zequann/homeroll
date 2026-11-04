#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderInvoicePdf } from "@homeroll/shared/invoice-pdf";
import { invoiceInput, loadFixtures } from "./index.ts";

/**
 * Writes the committed invoice PDFs: `pnpm fixtures:invoices`. The app renders the same template
 * at runtime, so local runs, CI and the hosted app use identical documents (SPEC §9.6). The PDFs
 * hold no account IDs, so the root here does not reach them.
 */
const fixtures = loadFixtures("homeroll-demo.testnet");
const dir = join(import.meta.dirname, "invoices");
mkdirSync(dir, { recursive: true });

for (const invoice of fixtures.invoices) {
  const input = invoiceInput(fixtures, invoice);
  writeFileSync(join(dir, `${invoice.number}.pdf`), await renderInvoicePdf(input));
}
const target = fixtures.invoices.find((i) => i.number === "INV-2026-1043");
if (!target) throw new Error("INV-2026-1043 is missing from the fixtures");
writeFileSync(
  join(dir, `${target.number}-tampered.pdf`),
  await renderInvoicePdf(invoiceInput(fixtures, target), { tampered: true }),
);
