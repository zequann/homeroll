import { z } from "zod";
import { invoiceAgentDeps, invoiceResults } from "@/lib/agents";
import { invoiceDocumentFromPdf, runInvoiceAgent } from "@/lib/agents/invoice-agent";
import { requireSigner } from "@/lib/session";

const bodySchema = z
  .object({ invoiceNumber: z.string().max(40), tampered: z.boolean().optional() })
  .strict();

/** Invoice agent (SPEC §8.1). Needs the owner's demo session: it attests with the agent's key. */
export async function POST(request: Request): Promise<Response> {
  const session = await requireSigner("owner");
  if (!session.connected) return Response.json({ reason: "not_connected" }, { status: 401 });

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ reason: "invalid_body" }, { status: 400 });

  const deps = invoiceAgentDeps();
  const invoice = deps.fixtures.invoices.find((i) => i.number === body.data.invoiceNumber);
  if (!invoice) return Response.json({ reason: "unknown_invoice" }, { status: 404 });

  const document = await invoiceDocumentFromPdf(deps.fixtures, invoice, {
    tampered: body.data.tampered,
  });
  const result = await runInvoiceAgent(deps, document);
  if (result.attest.ok || !invoiceResults().has(invoice.number)) {
    invoiceResults().set(invoice.number, result);
  }
  return Response.json({ mock: result.model.mock, ...result });
}
