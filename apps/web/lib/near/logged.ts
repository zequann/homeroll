import type { AccountId, HomerollAccounts } from "@homeroll/shared";
import type { ActivityLog } from "@/lib/activity";
import { type Units, units } from "@/lib/fx";
import type { Attestation, ChainClient, PayLine, Signer, Tx } from "./client";
import { failureText } from "./failure";

/**
 * Records every call for the Activity tab (SPEC §9.1), failures included. The fake chain logs for
 * itself; this does it for a client that does not. Only the call's shape is read, so no name ever
 * reaches the log (rule R13). In memory until Supabase holds the `activity` table (SPEC §8.7).
 */
type Described = { method: string; to: AccountId; amount: Units | null };

export function withActivityLog(
  inner: ChainClient,
  accounts: HomerollAccounts,
  log: ActivityLog,
  now: () => number = Date.now,
): ChainClient {
  const { payroll, pool } = accounts;
  const describe: Partial<Record<keyof ChainClient, (...args: never[]) => Described>> = {
    submitRun: (_s: Signer, _p: string, lines: PayLine[]) => ({
      method: "submit_run",
      to: payroll,
      amount: units(lines.reduce((sum, l) => sum + l.amount, 0n)),
    }),
    payRun: () => ({ method: "pay_run", to: payroll, amount: null }),
    addPayee: () => ({ method: "add_payee", to: payroll, amount: null }),
    removePayee: () => ({ method: "remove_payee", to: payroll, amount: null }),
    cancelRun: () => ({ method: "cancel_run", to: payroll, amount: null }),
    attestInvoice: (_s: Signer, a: Attestation) => ({
      method: "attest_invoice",
      to: pool,
      amount: a.amount,
    }),
    requestAdvance: (_s: Signer, _k: string, amount: Units) => ({
      method: "request_advance",
      to: pool,
      amount,
    }),
    settleInvoice: (_s: Signer, _k: string, paid: Units) => ({
      method: "settle",
      to: pool,
      amount: paid,
    }),
    ftTransfer: (_s: Signer, to: AccountId, amount: Units) => ({
      method: "ft_transfer",
      to,
      amount,
    }),
  };

  return new Proxy(inner, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      const shape = describe[key as keyof ChainClient];
      if (!shape || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (signer: Signer, ...rest: unknown[]) => {
        const { method, to, amount } = (shape as (...a: unknown[]) => Described)(signer, ...rest);
        const record = (txHash: string | null, failure: string | null) =>
          log.record({ at: now(), method, from: signer.accountId, to, amount, txHash, failure });
        try {
          const result: Tx<unknown> = await value.call(target, signer, ...rest);
          record(result.txHash, result.ok ? null : failureText(result.failure));
          return result;
        } catch (error) {
          record(null, error instanceof Error ? error.message : String(error));
          throw error;
        }
      };
    },
  });
}
