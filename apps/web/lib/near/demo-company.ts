import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Fixtures, loadFixtures } from "@homeroll/fixtures";
import type { AccountId } from "@homeroll/shared";
import { homerollAccounts } from "@homeroll/shared";
import { buyerHash, invoiceHash } from "@homeroll/shared/invoice";
import { getEnv } from "../env.ts";
import { derivedDepositRouteAccounts, provisionDepositRoute } from "../fund/deposit-route.ts";
import {
  applyFundAction,
  companyFloors,
  fundAccounts,
  planFund,
  readFundSnapshot,
} from "../fund/plan.ts";
import { adminSigner, deriveKey } from "../keys.ts";
import type { SeedCompany } from "../seed/plan.ts";
import { type SeedInput, seedCompany } from "../seed/shell.ts";
import { type RowStore, rowStore } from "../store/rows.ts";
import { configureRpc, transferNear, viewAccount } from "./rpc.ts";

type DemoEmployerId = AccountId;
type Tin = string;

export type DemoCompany = {
  readonly employer: DemoEmployerId;
  readonly sellerTin: Tin;
  readonly buyerTinByInvoice: Readonly<Record<string, Tin>>;
};

type DemoLedger = {
  readonly root: AccountId;
  readonly live: DemoCompany | null;
  readonly provisioning: DemoCompany | null;
};

export type EmployerCache<T> = Map<AccountId, T>;

export function cacheForEmployer<T>(
  cache: EmployerCache<T>,
  employer: AccountId,
  factory: () => T,
): T {
  let value = cache.get(employer);
  if (value === undefined) {
    value = factory();
    cache.set(employer, value);
  }
  return value;
}

function ledgerPath(): string {
  const override = process.env.DEMO_LEDGER_PATH?.trim();
  if (override) return override;
  // The Next server bundle's import.meta.url is not a filesystem path fileURLToPath can take.
  if (process.env.NEXT_RUNTIME) return join(process.cwd(), ".data", "demo-company.json");
  return fileURLToPath(new URL("../../.data/demo-company.json", import.meta.url).href);
}

function lockPath(): string {
  return `${ledgerPath()}.lock`;
}

function isCompany(value: unknown): value is DemoCompany {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.employer !== "string" || typeof row.sellerTin !== "string") return false;
  if (typeof row.buyerTinByInvoice !== "object" || row.buyerTinByInvoice === null) return false;
  return Object.values(row.buyerTinByInvoice).every((tin) => typeof tin === "string");
}

