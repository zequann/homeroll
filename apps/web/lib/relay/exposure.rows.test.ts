import { describe, expect, it } from "vitest";
import { createMemoryRowStore } from "@/lib/store/rows";
import { type BlobId, ExposureLog, type UtcDay } from "./exposure";

const WORKER = "w-7k2q9x.homeroll.testnet";
const DAY = "2026-11-04" as UtcDay;
// The daily cap in token base units, as the relayer counts it
const CAP = 4_000_000_000n;

/** The relayer's check-and-hold, as relay() does it: spend only if today's total stays under the cap. */
function holdIfUnderCap(log: ExposureLog, blob: string, amount: bigint) {
  return log.withWorker(WORKER, (book) => {
    if (book.spentUnits(DAY, 0n) + amount > CAP) return false;
    book.hold({ blob: blob as BlobId, day: DAY, amount, maxBlockHeight: 100n });
    return true;
  });
}

describe("relayer claims shared by several server instances (R12, Vercel)", () => {
  it("counts what another instance held toward today's cap", async () => {
    const shared = createMemoryRowStore();
    const a = ExposureLog.rows(shared);
    const b = ExposureLog.rows(shared);
    expect(await holdIfUnderCap(a, "blob-1", 3_000_000_000n)).toBe(true);
    expect(await holdIfUnderCap(b, "blob-2", 3_000_000_000n)).toBe(false);
    expect(await holdIfUnderCap(b, "blob-3", 1_000_000_000n)).toBe(true);
  });

  it("lets only one of two instances racing past the cap hold", async () => {
    const shared = createMemoryRowStore();
    const results = await Promise.all([
      holdIfUnderCap(ExposureLog.rows(shared), "blob-a", 3_000_000_000n),
      holdIfUnderCap(ExposureLog.rows(shared), "blob-b", 3_000_000_000n),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("takes over a lock a crashed request left behind, once it expires", async () => {
    const shared = createMemoryRowStore();
    let now = 1_000_000;
    await shared.insert("relay_claims", "relay", `lock:${WORKER}`, { until: now + 15_000 });
    now += 16_000;
    const log = ExposureLog.rows(shared, () => now);
    expect(await holdIfUnderCap(log, "blob-x", 1n)).toBe(true);
    expect(await shared.get("relay_claims", "relay", `lock:${WORKER}`)).toBeNull();
  });
});

describe("Reset demo forgets a worker's daily limits (SPEC §9.6)", () => {
  it("lets the worker send again after a reset, on every instance", async () => {
    const shared = createMemoryRowStore();
    const a = ExposureLog.rows(shared);
    await a.withWorker(WORKER, (book) => {
      book.hold({ blob: "blob-1" as BlobId, day: DAY, amount: CAP, maxBlockHeight: 100n });
      book.land("blob-1" as BlobId, "tx-1");
    });
    expect(await holdIfUnderCap(a, "blob-2", 800_000_000n)).toBe(false);

    await a.forget(WORKER);
    expect(await holdIfUnderCap(ExposureLog.rows(shared), "blob-3", 800_000_000n)).toBe(true);
  });

  it("keeps a claim still in flight, so a transfer being relayed during the reset still counts", async () => {
    const log = ExposureLog.memory();
    await holdIfUnderCap(log, "in-flight", 3_500_000_000n);
    await log.forget(WORKER);
    expect(await holdIfUnderCap(log, "after", 800_000_000n)).toBe(false);
    expect(await holdIfUnderCap(log, "small", 500_000_000n)).toBe(true);
  });
});
