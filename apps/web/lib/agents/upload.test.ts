import { invoiceInput, loadFixtures } from "@homeroll/fixtures";
import { renderInvoicePdf } from "@homeroll/shared/invoice-pdf";
import { describe, expect, it } from "vitest";
import { createActivityLog } from "@/lib/activity";
import { FakeChainClient } from "@/lib/near/fake";
import { MockInference } from "./inference";
import { mockMyInvois } from "./myinvois";
import { checkUploadedInvoice } from "./upload";
import { MAX_INVOICE_BYTES } from "./upload-limits";

function make() {
  const fixtures = loadFixtures("homeroll-test.testnet");
  const chain = new FakeChainClient({
    fixtures,
    now: () => Date.UTC(2026, 10, 5),
    activity: createActivityLog(),
  });
  const deps = {
    chain,
    fixtures,
    inference: new MockInference(),
    myinvois: mockMyInvois(fixtures),
  };
  const invoice = fixtures.invoices[0];
  if (!invoice) throw new Error("no invoice");
  return { fixtures, chain, deps, invoice, input: invoiceInput(fixtures, invoice) };
}

describe("invoice upload (SPEC §9.1)", () => {
  it("checks, grades and registers an uploaded invoice", async () => {
    const { chain, deps, invoice, input } = make();
    const outcome = await checkUploadedInvoice(deps, await renderInvoicePdf(input));
    expect(outcome.ok && outcome.result.grade).toBe("A");
    expect(outcome.ok && outcome.result.offer?.advanceSen).toBe(12_000_000);
    expect((await chain.getInvoice(invoice.hash))?.status).toBe("Attested");
  });

  it("attack 04 by upload: hidden text fools the model, code keeps Grade A and 80% (R8, R9)", async () => {
    const { deps, input } = make();
    const bytes = await renderInvoicePdf(input, { tampered: true });
    const outcome = await checkUploadedInvoice(deps, bytes);
    if (!outcome.ok) throw new Error("expected a result");
    expect(outcome.result.model.suggestedGrade).toBe("A+");
    expect(outcome.result.grade).toBe("A");
    expect(outcome.result.offer?.advanceBps).toBe(8000);
  });

  it("declines a PDF whose amount was edited: its record does not match, and the real invoice is untouched", async () => {
    const { chain, deps, invoice, input } = make();
    const edited = await renderInvoicePdf({ ...input, amountSen: input.amountSen * 2 });
    const outcome = await checkUploadedInvoice(deps, edited);
    if (!outcome.ok) throw new Error("expected a result");
    expect(outcome.result.grade).toBe("D");
    expect(outcome.result.checks.find((c) => c.id === "myinvois")?.result).toBe("fail");
    expect(outcome.result.invoiceKey).not.toBe(invoice.hash);
    expect(await chain.getInvoice(invoice.hash)).toBeNull();
  });

  it("refuses the same invoice twice at the pool (R7)", async () => {
    const { deps, input } = make();
    const bytes = await renderInvoicePdf(input);
    await checkUploadedInvoice(deps, bytes);
    const again = await checkUploadedInvoice(deps, bytes);
    expect(again.ok && !again.result.attest.ok && again.result.attest.failure.code).toBe(
      "ERR_INVOICE_ALREADY_REGISTERED",
    );
  });

  it("refuses an invoice number this company does not have, and registers nothing", async () => {
    const { chain, deps, input } = make();
    const before = (await chain.getPool()).cash;
    const outcome = await checkUploadedInvoice(
      deps,
      await renderInvoicePdf({ ...input, invoiceNo: "INV-2026-9999" }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "unknown-invoice" });
    expect((await chain.getPool()).cash).toBe(before);
  });

  it("refuses a file that is not a PDF, a PDF with no invoice, a broken PDF, and an oversized file", async () => {
    const { deps } = make();
    const text = new TextEncoder().encode("Total Payable (sen): 1");
    expect(await checkUploadedInvoice(deps, text)).toMatchObject({ reason: "not-a-pdf" });

    // A real PDF with one empty page: no invoice text to read.
    const blank = new TextEncoder().encode(
      "%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
    );
    expect(await checkUploadedInvoice(deps, blank)).toMatchObject({ reason: "unreadable" });

    const broken = new TextEncoder().encode("%PDF-1.7 not really");
    expect(await checkUploadedInvoice(deps, broken)).toMatchObject({ reason: "unreadable" });

    const huge = new Uint8Array(MAX_INVOICE_BYTES + 1);
    expect(await checkUploadedInvoice(deps, huge)).toMatchObject({ reason: "too-large" });
  });
});
