import { loadFixtures } from "@homeroll/fixtures";
import { homerollAccounts } from "@homeroll/shared";
import { describe, expect, it, vi } from "vitest";
import { createActivityLog } from "@/lib/activity";
import { units } from "@/lib/fx";
import type { PoolView } from "@/lib/near/client";
import { FakeChainClient } from "@/lib/near/fake";
import {
  checkDeposit,
  type DepositAsset,
  type DepositCheck,
  DepositLimiter,
  depositAssets,
  MAX_DEPOSIT,
  MAX_DEPOSITS_PER_HOUR,
  MockDeposit,
  parseAssetAmount,
  priceDeposit,
  sampleDepositQuote,
  sharesValue,
} from "./index";

// Made-up numbers throughout: 1Click responses are never committed as fixtures (SPEC §8.4).
const ROOT = "homeroll-test.testnet";
const USDT: DepositAsset = {
  key: "tron:USDT",
  label: "USDT on Tron",
  symbol: "USDT",
  assetId: "nep141:usdt-made-up",
  decimals: 6,
  source: "live",
};
const usdc = (whole: bigint) => units(whole * 1_000_000n);
const pool: PoolView = {
  cash: usdc(1_000n),
  outstanding: usdc(1_000n),
  feesEarned: units(0n),
  totalShares: 1_000_000_000n,
  minFirstDeposit: usdc(10n),
};
const quoteOf = (amountOut: bigint) => ({
  ...sampleDepositQuote(USDT, 1n),
  amountOut: units(amountOut),
});
const allowed = (amountOut: bigint): DepositCheck => ({
  quote: quoteOf(amountOut),
  lender: { shares: 1n, pendingAssets: null },
  pool,
  solverBalance: usdc(200_000n),
  retryAt: null,
});

describe("asset amounts", () => {
  it("turns decimal text into base units without floats", () => {
    expect(parseAssetAmount("1,250.5", 6)).toBe(1_250_500_000n);
    expect(parseAssetAmount("0.1", 18)).toBe(100_000_000_000_000_000n);
    expect(parseAssetAmount("3", 8)).toBe(300_000_000n);
  });

  it.each(["", "1.2.3", "-1", "1e3", "0.1234567"])("refuses %s for a 6-decimal token", (text) => {
    expect(parseAssetAmount(text, 6)).toBeNull();
  });
});

describe("the asset picker", () => {
  it("takes asset ids and decimals from the live token list, in picker order", () => {
    const assets = depositAssets([
      { assetId: "nep141:btc-made-up", blockchain: "btc", symbol: "BTC", decimals: 8 },
      { assetId: "nep141:usdt-made-up", blockchain: "tron", symbol: "USDT", decimals: 6 },
      { assetId: "nep141:other", blockchain: "doge", symbol: "DOGE", decimals: 8 },
    ]);
    expect(assets.map((a) => [a.key, a.assetId, a.source])).toEqual([
      ["tron:USDT", "nep141:usdt-made-up", "live"],
      ["btc:BTC", "nep141:btc-made-up", "live"],
    ]);
  });

  it("falls back to a labelled sample list that never reaches 1Click", () => {
    const assets = depositAssets(null);
    expect(assets).toHaveLength(7);
    expect(assets.every((a) => a.source === "sample" && a.assetId === null)).toBe(true);
  });
});

describe("pricing a deposit", () => {
  it("uses the live dry-run quote and says whether it was confidential", async () => {
    const quoteLeg = vi.fn(async () => ({
      amountIn: 5n,
      amountOut: 4n,
      confidential: true,
      fetchedAt: 0,
    }));
    const quote = await priceDeposit(USDT, 5n, { live: true, quoteLeg });
    expect(quote.amountOut).toBe(4n);
    expect(quote.swap).toMatchObject({ source: "live", confidential: true });
    expect(quote.routing.mock).toBe(true);
    expect(quote.delivery.mock).toBe(true);
  });

  it("labels a made-up quote as a sample when the live one is off or down", async () => {
    const down = await priceDeposit(USDT, usdc(1_000n), { live: true, quoteLeg: async () => null });
    expect(down.swap.source).toBe("sample");
    // 1,000 USDT at a made-up $1.00, minus the made-up 0.10%
    expect(down.amountOut).toBe(usdc(999n));
    const quoteLeg = vi.fn();
    await priceDeposit(USDT, 5n, { live: false, quoteLeg });
    expect(quoteLeg).not.toHaveBeenCalled();
  });
});

