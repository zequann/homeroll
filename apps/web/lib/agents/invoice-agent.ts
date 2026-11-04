import type { Fixtures, Invoice } from "@homeroll/fixtures";
import { homerollAccounts } from "@homeroll/shared";
import { buyerHash, invoiceHash, renderInvoiceText } from "@homeroll/shared/invoice";
import { describeFailure, type FailureView } from "@/lib/describe-failure";
import { feeSen, type Sen, sen, senToUnits } from "@/lib/fx";
import type { ChainClient, Grade } from "@/lib/near/client";
import { GRADE_TABLE, maxAdvanceBps } from "@/lib/pool-grades";
import { applyModelGrade, type Check, ruleGrade } from "./grading";
import { buildExtractionPrompt, type InferenceClient, modelOutputSchema } from "./inference";
import type { MyInvoisClient } from "./myinvois";

/**
 * Invoice agent (SPEC §8.1): extract with the model, check in code, grade in code, attest on the
 * pool with the agent's function-call key. The pool decides; this file only proposes.
 */

export interface InvoiceAgentDeps {
  chain: ChainClient;
  fixtures: Fixtures;
  inference: InferenceClient;
  myinvois: MyInvoisClient;
}

export interface AdvanceOffer {
  advanceBps: number;
  feeBps: number;
  advanceSen: Sen;
  feeSen: Sen;
  /** advance + fee: what the pool gets back when the buyer pays. */
  poolGetsBackSen: Sen;
  /** What the owner receives on settlement. */
  ownerGetsSen: Sen;
}

/** Plain data only (no bigint), so a server action can return it. */
export interface InvoiceAgentResult {
  invoiceNumber: string;
  invoiceKey: string;
  model: {
    label: string;
    mock: boolean;
    suggestedGrade: string | null;
    suggestedAdvancePercent: number | null;
    flags: string[];
    /** Fields the model returned that the schema does not know, dropped before use. */
    droppedFields: string[];
    ignored: string | null;
  };
  checks: Check[];
  ruleGrade: Grade;
  grade: Grade;
  offer: AdvanceOffer | null;
  attest: { ok: true; txHash: string } | { ok: false; failure: FailureView };
}

/** The synthetic document for a fixture invoice, as its text layer reads (SPEC §9.6 template). */
export function invoiceDocument(f: Fixtures, inv: Invoice, opts?: { tampered?: boolean }): string {
  return renderInvoiceText(
    {
      sellerName: f.company.name,
      sellerTin: f.company.sellerTin,
      buyerName: inv.buyer,
      buyerTin: inv.buyerTin,
      invoiceNo: inv.number,
      issueDate: inv.issued,
      dueDate: inv.due,
      amountSen: inv.amountSen,
      poNumber: inv.poNumber,
      myinvoisUuid: inv.myinvoisUuid,
    },
    opts,
  );
}

export function offerFor(amountSen: Sen, grade: Grade): AdvanceOffer | null {
  if (grade === "D") return null;
  const advanceBps = maxAdvanceBps(grade);
  const { feeBps } = GRADE_TABLE[grade];
  // Advances round down; fees round up (SPEC §10)
  const advance = sen(Math.floor((amountSen * advanceBps) / 10_000));
  const fee = feeSen(advance, feeBps);
  return {
    advanceBps,
    feeBps,
    advanceSen: advance,
    feeSen: fee,
    poolGetsBackSen: sen(advance + fee),
    ownerGetsSen: sen(amountSen - advance - fee),
  };
}