function readLedgerFile(): DemoLedger | null {
  const path = ledgerPath();
  if (!existsSync(path)) return null;
  return parseLedger(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function parseLedger(raw: unknown): DemoLedger {
  if (typeof raw !== "object" || raw === null) throw new Error("demo ledger is unreadable");
  const row = raw as Record<string, unknown>;
  if (typeof row.root !== "string") throw new Error("demo ledger is unreadable");
  if (row.live !== null && !isCompany(row.live)) throw new Error("demo ledger is unreadable");
  if (row.provisioning !== null && !isCompany(row.provisioning)) {
    throw new Error("demo ledger is unreadable");
  }
  return {
    root: row.root,
    live: row.live as DemoCompany | null,
    provisioning: row.provisioning as DemoCompany | null,
  };
}

function assertLedger(ledger: DemoLedger): void {
  if (ledger.live && ledger.provisioning && ledger.live.employer === ledger.provisioning.employer) {
    throw new Error("demo ledger cannot set the same employer on live and provisioning");
  }
}

function writeLedgerFile(ledger: DemoLedger): void {
  assertLedger(ledger);
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger), "utf8");
  const fd = openSync(tmp, "r+");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

async function withLedgerFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeSync(fd, `${process.pid}\n`);
      try {
        return await fn();
      } finally {
        closeSync(fd);
        unlinkSync(path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
        process.kill(pid, 0);
      } catch {
        unlinkSync(path);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// --- The ledger in the shared store (Supabase): every server instance sees the live company ------
// On Vercel the file system is read-only and each request may run on another instance, so with a
// shared store the ledger is one row of `demo_company`, and a lock row replaces the lock file.

const LEDGER_TABLE = "demo_company";
const LEDGER_SCOPE = "ledger";
// A reset can take minutes (§9.6). Past this, a lock from a crashed reset is taken over.
const LEDGER_LOCK_TTL_MS = 330_000;
const LEDGER_LOCK_POLL_MS = 1_000;

function sharedRows(): RowStore | null {
  const store = rowStore();
  return store.kind === "supabase" ? store : null;
}

const globalForLedger = globalThis as unknown as {
  /** The shared ledger as this instance last read it; undefined = never read. */
  __homerollLiveLedger?: DemoLedger | null;
  __homerollLiveLedgerWarned?: boolean;
};

async function readLedger(): Promise<DemoLedger | null> {
  const rows = sharedRows();
  if (!rows) return readLedgerFile();
  const raw = await rows.get<unknown>(LEDGER_TABLE, LEDGER_SCOPE, "ledger");
  const ledger = raw === null ? null : parseLedger(raw);
  globalForLedger.__homerollLiveLedger = ledger;
  return ledger;
}

async function writeLedger(ledger: DemoLedger): Promise<void> {
  const rows = sharedRows();
  if (!rows) return writeLedgerFile(ledger);
  assertLedger(ledger);
  await rows.upsert(LEDGER_TABLE, LEDGER_SCOPE, "ledger", ledger);
  globalForLedger.__homerollLiveLedger = ledger;
}

async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const rows = sharedRows();
  if (!rows) return withLedgerFileLock(fn);
  for (;;) {
    const now = Date.now();
    if (
      await rows.insert(LEDGER_TABLE, LEDGER_SCOPE, "lock", { until: now + LEDGER_LOCK_TTL_MS })
    ) {
      break;
    }
    const held = await rows.get<{ until: number }>(LEDGER_TABLE, LEDGER_SCOPE, "lock");
    if (held && held.until < now) {
      await rows.remove(LEDGER_TABLE, LEDGER_SCOPE, "lock");
      continue;
    }
    // Another reset is running: wait for it, as a second press of Reset demo does
    await new Promise((resolve) => setTimeout(resolve, LEDGER_LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    await rows.remove(LEDGER_TABLE, LEDGER_SCOPE, "lock");
  }
}

/**
 * Reads which demo company is live from the shared store, so `getFixtures()` in the rest of this
 * request (synchronous, everywhere) uses it. Call it first in every page, server action and API
 * route. A no-op on the fake chain and without a shared store (the ledger file is read directly).
 */
export async function syncLiveCompany(): Promise<void> {
  if (getEnv().chainClient !== "near" || !sharedRows()) return;
  await readLedger();
}

function liveLedger(): DemoLedger | null {
  if (!sharedRows()) return readLedgerFile();
  const ledger = globalForLedger.__homerollLiveLedger;
  if (ledger === undefined) {
    if (!globalForLedger.__homerollLiveLedgerWarned) {
      globalForLedger.__homerollLiveLedgerWarned = true;
      console.warn("[demo] live company not loaded: call syncLiveCompany() first in this request");
    }
    return null;
  }
  return ledger;
}

const RECLAIM_KEEP_YOCTO = 10n ** 23n;

/** The old employer no longer pays gas. Its spare NEAR goes back to the root for the next company. */
async function reclaimEmployerNear(input: SeedInput, employer: AccountId): Promise<boolean> {
  configureRpc(input.rpcUrl);
  const account = await viewAccount(employer);
  if (!account.exists || account.balanceYocto <= RECLAIM_KEEP_YOCTO) return false;
  const owner = deriveKey(input.seedHex as string, employer, "owner");
  await transferNear(owner, input.root, account.balanceYocto - RECLAIM_KEEP_YOCTO);
  return true;
}

function assertSeedReady(input: SeedInput): void {
  if (!input.adminSecretKey) throw new Error("admin_key_missing");
  if (input.seedHex === null) throw new Error("seed_missing");
}

function fixtureTins(base: Fixtures): { seller: Set<string>; buyers: Set<string> } {
  const buyers = new Set(base.invoices.map((i) => i.buyerTin));
  return { seller: new Set([base.company.sellerTin]), buyers };
}

function mintTin(used: Set<string>, forbidden: Set<string>): Tin {
  for (;;) {
    const tin = `SYN-C${randomBytes(5).toString("hex").toUpperCase()}`;
    if (!used.has(tin) && !forbidden.has(tin)) return tin;
  }
}

function mintEmployer(
  ownerLabel: string,
  root: AccountId,
  forbidden: Set<AccountId>,
): DemoEmployerId {
  for (;;) {
    const id = `${ownerLabel}-${randomBytes(2).toString("hex")}.${root}` as DemoEmployerId;
    if (!forbidden.has(id)) return id;
  }
}

function mintDemoCompany(base: Fixtures, ledger: DemoLedger | null): DemoCompany {
  const tins = fixtureTins(base);
  const usedTins = new Set<string>();
  const forbiddenEmployers = new Set<AccountId>([base.company.accountId]);
  if (ledger?.live) forbiddenEmployers.add(ledger.live.employer);
  if (ledger?.provisioning) forbiddenEmployers.add(ledger.provisioning.employer);

  const sellerTin = mintTin(usedTins, tins.seller);
  usedTins.add(sellerTin);
  const buyerTinByInvoice: Record<string, Tin> = {};
  for (const invoice of base.invoices) {
    const forbiddenBuyers = new Set([...tins.buyers, ...usedTins]);
    const buyerTin = mintTin(usedTins, forbiddenBuyers);
    usedTins.add(buyerTin);
    buyerTinByInvoice[invoice.number] = buyerTin;
  }
  return {
    employer: mintEmployer(base.company.ownerLabel, base.root, forbiddenEmployers),
    sellerTin,
    buyerTinByInvoice,
  };
}

function seedWorkers(base: Fixtures): SeedCompany["workers"] {
  return base.workers.map((worker) => ({
    name: worker.name,
    accountId: worker.accountId,
    capSen: worker.capSen,
  }));
}

async function runFund(input: SeedInput, employer: DemoEmployerId, base: Fixtures): Promise<void> {
  configureRpc(input.rpcUrl);
  const admin = adminSigner(input.root, input.adminSecretKey);
  if (!admin) throw new Error("admin_key_missing");
  const escrow = homerollAccounts(input.root).escrow;
  const accounts = {
    ...fundAccounts(
      input.root,
      deriveKey(input.seedHex as string, escrow, "escrow").publicKey,
      base.company.ownerLabel,
    ),
    employer,
  };
  const floors = companyFloors(base);
  let actions = planFund(await readFundSnapshot(accounts), floors, accounts);
  for (const action of actions) await applyFundAction(action, admin);
  actions = planFund(await readFundSnapshot(accounts), floors, accounts);
  if (actions.length > 0) throw new Error("fund plan did not converge");
  // The mock solver's float and the demo lender's account, for private deposits (SPEC §8.9)
  await provisionDepositRoute(
    derivedDepositRouteAccounts(input.root, input.seedHex as string, base.lender.accountId),
    admin,
  );
}

function seedPayload(company: DemoCompany, base: Fixtures): SeedCompany {
  return {
    employer: company.employer,
    bufferSen: base.company.bufferSen,
    workers: seedWorkers(base),
  };
}

export async function provisionDemoCompany(
  input: SeedInput,
): Promise<{ employer: DemoEmployerId }> {
  const base = loadFixtures(input.root);
  assertSeedReady(input);

  return withLedgerLock(async () => {
    const existing = await readLedger();
    if (existing && existing.root !== input.root) {
      throw new Error("demo ledger root does not match NEAR_ROOT_ACCOUNT");
    }
    let ledger: DemoLedger = existing ?? {
      root: input.root,
      live: null,
      provisioning: null,
    };

    let company = ledger.provisioning;
    if (!company) {
      company = mintDemoCompany(base, ledger);
      ledger = { ...ledger, provisioning: company };
      // The id is on disk before any chain call, so a crash retries this employer.
      await writeLedger(ledger);
    }

    let seedReport = await seedCompany(input, seedPayload(company, base));
    if (
      seedReport.outcome === "refused" &&
      seedReport.refusal.reason === "foreign_key" &&
      seedReport.refusal.account === company.employer
    ) {
      company = mintDemoCompany(base, { ...ledger, provisioning: company });
      ledger = { ...ledger, provisioning: company };
      await writeLedger(ledger);
      seedReport = await seedCompany(input, seedPayload(company, base));
    }

    if (seedReport.outcome === "refused") {
      throw new Error(`seed refused: ${seedReport.refusal.reason}`);
    }
    if (
      seedReport.outcome === "blocked" &&
      seedReport.reason === "insufficient_root_balance" &&
      ledger.live &&
      ledger.live.employer !== company.employer
    ) {
      const returned = await reclaimEmployerNear(input, ledger.live.employer);
      if (returned) seedReport = await seedCompany(input, seedPayload(company, base));
    }
    if (seedReport.outcome === "blocked") {
      throw new Error(`seed blocked: ${seedReport.reason}`);
    }
    if (seedReport.outcome !== "converged") {
      throw new Error(`seed did not converge: ${seedReport.outcome}`);
    }

    await runFund(input, company.employer, base);

    ledger = { root: input.root, live: company, provisioning: null };
    await writeLedger(ledger);
    return { employer: company.employer };
  });
}

export function overlayLiveCompany(base: Fixtures): Fixtures {
  if (getEnv().chainClient !== "near") return base;
  const ledger = liveLedger();
  if (!ledger || ledger.root !== base.root || !ledger.live) return base;
  const live = ledger.live;
  return {
    ...base,
    company: {
      ...base.company,
      accountId: live.employer,
      sellerTin: live.sellerTin,
    },
    invoices: base.invoices.map((invoice) => {
      const buyerTin = live.buyerTinByInvoice[invoice.number];
      if (!buyerTin) {
        throw new Error(`demo ledger missing buyer TIN for invoice ${invoice.number}`);
      }
      return {
        ...invoice,
        buyerTin,
        hash: invoiceHash({
          sellerTin: live.sellerTin,
          buyerTin,
          invoiceNo: invoice.number,
          issueDate: invoice.issued,
          amountSen: invoice.amountSen,
        }),
        buyerHash: buyerHash(buyerTin),
      };
    }),
  };
}
