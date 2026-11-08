import { beforeEach, describe, expect, it } from "vitest";
import {
  isThrottled,
  isUnreachable,
  type RetryPolicy,
  resetRpcBench,
  rpcUrls,
  sendWithRetry,
} from "./rpc-retry";

const A = "https://a.example";
const B = "https://b.example";

/** The body FastNEAR returns with HTTP 429; near-api-js throws it with `cause: 429`. */
function throttled(): Error {
  const e = new Error(
    '{"jsonrpc":"2.0","error":{"code":-429,"message":"Rate limits exceeded."},"id":"1"}',
  );
  (e as { cause?: unknown }).cause = 429;
  return e;
}

function policy(): RetryPolicy & { slept: number[] } {
  let clock = 0;
  const slept: number[] = [];
  return {
    attempts: 5,
    firstWaitMs: 100,
    maxWaitMs: 300,
    benchMs: 1_000,
    slept,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  };
}

beforeEach(() => resetRpcBench());

describe("sendWithRetry", () => {
  it("retries a throttled request with growing waits, then returns the result", async () => {
    const p = policy();
    let calls = 0;
    const result = await sendWithRetry(
      [A],
      "query",
      async () => {
        calls += 1;
        if (calls < 4) throw throttled();
        return "ok";
      },
      p,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(4);
    expect(p.slept).toEqual([100, 200, 300]);
  });

  it("moves to the fallback at once when the primary is throttled, and skips it after", async () => {
    const p = policy();
    const seen: string[] = [];
    const send = async (url: string) => {
      seen.push(url);
      if (url === A) throw throttled();
      return url;
    };
    expect(await sendWithRetry([A, B], "query", send, p)).toBe(B);
    expect(await sendWithRetry([A, B], "query", send, p)).toBe(B);
    expect(seen).toEqual([A, B, B]);
    expect(p.slept).toEqual([]);
  });

  it("keeps a throttled transaction on NEAR_RPC_URL: it waits and resends there", async () => {
    const p = policy();
    const bodies: string[] = [];
    let calls = 0;
    await sendWithRetry(
      [A, B],
      "send_tx",
      async (url) => {
        bodies.push(`${url}:signed-bytes`);
        calls += 1;
        if (calls === 1) throw throttled();
        return "outcome";
      },
      p,
    );
    // B may cap request time (dRPC's free plan cuts send_tx at 2 s), so it never gets a transaction
    expect(bodies).toEqual([`${A}:signed-bytes`, `${A}:signed-bytes`]);
    expect(p.slept).toEqual([100]);
  });

  it("never resends a transaction after a network failure, when it may have arrived", async () => {
    const p = policy();
    let calls = 0;
    await expect(
      sendWithRetry(
        [A, B],
        "send_tx",
        async () => {
          calls += 1;
          throw new Error("fetch failed");
        },
        p,
      ),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(1);
  });

  it("sends a read to the fallback when the primary cannot be reached", async () => {
    const p = policy();
    const result = await sendWithRetry(
      [A, B],
      "query",
      async (url) => {
        if (url === A) throw new Error("Exceeded 12 attempts for https://a.example.");
        return "from B";
      },
      p,
    );
    expect(result).toBe("from B");
  });

  it("throws a contract panic at once and does not try another endpoint", async () => {
    const p = policy();
    let calls = 0;
    await expect(
      sendWithRetry(
        [A, B],
        "query",
        async () => {
          calls += 1;
          throw new Error(
            "Smart contract panicked: ERR_ABOVE_WAGE_CAP:4:w-6b1x4k.homeroll.testnet",
          );
        },
        p,
      ),
    ).rejects.toThrow("ERR_ABOVE_WAGE_CAP");
    expect(calls).toBe(1);
  });

  it("gives up after the last attempt and throws the 429", async () => {
    const p = policy();
    let calls = 0;
    await expect(
      sendWithRetry(
        [A],
        "query",
        async () => {
          calls += 1;
          throw throttled();
        },
        p,
      ),
    ).rejects.toThrow("Rate limits exceeded");
    expect(calls).toBe(5);
  });
});

describe("error kinds", () => {
  it("knows a 429 by status or by the JSON-RPC body", () => {
    expect(isThrottled(throttled())).toBe(true);
    expect(isThrottled(new Error('{"error":{"code":-429}}'))).toBe(true);
    expect(isThrottled(new Error("Too Many Requests"))).toBe(true);
    expect(isThrottled(new Error("Smart contract panicked: ERR_NOT_ADMIN"))).toBe(false);
  });

  it("knows an unreachable endpoint", () => {
    expect(isUnreachable(new Error("fetch failed"))).toBe(true);
    expect(isUnreachable(Object.assign(new Error("Bad Gateway"), { cause: 502 }))).toBe(true);
    expect(isUnreachable(Object.assign(new Error("Internal server error"), { cause: 500 }))).toBe(
      true,
    );
    expect(isUnreachable(new Error("Smart contract panicked: ERR_NOT_ADMIN"))).toBe(false);
  });
});

describe("rpcUrls", () => {
  it("puts NEAR_RPC_URL first and drops blanks and repeats", () => {
    expect(rpcUrls(A, ` ${B}, ,${A}`)).toEqual([A, B]);
    expect(rpcUrls(A, "")).toEqual([A]);
  });
});

describe("the provider in rpc.ts", () => {
  it("answers from the fallback when NEAR_RPC_URL returns HTTP 429", async () => {
    const { blockHeight, configureRpc } = await import("./rpc");
    const hits: string[] = [];
    const realFetch = globalThis.fetch;
    const previous = process.env.NEAR_RPC_FALLBACK_URLS;
    process.env.NEAR_RPC_FALLBACK_URLS = B;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      hits.push(url);
      if (url === A) {
        return new Response(
          '{"jsonrpc":"2.0","error":{"code":-429,"message":"Rate limits exceeded."}}',
          {
            status: 429,
          },
        );
      }
      return Response.json({
        jsonrpc: "2.0",
        id: "1",
        result: { sync_info: { latest_block_height: 42 } },
      });
    }) as typeof fetch;
    try {
      configureRpc(A);
      expect(await blockHeight()).toBe(42n);
      expect(hits).toEqual([A, B]);
    } finally {
      globalThis.fetch = realFetch;
      if (previous === undefined) delete process.env.NEAR_RPC_FALLBACK_URLS;
      else process.env.NEAR_RPC_FALLBACK_URLS = previous;
    }
  });
});

