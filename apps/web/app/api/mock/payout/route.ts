import { receiptResponse } from "@/lib/mock/receipt-route";

/** Remittance payout, mocked (SPEC §8.6): the receipt for a transfer it already received. */
export function POST(request: Request): Promise<Response> {
  return receiptResponse(request, "payout");
}
