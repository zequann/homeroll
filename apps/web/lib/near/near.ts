import { join } from "node:path";
import {
  type AccountId,
  homerollAccounts,
  parseContractError,
  WORKER_NAME_PATTERN,
} from "@homeroll/shared";
import { getEnv } from "@/lib/env";
import type { Units } from "@/lib/fx";
import { adminSigner, deriveKey } from "@/lib/keys";
import { provisionDemoCompany } from "@/lib/near/demo-company";
import { ExposureLog } from "@/lib/relay/exposure";
import { relay } from "@/lib/relay/relay";
import { readSeedEnv } from "@/lib/seed/shell";
import type {
  AccessKeyView,
  Attestation,
  ChainClient,
  EmployerView,
  InvoiceView,
  PayeeView,
  PayLine,
  Period,
  PoolView,
  ProtocolFailureName,
  RunView,
  SettleOutcome,
  Signer,
  Tx,
  TxFailure,
} from "./client";
import {
  parseAccessKeys,
  parseEmployer,
  parseInvoice,
  parsePayees,
  parsePool,
  parseRuns,
} from "./parse";
import {
  accessKey,
  accessKeyList,
  blockHeight,
  callMethod,
  callMethods,
  callMethodWithReceipts,
  configureRpc,
  ftBalanceOf as rpcFtBalance,
  signDelegate,
  submitDelegate,
  viewAccount,
  viewFunction,
} from "./rpc";

// 20 lines attach 500 Tgas. The stored config from `new` was 36, so earlier calls scheduled
// 36 lines and panicked (tx AJTGkAXsCWqAQ9PjjKUjoJkwnP8b5eJUJueSEbrn1Xfq). 970 fits twice
// in a 1 NEAR allowance, which is priced at 10x the block gas price.
const GAS_PAY_RUN = 970n * 1_000_000_000_000n;
const GAS_REQUEST_ADVANCE = 150n * 1_000_000_000_000n;
const GAS_FT_TRANSFER = 15n * 1_000_000_000_000n;
const GAS_OWNER_CALL = 30n * 1_000_000_000_000n;
// Account create, the 0.05 NEAR transfer, and the token storage deposit.
const GAS_CREATE_WORKER = 100n * 1_000_000_000_000n;
// ft_on_transfer forwards the rest with 65 Tgas plus a 20 Tgas callback, and the token resolves after.
const GAS_SETTLE = 200n * 1_000_000_000_000n;

const exposure = ExposureLog.files(join(process.cwd(), ".data", "relay-near-client"));

// The RPC names each rejection; near-api-js 7.4 rethrows it as this sentence instead.
const PROTOCOL_FAILURES: readonly [ProtocolFailureName, RegExp][] = [
  ["RequiresFullAccess", /RequiresFullAccess|Access key requires full access/],
  ["DepositWithFunctionCall", /DepositWithFunctionCall|Deposit is not allowed with function call/],
  [
    "ReceiverMismatch",
    /ReceiverMismatch|Access key receiver .* does not match transaction receiver/,
  ],
  ["MethodNameMismatch", /MethodNameMismatch|Access key does not allow method/],
];

export function txFailureFromMessage(message: string): TxFailure {
  for (const [name, pattern] of PROTOCOL_FAILURES) {
    if (pattern.test(message)) return { kind: "protocol", name };
  }
  const contract = parseContractError(message);
  if (contract) return { kind: "contract", error: contract };
  throw new Error(message);
}

function requireSeed(): string {
  const seed = process.env.SERVER_KEY_SEED?.trim();
  if (!seed) throw new Error("SERVER_KEY_SEED is not set");
  return seed;
}

function payrollSigner(employer: AccountId) {
  return deriveKey(requireSeed(), employer, "payrollAgent");
}

function ownerSigner(employer: AccountId) {
  return deriveKey(requireSeed(), employer, "owner");
}

function workerSigner(accountId: AccountId) {
  return deriveKey(requireSeed(), accountId, "worker");
}

/** The key the server holds for this signer. Lenders sign in their own wallet. */
function keyFor(signer: Signer) {
  const seed = requireSeed();
  switch (signer.role) {
    case "owner":
      return deriveKey(seed, signer.accountId, "owner");
    case "payrollAgent":
      return deriveKey(seed, signer.accountId, "payrollAgent");
    case "invoiceAgent":
      return deriveKey(seed, signer.accountId, "invoiceAgent");
    case "settler":
      return deriveKey(seed, signer.accountId, "escrow");
    case "worker":
      return deriveKey(seed, signer.accountId, "worker");
    case "lender":
      return null;
  }
}