describe("transaction sends in rpc.ts", () => {
  it("wait until executed (every receipt run), not until final", async () => {
    const { callMethod, configureRpc } = await import("./rpc");
    const { deriveKey } = await import("@/lib/keys");
    const signer = deriveKey("11".repeat(32), "owner.homeroll-test.testnet", "owner");
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      sent.push(body);
      const result =
        body.method === "query"
          ? {
              nonce: 7,
              permission: "FullAccess",
              block_height: 1,
              block_hash: "11111111111111111111111111111111",
            }
          : body.method === "block"
            ? { header: { hash: "11111111111111111111111111111111", height: 1 } }
            : {
                status: { SuccessValue: "" },
                transaction: { hash: "tx" },
                transaction_outcome: { id: "tx", outcome: { status: { SuccessValue: "" } } },
                receipts_outcome: [],
              };
      return Response.json({ jsonrpc: "2.0", id: "1", result });
    }) as typeof fetch;
    try {
      configureRpc(A);
      await callMethod(signer, "payroll.homeroll-test.testnet", {
        method: "submit_run",
        args: {},
        gas: 30_000_000_000_000n,
        depositYocto: 0n,
      });
      const send = sent.find((s) => s.method === "send_tx");
      expect(send?.params.wait_until).toBe("EXECUTED_OPTIMISTIC");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
