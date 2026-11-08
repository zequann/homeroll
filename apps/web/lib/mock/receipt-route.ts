import { z } from "zod";
import { syncLiveCompany } from "@/lib/near";
import { getMockLedger, type MockReceipt } from "./ledger";

const bodySchema = z.object({ txHash: z.string().min(1).max(128) }).strict();

/**
 * A partner's receipt for a transfer it received. Read-only: the transfer itself goes through the
 * relayer, so these routes can never move money or mint a receipt (SPEC §8.5, §8.6).
 */
export async function receiptResponse(
  request: Request,
  kind: MockReceipt["kind"],
): Promise<Response> {
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ mock: true, reason: "invalid_body" }, { status: 400 });
  await syncLiveCompany();
  const receipt = (await getMockLedger().list()).find(
    (r) => r.kind === kind && r.txHash === body.data.txHash,
  );
  if (!receipt) return Response.json({ mock: true, reason: "no_receipt" }, { status: 404 });
  return Response.json(receipt);
}
