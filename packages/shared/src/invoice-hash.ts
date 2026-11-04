import { createHash } from "node:crypto";

export type SellerTin = string & { readonly __sellerTin: "SellerTin" };
export type BuyerTin = string & { readonly __buyerTin: "BuyerTin" };
export type InvoiceHash = string & { readonly __invoiceHash: "InvoiceHash" };
export type BuyerHash = string & { readonly __buyerHash: "BuyerHash" };

export type InvoiceIdentity = {
  readonly seller: SellerTin;
  readonly buyer: BuyerTin;
  readonly invoiceNo: string;
  readonly issueDate: string;
  readonly amountSen: number;
};

function assertTinPart(value: string, label: string): void {
  if (value === "" || value.includes("|")) {
    throw new Error(`${label} must be non-empty and must not contain "|"`);
  }
}

/** Rejects empty parts and any `|`. */
export function sellerTin(value: string): SellerTin {
  assertTinPart(value, "seller TIN");
  return value as SellerTin;
}

export function buyerTin(value: string): BuyerTin {
  assertTinPart(value, "buyer TIN");
  return value as BuyerTin;
}

export function invoiceHash(identity: InvoiceIdentity): InvoiceHash {
  const preimage = `v1|${identity.seller}|${identity.buyer}|${identity.invoiceNo}|${identity.issueDate}|${identity.amountSen}`;
  return createHash("sha256").update(preimage).digest("hex") as InvoiceHash;
}

export function buyerHash(buyer: BuyerTin): BuyerHash {
  return createHash("sha256").update(`v1|${buyer}`).digest("hex") as BuyerHash;
}
