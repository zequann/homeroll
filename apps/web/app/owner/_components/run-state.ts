import type { Sen } from "@/lib/fx";

/** What the Run payroll control shows. This file is the only source of the hero's status line and button label. */
export type FailureNote = { sentence: string; code: string; ruleCaption: string | null };

export type RunState =
  | { kind: "short"; shortfall: Sen }
  | { kind: "ready"; leftAfter: Sen }
  | { kind: "checking" }
  /** The owner signs the payout intent and the payout rail checks it (SPEC §8.11, R17). */
  | { kind: "approving" }
  /** `inFlight` is a pay_run call this browser is making now; otherwise a run was left half paid. */
  | { kind: "paying"; paid: number; total: number; runId: number; inFlight: boolean }
  | { kind: "done"; total: Sen; lineCount: number; missed?: number }
  | { kind: "rejected"; failure: FailureNote; shortfall?: Sen }
  | { kind: "nothingToRun"; period: string };

/** Facts the server read from the chain for this render. All money is Sen. */
export interface RunFacts {
  period: string;
  lineCount: number;
  totalSen: Sen;
  treasurySen: Sen;
  bufferSen: Sen;
  /** Payees who already hold the period in some run. */
  heldCount: number;
  /** A submitted run that still has Reserved lines. */
  pendingRun: { runId: number; paid: number; total: number } | null;
  /** A submitted run with no Reserved line left. */
  doneRun: { total: Sen; lineCount: number; missed?: number } | null;
  /** The whole period, for the label under the button. Defaults to `totalSen`. */
  periodTotalSen?: Sen;
}

/** What the browser is doing right now, on top of the server facts. */
export interface LocalPhase {
  checking: boolean;
  approving?: boolean;
  paying: { paid: number; total: number; runId: number } | null;
  rejection: { failure: FailureNote; shortfall?: Sen; atTreasury: Sen } | null;
}

export const IDLE: LocalPhase = { checking: false, paying: null, rejection: null };

export function shortfallOf(f: RunFacts): Sen {
  return (f.totalSen + f.bufferSen - f.treasurySen) as Sen;
}

export function deriveRunState(f: RunFacts, local: LocalPhase): RunState {
  if (local.checking) return { kind: "checking" };
  if (local.approving) return { kind: "approving" };
  if (local.paying) return { kind: "paying", ...local.paying, inFlight: true };
  // A rejection is stale once the treasury moves (for example after Take advance).
  if (local.rejection && local.rejection.atTreasury === f.treasurySen) {
    return {
      kind: "rejected",
      failure: local.rejection.failure,
      shortfall: local.rejection.shortfall,
    };
  }
  if (f.doneRun) return { kind: "done", ...f.doneRun };
  if (f.pendingRun) return { kind: "paying", ...f.pendingRun, inFlight: false };
  if (f.lineCount > 0 && f.heldCount >= f.lineCount)
    return { kind: "nothingToRun", period: f.period };
  const shortfall = shortfallOf(f);
  if (shortfall > 0) return { kind: "short", shortfall: shortfall as Sen };
  return { kind: "ready", leftAfter: (f.treasurySen - f.totalSen) as Sen };
}

export function buttonLabel(state: RunState): string {
  switch (state.kind) {
    case "checking":
      return "Checking run…";
    case "approving":
      return "Approving payout…";
    case "paying":
      return state.inFlight ? "Paying…" : "Finish paying";
    case "done":
      return "October paid";
    case "nothingToRun":
      return "October paid";
    default:
      return "Run payroll";
  }
}

/** The button is enabled where the contract should decide (SPEC §5 principle 1). */
export function buttonEnabled(state: RunState, busy: boolean): boolean {
  if (busy) return false;
  return (
    state.kind === "short" ||
    state.kind === "ready" ||
    state.kind === "rejected" ||
    (state.kind === "paying" && !state.inFlight)
  );
}
