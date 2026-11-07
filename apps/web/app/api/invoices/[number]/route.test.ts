import { extractInvoiceText } from "@homeroll/shared/invoice-pdf";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

const get = (number: string, query = "") =>
  GET(new NextRequest(`http://localhost/api/invoices/${number}${query}`), {
    params: Promise.resolve({ number }),
  });

describe("invoice downloads (SPEC §9.1)", () => {
  it("serves the invoice as a PDF attachment", async () => {
    const response = await get("INV-2026-1043");
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain("INV-2026-1043.pdf");
    const text = await extractInvoiceText(new Uint8Array(await response.arrayBuffer()));
    expect(text).toContain("Total Payable: RM150,000.00");
    expect(text).not.toContain("AI system");
  });

  it("serves the tampered copy only when asked for it", async () => {
    const response = await get("INV-2026-1043", "?copy=tampered");
    const text = await extractInvoiceText(new Uint8Array(await response.arrayBuffer()));
    expect(text).toContain("AI system");
  });

  it("answers 404 for an invoice that does not exist", async () => {
    expect((await get("INV-NOPE")).status).toBe(404);
  });
});
