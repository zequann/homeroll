import { after } from "next/server";

/**
 * A store write that must not hold up the caller (the activity log is written from inside chain
 * calls). The write starts now; `after` keeps a serverless function alive until it lands. Outside
 * a request (scripts, tests) it just runs. `pending()` lets a reader in the same instance wait for
 * writes it started, so a page shows the rows its own action just wrote.
 */
const inFlight = new Set<Promise<void>>();

export function inBackground(label: string, task: () => Promise<void>): void {
  const run = task()
    .catch((error: unknown) => {
      console.error(`[store] ${label} failed:`, error instanceof Error ? error.message : error);
    })
    .finally(() => inFlight.delete(run));
  inFlight.add(run);
  try {
    after(() => run);
  } catch {
    // Not inside a request: nothing to keep alive
  }
}

export async function pending(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}
