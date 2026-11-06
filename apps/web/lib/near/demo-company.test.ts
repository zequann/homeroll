import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtures } from "@homeroll/fixtures";
import { buyerHash, invoiceHash } from "@homeroll/shared/invoice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedInput } from "@/lib/seed/shell";

const ROOT = "homeroll-test.testnet";

const seedCompany = vi.fn();
vi.mock("@/lib/seed/shell.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seed/shell.ts")>();
  return { ...actual, seedCompany };
});

const readFundSnapshot = vi.fn();
const planFund = vi.fn();
const applyFundAction = vi.fn();
vi.mock("@/lib/fund/plan.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fund/plan.ts")>();
  return { ...actual, readFundSnapshot, planFund, applyFundAction };
});

function seedInput(): SeedInput {
  return {
    network: "testnet",
    root: ROOT,
    rpcUrl: "https://rpc.testnet.near.org",
    adminSecretKey: "ed25519:00",
    seedHex: "11".repeat(32),
  };
}

function ledgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "homeroll-demo-ledger-"));
  return join(dir, "demo-company.json");
}

let ledgerFile: string;
let ledgerDir: string;

beforeEach(() => {
  vi.resetModules();
  seedCompany.mockReset();
  readFundSnapshot.mockReset();
  planFund.mockReset();
  applyFundAction.mockReset();
  ledgerFile = ledgerPath();
  ledgerDir = join(ledgerFile, "..");
  process.env.DEMO_LEDGER_PATH = ledgerFile;
  delete process.env.CHAIN_CLIENT;
  delete process.env.NEAR_ROOT_ACCOUNT;
});

afterEach(() => {
  rmSync(ledgerDir, { recursive: true, force: true });
  delete process.env.DEMO_LEDGER_PATH;
  delete process.env.CHAIN_CLIENT;
  delete process.env.NEAR_ROOT_ACCOUNT;
});

async function loadDemoModule() {
  return import("./demo-company.ts");
}

function fundConvergesImmediately() {
  planFund.mockReturnValue([]);
  readFundSnapshot.mockResolvedValue({});
}

