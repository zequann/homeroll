import { join } from "node:path";
import {
  homerollAccounts,
  parseContractError,
  type AccountId,
  type InvoiceHash,
} from "@homeroll/shared";
import { getEnv } from "@/lib/env";
import { type Units } from "@/lib/fx";
import { deriveKey } from "@/lib/keys";
import { ExposureLog } from "@/lib/relay/exposure";
import { relay } from "@/lib/relay/relay";
import type {
  AccessKeyView,
  ChainClient,
  EmployerView,
  InvoiceView,
  PayeeView,
  PayLine,
  Period,
  PoolView,
  ProtocolFailureName,
  RunView,
  Signer,
  Tx,
  TxFailure,
} from "./client";
import {
  accessKey,
  accessKeyList,
  blockHeight,
  callMethod,
  callMethods,
  configureRpc,
  ftBalanceOf as rpcFtBalance,
  signDelegate,
  submitDelegate,
  viewFunction,
} from "./rpc";
import {
  parseAccessKeys,
  parseEmployer,
  parseInvoice,
  parsePayees,
  parsePool,
  parseRuns,
} from "./parse";

const NOT_BUILT = "NearChainClient is not built yet (on-chain dev, SPEC §8.8)";

// 20 lines attach 500 Tgas. The stored config from `new` was 36, so earlier calls scheduled
// 36 lines and panicked (tx AJTGkAXsCWqAQ9PjjKUjoJkwnP8b5eJUJueSEbrn1Xfq). 970 fits twice
// in a 1 NEAR allowance, which is priced at 10x the block gas price.
const GAS_PAY_RUN = 970n * 1_000_000_000_000n;
const GAS_REQUEST_ADVANCE = 150n * 1_000_000_000_000n;
const GAS_FT_TRANSFER = 15n * 1_000_000_000_000n;

const exposure = ExposureLog.files(join(process.cwd(), ".data", "relay-near-client"));

function txFailureFromMessage(message: string): TxFailure {
  const protocols: ProtocolFailureName[] = [
    "RequiresFullAccess",
    "DepositWithFunctionCall",
    "ReceiverMismatch",
    "MethodNameMismatch",
  ];
  for (const name of protocols) {
    if (message.includes(name)) return { kind: "protocol", name };
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

  async getInvoice(invoiceHash: InvoiceHash): Promise<InvoiceView | null> {
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
      return { ok: false, txHash: null, failure: { kind: "contract", error: { code: "ERR_NOT_EMPLOYER" } } };
    }
    const key = payrollSigner(signer.accountId);
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
  addPayee(): never {
    throw new Error(NOT_BUILT);
  }
  removePayee(): never {
    throw new Error(NOT_BUILT);
  }
  cancelRun(): never {
    throw new Error(NOT_BUILT);
  }
  attestInvoice(): never {
    throw new Error(NOT_BUILT);
  }
  settleInvoice(): never {
    throw new Error(NOT_BUILT);
  }

  async payRun(signer: Signer, runId: number): Promise<Tx<RunView>> {
    if (signer.role !== "payrollAgent" && signer.role !== "owner") {
      return { ok: false, txHash: null, failure: { kind: "contract", error: { code: "ERR_NOT_EMPLOYER" } } };
    }
    const key = payrollSigner(signer.accountId);
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
        view = (await this.getRuns(signer.accountId, period))?.find((r) => r.runId === runId) ?? view;
      }
      return { ok: true, txHash, value: view };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, txHash: null, failure: txFailureFromMessage(message) };
    }
  }

  async requestAdvance(
    signer: Signer,
    invoiceHash: InvoiceHash,
    amount: Units,
  ): Promise<Tx<InvoiceView>> {
    if (signer.role !== "owner") {
      return { ok: false, txHash: null, failure: { kind: "contract", error: { code: "ERR_NOT_EMPLOYER" } } };
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
    throw new Error("resetDemo is not implemented on NearChainClient");
  }

  private async findRunPeriod(employer: AccountId, runId: number): Promise<Period> {
    for (const month of ["2026-10", "2026-09", "2026-11"] as Period[]) {
      const runs = await this.getRuns(employer, month);
      if (runs?.some((r) => r.runId === runId)) return month;
    }
    throw new Error(`run ${runId} not found`);
  }
}