function ownerDenied(signer: Signer): TxFailure | null {
  if (signer.role === "payrollAgent") return { kind: "protocol", name: "MethodNameMismatch" };
  if (signer.role !== "owner") return { kind: "contract", error: { code: "ERR_NOT_EMPLOYER" } };
  return null;
}

function workerNameOf(accountId: AccountId, root: AccountId): string | null {
  const suffix = `.${root}`;
  if (!accountId.endsWith(suffix)) return null;
  const name = accountId.slice(0, -suffix.length);
  return WORKER_NAME_PATTERN.test(name) ? name : null;
}

function failed(error: unknown): { ok: false; txHash: null; failure: TxFailure } {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, txHash: null, failure: txFailureFromMessage(message) };
}

export class NearChainClient implements ChainClient {
  readonly network = "testnet" as const;
  private readonly accounts = homerollAccounts(getEnv().root as AccountId);

  constructor() {
    const rpc = process.env.NEAR_RPC_URL;
    if (rpc) configureRpc(rpc);
  }

  async getEmployer(employer: AccountId): Promise<EmployerView | null> {
    const raw = await viewFunction(this.accounts.payroll, "get_employer", { employer });
    return parseEmployer(raw);
  }

  async getPayees(employer: AccountId): Promise<PayeeView[]> {
    const raw = await viewFunction(this.accounts.payroll, "get_payees", { employer });
    return parsePayees(raw);
  }

  async getRuns(employer: AccountId, period: Period): Promise<RunView[] | null> {
    const raw = await viewFunction(this.accounts.payroll, "get_runs", { employer, period });
    return parseRuns(raw);
  }

  async getInvoice(invoiceHash: string): Promise<InvoiceView | null> {
    const raw = await viewFunction(this.accounts.pool, "get_invoice", {
      invoice_hash: invoiceHash,
    });
    return parseInvoice(raw, invoiceHash);
  }

  async getPool(): Promise<PoolView> {
    return parsePool(await viewFunction(this.accounts.pool, "get_pool", {}));
  }

  async ftBalanceOf(accountId: AccountId): Promise<Units> {
    return rpcFtBalance(this.accounts.tusdc, accountId);
  }

  async getAccessKeys(accountId: AccountId): Promise<AccessKeyView[]> {
    return parseAccessKeys(accountId, await accessKeyList(accountId));
  }

