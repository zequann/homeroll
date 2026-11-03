import { type AccountId, isValidAccountId, workerAccountId } from "@homeroll/shared";
import { z } from "zod";
import companyJson from "./company.json";
import invoicesJson from "./invoices.json";
import lendersJson from "./lenders.json";
import timesheetJson from "./timesheets/2026-10.json";
import tamperedJson from "./timesheets/2026-10-tampered.json";
import workersJson from "./workers.json";

// All values here are synthetic (CLAUDE.md rule 1). Money is integer sen (SPEC §10).

const sen = z.number().int().nonnegative();
const workerAccountName = z.string().regex(/^w-[a-z0-9]{6}$/);

const companySchema = z.object({
  name: z.string(),
  town: z.string(),
  ownerLabel: z.string(),
  treasurySen: sen,
  bufferSen: sen,
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

const invoiceSchema = z.object({
  number: z.string(),
  buyer: z.string(),
  amountSen: sen,
  issued: z.string(),
  due: z.string(),
  grade: z.enum(["A", "B", "C", "D"]),
  advanceBps: z.number().int().min(0).max(8000),
  feeBps: z.number().int().min(0),
  checks: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      result: z.enum(["ok", "warn", "fail"]),
    }),
  ),
});

const timesheetSchema = z.array(z.object({ name: workerAccountName, amountSen: sen }));

const lenderSchema = z.object({
  name: z.string(),
  label: z.string(),
  depositUsdc: z.string().regex(/^\d+$/),
});

const WORKERS = z.array(workerSchema).parse(workersJson);
const BY_NAME = new Map(WORKERS.map((w) => [w.name, w]));

export type Worker = z.infer<typeof workerSchema> & { accountId: AccountId };
export type Invoice = z.infer<typeof invoiceSchema>;
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
    invoices: z.array(invoiceSchema).parse(invoicesJson),
    lender: { ...lender, accountId: labelledAccount(lender.label, root) },
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
