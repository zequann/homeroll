import { describe, expect, it, vi } from "vitest";
import { sen, senToUnits } from "@/lib/fx";
import { getMockLedger } from "@/lib/mock/ledger";
import { MockRoute, SampleQuote } from "@/lib/remit";
import { cashoutQuote, mockDuitNow } from "./index";

describe("cash out (SPEC §8.5)", () => {
  it("rounds the fee up, so what the worker receives rounds down", () => {
    expect(cashoutQuote(sen(20_000))).toEqual({ feeSen: 100, rmOutSen: 19_900, bps: 50 });
    expect(cashoutQuote(sen(101))).toEqual({ feeSen: 1, rmOutSen: 100, bps: 50 });
  });

  it("transfers to the off-ramp and returns a labelled mock receipt", async () => {
    const transfer = vi.fn(async () => ({ txHash: "fake-tx-1" }));
    const receipt = await mockDuitNow(getMockLedger()).execute(
      transfer,
      "offramp.homeroll-test.testnet",
      sen(20_000),
      "tng",
    );
    expect(transfer).toHaveBeenCalledWith(
      "offramp.homeroll-test.testnet",
      senToUnits(sen(20_000)),
      "cash-out:tng",
    );
    expect(receipt).toMatchObject({ mock: true, kind: "duitnow", rmOutSen: 19_900 });
    expect(receipt.ref).toMatch(/^DN-SYN-\d{6}$/);
    expect(receipt.destination).toContain("TNG eWallet");
  });
});

describe("send home receipt (SPEC §8.4)", () => {
  it("transfers to the payout partner and returns a labelled mock receipt", async () => {
    const transfer = vi.fn(async () => ({ txHash: "fake-tx-2" }));
    const quote = SampleQuote.quote(sen(80_000));
    const receipt = await MockRoute.execute(
      transfer,
      "payout.homeroll-test.testnet",
      quote,
      getMockLedger(),
      "bKash •••• 4471",
    );
    expect(transfer).toHaveBeenCalledWith(
      "payout.homeroll-test.testnet",
      senToUnits(sen(80_000)),
      "send-home:MY-BD",
    );
    expect(receipt).toMatchObject({ mock: true, takaOut: quote.takaOut });
    expect(receipt.ref).toMatch(/^BKASH-SYN-\d{6}$/);
  });
});