  async submitRun(
    signer: Signer,
    period: Period,
    lines: PayLine[],
  ): Promise<Tx<{ runId: number }>> {
    if (signer.role !== "payrollAgent" && signer.role !== "owner") {
      return {
        ok: false,
        txHash: null,
        failure: { kind: "contract", error: { code: "ERR_NOT_EMPLOYER" } },
      };
    }
    const key =
      signer.role === "owner" ? ownerSigner(signer.accountId) : payrollSigner(signer.accountId);
    try {
      const { txHash } = await callMethods(key, this.accounts.payroll, [
        {
          method: "submit_run",
          args: {
            period,
            lines: lines.map((l) => ({ account_id: l.accountId, amount: l.amount.toString() })),
          },
        },
      ]);
      const runs = await this.getRuns(signer.accountId, period);
      const runId = runs?.at(-1)?.runId;
      if (runId === undefined) throw new Error("submit_run succeeded but run id missing");
      return { ok: true, txHash, value: { runId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, txHash: null, failure: txFailureFromMessage(message) };
    }
  }
  async addPayee(signer: Signer, accountId: AccountId, cap: Units): Promise<Tx<PayeeView>> {
    const denied = ownerDenied(signer);
    if (denied) return { ok: false, txHash: null, failure: denied };
    try {
      const created = await this.ensureWorker(accountId);
      if (created) return { ok: false, txHash: null, failure: created };
      const { txHash } = await callMethod(ownerSigner(signer.accountId), this.accounts.payroll, {
        method: "add_payee",
        args: { account_id: accountId, cap: cap.toString() },
        gas: GAS_OWNER_CALL,
        depositYocto: 0n,
      });
      const view = (await this.getPayees(signer.accountId)).find((p) => p.accountId === accountId);
      if (!view) throw new Error("add_payee succeeded but payee missing");
      return { ok: true, txHash, value: view };
    } catch (err) {
      return failed(err);
    }
  }

  async removePayee(signer: Signer, accountId: AccountId): Promise<Tx<null>> {
    const denied = ownerDenied(signer);
    if (denied) return { ok: false, txHash: null, failure: denied };
    try {
      const { txHash } = await callMethod(ownerSigner(signer.accountId), this.accounts.payroll, {
        method: "remove_payee",
        args: { account_id: accountId },
        gas: GAS_OWNER_CALL,
        depositYocto: 0n,
      });
      return { ok: true, txHash, value: null };
    } catch (err) {
      return failed(err);
    }
  }

  async cancelRun(signer: Signer, runId: number): Promise<Tx<RunView>> {
    const denied = ownerDenied(signer);
    if (denied) return { ok: false, txHash: null, failure: denied };
    try {
      const { txHash } = await callMethod(ownerSigner(signer.accountId), this.accounts.payroll, {
        method: "cancel_run",
        args: { run_id: runId },
        gas: GAS_OWNER_CALL,
        depositYocto: 0n,
      });
      const month = await this.findRunPeriod(signer.accountId, runId);
      const view = (await this.getRuns(signer.accountId, month))?.find((r) => r.runId === runId);
      if (!view) throw new Error("cancel_run succeeded but run missing");
      return { ok: true, txHash, value: view };
    } catch (err) {
      return failed(err);
    }
  }
  async attestInvoice(signer: Signer, a: Attestation): Promise<Tx<InvoiceView>> {
    const key = keyFor(signer);
    if (!key) {
      return {
        ok: false,
        txHash: null,
        failure: { kind: "contract", error: { code: "ERR_NOT_AGENT" } },
      };
    }
    try {
      const { txHash } = await callMethods(key, this.accounts.pool, [
        {
          method: "attest_invoice",
          args: {
            invoice_hash: a.invoiceKey,
            employer: a.employer,
            buyer_hash: a.buyerHash,
            amount: a.amount.toString(),
            due_ts: a.dueTs.toString(),
            grade: a.grade,
            attestation_ref: a.attestationRef,
          },
        },
      ]);
      const view = await this.getInvoice(a.invoiceKey);
      if (!view) throw new Error("attest_invoice succeeded but invoice missing");
      return { ok: true, txHash, value: view };
    } catch (err) {
      return failed(err);
    }
  }

  async settleInvoice(signer: Signer, invoiceKey: string, paid: Units): Promise<Tx<SettleOutcome>> {
    const key = keyFor(signer);
    if (!key) {
      return {
        ok: false,
        txHash: null,
        failure: { kind: "contract", error: { code: "ERR_NOT_SETTLER" } },
      };
    }
    try {
      const before = await this.getInvoice(invoiceKey);
      const { txHash, receiptFailures } = await callMethodWithReceipts(key, this.accounts.tusdc, {
        method: "ft_transfer_call",
        args: {
          receiver_id: this.accounts.pool,
          amount: paid.toString(),
          msg: JSON.stringify({ settle: { invoice_hash: invoiceKey } }),
        },
        gas: GAS_SETTLE,
        depositYocto: 1n,
      });
      for (const failure of receiptFailures) {
        const error = parseContractError(failure);
        if (error) return { ok: false, txHash, failure: { kind: "contract", error } };
      }
      const after = await this.getInvoice(invoiceKey);
      if (before?.status === "Advanced" && after?.status === "Settled") {
        return { ok: true, txHash, value: { settled: true, invoice: after } };
      }
      return { ok: true, txHash, value: { settled: false } };
    } catch (err) {
      return failed(err);
    }
  }

  async payRun(signer: Signer, runId: number): Promise<Tx<RunView>> {
    if (signer.role !== "payrollAgent" && signer.role !== "owner") {
      return {
        ok: false,
        txHash: null,
        failure: { kind: "contract", error: { code: "ERR_NOT_EMPLOYER" } },
      };
    }
    const key =
      signer.role === "owner" ? ownerSigner(signer.accountId) : payrollSigner(signer.accountId);
    try {
      const period = await this.findRunPeriod(signer.accountId, runId);
      const { txHash } = await callMethod(key, this.accounts.payroll, {
        method: "pay_run",
        args: { run_id: runId },
        gas: GAS_PAY_RUN,
        depositYocto: 0n,
      });
      let view = (await this.getRuns(signer.accountId, period))?.find((r) => r.runId === runId);
      if (!view) throw new Error("pay_run succeeded but run missing");
      if (view.lines.some((l) => l.status === "Sent")) {
        view =
          (await this.getRuns(signer.accountId, period))?.find((r) => r.runId === runId) ?? view;
      }
      return { ok: true, txHash, value: view };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, txHash: null, failure: txFailureFromMessage(message) };
    }
  }

