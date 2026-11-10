/**
 * Free testnet RPCs (FastNEAR, dRPC) rate-limit with HTTP 429 or a JSON-RPC `-429`. near-api-js
 * retries 500/503/408 itself but not 429, so a busy Run payroll or Reset demo failed outright.
 *
 * This retries only requests the RPC refused before handling them, so it never changes what a
 * transaction does: a retry resends the same signed bytes, and NEAR includes a nonce once.
 * Contract panics and every other error are thrown at once, never retried or sent elsewhere.
 */

export interface RetryPolicy {
  /** Total tries across all endpoints. */
  attempts: number;
  firstWaitMs: number;
  maxWaitMs: number;
  /** How long a throttled endpoint is skipped while another one is free. */
  benchMs: number;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 7,
  firstWaitMs: 500,
  maxWaitMs: 4_000,
  benchMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Methods that carry a signed transaction. Moved to another endpoint only when refused unread. */
const TRANSACTION_METHODS = new Set(["send_tx", "broadcast_tx_commit", "broadcast_tx_async"]);

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name} ${e.message} ${(e as { type?: unknown }).type ?? ""}`;
  return String(e);
}

/** The endpoint refused the request for load: it did not run it. */
export function isThrottled(e: unknown): boolean {
  if (typeof e === "object" && e !== null && (e as { cause?: unknown }).cause === 429) return true;
  return /rate limits? exceeded|too many requests|"code"\s*:\s*-?429\b/i.test(errorText(e));
}

/** The endpoint could not be reached (after near-api-js's own retries). Reads may go elsewhere. */
export function isUnreachable(e: unknown): boolean {
  if (typeof e === "object" && e !== null) {
    const cause = (e as { cause?: unknown }).cause;
    // 500 too: FastNEAR answers bursts with it as well. Only reads move on (see sendWithRetry).
    if (cause === 500 || cause === 502 || cause === 503) return true;
  }
  return /RetriesExceeded|Exceeded \d+ attempts|fetch failed|Failed to fetch|ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(
    errorText(e),
  );
}

/** Endpoint URL -> time until which it is skipped. Shared by every provider in this process. */
const benchedUntil = new Map<string, number>();

export function resetRpcBench(): void {
  benchedUntil.clear();
}

/** The first endpoint not benched, else the one whose bench ends soonest. */
function pick(urls: readonly string[], now: number): string {
  let best = urls[0] as string;
  let bestUntil = Number.POSITIVE_INFINITY;
  for (const url of urls) {
    const until = benchedUntil.get(url) ?? 0;
    if (until <= now) return url;
    if (until < bestUntil) {
      best = url;
      bestUntil = until;
    }
  }
  return best;
}

/**
 * Sends one JSON-RPC request, trying the endpoints in order. A throttled endpoint is benched and
 * the next free one is tried at once; when every endpoint is benched it waits, doubling the wait.
 * A transaction uses `txUrls` instead: it moves only when throttled (refused unread), never after
 * a network failure, when it may already have arrived.
 */
export async function sendWithRetry<T>(
  urls: readonly string[],
  method: string,
  send: (url: string) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  txUrls: readonly string[] = urls.slice(0, 1),
): Promise<T> {
  if (urls.length === 0) throw new Error("NEAR_RPC_URL is not set");
  // Transactions never go to the read fallbacks: they may cap request time (dRPC's free plan answers
  // a send_tx that runs past 2 s with 408, then 500 on every resend). They use txUrls.
  const endpoints = TRANSACTION_METHODS.has(method) && txUrls.length > 0 ? txUrls : urls;
  let wait = policy.firstWaitMs;
  let last: unknown;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    const url = pick(endpoints, policy.now());
    try {
      return await send(url);
    } catch (e) {
      const movable =
        isThrottled(e) || (!TRANSACTION_METHODS.has(method) && isUnreachable(e) && urls.length > 1);
      if (!movable) throw e;
      last = e;
      benchedUntil.set(url, policy.now() + policy.benchMs);
      const free = endpoints.some((u) => (benchedUntil.get(u) ?? 0) <= policy.now());
      if (!free && attempt < policy.attempts - 1) {
        await policy.sleep(Math.min(wait, policy.maxWaitMs));
        wait *= 2;
      }
    }
  }
  throw last;
}

/** `NEAR_RPC_URL` first, then each URL in the comma-separated `NEAR_RPC_FALLBACK_URLS`. */
export function rpcUrls(
  primary: string,
  fallbacks = process.env.NEAR_RPC_FALLBACK_URLS ?? "",
): string[] {
  const all = [primary, ...fallbacks.split(",")].map((u) => u.trim()).filter(Boolean);
  return [...new Set(all)];
}

/**
 * NEAR's own testnet RPC: ~3.5 s a call, but it does not cut a long send_tx off. On Vercel, FastNEAR
 * throttles the shared outbound IPs hard enough that a Reset demo failed on every try (10 Nov 2026).
 */
export const DEFAULT_TX_FALLBACK_URLS = "https://rpc.testnet.near.org";

/**
 * Where a transaction may go: `NEAR_RPC_URL` first, then `NEAR_RPC_TX_FALLBACK_URLS` (default
 * {@link DEFAULT_TX_FALLBACK_URLS}; set it empty to keep transactions on `NEAR_RPC_URL`).
 */
export function txRpcUrls(
  primary: string,
  fallbacks = process.env.NEAR_RPC_TX_FALLBACK_URLS ?? DEFAULT_TX_FALLBACK_URLS,
): string[] {
  return rpcUrls(primary, fallbacks);
}
