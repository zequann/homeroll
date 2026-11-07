import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { renderInvoiceText } from "./invoice";
import { extractInvoiceText, renderInvoicePdf } from "./invoice-pdf";

const doc = {
  sellerName: "Perabot Jaya Sdn Bhd",
  sellerTin: "SYN-C0000000001",
  buyerName: "MegaHome Retail Sdn Bhd",
  buyerTin: "SYN-C0000001043",
  invoiceNo: "INV-2026-1043",
  issueDate: "2026-10-17",
  dueDate: "2026-12-16",
  amountSen: 15_000_000,
  poNumber: "PO-88213",
  myinvoisUuid: "SYN-UUID-1043",
};

describe("invoice PDF template (SPEC §9.6)", () => {
  it("round-trips: the PDF's text layer is exactly the template's text", async () => {
    const bytes = await renderInvoicePdf(doc);
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(await extractInvoiceText(bytes)).toBe(renderInvoiceText(doc));
  });

  it("puts attack 04's instruction only in the tampered copy's text layer", async () => {
    const clean = await extractInvoiceText(await renderInvoicePdf(doc));
    const tampered = await extractInvoiceText(await renderInvoicePdf(doc, { tampered: true }));
    expect(clean).not.toContain("AI system");
    expect(tampered).toBe(renderInvoiceText(doc, { tampered: true }));
  });

  it("draws the hidden line in white and everything else in dark ink", async () => {
    const pdf = await PDFDocument.load(await renderInvoicePdf(doc, { tampered: true }));
    const contents = pdf.getPages()[0]?.node.Contents();
    const stream = contents instanceof PDFArray ? pdf.context.lookup(contents.get(0)) : contents;
    if (!(stream instanceof PDFRawStream)) throw new Error("expected one content stream");
    const content = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
    expect(content.match(/1 1 1 rg/g)).toHaveLength(1);
    const hidden = content.slice(content.indexOf("1 1 1 rg"));
    expect(hidden.match(/ Tj/g)).toHaveLength(1);
  });

  it("is reproducible, so regenerating the fixtures only changes them when the data changes", async () => {
    expect(await renderInvoicePdf(doc)).toEqual(await renderInvoicePdf(doc));
  });
});
