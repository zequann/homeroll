import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRADE_TERMS, lowerGrade, type ModelGrade, type RulesGrade } from "./grades";

const BOOKS = join(import.meta.dirname, "../../../contracts/pool/src/books.rs");

describe("GRADE_TERMS", () => {
  it("matches the pool contract initial grade rows", () => {
    const source = readFileSync(BOOKS, "utf8");
    const pairs = [...source.matchAll(/max_advance_bps:\s*(\d+),\s*\n\s*fee_bps:\s*(\d+)/g)].slice(
      0,
      4,
    );
    expect(pairs).toHaveLength(4);
    const grades = ["A", "B", "C", "D"] as const;
    for (let i = 0; i < 4; i++) {
      const match = pairs[i];
      if (!match) throw new Error("missing grade row");
      expect(Number(match[1])).toBe(GRADE_TERMS[grades[i] ?? "A"].maxAdvanceBps);
      expect(Number(match[2])).toBe(GRADE_TERMS[grades[i] ?? "A"].feeBps);
    }
  });
});

describe("lowerGrade", () => {
  it("keeps rules A when the model suggests A at 10000 bps", () => {
    const grade = lowerGrade("A" as RulesGrade, "A" as ModelGrade);
    expect(grade).toBe("A");
  });

  it("lowers to the worse of rules and model", () => {
    expect(lowerGrade("A" as RulesGrade, "C" as ModelGrade)).toBe("C");
    expect(lowerGrade("C" as RulesGrade, "A" as ModelGrade)).toBe("C");
  });
});
