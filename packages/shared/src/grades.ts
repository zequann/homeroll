export const GRADE_TERMS = {
  A: { maxAdvanceBps: 8000, feeBps: 150 },
  B: { maxAdvanceBps: 7000, feeBps: 220 },
  C: { maxAdvanceBps: 6000, feeBps: 280 },
  D: { maxAdvanceBps: 0, feeBps: 0 },
} as const;

export const HARD_MAX_ADVANCE_BPS = 8000;

export type Grade = keyof typeof GRADE_TERMS;

export type RulesGrade = Grade & { readonly __grade: "rules" };
export type ModelGrade = Grade & { readonly __grade: "model" };
export type AttestedGrade = Grade & { readonly __grade: "attested" };

const WORSE = { A: 0, B: 1, C: 2, D: 3 } as const;

export function lowerGrade(rules: RulesGrade, model: ModelGrade): AttestedGrade {
  const rulesKey = rules as Grade;
  const modelKey = model as Grade;
  const grade = WORSE[modelKey] > WORSE[rulesKey] ? modelKey : rulesKey;
  return grade as AttestedGrade;
}
