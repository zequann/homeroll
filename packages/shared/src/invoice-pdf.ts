import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { HIDDEN_INSTRUCTION, type InvoiceDocumentInput, invoiceLines } from "./invoice.ts";

/**
 * The synthetic invoice as a PDF (SPEC §9.6), from the same lines as `renderInvoiceText`, so the
 * committed fixtures and each Reset demo company's documents share one template. Server-only.
 *
 * The tampered copy carries attack 04's instruction in white text: invisible on paper, present in
 * the text layer a model reads (SPEC §11).
 */

const A4: [number, number] = [595, 842];
const MARGIN = 56;
const LINE_HEIGHT = 22;
/** Fixed so regenerating the fixtures changes nothing unless the template or its data did. */
const FIXED_DATE = new Date("2026-10-01T00:00:00.000Z");

export async function renderInvoicePdf(
  input: InvoiceDocumentInput,
  opts?: { tampered?: boolean },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Synthetic invoice ${input.invoiceNo}`);
  pdf.setProducer("Homeroll synthetic invoice template");
  pdf.setCreator("Homeroll synthetic invoice template");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);

  const page = pdf.addPage(A4);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.12, 0.12);

  let y = A4[1] - MARGIN;
  const [title, ...fields] = invoiceLines(input);
  page.drawText(title ?? "", { x: MARGIN, y, size: 15, font: bold, color: ink });
  y -= LINE_HEIGHT * 1.6;
  for (const line of fields) {
    page.drawText(line, { x: MARGIN, y, size: 11, font: regular, color: ink });
    y -= LINE_HEIGHT;
  }
  if (opts?.tampered) {
    // Attack 04: white on white, and small. Only the text layer shows it.
    page.drawText(HIDDEN_INSTRUCTION, {
      x: MARGIN,
      y,
      size: 4,
      font: regular,
      color: rgb(1, 1, 1),
    });
  }
  return pdf.save({ useObjectStreams: false });
}

/** Reads text-show operators out of a content stream. Our template writes one per line. */
const SHOW_TEXT = /<([0-9A-Fa-f]+)>\s*Tj/g;

/**
 * The text layer of a PDF made by `renderInvoicePdf`, hidden text included, as a model would read
 * it. Not a general PDF reader: other PDFs return little or nothing, and the agent's schema then
 * rejects them.
 */
export async function extractInvoiceText(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const lines: string[] = [];
  for (const page of pdf.getPages()) {
    const contents = page.node.Contents();
    const parts = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    for (const part of parts) {
      const stream = part instanceof PDFRawStream ? part : pdf.context.lookup(part);
      if (!(stream instanceof PDFRawStream)) continue;
      const content = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
      for (const match of content.matchAll(SHOW_TEXT)) {
        lines.push(Buffer.from(match[1] ?? "", "hex").toString("latin1"));
      }
    }
  }
  return lines.join("\n");
}
