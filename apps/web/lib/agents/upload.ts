import { extractInvoiceText } from "@homeroll/shared/invoice-pdf";
import {
  type InvoiceAgentDeps,
  type InvoiceAgentResult,
  InvoiceNotReadable,
  runInvoiceAgent,
} from "./invoice-agent";
import { MAX_INVOICE_BYTES } from "./upload-limits";

/**
 * An invoice PDF the owner uploaded (SPEC §9.1). Everything in the file is untrusted: size and
 * type are checked first, its text is passed to the model as data (rule 5), and the checks and the
 * grade come from code. The MockInference model reads only our synthetic template (SPEC §8.1).
 */
export type UploadRefusal = "too-large" | "not-a-pdf" | "unreadable" | "unknown-invoice";

export type UploadOutcome =
  | { ok: true; result: InvoiceAgentResult }
  | { ok: false; reason: UploadRefusal; message: string };

const MESSAGE: Record<UploadRefusal, string> = {
  "too-large": "That file is too big. Invoice PDFs here are well under 512 KB.",
  "not-a-pdf": "That file is not a PDF. Upload a PDF invoice.",
  unreadable:
    "We could not read an invoice in that PDF. Homeroll reads invoices made from its template: download one above and try that.",
  "unknown-invoice":
    "That invoice is not one of this demo company's. Download one of the invoices above and upload that.",
};

const refuse = (reason: UploadRefusal): UploadOutcome => ({
  ok: false,
  reason,
  message: MESSAGE[reason],
});

export async function checkUploadedInvoice(
  deps: InvoiceAgentDeps,
  bytes: Uint8Array,
): Promise<UploadOutcome> {
  if (bytes.length > MAX_INVOICE_BYTES) return refuse("too-large");
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") return refuse("not-a-pdf");

  let text: string;
  try {
    text = await extractInvoiceText(bytes);
  } catch {
    return refuse("unreadable");
  }
  try {
    return { ok: true, result: await runInvoiceAgent(deps, text) };
  } catch (error) {
    if (error instanceof InvoiceNotReadable) return refuse(error.reason);
    throw error;
  }
}
