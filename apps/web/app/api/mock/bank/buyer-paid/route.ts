import { revalidatePath } from "next/cache";
import { z } from "zod";
import { settleWithMockBank } from "@/lib/mock/bank";
import { getFixtures } from "@/lib/near";
import { requireSigner } from "@/lib/session";

const bodySchema = z.object({ invoiceNumber: z.string().max(40) }).strict();

/** Mock bank: the buyer paid in full, escrow settles on the pool (SPEC §8.6). Moves demo money. */
export async function POST(request: Request): Promise<Response> {
  const session = await requireSigner("owner");
  if (!session.connected) {
    return Response.json({ mock: true, reason: "not_connected" }, { status: 401 });
  }
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ mock: true, reason: "invalid_body" }, { status: 400 });
  const invoice = getFixtures().invoices.find((i) => i.number === body.data.invoiceNumber);
  if (!invoice) return Response.json({ mock: true, reason: "unknown_invoice" }, { status: 404 });

  const receipt = await settleWithMockBank(invoice);
  revalidatePath("/owner");
  revalidatePath("/lender");
  // The pool refunds with no error when the invoice is not advanced (SPEC §7.4)
  if (!receipt) return Response.json({ mock: true, settled: false });
  return Response.json({ settled: true, ...receipt });
}
