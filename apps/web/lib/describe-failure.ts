import type { AccountId } from "@homeroll/shared";
import { explain, explainProtocol } from "@/lib/errors/explain";
import { type Sen, units, unitsToSen } from "@/lib/fx";
import { nameOf } from "@/lib/names";
import type { ChainClient, PayLine, TxFailure } from "@/lib/near/client";
import { failureText } from "@/lib/near/failure";

/** A failure ready for the browser: plain strings only, no bigint. */
export interface FailureView {
  sentence: string;
  /** The exact text on chain, e.g. `ERR_ABOVE_WAGE_CAP:4:w-6b1x4k.<root>`. */
  code: string;
  ruleCaption: string | null;
  shortfallSen: Sen | null;
}

/** Turns a rejected call into the sentence, code and rule the UI shows. Names resolve here, off-chain. */
export async function describeFailure(
  chain: ChainClient,
  employer: AccountId,
  failure: TxFailure,
  lines: PayLine[] = [],
  period?: string,
): Promise<FailureView> {
  const code = failureText(failure);
  if (failure.kind === "protocol") {
    return { ...explainProtocol(failure.name), code, shortfallSen: null };
  }

  const { error } = failure;
  const line = error.line ? lines[error.line.index] : undefined;
  const payee = error.line
    ? (await chain.getPayees(employer)).find((p) => p.accountId === error.line?.accountId)
    : undefined;
  const name = error.line ? nameOf(error.line.accountId) : null;

  let shortfallSen: Sen | null = null;
  if (error.code === "ERR_BELOW_BUFFER") {
    const view = await chain.getEmployer(employer);
    if (view) {
      const total = lines.reduce((sum, l) => sum + l.amount, 0n);
      const short = total + view.buffer - view.treasury;
      if (short > 0n) shortfallSen = unitsToSen(units(short), "nearest");
    }
  }

  const { sentence, ruleCaption } = explain(error, {
    workerName: name?.displayName ?? null,
    possessive: name?.possessive,
    amountSen: line ? unitsToSen(line.amount, "nearest") : undefined,
    capSen: payee ? unitsToSen(payee.cap, "nearest") : undefined,
    shortfallSen: shortfallSen ?? undefined,
    period,
  });
  return { sentence, code, ruleCaption, shortfallSen };
}
