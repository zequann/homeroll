import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRADE_TABLE } from "./pool-grades";

const BOOKS = join(import.meta.dirname, "../../../contracts/pool/src/books.rs");

describe("GRADE_TABLE", () => {
  it("matches the pool contract initial grade rows", () => {
    const source = readFileSync(BOOKS, "utf8");
    const pairs = [...source.matchAll(/max_advance_bps:\s*(\d+),\s*\n\s*fee_bps:\s*(\d+)/g)].slice(
      0,
      4,
    );
    expect(pairs).toHaveLength(4);
    for (const [i, grade] of (["A", "B", "C", "D"] as const).entries()) {
      const match = pairs[i];
      if (!match) throw new Error("missing grade row");
      expect(Number(match[1])).toBe(GRADE_TABLE[grade].maxAdvanceBps);
      expect(Number(match[2])).toBe(GRADE_TABLE[grade].feeBps);
    }
  });
});
