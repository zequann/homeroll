import type { Fixtures } from "@homeroll/fixtures";

/**
 * LHDN MyInvois, mocked (SPEC §8.6). Records come from the fixtures: a fixture invoice with no
 * `myinvoisUuid` has no record. Every response says `mock: true`.
 */
export interface MyInvoisRecord {
  mock: true;
  uuid: string;
  invoiceNo: string;
  sellerTin: string;
  buyerTin: string;
  issueDate: string;
  amountSen: number;
  status: "Valid";
}

export interface MyInvoisClient {
  getDocument(uuid: string): Promise<MyInvoisRecord | null>;
}

export function mockMyInvois(fixtures: Fixtures): MyInvoisClient {
  return {
    async getDocument(uuid) {
      const inv = fixtures.invoices.find((i) => i.myinvoisUuid === uuid);
      if (!inv?.myinvoisUuid) return null;
      return {
        mock: true,
        uuid: inv.myinvoisUuid,
        invoiceNo: inv.number,
        sellerTin: fixtures.company.sellerTin,
        buyerTin: inv.buyerTin,
        issueDate: inv.issued,
        amountSen: inv.amountSen,
        status: "Valid",
      };
    },
  };
}
