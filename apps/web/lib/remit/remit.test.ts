import { describe, expect, it } from "vitest";
import { sen } from "@/lib/fx";
import { BENCHMARKS, benchmarkTaka, SampleQuote } from "./index";

describe("sample quote", () => {
  it("gives Amma ৳22,628 for RM800 and marks itself as a mock", () => {
    const quote = SampleQuote.quote(sen(80_000));
    expect(quote.mock).toBe(true);
    expect(quote.swap.feeSen).toBe(80);
    expect(quote.payout.feeSen).toBe(800);
    expect(quote.takaOut).toBe(22_628);
    expect(quote.totalBps).toBe(110);
  });

  it("rounds each fee up per leg", () => {
    const quote = SampleQuote.quote(sen(1_234));
    expect(quote.swap.feeSen).toBe(2);
    expect(quote.payout.feeSen).toBe(13);
  });

  it("shows the benchmark routes behind Homeroll", () => {
    const [avg] = BENCHMARKS;
    expect(benchmarkTaka(sen(80_000), avg.bps)).toBe(21_161);
    for (const b of BENCHMARKS) {
      expect(benchmarkTaka(sen(80_000), b.bps)).toBeLessThan(
        SampleQuote.quote(sen(80_000)).takaOut,
      );
    }
  });
});