describe("R16: the mock solver's limits", () => {
  it("lets a deposit within every limit through", () => {
    expect(checkDeposit(allowed(usdc(100n)))).toBeNull();
  });

  it("R16.1: refuses more than 50,000 USDC in one deposit", () => {
    expect(checkDeposit(allowed(MAX_DEPOSIT))).toBeNull();
    expect(checkDeposit(allowed(MAX_DEPOSIT + 1n))).toEqual({
      reason: "above-limit",
      max: MAX_DEPOSIT,
    });
  });

  it("R16.2: refuses a fourth deposit within the hour, until the oldest is an hour old", () => {
    const limiter = new DepositLimiter();
    const lender = `l-4f9t2c.${ROOT}`;
    for (let i = 0; i < MAX_DEPOSITS_PER_HOUR; i++) limiter.record(lender, i * 1_000);
    expect(limiter.retryAt(lender, 5_000)).toBe(3_600_000);
    expect(checkDeposit({ ...allowed(usdc(100n)), retryAt: 3_600_000 })).toEqual({
      reason: "rate-limited",
      retryAt: 3_600_000,
    });
    expect(limiter.retryAt(lender, 3_600_000)).toBeNull();
    expect(limiter.retryAt(`l-zz0003.${ROOT}`, 5_000)).toBeNull();
  });

  it("R16.3: refuses a new lender below the pool's minimum first deposit, before the solver pays", () => {
    const newLender = { ...allowed(usdc(10n) - 1n), lender: null };
    expect(checkDeposit(newLender)).toEqual({ reason: "below-first-minimum", min: usdc(10n) });
    expect(checkDeposit({ ...allowed(usdc(10n)), lender: null })).toBeNull();
    // An existing lender may top up by any amount
    expect(checkDeposit(allowed(1n))).toBeNull();
  });

  it("R16.4: refuses what the solver's float cannot cover", () => {
    expect(checkDeposit({ ...allowed(usdc(100n)), solverBalance: usdc(99n) })).toEqual({
      reason: "solver-empty",
    });
  });

  it("refuses a quote worth nothing", () => {
    expect(checkDeposit(allowed(0n))).toEqual({ reason: "no-quote" });
  });
});

describe("MockDeposit on the fake chain", () => {
  const make = () => {
    const fixtures = loadFixtures(ROOT);
    const chain = new FakeChainClient({ fixtures, now: () => 0, activity: createActivityLog() });
    const deps = {
      chain,
      solver: homerollAccounts(ROOT).solver,
      limiter: new DepositLimiter(),
      now: () => 0,
    };
    return { chain, deps, lender: fixtures.lender.accountId };
  };

  it("delivers the server's quote from the solver, then deposits it for shares", async () => {
    const { chain, deps, lender } = make();
    const quote = quoteOf(usdc(25_000n));
    const before = await chain.getPool();
    const outcome = await MockDeposit.execute(quote, lender, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.receipt).toMatchObject({ mock: true, lender, amountOut: usdc(25_000n) });
    expect(outcome.receipt.shares).toBeGreaterThan(0n);
    expect((await chain.getPool()).cash).toBe(before.cash + usdc(25_000n));
    expect(await chain.ftBalanceOf(deps.solver)).toBe(usdc(200_000n - 25_000n));
    expect(await chain.ftBalanceOf(lender)).toBe(0n);
  });

  it("moves nothing when a check refuses", async () => {
    const { chain, deps, lender } = make();
    const outcome = await MockDeposit.execute(quoteOf(MAX_DEPOSIT + 1n), lender, deps);
    expect(outcome).toEqual({ ok: false, refusal: { reason: "above-limit", max: MAX_DEPOSIT } });
    expect(await chain.ftBalanceOf(deps.solver)).toBe(usdc(200_000n));
  });

  it("counts only deliveries toward the hourly limit", async () => {
    const { deps, lender } = make();
    await MockDeposit.execute(quoteOf(MAX_DEPOSIT + 1n), lender, deps);
    for (let i = 0; i < MAX_DEPOSITS_PER_HOUR; i++) {
      expect((await MockDeposit.execute(quoteOf(usdc(100n)), lender, deps)).ok).toBe(true);
    }
    const fourth = await MockDeposit.execute(quoteOf(usdc(100n)), lender, deps);
    expect(fourth.ok === false && "refusal" in fourth && fourth.refusal.reason).toBe(
      "rate-limited",
    );
  });

  it("values shares at current NAV, rounded down", () => {
    expect(sharesValue(500_000_000n, pool)).toBe(usdc(1_000n));
    expect(sharesValue(1n, { ...pool, totalShares: 0n })).toBe(0n);
  });
});
