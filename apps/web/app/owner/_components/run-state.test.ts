import { describe, expect, it } from "vitest";
import { type Sen, sen } from "@/lib/fx";
import { buttonEnabled, buttonLabel, deriveRunState, IDLE, type RunFacts } from "./run-state";

const rm = (n: number): Sen => sen(n * 100);
const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
  period: "2026-10",
  lineCount: 40,
  totalSen: rm(78_000),
  treasurySen: rm(138_400),
  bufferSen: rm(5_000),
  heldCount: 0,
  pendingRun: null,
  doneRun: null,
  ...over,
});

describe("deriveRunState", () => {
  it("is ready with the money left after the run", () => {
    expect(deriveRunState(facts(), IDLE)).toEqual({ kind: "ready", leftAfter: rm(60_400) });
  });

  it("is short by RM39,400 with only the Grade C advance", () => {
    const state = deriveRunState(facts({ treasurySen: rm(43_600) }), IDLE);
    expect(state).toEqual({ kind: "short", shortfall: rm(39_400) });
    expect(buttonEnabled(state, false)).toBe(true);
  });

  it("is short by RM64,600 before any advance", () => {
    expect(deriveRunState(facts({ treasurySen: rm(18_400) }), IDLE)).toMatchObject({
      kind: "short",
      shortfall: rm(64_600),
    });
  });

  it("answers on the same frame while checking", () => {
    const state = deriveRunState(facts(), { ...IDLE, checking: true });
    expect(state.kind).toBe("checking");
    expect(buttonLabel(state)).toBe("Checking run…");
    expect(buttonEnabled(state, true)).toBe(false);
  });

  it("shows paid of total while pay_run calls are in flight", () => {
    const state = deriveRunState(facts(), {
      ...IDLE,
      paying: { paid: 10, total: 40, runId: 0 },
    });
    expect(state).toEqual({ kind: "paying", paid: 10, total: 40, runId: 0, inFlight: true });
    expect(buttonLabel(state)).toBe("Paying…");
  });

  it("is done once a run has no Reserved line left, with the button off", () => {
    const state = deriveRunState(
      facts({ treasurySen: rm(60_400), doneRun: { total: rm(78_000), lineCount: 40 } }),
      IDLE,
    );
    expect(state).toEqual({ kind: "done", total: rm(78_000), lineCount: 40 });
    expect(buttonLabel(state)).toBe("October paid");
    expect(buttonEnabled(state, false)).toBe(false);
  });

  it("offers to finish a run that was left half paid", () => {
    const state = deriveRunState(facts({ pendingRun: { runId: 0, paid: 10, total: 40 } }), IDLE);
    expect(state).toMatchObject({ kind: "paying", inFlight: false });
    expect(buttonLabel(state)).toBe("Finish paying");
    expect(buttonEnabled(state, false)).toBe(true);
  });

  it("has nothing to run when every payee already holds the period", () => {
    expect(deriveRunState(facts({ heldCount: 40 }), IDLE).kind).toBe("nothingToRun");
  });

  it("shows a rejection until the treasury moves", () => {
    const failure = { sentence: "No.", code: "ERR_BELOW_BUFFER", ruleCaption: null };
    const local = { ...IDLE, rejection: { failure, atTreasury: rm(43_600) } };
    expect(deriveRunState(facts({ treasurySen: rm(43_600) }), local).kind).toBe("rejected");
    // Taking another advance changes the treasury, so the old rejection is stale.
    expect(deriveRunState(facts({ treasurySen: rm(163_600) }), local).kind).toBe("ready");
  });
});
