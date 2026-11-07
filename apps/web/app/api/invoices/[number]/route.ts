import type { NextRequest } from "next/server";
import { invoicePdf } from "@/lib/agents/invoice-agent";
import { getFixtures } from "@/lib/near";

/** The demo company's invoices as downloads (SPEC §9.1). Synthetic documents, public on purpose. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ number: string }> }) {
  const { number } = await ctx.params;
  const fixtures = getFixtures();
  const invoice = fixtures.invoices.find((i) => i.number === number);
  if (!invoice) return Response.json({ reason: "unknown_invoice" }, { status: 404 });

  const tampered = request.nextUrl.searchParams.get("copy") === "tampered";
  const bytes = await invoicePdf(fixtures, invoice, { tampered });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${number}${tampered ? "-tampered" : ""}.pdf"`,
    },
  });
}
