import { z } from "zod";
import { invoiceAgentDeps, rememberInvoiceResult } from "@/lib/agents";
import { invoiceDocumentFromPdf, runInvoiceAgent } from "@/lib/agents/invoice-agent";
import { checkUploadedInvoice } from "@/lib/agents/upload";
import { syncLiveCompany } from "@/lib/near";

const bodySchema = z
  .object({ invoiceNumber: z.string().max(40), tampered: z.boolean().optional() })
  .strict();

/** Invoice agent (SPEC §8.1). Runs for the shared demo company: it attests with the agent's key. */
export async function POST(request: Request): Promise<Response> {
  await syncLiveCompany();
  // Multipart = an uploaded PDF (curl -F file=@invoice.pdf). JSON = one of the company's own.
  if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return uploaded(request);
  }

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ reason: "invalid_body" }, { status: 400 });

  const deps = invoiceAgentDeps();
  const invoice = deps.fixtures.invoices.find((i) => i.number === body.data.invoiceNumber);
  if (!invoice) return Response.json({ reason: "unknown_invoice" }, { status: 404 });

  const document = await invoiceDocumentFromPdf(deps.fixtures, invoice, {
    tampered: body.data.tampered,
  });
  const result = await runInvoiceAgent(deps, document);
  await rememberInvoiceResult(result, invoice.hash);
  return Response.json({ mock: result.model.mock, ...result });
}

async function uploaded(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ reason: "not-a-pdf" }, { status: 400 });

  const deps = invoiceAgentDeps();
  const outcome = await checkUploadedInvoice(deps, new Uint8Array(await file.arrayBuffer()));
  if (!outcome.ok) {
    const status = outcome.reason === "too-large" ? 413 : 422;
    return Response.json({ reason: outcome.reason, message: outcome.message }, { status });
  }
  const fixture = deps.fixtures.invoices.find((i) => i.number === outcome.result.invoiceNumber);
  if (fixture) await rememberInvoiceResult(outcome.result, fixture.hash);
  return Response.json({ mock: outcome.result.model.mock, ...outcome.result });
}
