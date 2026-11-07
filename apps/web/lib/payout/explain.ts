import type { FailureView } from "@/lib/describe-failure";
import type { RailRefusal } from "./index";

const RULE =
  "Rule R17: a payout needs the owner's signed payout intent. Checked by the payout rail (mock).";

/** What happened and what to do, for each refusal of the payout rail (SPEC §8.11). */
const SENTENCES: Record<RailRefusal, string> = {
  "unknown-quote": "That payout quote does not exist. Approve the payout again.",
  "run-not-pending": "This run has nothing reserved to pay. Run payroll first.",
  "signer-mismatch": "Only this run's employer can approve its payout.",
  "unknown-intent": "That payout intent was never issued by the payout rail. Nothing was paid.",
  "nonce-used":
    "That payout intent was already used. A signed intent pays once. Nothing more was paid.",
  "deadline-passed": "That payout intent expired after 10 minutes. Approve the payout again.",
  "bad-signature": "The payout intent was changed after the owner signed it. Nothing was paid.",
  "not-owner-key":
    "That key cannot approve a payout. Only the owner's full-access key can, not the payroll agent's key. Nothing was paid.",
  "payload-changed":
    "The signed payout intent is not the one the rail generated. Nothing was paid.",
  "run-changed":
    "The run changed after the payout intent was made, so it no longer matches. Approve the payout again.",
  "not-approved": "The owner has not approved this payout yet. Approve it to pay.",
};

export function railFailure(refusal: RailRefusal): FailureView {
  return {
    sentence: SENTENCES[refusal],
    code: `R17:${refusal}`,
    ruleCaption: RULE,
    shortfallSen: null,
  };
}
