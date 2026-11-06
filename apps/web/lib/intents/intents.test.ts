import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listTokens,
  quoteDepositLeg,
  quoteSwapLeg,
  resetIntentsCache,
  USDC_ON_NEAR,
} from "./index";

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

describe("1Click partner key", () => {
  it("sends the key as X-API-Key when set, and no key header otherwise", async () => {
    const fetch = respond({ quote: { amountIn: "100", amountOut: "99" } });
    await quoteSwapLeg(9n, { fetch, now: () => 1, apiKey: "jwt-made-up" });
    await quoteSwapLeg(10n, { fetch, now: () => 1 });
    const [withKey, without] = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(withKey?.[1].headers).toMatchObject({ "X-API-Key": "jwt-made-up" });
    expect(without?.[1].headers).not.toHaveProperty("X-API-Key");
  });
});

describe("deposit quote into USDC on NEAR", () => {
  beforeEach(() => resetIntentsCache());
  const ETH = "nep141:eth.omft.near";
  const bodyOf = (fetch: ReturnType<typeof vi.fn>, call: number) =>
    JSON.parse((fetch.mock.calls[call] as unknown as [string, RequestInit])[1].body as string);

  it("asks a public dry run without a key, refunding through Intents for any chain", async () => {
    const fetch = respond({ quote: { amountIn: "1000", amountOut: "2222" } });
    const quote = await quoteDepositLeg(ETH, 1000n, { fetch, now: () => 1 });
    expect(quote).toMatchObject({ amountIn: 1000n, amountOut: 2222n, confidential: false });
    const body = bodyOf(fetch, 0);
    expect(body).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      originAsset: ETH,
      destinationAsset: USDC_ON_NEAR,
      refundType: "INTENTS",
    });
    expect(body).not.toHaveProperty("confidentiality");
  });

  it("with a key, asks for a confidential dry run first", async () => {
    const fetch = respond({ quote: { amountIn: "1000", amountOut: "2222" } });
    const quote = await quoteDepositLeg(ETH, 1000n, { fetch, now: () => 1, apiKey: "k" });
    expect(quote?.confidential).toBe(true);
    expect(bodyOf(fetch, 0).confidentiality).toBe("basic");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to a public quote when 1Click refuses the confidential one, then stops asking", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const confidential = JSON.parse(init.body as string).confidentiality === "basic";
      return {
        ok: !confidential,
        status: confidential ? 401 : 201,
        json: async () =>
          confidential
            ? { message: "User authentication is required for confidential intent quotes" }
            : { quote: { amountIn: "1000", amountOut: "2000" } },
      } as Response;
    });
    const first = await quoteDepositLeg(ETH, 1000n, { fetch, now: () => 1, apiKey: "k" });
    expect(first).toMatchObject({ amountOut: 2000n, confidential: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    await quoteDepositLeg(ETH, 2000n, { fetch, now: () => 2, apiKey: "k" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("refuses a quote for an amount other than the one asked", async () => {
    const fetch = respond({ quote: { amountIn: "999", amountOut: "2000" } });
    expect(await quoteDepositLeg(ETH, 1000n, { fetch, now: () => 1 })).toBeNull();
  });

  it("lists tokens, drops fields it does not use, and returns null when the list is down", async () => {
    const fetch = respond([
      { assetId: ETH, blockchain: "eth", symbol: "ETH", decimals: 18, price: 1, extra: true },
    ]);
    expect(await listTokens({ fetch, now: () => 1 })).toEqual([
      { assetId: ETH, blockchain: "eth", symbol: "ETH", decimals: 18 },
    ]);
    resetIntentsCache();
    expect(await listTokens({ fetch: respond({}, false), now: () => 1 })).toBeNull();
  });
});
