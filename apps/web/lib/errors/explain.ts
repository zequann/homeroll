import type { AccountId, ContractError, ContractErrorCode } from "@homeroll/shared";
import { formatRm, type Sen } from "@/lib/fx";
import type { ProtocolFailureName } from "@/lib/near/client";

/** What the UI knows about a failure beyond the code. Names come from `lib/names.ts`, off-chain. */
export interface ExplainContext {
  line?: { index: number; accountId: AccountId };
  workerName?: string | null;
  possessive?: "his" | "her" | "their";
  amountSen?: Sen;
  capSen?: Sen;
  shortfallSen?: Sen;
  /** YYYY-MM */
  period?: string;
}

export interface Explanation {
  sentence: string;
  /** "Rule R4: wage ≤ wage cap. Enforced by the payroll contract." */
  ruleCaption: string | null;
}

interface Explain {
  rule: string | null;
  sentence: (c: ExplainContext) => string;
}

// Captions per SPEC §11. A rule that has an attack script in the lab says who enforces it.
const RULES = {
  R3: "Rule R3: only active payees can be paid. Enforced by the payroll contract.",
  R4: "Rule R4: wage ≤ wage cap. Enforced by the payroll contract.",
  R5: "Rule R5: a payee is paid at most once per period. Enforced by the payroll contract.",
  R6: "Rule R6: the treasury stays above the buffer.",
  R7: "Rule R7: one invoice, one advance. Enforced by the pool.",
  R8: "Rule R8: an advance stays under the grade cap. Enforced by the pool.",
  R10: "Rule R10: only registered agents attest, only settlers settle.",
  R11: "Rule R11: the pool limits what it lends against one buyer.",
  R13: "Rule R13: no real names on-chain.",
  R14: "Rule R14: runs only for the current or previous month.",
  R15: "Rule R15: only the admin onboards employers; payee and deposit limits.",
} as const;
type RuleId = keyof typeof RULES;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthName(period: string | undefined): string {
  const month = period ? MONTHS[Number(period.slice(5, 7)) - 1] : undefined;
  return month ?? "this period";
}

/** "Line 5, Hafiz Rahman" or, for an account with no name on file, "Line 1, rahim-wallet.testnet". */
function lineLabel(c: ExplainContext): string {
  if (!c.line) return "A pay line";
  return `Line ${c.line.index + 1}, ${c.workerName ?? c.line.accountId}`;
}

const NOTHING_MOVED = "Nothing was reserved or paid.";

const e = (rule: RuleId | null, sentence: (c: ExplainContext) => string): Explain => ({
  rule: rule ? RULES[rule] : null,
  sentence,
});
const plain = (text: string) => () => text;

