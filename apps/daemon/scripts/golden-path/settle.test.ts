import { describe, expect, test } from "bun:test";
import { planSettled, settleVerdict, type PlanSettleState, type SettleSnapshot, type SettleTiming } from "./settle";

const TIMING: SettleTiming = { quietMs: 15_000, stableMs: 5_000, settleQuietMs: 30_000, settleGraceMs: 3_000, organizerTimeoutMs: 135_000, settleFiles: true };
const NOW = 1_000_000;

function quiet(overrides: Partial<SettleSnapshot> = {}): SettleSnapshot {
  return {
    nowMs: NOW,
    deadlineMs: NOW + 600_000,
    liveTurns: 0,
    blockedTurns: 0,
    pendingJudgements: 0,
    checkBackDueMs: [],
    runningChecks: 0,
    lastActivityMs: NOW - 60_000,
    stableSinceMs: NOW - 60_000,
    plans: [],
    ...overrides,
  };
}

function plan(overrides: Partial<PlanSettleState> = {}): PlanSettleState {
  return { id: "p", lastTurnEndMs: NOW - 60_000, needsFiling: false, organizedAtMs: null, ...overrides };
}

describe("settle", () => {
  test("nothing live, nothing due, quiet and stable: settled", () => {
    expect(settleVerdict(quiet(), TIMING)).toEqual({ state: "settled", waitingOn: [] });
  });

  test("a live turn or a pending judgement keeps it busy", () => {
    expect(settleVerdict(quiet({ liveTurns: 1 }), TIMING).state).toBe("busy");
    expect(settleVerdict(quiet({ pendingJudgements: 2 }), TIMING).waitingOn).toContain("2 judgement(s) or filing(s)");
  });

  test("a check-back due before the deadline is waited for; one booked past it is not", () => {
    expect(settleVerdict(quiet({ checkBackDueMs: [NOW + 120_000] }), TIMING).state).toBe("busy");
    expect(settleVerdict(quiet({ checkBackDueMs: [NOW - 1_000] }), TIMING).state).toBe("busy");
    expect(settleVerdict(quiet({ checkBackDueMs: [NOW + 3_600_000] }), TIMING).state).toBe("settled");
  });

  test("an acceptance check still running keeps it busy", () => {
    const verdict = settleVerdict(quiet({ runningChecks: 2 }), TIMING);
    expect(verdict.state).toBe("busy");
    expect(verdict.waitingOn).toContain("2 acceptance check(s) still running");
  });

  test("it waits out the quiet window and a changing snapshot", () => {
    expect(settleVerdict(quiet({ lastActivityMs: NOW - 10_000 }), TIMING).waitingOn).toEqual(["quiet 10s of 15s"]);
    expect(settleVerdict(quiet({ stableSinceMs: NOW - 1_000 }), TIMING).waitingOn).toEqual(["state still changing"]);
  });

  test("a turn waiting on an answer nobody could give is blocked, not busy, once the rest is quiet", () => {
    expect(settleVerdict(quiet({ liveTurns: 1, blockedTurns: 1 }), TIMING)).toEqual({ state: "blocked", waitingOn: ["1 turn(s) waiting on you"] });
    expect(settleVerdict(quiet({ liveTurns: 2, blockedTurns: 1 }), TIMING).state).toBe("busy");
  });

  test("a plan whose turns never ended has no settle coming", () => {
    expect(planSettled(plan({ lastTurnEndMs: null }), NOW, TIMING)).toBe(true);
  });

  test("a plan is not settled before its settle timer and the grace after it", () => {
    expect(planSettled(plan({ lastTurnEndMs: NOW - 31_000 }), NOW, TIMING)).toBe(false);
    expect(planSettled(plan({ lastTurnEndMs: NOW - 34_000 }), NOW, TIMING)).toBe(true);
  });

  test("with something left to file, it waits for the organizer's answer or its timeout", () => {
    const due = NOW - 40_000 + 30_000;
    expect(planSettled(plan({ lastTurnEndMs: NOW - 40_000, needsFiling: true }), NOW, TIMING)).toBe(false);
    expect(planSettled(plan({ lastTurnEndMs: NOW - 40_000, needsFiling: true, organizedAtMs: due - 20_000 }), NOW, TIMING)).toBe(false);
    expect(planSettled(plan({ lastTurnEndMs: NOW - 40_000, needsFiling: true, organizedAtMs: due + 2_000 }), NOW, TIMING)).toBe(true);
    expect(planSettled(plan({ lastTurnEndMs: NOW - 170_000, needsFiling: true }), NOW, TIMING)).toBe(true);
  });

  test("with settleFiles off (organize-settle ablated), the timer and grace are all it waits for", () => {
    const noFiles: SettleTiming = { ...TIMING, settleFiles: false };
    expect(planSettled(plan({ lastTurnEndMs: NOW - 31_000, needsFiling: true }), NOW, noFiles)).toBe(false);
    expect(planSettled(plan({ lastTurnEndMs: NOW - 34_000, needsFiling: true, organizedAtMs: null }), NOW, noFiles)).toBe(true);
  });

  test("an unsettled plan keeps the whole job busy", () => {
    const verdict = settleVerdict(quiet({ plans: [plan(), plan({ id: "q", lastTurnEndMs: NOW - 20_000 })] }), TIMING);
    expect(verdict.state).toBe("busy");
    expect(verdict.waitingOn).toContain("1 plan(s) not yet through the organizer's settle");
  });
});
