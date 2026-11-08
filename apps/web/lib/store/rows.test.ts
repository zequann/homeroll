import { describe, expect, it } from "vitest";
import {
  createMemoryRowStore,
  createSupabaseRowStore,
  decodeJson,
  encodeJson,
  StoreUnavailable,
} from "./rows";

describe("bigint JSON codec", () => {
  it("round-trips bigint amounts and leaves everything else alone", () => {
    const value = { amount: 1_950_000_000n, nested: [{ fee: 1n }], name: "Rahim", n: 2 };
    const wire = encodeJson(value);
    expect(JSON.stringify(wire)).not.toContain("n,");
    expect(decodeJson(wire)).toEqual(value);
  });
});

describe("memory row store", () => {
  it("keeps rows per scope, newest first, and an update keeps its place", async () => {
    const store = createMemoryRowStore();
    await store.upsert("workers", "emp-a", "w1", { name: "A" });
    await store.upsert("workers", "emp-a", "w2", { name: "B" });
    await store.upsert("workers", "emp-b", "w3", { name: "C" });
    await store.upsert("workers", "emp-a", "w1", { name: "A2" });
    expect(await store.list("workers", "emp-a")).toEqual([
      { key: "w2", data: { name: "B" } },
      { key: "w1", data: { name: "A2" } },
    ]);
    expect(await store.get("workers", "emp-b", "w3")).toEqual({ name: "C" });
    await store.clear("workers", "emp-a");
    expect(await store.list("workers", "emp-a")).toEqual([]);
    expect(await store.list("workers", "emp-b")).toHaveLength(1);
  });
});

describe("insert-if-new", () => {
  it("lets exactly one of two racing inserts win, in memory", async () => {
    const store = createMemoryRowStore();
    const results = await Promise.all([
      store.insert("payout_nonces", "emp", "n1", { at: 1 }),
      store.insert("payout_nonces", "emp", "n1", { at: 2 }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await store.get("payout_nonces", "emp", "n1")).toEqual({ at: 1 });
    await store.remove("payout_nonces", "emp", "n1");
    expect(await store.insert("payout_nonces", "emp", "n1", { at: 3 })).toBe(true);
  });
});

describe("Supabase row store", () => {
  function fakeFetch(responses: Response[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses.shift() ?? new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it("sends a new secret key only as apikey, and upserts on (scope, key)", async () => {
    const { fn, calls } = fakeFetch([new Response(null, { status: 201 })]);
    const store = createSupabaseRowStore({
      url: "https://x.supabase.co/",
      secretKey: "sb_secret_test",
      fetch: fn,
    });
    await store.upsert("activity", "emp", "k1", { amount: 5n });
    const [call] = calls;
    expect(call?.url).toBe("https://x.supabase.co/rest/v1/activity?on_conflict=scope,key");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.apikey).toBe("sb_secret_test");
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Prefer).toContain("merge-duplicates");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      scope: "emp",
      key: "k1",
      data: { amount: { $bigint: "5" } },
    });
  });

  it("insert maps the primary key's 409 to false, without merging", async () => {
    const { fn, calls } = fakeFetch([
      new Response(null, { status: 201 }),
      new Response('{"code":"23505"}', { status: 409 }),
    ]);
    const store = createSupabaseRowStore({ url: "https://x", secretKey: "sb_secret_t", fetch: fn });
    expect(await store.insert("payout_nonces", "emp", "n1", {})).toBe(true);
    expect(await store.insert("payout_nonces", "emp", "n1", {})).toBe(false);
    expect(calls[0]?.url).toBe("https://x/rest/v1/payout_nonces");
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.Prefer).toBe("return=minimal");
  });

  it("adds the bearer header for a legacy JWT key", async () => {
    const { fn, calls } = fakeFetch([new Response("[]")]);
    const store = createSupabaseRowStore({ url: "https://x", secretKey: "eyJhbGci", fetch: fn });
    await store.list("workers", "emp");
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer eyJhbGci");
  });

  it("lists newest first for one scope and decodes bigint", async () => {
    const { fn, calls } = fakeFetch([
      new Response(JSON.stringify([{ key: "a", data: { amount: { $bigint: "7" } } }])),
    ]);
    const store = createSupabaseRowStore({ url: "https://x", secretKey: "sb_secret_t", fetch: fn });
    expect(await store.list("activity", "coffeefactory.homeroll.testnet", 50)).toEqual([
      { key: "a", data: { amount: 7n } },
    ]);
    expect(calls[0]?.url).toBe(
      "https://x/rest/v1/activity?scope=eq.coffeefactory.homeroll.testnet&select=key,data&order=created_at.desc,key.desc&limit=50",
    );
  });

  it("deletes only the scope's rows, and reports a failed call", async () => {
    const { fn, calls } = fakeFetch([
      new Response(null, { status: 204 }),
      new Response("permission denied", { status: 401 }),
    ]);
    const store = createSupabaseRowStore({ url: "https://x", secretKey: "sb_secret_t", fetch: fn });
    await store.clear("mock_ledger", "emp");
    expect(calls[0]?.url).toBe("https://x/rest/v1/mock_ledger?scope=eq.emp");
    expect(calls[0]?.init.method).toBe("DELETE");
    await expect(store.get("workers", "emp", "w")).rejects.toBeInstanceOf(StoreUnavailable);
  });
});
