import type { AccountId } from "./accounts";

/**
 * Contract error codes (SPEC §7, §11). Contracts panic with these exact strings.
 * Mirrors contracts/common/src/errors.rs in the same order; errors.test.ts fails if the
 * two lists differ. Change a code only by agreement, and update SPEC in the same change.
 */
export const CONTRACT_ERROR_CODES = [
  // Shared
  "ERR_NOT_ADMIN",
  // Factory (§7.2)
  "ERR_INVALID_NAME",
  "ERR_ACCOUNT_EXISTS",
  "ERR_TOKEN_REGISTRATION_FAILED",
  // Payroll (§7.3)
  "ERR_EMPLOYER_EXISTS",
  "ERR_NOT_EMPLOYER",
  "ERR_UNKNOWN_EMPLOYER",
  "ERR_WRONG_TOKEN",
  "ERR_UNKNOWN_PAYEE",
  "ERR_TOO_MANY_PAYEES",
  "ERR_TOO_MANY_LINES",
  "ERR_PERIOD_NOT_OPEN",
  "ERR_PAYEE_NOT_ACTIVE",
  "ERR_ABOVE_WAGE_CAP",
  "ERR_DUPLICATE_PAYEE",
  "ERR_ALREADY_PAID",
  "ERR_BELOW_BUFFER",
  "ERR_INSUFFICIENT_TREASURY",
  "ERR_RUN_NOT_FOUND",
  "ERR_RUN_COMPLETE",
  // Pool (§7.4)
  "ERR_NOT_AGENT",
  "ERR_NOT_SETTLER",
  "ERR_INVOICE_ALREADY_REGISTERED",
  "ERR_ADVANCE_ABOVE_CAP",
  "ERR_POOL_INSUFFICIENT",
  "ERR_BUYER_EXPOSURE",
  "ERR_DEPOSIT_TOO_SMALL",
] as const;

export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

export interface ContractError {
  code: ContractErrorCode;
  /** Set when `submit_run` names the failing pay line (`<code>:<index>:<account>`, 0-based). */
  line?: { index: number; accountId: AccountId };
}

const CODES: ReadonlySet<string> = new Set(CONTRACT_ERROR_CODES);
const ERROR_IN_MESSAGE = /\b(ERR_[A-Z_]+)(?::(\d+):([a-z\d._-]+))?/;

/**
 * Finds a Homeroll error code in a failure message. RPC errors wrap the panic text, e.g.
 * "Smart contract panicked: ERR_ABOVE_WAGE_CAP:4:w-6b1x4k.homeroll.testnet".
 * Returns null when the failure did not come from one of our contracts.
 */
export function parseContractError(message: string): ContractError | null {
  const match = ERROR_IN_MESSAGE.exec(message);
  if (!match) return null;
  const [, code, index, accountId] = match;
  if (code === undefined || !isContractErrorCode(code)) return null;
  if (index === undefined || accountId === undefined) return { code };
  return { code, line: { index: Number(index), accountId } };
}

function isContractErrorCode(code: string): code is ContractErrorCode {
  return CODES.has(code);
}