// `satisfies` makes `tsc` fail until every ContractErrorCode has a sentence.
const EXPLANATIONS = {
  ERR_NOT_ADMIN: e("R15", plain("Only the Homeroll admin can do that. Nothing changed.")),
  ERR_INVALID_NAME: e(
    "R13",
    plain("That account name is not allowed. Worker accounts are random w- names."),
  ),
  ERR_ACCOUNT_EXISTS: e(null, plain("That account already exists. Nothing was created.")),
  ERR_TOKEN_REGISTRATION_FAILED: e(
    null,
    plain("The new account could not be set up for USDC. Try again."),
  ),
  ERR_EMPLOYER_EXISTS: e(null, plain("That employer is already registered.")),
  ERR_NOT_EMPLOYER: e(
    null,
    plain("Only the employer can do that. Connect the owner account, then try again."),
  ),
  ERR_UNKNOWN_EMPLOYER: e(
    null,
    plain("The payroll contract does not know that employer. The money was returned."),
  ),
  ERR_WRONG_TOKEN: e(
    null,
    plain("The payroll contract only takes Homeroll's test USDC. The deposit was returned."),
  ),
  ERR_UNKNOWN_PAYEE: e(null, plain("That worker is not on the payee list.")),
  ERR_TOO_MANY_PAYEES: e("R15", plain("The payee list is full.")),
  ERR_TOO_MANY_LINES: e(
    null,
    plain(`This run has too many pay lines. ${NOTHING_MOVED} Split it into smaller runs.`),
  ),
  ERR_PERIOD_NOT_OPEN: e(
    "R14",
    (c) =>
      `${monthName(c.period)} is not open for payroll. Runs are allowed for this month and last month only. ${NOTHING_MOVED}`,
  ),
  ERR_PAYEE_NOT_ACTIVE: e("R3", (c) =>
    c.workerName
      ? `${lineLabel(c)}: not an active payee yet. ${NOTHING_MOVED} Wait out the 48-hour hold, then run payroll again.`
      : `Line ${(c.line?.index ?? 0) + 1}: ${c.line?.accountId ?? "that account"} is not a payee. ${NOTHING_MOVED}`,
  ),
  ERR_ABOVE_WAGE_CAP: e("R4", (c) => {
    const amount = c.amountSen === undefined ? "That wage" : formatRm(c.amountSen);
    const cap =
      c.capSen === undefined
        ? "the wage cap"
        : `${c.possessive ?? "their"} ${formatRm(c.capSen)} cap`;
    return `${lineLabel(c)}: above wage cap. ${amount} is more than ${cap}. ${NOTHING_MOVED} Check the timesheet, then run payroll again.`;
  }),
  ERR_DUPLICATE_PAYEE: e(
    "R5",
    (c) =>
      `${lineLabel(c)}: appears twice in this run. ${NOTHING_MOVED} Remove the extra line, then run payroll again.`,
  ),
  ERR_ALREADY_PAID: e(
    "R5",
    (c) =>
      `${lineLabel(c)}: already has a pay line for ${monthName(c.period)}. ${NOTHING_MOVED} A worker is paid once per period.`,
  ),
  ERR_BELOW_BUFFER: e("R6", (c) =>
    c.shortfallSen === undefined
      ? `The treasury would drop below the buffer. ${NOTHING_MOVED} Take an advance on another invoice, then run payroll again.`
      : `Short by ${formatRm(c.shortfallSen)}. ${NOTHING_MOVED} Take an advance on another invoice, then run payroll again.`,
  ),
  ERR_INSUFFICIENT_TREASURY: e(
    null,
    plain("The treasury has less than that. Nothing was withdrawn."),
  ),
  ERR_RUN_NOT_FOUND: e(null, plain("That payroll run does not exist.")),
  ERR_RUN_COMPLETE: e(null, plain("Every line of that run has already been sent.")),
  ERR_NOT_AGENT: e("R10", plain("Only a registered invoice agent can attest an invoice.")),
  ERR_NOT_SETTLER: e("R10", plain("Only the bank can settle an invoice.")),
  ERR_INVOICE_ALREADY_REGISTERED: e(
    "R7",
    plain("This invoice is already registered. One invoice gets one advance."),
  ),
  ERR_ADVANCE_ABOVE_CAP: e(
    "R8",
    plain("That is more than this invoice's grade allows. Ask for less."),
  ),
  ERR_POOL_INSUFFICIENT: e(null, plain("The pool does not have that much cash right now.")),
  ERR_BUYER_EXPOSURE: e("R11", plain("The pool already lends its maximum against this buyer.")),
  ERR_DEPOSIT_TOO_SMALL: e(null, plain("A first deposit must be larger. The money was returned.")),
} satisfies Record<ContractErrorCode, Explain>;

export function explain(error: ContractError, ctx: ExplainContext = {}): Explanation {
  const entry: Explain = EXPLANATIONS[error.code];
  return {
    sentence: entry.sentence({ line: error.line, ...ctx }),
    ruleCaption: entry.rule,
  };
}

const PROTOCOL_SENTENCES = {
  RequiresFullAccess:
    "NEAR rejected this before any contract ran: this key can only make one function call.",
  DepositWithFunctionCall:
    "NEAR rejected this before any contract ran: this key cannot attach a deposit.",
  ReceiverMismatch:
    "NEAR rejected this before any contract ran: this key cannot call that contract.",
  MethodNameMismatch:
    "NEAR rejected this before any contract ran: this key cannot call that method.",
} satisfies Record<ProtocolFailureName, string>;

export function explainProtocol(name: ProtocolFailureName): Explanation {
  return {
    sentence: PROTOCOL_SENTENCES[name],
    ruleCaption: "Rule R1, R2: enforced by the NEAR protocol.",
  };
}