describe("provisionDemoCompany", () => {
  it("retries the same employer after seedCompany throws once", async () => {
    seedCompany.mockRejectedValueOnce(new Error("rpc down"));
    fundConvergesImmediately();

    const { provisionDemoCompany } = await loadDemoModule();
    await expect(provisionDemoCompany(seedInput())).rejects.toThrow("rpc down");
    const firstEmployer = seedCompany.mock.calls[0]?.[1]?.employer;
    expect(firstEmployer).toBeDefined();

    seedCompany.mockResolvedValueOnce({ outcome: "converged", txHashes: [] });
    fundConvergesImmediately();
    await provisionDemoCompany(seedInput());
    expect(seedCompany.mock.calls[1]?.[1]?.employer).toBe(firstEmployer);
  });

  it("publishes live company and overlay updates hashes", async () => {
    seedCompany.mockResolvedValue({ outcome: "converged", txHashes: [] });
    fundConvergesImmediately();

    const base = loadFixtures(ROOT);
    const { provisionDemoCompany } = await loadDemoModule();
    const { employer } = await provisionDemoCompany(seedInput());

    expect(employer).toBe(seedCompany.mock.calls[0]?.[1]?.employer);
    process.env.CHAIN_CLIENT = "near";
    process.env.NEAR_ROOT_ACCOUNT = ROOT;
    vi.resetModules();
    const { overlayLiveCompany: overlayAgain } = await import("./demo-company.ts");
    const { getFixtures } = await import("./index.ts");
    const overlaid = overlayAgain(base);
    expect(overlaid.company.accountId).toBe(employer);
    expect(overlaid.company.sellerTin).not.toBe(base.company.sellerTin);
    expect(getFixtures().company.accountId).toBe(employer);
    for (const inv of overlaid.invoices) {
      const fixture = base.invoices.find((i) => i.number === inv.number);
      expect(fixture).toBeDefined();
      expect(inv.hash).not.toBe(fixture?.hash);
      expect(inv.hash).toBe(
        invoiceHash({
          sellerTin: overlaid.company.sellerTin,
          buyerTin: inv.buyerTin,
          invoiceNo: inv.number,
          issueDate: inv.issued,
          amountSen: inv.amountSen,
        }),
      );
      expect(inv.buyerHash).toBe(buyerHash(inv.buyerTin));
    }
  });

  it("keeps previous live on overlay until publish", async () => {
    seedCompany.mockResolvedValue({ outcome: "converged", txHashes: [] });
    fundConvergesImmediately();
    const { provisionDemoCompany } = await loadDemoModule();
    const first = await provisionDemoCompany(seedInput());
    const base = loadFixtures(ROOT);

    process.env.CHAIN_CLIENT = "near";
    process.env.NEAR_ROOT_ACCOUNT = ROOT;
    vi.resetModules();

    seedCompany.mockImplementationOnce(async (_input, _company) => {
      const { overlayLiveCompany: overlay } = await import("./demo-company.ts");
      const mid = overlay(base);
      expect(mid.company.accountId).toBe(first.employer);
      return { outcome: "converged", txHashes: [] };
    });
    seedCompany.mockResolvedValue({ outcome: "converged", txHashes: [] });
    fundConvergesImmediately();

    const { provisionDemoCompany: provisionAgain } = await loadDemoModule();
    const second = await provisionAgain(seedInput());
    expect(second.employer).not.toBe(first.employer);
  });

  it("overlay ignores ledger in fake chain mode", async () => {
    seedCompany.mockResolvedValue({ outcome: "converged", txHashes: [] });
    fundConvergesImmediately();
    const base = loadFixtures(ROOT);
    const { provisionDemoCompany } = await loadDemoModule();
    await provisionDemoCompany(seedInput());
    process.env.CHAIN_CLIENT = "fake";
    vi.resetModules();
    const { overlayLiveCompany: overlayFake } = await import("./demo-company.ts");
    expect(overlayFake(base).company.accountId).toBe(base.company.accountId);
  });

  it("mints a new employer on a second converged provision", async () => {
    seedCompany.mockResolvedValue({ outcome: "converged", txHashes: [] });
    fundConvergesImmediately();
    const { provisionDemoCompany } = await loadDemoModule();
    await provisionDemoCompany(seedInput());
    await provisionDemoCompany(seedInput());
    const first = seedCompany.mock.calls[0]?.[1]?.employer;
    const second = seedCompany.mock.calls[1]?.[1]?.employer;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("a failed second reset keeps the company already published", async () => {
    let releaseFirst: () => void = () => {};
    const firstInsideSeed = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markInsideSeed: () => void = () => {};
    const insideSeed = new Promise<void>((resolve) => {
      markInsideSeed = resolve;
    });
    seedCompany.mockImplementationOnce(async () => {
      markInsideSeed();
      await firstInsideSeed;
      return { outcome: "converged", txHashes: [] };
    });
    fundConvergesImmediately();

    const { provisionDemoCompany } = await loadDemoModule();
    const first = provisionDemoCompany(seedInput());
    await insideSeed;

    seedCompany.mockRejectedValueOnce(new Error("rpc down"));
    const second = provisionDemoCompany(seedInput());
    releaseFirst();

    const published = await first;
    await expect(second).rejects.toThrow("rpc down");

    process.env.CHAIN_CLIENT = "near";
    process.env.NEAR_ROOT_ACCOUNT = ROOT;
    vi.resetModules();
    const { overlayLiveCompany: overlay } = await import("./demo-company.ts");
    expect(overlay(loadFixtures(ROOT)).company.accountId).toBe(published.employer);
  });

  it("replaces employer once on foreign_key refusal", async () => {
    seedCompany
      .mockImplementationOnce(async (_input, company) => ({
        outcome: "refused",
        refusal: { reason: "foreign_key", account: company.employer },
      }))
      .mockResolvedValueOnce({ outcome: "converged", txHashes: [] });
    fundConvergesImmediately();

    const { provisionDemoCompany } = await loadDemoModule();
    await provisionDemoCompany(seedInput());
    expect(seedCompany).toHaveBeenCalledTimes(2);
    const first = seedCompany.mock.calls[0]?.[1]?.employer;
    const second = seedCompany.mock.calls[1]?.[1]?.employer;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("keeps the employer when foreign_key names another account", async () => {
    seedCompany.mockImplementationOnce(async () => ({
      outcome: "refused",
      refusal: { reason: "foreign_key", account: `w-7k2q9x.${ROOT}` },
    }));
    const { provisionDemoCompany } = await loadDemoModule();
    await expect(provisionDemoCompany(seedInput())).rejects.toThrow(/foreign_key/);
    const firstEmployer = seedCompany.mock.calls[0]?.[1]?.employer;
    expect(firstEmployer).toBeDefined();
    expect(seedCompany).toHaveBeenCalledTimes(1);

    seedCompany.mockResolvedValueOnce({ outcome: "converged", txHashes: [] });
    fundConvergesImmediately();
    await provisionDemoCompany(seedInput());
    expect(seedCompany.mock.calls[1]?.[1]?.employer).toBe(firstEmployer);
  });
});
