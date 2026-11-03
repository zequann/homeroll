import type { TxFailure } from "./client";

/** The exact text a failure has on chain, e.g. `ERR_ABOVE_WAGE_CAP:4:w-6b1x4k.<root>`. */
export function failureText(failure: TxFailure): string {
  if (failure.kind === "protocol") return `InvalidAccessKeyError: ${failure.name}`;
  const { code, line } = failure.error;
  return line ? `${code}:${line.index}:${line.accountId}` : code;
}
