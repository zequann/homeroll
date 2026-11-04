import type { Grade } from "@/lib/near/client";

/**
 * The pool's initial grade table (SPEC §7.4). On testnet the pool contract holds it; the fake
 * chain and the invoice agent's offer read this copy. Every max advance is clamped to 80% in code.
 */
export const HARD_MAX_ADVANCE_BPS = 8000;

export const GRADE_TABLE: Record<Grade, { maxAdvanceBps: number; feeBps: number }> = {
  A: { maxAdvanceBps: 8000, feeBps: 150 },
  B: { maxAdvanceBps: 7000, feeBps: 220 },
  C: { maxAdvanceBps: 6000, feeBps: 280 },
  D: { maxAdvanceBps: 0, feeBps: 0 },
};

export function maxAdvanceBps(grade: Grade): number {
  return Math.min(GRADE_TABLE[grade].maxAdvanceBps, HARD_MAX_ADVANCE_BPS);
}
