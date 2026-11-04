import { describe, expect, it, vi } from "vitest";
import { quoteSwapLeg } from "./index";

// Made-up numbers: 1Click responses are never committed as fixtures (SPEC §8.4).
const respond = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as Response);

describe("1Click dry-run quote", () => {
  it("always asks for a dry run and turns the quote into basis points, rounded up", async () => {
    const fetch = respond({ quote: { amountIn: "1000000", amountOut: "998999" } });
    const quote = await quoteSwapLeg(1_000_001n, { fetch, now: () => 1 });
    expect(quote?.bps).toBe(11);
    const init = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init[1].body as string).dry).toBe(true);
  });

  it("never shows a negative cost", async () => {
    const fetch = respond({ quote: { amountIn: "1000000", amountOut: "1000500" } });
    expect((await quoteSwapLeg(1_000_002n, { fetch, now: () => 1 }))?.bps).toBe(0);
  });

  it("returns null when the service fails, answers badly, or throws", async () => {
    expect(await quoteSwapLeg(5n, { fetch: respond({}, false), now: () => 1 })).toBeNull();
    expect(await quoteSwapLeg(6n, { fetch: respond({ nope: 1 }), now: () => 1 })).toBeNull();
    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await quoteSwapLeg(7n, { fetch: boom, now: () => 1 })).toBeNull();
  });

  it("keeps a quote for a minute, then asks again", async () => {
    const fetch = respond({ quote: { amountIn: "100", amountOut: "99" } });
    await quoteSwapLeg(8n, { fetch, now: () => 0 });
    await quoteSwapLeg(8n, { fetch, now: () => 59_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await quoteSwapLeg(8n, { fetch, now: () => 61_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
