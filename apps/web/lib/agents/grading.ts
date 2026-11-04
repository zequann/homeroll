import type { Invoice } from "@homeroll/fixtures";
import type { Grade } from "@/lib/near/client";

/**
 * Deterministic grading (SPEC §8.1 step 3, principle 3). Code decides the grade from the checks;
 * the model may only lower it (rule R9). Nothing in this file reads model output except
 * `applyModelGrade`, and that function can only return the same grade or a worse one.
 */

export type CheckResult = "ok" | "warn" | "fail";
export interface Check {
  id: "myinvois" | "delivery" | "history" | "registry";
  title: string;
  detail: string;
  result: CheckResult;
}

const ORDER: Grade[] = ["A", "B", "C", "D"];
const worse = (a: Grade, b: Grade): Grade => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

export function historyGrade(h: Invoice["buyerHistory"]): Grade {
  // A buyer with no record is not trusted with a top grade
  if (h.invoices === 0) return "C";
  // 10% or more of invoices paid after 120 days → C (SPEC §4: "late payment history")
  if (h.paidAfter120Days * 10 >= h.invoices) return "C";
  if (h.paidOnTime === h.invoices && h.invoices >= 20) return "A";
  return "B";
}

/** Rules table: a failed document check declines the invoice; otherwise payment history decides. */
export function ruleGrade(checks: Check[], history: Invoice["buyerHistory"]): Grade {
  if (checks.some((c) => c.result === "fail")) return "D";
  return historyGrade(history);
}

export interface ModelGradeOutcome {
  grade: Grade;
  /** Set when the model asked for something the rules do not allow, in words for the UI. */
  ignored: string | null;
}

/** R9: the model can lower the grade, never raise it. Anything that is not A–D is ignored. */
export function applyModelGrade(rule: Grade, suggested: string | undefined): ModelGradeOutcome {
  if (suggested === undefined) return { grade: rule, ignored: null };
  if (!ORDER.includes(suggested as Grade)) {
    return { grade: rule, ignored: `Model said "${suggested}". Not a grade; ignored.` };
  }
  const model = suggested as Grade;
  const grade = worse(rule, model);
  if (grade === rule && model !== rule) {
    return {
      grade,
      ignored: `Model said ${model}. The model can only lower a grade; kept ${rule}.`,
    };
  }
  return { grade, ignored: null };
}
