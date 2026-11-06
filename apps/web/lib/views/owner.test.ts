import { afterEach, describe, expect, it, vi } from "vitest";
import { getChainClient } from "@/lib/near";
import type { ChainClient } from "@/lib/near/client";
import { loadOwnerView, type OwnerTab } from "./owner";
import { loadRahimView } from "./rahim";

// Free RPC endpoints rate-limit bursts, so each owner page load reads only what it shows.
const READS = [
  "getEmployer",
  "getRuns",
  "getPayees",
  "ftBalanceOf",
  "getInvoice",
  "getAccessKeys",
  "getPool",
] as const satisfies readonly (keyof ChainClient)[];

function countReads() {
  const chain = getChainClient();
  return Object.fromEntries(READS.map((m) => [m, vi.spyOn(chain, m)]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("owner page chain reads", () => {
  it.each([
    ["pay-lines", 0, 0],
    ["workers", 0, 0],
    ["activity", 0, 0],
    ["invoices", 3, 0],
    ["agent-keys", 0, 2],
  ] as [OwnerTab, number, number][])("%s reads each value once", async (tab, invoices, keys) => {
    const spies = countReads();
    const view = await loadOwnerView(tab);
    await loadRahimView(view.chainReads);
    expect(spies.getEmployer).toHaveBeenCalledTimes(1);
    expect(spies.getRuns).toHaveBeenCalledTimes(1);
    expect(spies.getPayees).toHaveBeenCalledTimes(1);
    expect(spies.ftBalanceOf).toHaveBeenCalledTimes(1);
    expect(spies.getInvoice).toHaveBeenCalledTimes(invoices);
    expect(spies.getAccessKeys).toHaveBeenCalledTimes(keys);
  });

  it("still shows the invoices and keys on their own tabs", async () => {
    expect((await loadOwnerView("invoices")).invoices).toHaveLength(3);
    expect((await loadOwnerView("agent-keys")).keys.length).toBeGreaterThan(0);
  });
});