  async requestAdvance(
    signer: Signer,
    invoiceHash: string,
    amount: Units,
  ): Promise<Tx<InvoiceView>> {
    if (signer.role !== "owner") {
      return {
        ok: false,
        txHash: null,
        failure: { kind: "contract", error: { code: "ERR_NOT_EMPLOYER" } },
      };
    }
    const key = ownerSigner(signer.accountId);
    try {
      const { txHash } = await callMethod(key, this.accounts.pool, {
        method: "request_advance",
        args: { invoice_hash: invoiceHash, amount: amount.toString() },
        gas: GAS_REQUEST_ADVANCE,
        depositYocto: 0n,
      });
      const view = await this.getInvoice(invoiceHash);
      if (!view) throw new Error("request_advance succeeded but invoice missing");
      return { ok: true, txHash, value: view };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, txHash: null, failure: txFailureFromMessage(message) };
    }
  }

  async ftTransfer(
    signer: Signer,
    receiverId: AccountId,
    amount: Units,
    memo: string,
  ): Promise<Tx<null>> {
    if (signer.role !== "worker") throw new Error("ftTransfer expects a worker signer");
    const worker = workerSigner(signer.accountId);
    const height = await blockHeight();
    const key = await accessKey(worker.accountId, worker.publicKey);
    const nonce = (key?.nonce ?? 0n) + 1n;
    const args = new TextEncoder().encode(
      JSON.stringify({ receiver_id: receiverId, amount: amount.toString(), memo }),
    );
    const signed = await signDelegate(worker, {
      senderId: worker.accountId,
      receiverId: this.accounts.tusdc,
      method: "ft_transfer",
      args,
      gas: GAS_FT_TRANSFER,
      depositYocto: 1n,
      nonce,
      maxBlockHeight: height + 120n,
      publicKey: worker.publicKey,
    });
    const relayer = deriveKey(requireSeed(), this.accounts.relayer, "relayer");
    const result = await relay(Buffer.from(signed).toString("base64"), {
      accounts: this.accounts,
      now: () => new Date(),
      blockHeight,
      accessKey,
      exposure,
      relayer,
      submit: submitDelegate,
    });
    if (result.status !== 200) {
      throw new Error(`relay rejected: ${JSON.stringify(result.body)}`);
    }
    return { ok: true, txHash: result.body.txHash, value: null };
  }

  async resetDemo(): Promise<{ employer: AccountId }> {
    const parsed = readSeedEnv(process.env);
    if (!parsed.ok) throw new Error(parsed.reason);
    return provisionDemoCompany(parsed.input);
  }

  private async ensureWorker(accountId: AccountId): Promise<TxFailure | null> {
    const name = workerNameOf(accountId, this.accounts.root);
    if (!name) return null;
    if ((await viewAccount(accountId)).exists) return null;
    const admin = adminSigner(
      this.accounts.root,
      process.env.HOMEROLL_ADMIN_PRIVATE_KEY?.trim() ?? null,
    );
    if (!admin) throw new Error("HOMEROLL_ADMIN_PRIVATE_KEY is not set");
    const worker = deriveKey(requireSeed(), accountId, "worker");
    try {
      // A taken name panics in a callback. The outer transaction still succeeds.
      const { receiptFailures } = await callMethodWithReceipts(admin, this.accounts.factory, {
        method: "create_worker",
        args: { name, public_key: worker.publicKey },
        gas: GAS_CREATE_WORKER,
        depositYocto: 0n,
      });
      for (const failure of receiptFailures) {
        const error = parseContractError(failure);
        if (error?.code === "ERR_ACCOUNT_EXISTS") return null;
        if (error) return { kind: "contract", error };
      }
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (parseContractError(message)?.code === "ERR_ACCOUNT_EXISTS") return null;
      return txFailureFromMessage(message);
    }
  }

  private async findRunPeriod(employer: AccountId, runId: number): Promise<Period> {
    for (const month of ["2026-10", "2026-09", "2026-11"] as Period[]) {
      const runs = await this.getRuns(employer, month);
      if (runs?.some((r) => r.runId === runId)) return month;
    }
    throw new Error(`run ${runId} not found`);
  }
}
