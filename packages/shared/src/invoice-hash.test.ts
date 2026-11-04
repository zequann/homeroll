import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buyerHash,
  buyerTin,
  invoiceHash,
  sellerTin,
  type InvoiceIdentity,
} from "./invoice-hash";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const SELLER = sellerTin("SYN-PJ-0001");

const CASES: { invoiceNo: string; buyer: string; issued: string; amountSen: number }[] = [
  { invoiceNo: "INV-2026-1043", buyer: "SYN-MH-1043", issued: "2026-10-17", amountSen: 15_000_000 },
  { invoiceNo: "INV-2026-1047", buyer: "SYN-LB-1047", issued: "2026-10-18", amountSen: 4_200_000 },
  { invoiceNo: "INV-2026-1050", buyer: "SYN-HS-1050", issued: "2026-10-19", amountSen: 3_680_000 },
];

describe("invoiceHash", () => {
  for (const row of CASES) {
    it(`hashes ${row.invoiceNo} from the v1 preimage`, () => {
      const identity: InvoiceIdentity = {
        seller: SELLER,
        buyer: buyerTin(row.buyer),
        invoiceNo: row.invoiceNo,
        issueDate: row.issued,
        amountSen: row.amountSen,
      };
      const preimage = `v1|${SELLER}|${row.buyer}|${row.invoiceNo}|${row.issued}|${row.amountSen}`;
      expect(invoiceHash(identity)).toBe(sha256Hex(preimage));
      expect(buyerHash(buyerTin(row.buyer))).toBe(sha256Hex(`v1|${row.buyer}`));
    });
  }

  it("rejects a pipe in a TIN", () => {
    expect(() => sellerTin("bad|tin")).toThrow();
  });
});
