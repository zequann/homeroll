import {
  type AccountId,
  isValidAccountId,
  LENDER_NAME_PATTERN,
  lenderAccountId,
  workerAccountId,
} from "@homeroll/shared";
import { buyerHash, invoiceHash } from "@homeroll/shared/invoice";
import { z } from "zod";
import companyJson from "./company.json" with { type: "json" };
import invoicesJson from "./invoices.json" with { type: "json" };
import lendersJson from "./lenders.json" with { type: "json" };
import timesheetJson from "./timesheets/2026-10.json" with { type: "json" };
import tamperedJson from "./timesheets/2026-10-tampered.json" with { type: "json" };
import workersJson from "./workers.json" with { type: "json" };

// All values here are synthetic (CLAUDE.md rule 1). Money is integer sen (SPEC §10).

const sen = z.number().int().nonnegative();
const workerAccountName = z.string().regex(/^w-[a-z0-9]{6}$/);

const companySchema = z.object({
  name: z.string(),
  town: z.string(),
  ownerLabel: z.string(),
  treasurySen: sen,
  bufferSen: sen,
  /** Synthetic seller TIN. Each Reset demo company gets a fresh one (SPEC §9.6). */
  sellerTin: z.string().startsWith("SYN-"),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

const workerSchema = z.object({
  name: workerAccountName,
  displayName: z.string(),
  country: z.string(),
  role: z.string(),
  wageSen: sen,
  capSen: sen,
  possessive: z.enum(["his", "her"]).optional(),
  family: z.object({ label: z.string(), wallet: z.string(), city: z.string() }).optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * What the invoice agent can look up about one invoice (SPEC §8.1): the document's fields plus the
 * evidence the mock MyInvois, PO/delivery and buyer-history checks read. The grade is decided by
 * code in lib/agents; `expectedGrade` is SPEC §4's expected result, kept so tests can compare.
 */
const invoiceSchema = z.object({
  number: z.string(),
  buyer: z.string(),
  buyerTin: z.string().startsWith("SYN-"),
  amountSen: sen,
  issued: isoDate,
  due: isoDate,
  poNumber: z.string().nullable(),
  /** null = no MyInvois record exists. */
  myinvoisUuid: z.string().nullable(),
  deliveryOrderSigned: z.boolean(),
  buyerHistory: z.object({
    invoices: z.number().int().nonnegative(),
    paidOnTime: z.number().int().nonnegative(),
    paidAfter120Days: z.number().int().nonnegative(),
    averageDays: z.number().int().nonnegative(),
  }),
  expectedGrade: z.enum(["A", "B", "C", "D"]),
});

const timesheetSchema = z.array(z.object({ name: workerAccountName, amountSen: sen }));

const lenderSchema = z.object({
  /** Off-chain only. On-chain the lender is its pseudonymous account (SPEC §8.9). */
  name: z.string(),
  accountName: z.string().regex(LENDER_NAME_PATTERN),
  /** What the lender has already deposited in the fake chain. On testnet the root seeded the pool. */
  depositUsdc: z.string().regex(/^\d+$/),
});

const WORKERS = z.array(workerSchema).parse(workersJson);
const BY_NAME = new Map(WORKERS.map((w) => [w.name, w]));

export type Worker = z.infer<typeof workerSchema> & { accountId: AccountId };
export type Invoice = z.infer<typeof invoiceSchema> & {
  /** The pool's registry key (SPEC §7.4). */
  hash: string;
  buyerHash: string;
};
export type Timesheet = { accountId: AccountId; amountSen: number }[];

export interface Fixtures {
  root: AccountId;
  company: z.infer<typeof companySchema> & { accountId: AccountId };
  workers: Worker[];
  invoices: Invoice[];
  lender: z.infer<typeof lenderSchema> & { accountId: AccountId };
  /** Net wages for October, one line per worker, in worker order. */
  timesheet: Timesheet;
  /** The same timesheet with Hafiz's line inflated: stands in for the payroll agent's output. */
  timesheetTampered: Timesheet;
}

export function loadFixtures(root: AccountId): Fixtures {
  const company = companySchema.parse(companyJson);
  const [lender] = z.array(lenderSchema).min(1).parse(lendersJson);
  if (!lender) throw new Error("lenders.json is empty");

  const toLines = (raw: unknown): Timesheet =>
    timesheetSchema.parse(raw).map((l) => ({
      accountId: workerAccountId(l.name, root),
      amountSen: l.amountSen,
    }));

  return {
    root,
    company: { ...company, accountId: labelledAccount(company.ownerLabel, root) },
    workers: WORKERS.map((w) => ({ ...w, accountId: workerAccountId(w.name, root) })),
    invoices: z
      .array(invoiceSchema)
      .parse(invoicesJson)
      .map((i) => ({
        ...i,
        hash: invoiceHash({
          sellerTin: company.sellerTin,
          buyerTin: i.buyerTin,
          invoiceNo: i.number,
          issueDate: i.issued,
          amountSen: i.amountSen,
        }),
        buyerHash: buyerHash(i.buyerTin),
      })),
    lender: { ...lender, accountId: lenderAccountId(lender.accountName, root) },
    timesheet: toLines(timesheetJson),
    timesheetTampered: toLines(tamperedJson),
  };
}

/** Business accounts have readable names (SPEC §6); packages/shared has no helper for them yet. */
function labelledAccount(label: string, root: AccountId): AccountId {
  const id = `${label}.${root}`;
  if (!isValidAccountId(id)) throw new Error(`Invalid NEAR account ID "${id}"`);
  return id;
}

export interface WorkerNameRecord {
  displayName: string;
  possessive: "his" | "her" | "their";
}

/**
 * Resolves a pseudonymous worker account to a name, off-chain only (SPEC §12, rule R13).
 * Returns null for any account that is not one of the 40 synthetic workers.
 */
export function workerName(accountId: AccountId): WorkerNameRecord | null {
  const worker = BY_NAME.get(accountId.split(".")[0] ?? "");
  if (!worker) return null;
  return { displayName: worker.displayName, possessive: worker.possessive ?? "their" };
}
