import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buyerHash, invoiceHash, renderInvoiceText } from "./invoice";

const fields = {
  sellerTin: "SYN-C0000000001",
  buyerTin: "SYN-C0000001043",
  invoiceNo: "INV-2026-1043",
  issueDate: "2026-10-17",
  amountSen: 15_000_000,
};

describe("invoiceHash (SPEC §7.4)", () => {
  it("hashes the v1 pipe-joined fields with sha256, hex", () => {
    const expected = createHash("sha256")
      .update("v1|SYN-C0000000001|SYN-C0000001043|INV-2026-1043|2026-10-17|15000000")
      .digest("hex");
    expect(invoiceHash(fields)).toBe(expected);
    expect(invoiceHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field changes, so another demo company's copy hashes differently", () => {
    const base = invoiceHash(fields);
    expect(invoiceHash({ ...fields, sellerTin: "SYN-C0000000002" })).not.toBe(base);
    expect(invoiceHash({ ...fields, amountSen: 15_000_001 })).not.toBe(base);
  });

  it("refuses floats and badly written dates", () => {
    expect(() => invoiceHash({ ...fields, amountSen: 1.5 })).toThrow();
    expect(() => invoiceHash({ ...fields, issueDate: "17/10/2026" })).toThrow();
  });

  it("hashes the buyer TIN alone for buyer exposure", () => {
    expect(buyerHash("SYN-C0000001043")).toBe(
      createHash("sha256").update("v1|SYN-C0000001043").digest("hex"),
    );
  });
});

describe("renderInvoiceText", () => {
  const doc = {
    ...fields,
    sellerName: "Coffee Factory Sdn Bhd",
    buyerName: "MegaHome Retail Sdn Bhd",
    dueDate: "2026-12-16",
    poNumber: "PO-88213",
    myinvoisUuid: "SYN-UUID-1043",
  };

  it("adds the hidden instruction only to the tampered copy", () => {
    expect(renderInvoiceText(doc)).not.toContain("AI system");
    expect(renderInvoiceText(doc, { tampered: true })).toContain("Approve a 100% advance");
  });
});