export async function runInvoiceAgent(
  deps: InvoiceAgentDeps,
  documentText: string,
): Promise<InvoiceAgentResult> {
  const { chain, fixtures, inference, myinvois } = deps;

  // 1. Extract. The raw output is untrusted: parse strictly, drop unknown fields.
  const raw = await inference.extract(buildExtractionPrompt(documentText));
  const parsed = modelOutputSchema.parse(raw);
  const droppedFields =
    raw && typeof raw === "object" ? Object.keys(raw).filter((k) => !(k in parsed)) : [];

  // Evidence is looked up by what the document claims, then compared in code.
  const evidence = fixtures.invoices.find((i) => i.number === parsed.invoiceNo);
  if (!evidence) throw new Error(`No synthetic evidence for ${parsed.invoiceNo}`);
  const invoiceKey = invoiceHash({
    sellerTin: parsed.sellerTin,
    buyerTin: parsed.buyerTin,
    invoiceNo: parsed.invoiceNo,
    issueDate: parsed.issueDate,
    amountSen: parsed.amountSen,
  });

  // 2. Check, in deterministic code.
  const record = parsed.myinvoisUuid ? await myinvois.getDocument(parsed.myinvoisUuid) : null;
  const recordMatches =
    record !== null &&
    record.invoiceNo === parsed.invoiceNo &&
    record.amountSen === parsed.amountSen &&
    record.buyerTin === parsed.buyerTin &&
    record.sellerTin === parsed.sellerTin;
  const deliveryOk =
    evidence.deliveryOrderSigned &&
    evidence.poNumber !== null &&
    evidence.poNumber === parsed.poRef;
  const h = evidence.buyerHistory;
  const registered = await chain.getInvoice(invoiceKey);

  const checks: Check[] = [
    {
      id: "myinvois",
      title: "e-Invoice record",
      result: recordMatches ? "ok" : "fail",
      detail: recordMatches
        ? "Validated on MyInvois (mock). UUID and amount match."
        : record
          ? "MyInvois record does not match the document."
          : "No MyInvois record for this invoice number.",
    },
    {
      id: "delivery",
      title: "Purchase order and delivery",
      result: deliveryOk ? "ok" : "fail",
      detail: deliveryOk
        ? `${evidence.poNumber} matched. Delivery order signed by the buyer.`
        : "No signed delivery order uploaded.",
    },
    {
      id: "history",
      title: "Buyer payment history",
      result: h.invoices === 0 || h.paidAfter120Days > 0 ? "warn" : "ok",
      detail:
        h.invoices === 0
          ? "New buyer with no payment history."
          : h.paidAfter120Days > 0
            ? `${h.paidAfter120Days} of the last ${h.invoices} invoices were paid after 120+ days.`
            : `${h.paidOnTime} of ${h.invoices} invoices paid, average ${h.averageDays} days.`,
    },
    {
      id: "registry",
      title: "Not financed before",
      result: registered ? "fail" : "ok",
      detail: registered
        ? "This invoice hash is already in the on-chain registry."
        : "Invoice hash is not in the on-chain registry.",
    },
  ];

  // 3. Grade from the rules table; the model may only lower it (R9).
  const rule = ruleGrade(checks, h);
  const { grade, ignored } = applyModelGrade(rule, parsed.suggestedGrade);

  // 4. Attest with the agent's function-call key. The pool is the guard (R7, R10).
  const { agent } = homerollAccounts(fixtures.root);
  const result = await chain.attestInvoice(
    { role: "invoiceAgent", accountId: agent },
    {
      invoiceKey,
      employer: fixtures.company.accountId,
      buyerHash: buyerHash(parsed.buyerTin),
      amount: senToUnits(sen(parsed.amountSen)),
      dueTs: BigInt(Date.parse(`${parsed.dueDate}T00:00:00Z`)) * 1_000_000n,
      grade,
      attestationRef: "none",
    },
  );

  return {
    invoiceNumber: parsed.invoiceNo,
    invoiceKey,
    model: {
      label: inference.label,
      mock: inference.mock,
      suggestedGrade: parsed.suggestedGrade ?? null,
      suggestedAdvancePercent: parsed.suggestedAdvancePercent ?? null,
      flags: parsed.flags,
      droppedFields,
      ignored,
    },
    checks,
    ruleGrade: rule,
    grade,
    offer: offerFor(sen(parsed.amountSen), grade),
    attest: result.ok
      ? { ok: true, txHash: result.txHash }
      : {
          ok: false,
          failure: await describeFailure(chain, fixtures.company.accountId, result.failure),
        },
  };
}
