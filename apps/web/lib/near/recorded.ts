import { type AccountId, homerollAccounts } from "@homeroll/shared";
import { type ActivityLog, getActivityLog } from "@/lib/activity";
import { type Units, units } from "@/lib/fx";
import type { ChainClient, Tx } from "./client";
import { failureText } from "./failure";

/**
 * Records every call a chain client makes in the activity log, failed ones too, as the fake chain
 * does inside itself. The owner's Activity tab and Rahim's phone read that log, so without this
 * they stay empty on testnet. Views pass straight through.
 */
export function recordingActivity(
  chain: ChainClient,
  root: AccountId,
  log: ActivityLog = getActivityLog(),
): ChainClient {
  const accounts = homerollAccounts(root);
  const record = <T>(
    method: string,
    from: AccountId,
    to: AccountId,
    amount: Units | null,
    tx: Tx<T>,
  ): Tx<T> => {
    log.record({
      at: Date.now(),
      method,
      from,
      to,
      amount,
      txHash: tx.txHash,
      failure: tx.ok ? null : failureText(tx.failure),
    });
    return tx;
  };

  return {
    network: chain.network,
    getEmployer: (employer) => chain.getEmployer(employer),
    getPayees: (employer) => chain.getPayees(employer),
    getRuns: (employer, period) => chain.getRuns(employer, period),
    getInvoice: (invoiceKey) => chain.getInvoice(invoiceKey),
    getPool: () => chain.getPool(),
    getLender: (accountId) => chain.getLender(accountId),
    ftBalanceOf: (accountId) => chain.ftBalanceOf(accountId),
    getAccessKeys: (accountId) => chain.getAccessKeys(accountId),

    submitRun: async (signer, period, lines) =>
      record(
        "submit_run",
        signer.accountId,
        accounts.payroll,
        units(lines.reduce((sum, l) => sum + l.amount, 0n)),
        await chain.submitRun(signer, period, lines),
      ),
    payRun: async (signer, runId) =>
      record(
        "pay_run",
        signer.accountId,
        accounts.payroll,
        null,
        await chain.payRun(signer, runId),
      ),
    addPayee: async (signer, accountId, cap) =>
      record(
        "add_payee",
        signer.accountId,
        accounts.payroll,
        null,
        await chain.addPayee(signer, accountId, cap),
      ),
    removePayee: async (signer, accountId) =>
      record(
        "remove_payee",
        signer.accountId,
        accounts.payroll,
        null,
        await chain.removePayee(signer, accountId),
      ),
    cancelRun: async (signer, runId) =>
      record(
        "cancel_run",
        signer.accountId,
        accounts.payroll,
        null,
        await chain.cancelRun(signer, runId),
      ),
    attestInvoice: async (signer, a) =>
      record(
        "attest_invoice",
        signer.accountId,
        accounts.pool,
        a.amount,
        await chain.attestInvoice(signer, a),
      ),
    requestAdvance: async (signer, invoiceKey, amount) =>
      record(
        "request_advance",
        signer.accountId,
        accounts.pool,
        amount,
        await chain.requestAdvance(signer, invoiceKey, amount),
      ),
    settleInvoice: async (signer, invoiceKey, paid) => {
      const tx = await chain.settleInvoice(signer, invoiceKey, paid);
      const method = tx.ok && !tx.value.settled ? "settle (refunded)" : "settle";
      return record(method, signer.accountId, accounts.pool, paid, tx);
    },
    ftTransfer: async (signer, receiverId, amount, memo) =>
      record(
        "ft_transfer",
        signer.accountId,
        receiverId,
        amount,
        await chain.ftTransfer(signer, receiverId, amount, memo),
      ),
    deliverFromSolver: async (lender, amount) =>
      record(
        "ft_transfer (mock delivery)",
        accounts.solver,
        lender,
        amount,
        await chain.deliverFromSolver(lender, amount),
      ),
    depositToPool: async (signer, amount) =>
      record(
        "deposit",
        signer.accountId,
        accounts.pool,
        amount,
        await chain.depositToPool(signer, amount),
      ),
    // A new demo company starts with an empty log, as the fake chain's reset does
    resetDemo: async () => {
      const result = await chain.resetDemo();
      log.clear();
      return result;
    },
  };
}
