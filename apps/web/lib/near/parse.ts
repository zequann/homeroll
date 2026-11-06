import { type Units, units } from "@/lib/fx";
import type {
  AccessKeyView,
  EmployerView,
  InvoiceStatus,
  InvoiceView,
  LenderView,
  PayeeView,
  Period,
  PoolView,
  RunStatus,
  RunView,
} from "./client";

function decimalString(field: string, value: unknown): string {
  if (typeof value === "number") {
    throw new Error(`${field} must not be a JSON number`);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be a decimal string`);
  }
  return value;
}

function parseUnits(field: string, value: unknown): Units {
  return units(BigInt(decimalString(field, value)));
}

function parseU64(field: string, value: unknown): bigint {
  return BigInt(decimalString(field, value));
}

function parseRunId(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error("run_id must be a safe integer");
}

export function parsePayees(raw: unknown): PayeeView[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("payees must be an array or null");
  return raw.map((row, index) => {
    if (typeof row !== "object" || row === null) throw new Error(`payee ${index} is not an object`);
    const record = row as Record<string, unknown>;
    const accountId = record.account_id;
    if (typeof accountId !== "string") throw new Error(`payee ${index} missing account_id`);
    return {
      accountId,
      cap: parseUnits(`payees[${index}].cap`, record.cap),
      activeFrom: parseU64(`payees[${index}].active_from`, record.active_from),
    };
  });
}

export function parseEmployer(raw: unknown): EmployerView | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw new Error("employer must be an object or null");
  const record = raw as Record<string, unknown>;
  return {
    treasury: parseUnits("treasury", record.treasury),
    buffer: parseUnits("buffer", record.buffer),
    onboarding: Boolean(record.onboarding),
    payeeCount: Number(record.payee_count),
  };
}

function parseLineStatus(value: unknown): RunView["lines"][number]["status"] {
  if (
    value === "Reserved" ||
    value === "Sent" ||
    value === "Paid" ||
    value === "Failed" ||
    value === "Skipped" ||
    value === "Cancelled"
  ) {
    return value;
  }
  throw new Error(`unknown line status ${String(value)}`);
}

function parseRunStatus(value: unknown): RunStatus {
  if (value === "Pending" || value === "Done" || value === "Cancelled") return value;
  throw new Error(`unknown run status ${String(value)}`);
}

export function parseRuns(raw: unknown): RunView[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) throw new Error("runs must be an array or null");
  return raw.map((run, runIndex) => {
    if (typeof run !== "object" || run === null)
      throw new Error(`run ${runIndex} is not an object`);
    const record = run as Record<string, unknown>;
    const linesRaw = record.lines;
    if (!Array.isArray(linesRaw)) throw new Error(`run ${runIndex} missing lines`);
    const lines = linesRaw.map((line, lineIndex) => {
      if (typeof line !== "object" || line === null) {
        throw new Error(`run ${runIndex} line ${lineIndex} is not an object`);
      }
      const row = line as Record<string, unknown>;
      const accountId = row.account_id;
      if (typeof accountId !== "string") throw new Error("line missing account_id");
      return {
        accountId,
        amount: parseUnits(`lines[${lineIndex}].amount`, row.amount),
        status: parseLineStatus(row.status),
      };
    });
    const periodValue = record.period;
    if (typeof periodValue !== "string") throw new Error("run missing period");
    return {
      runId: parseRunId(record.run_id),
      period: periodValue as Period,
      status: parseRunStatus(record.status),
      lines,
    };
  });
}

function parseInvoiceStatus(value: unknown): InvoiceStatus {
  if (value === "Attested" || value === "Advanced" || value === "Settled" || value === "Declined") {
    return value;
  }
  throw new Error(`unknown invoice status ${String(value)}`);
}

export function parseInvoice(raw: unknown, invoiceHash: string): InvoiceView | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw new Error("invoice must be an object or null");
  const record = raw as Record<string, unknown>;
  const employer = record.employer;
  if (typeof employer !== "string") throw new Error("invoice missing employer");
  const grade = record.grade;
  if (grade !== "A" && grade !== "B" && grade !== "C" && grade !== "D") {
    throw new Error("invoice missing grade");
  }
  const advanceRaw = record.advance;
  const feeRaw = record.fee;
  return {
    invoiceKey: invoiceHash,
    employer,
    amount: parseUnits("amount", record.amount),
    grade,
    status: parseInvoiceStatus(record.status),
    advance:
      advanceRaw === null || advanceRaw === undefined ? null : parseUnits("advance", advanceRaw),
    fee: feeRaw === null || feeRaw === undefined ? null : parseUnits("fee", feeRaw),
  };
}

export function parsePool(raw: unknown): PoolView {
  if (typeof raw !== "object" || raw === null) throw new Error("pool must be an object");
  const record = raw as Record<string, unknown>;
  return {
    cash: parseUnits("cash", record.cash),
    outstanding: parseUnits("outstanding", record.outstanding),
    feesEarned: parseUnits("fees_earned", record.fees_earned),
    totalShares: BigInt(decimalString("total_shares", record.total_shares)),
    minFirstDeposit: parseUnits("min_first_deposit", record.min_first_deposit),
  };
}

/** `get_lender`: null for an account the pool has never seen. */
export function parseLender(raw: unknown): LenderView | null {
  if (raw === null) return null;
  if (typeof raw !== "object") throw new Error("lender must be an object or null");
  const record = raw as Record<string, unknown>;
  return {
    shares: BigInt(decimalString("shares", record.shares)),
    pendingAssets:
      record.pending_assets === null || record.pending_assets === undefined
        ? null
        : parseUnits("pending_assets", record.pending_assets),
  };
}

export function parseAccessKeys(accountId: string, raw: unknown): AccessKeyView[] {
  if (typeof raw !== "object" || raw === null || !("keys" in raw) || !Array.isArray(raw.keys)) {
    throw new Error("access key list is missing keys");
  }
  return raw.keys.map((item) => {
    if (typeof item !== "object" || item === null)
      throw new Error("access key entry is not an object");
    const row = item as { public_key?: unknown; access_key?: { permission?: unknown } };
    if (typeof row.public_key !== "string") throw new Error("access key entry has no public key");
    const permission = row.access_key?.permission;
    if (
      permission === "FullAccess" ||
      (typeof permission === "object" && permission !== null && "FullAccess" in permission)
    ) {
      return { accountId, publicKey: row.public_key, permission: { kind: "FullAccess" as const } };
    }
    const inner =
      typeof permission === "object" && permission !== null && "FunctionCall" in permission
        ? (permission as { FunctionCall: Record<string, unknown> }).FunctionCall
        : null;
    if (!inner) throw new Error("unreadable function call permission");
    const receiverId = inner.receiver_id ?? inner.receiverId;
    const methodNames = inner.method_names ?? inner.methodNames;
    if (typeof receiverId !== "string" || !Array.isArray(methodNames)) {
      throw new Error("function call permission missing fields");
    }
    const allowanceRaw = inner.allowance;
    const allowance =
      typeof allowanceRaw === "string" && /^\d+$/.test(allowanceRaw)
        ? BigInt(allowanceRaw)
        : typeof allowanceRaw === "bigint"
          ? allowanceRaw
          : null;
    return {
      accountId,
      publicKey: row.public_key,
      permission: {
        kind: "FunctionCall",
        receiverId,
        methodNames: methodNames.filter((m): m is string => typeof m === "string"),
        allowance,
      },
    };
  });
}
