/**
 * When a job has settled: nothing the app would still do on its own is pending. Pure, over a
 * snapshot the runner takes from the runtime every couple of seconds, so each rule is tested.
 *
 * A job is settled when all of these hold at once:
 *
 * 1. No live turn (`turns.status` running / waiting_approval / waiting_ask) and no pending
 *    judgement or filing (`GET /v1/sessions` → `pending_judgements`, which also covers the Bots a
 *    message is holding while the organizer files it).
 * 2. No pending check-back (`check_backs` not fired, not voided) due before the run's deadline.
 *    One booked for later cannot change this run, so it is recorded, not waited for.
 * 3. Every plan that had a turn end has been through the organizer's settle and the plan
 *    reconcile that follows it: the settle timer fires `settleQuietMs` after the plan's last turn
 *    ended; it is done once there is nothing new to file since the last spec revision (it filed,
 *    or had nothing to file), or an `organize` spend row landed after the timer (it answered but
 *    filed nothing), or the organizer's own timeout has passed. A plan nudge it books shows up as
 *    a live turn, which resets everything.
 * 4. Quiet: nothing written (turn, message, check-back, spend row) for `quietMs`, which covers the
 *    ~10 s timer that calls a Bot back from a quiet Bot↔Bot direct, and the snapshot unchanged for
 *    `stableMs`.
 * 5. No acceptance check still running (`acceptance_check_runs` with no `finished_at`): the quiet
 *    stretch's `beforeSettle`/`afterSettle` runs can still be in flight after the settle itself lands.
 *
 * A waiting turn the runner could not answer (the answer was refused) is "blocked": when that is
 * all that is left, the job is blocked on you rather than busy.
 */

export type PlanSettleState = {
  id: string;
  /** When the plan's last turn reached a terminal state; null when no turn of it has ended. */
  lastTurnEndMs: number | null;
  /** Messages or cited files since the plan's last spec revision: the settle has something to file. */
  needsFiling: boolean;
  /** Latest `organize` spend row in the plan's session, if any. */
  organizedAtMs: number | null;
};

export type SettleSnapshot = {
  nowMs: number;
  deadlineMs: number;
  liveTurns: number;
  /** Live turns waiting on an approval or answer the runner could not give. */
  blockedTurns: number;
  pendingJudgements: number;
  checkBackDueMs: readonly number[];
  /** Acceptance checks with an open run (`finished_at IS NULL`) right now. */
  runningChecks: number;
  lastActivityMs: number;
  /** When the snapshot's fingerprint last changed. */
  stableSinceMs: number;
  plans: readonly PlanSettleState[];
};

export type SettleTiming = {
  quietMs: number;
  stableMs: number;
  /** The organizer's quiet time after a plan's last turn (SETTLE_QUIET_MS). */
  settleQuietMs: number;
  /** Slack after the settle timer, for the call to start and the reconcile to run. */
  settleGraceMs: number;
  /** How long a settle call may take before it is given up on (ORGANIZER_SETTLE_TIMEOUT_MS plus slack). */
  organizerTimeoutMs: number;
  /** False under the `organize-settle` ablation: a plan counts as settled once its timer and grace
   *  have passed, without waiting for an `organize` row or the organizer's own timeout. */
  settleFiles: boolean;
};

export type SettleVerdict = { state: "busy" | "settled" | "blocked"; waitingOn: string[] };

export function planSettled(plan: PlanSettleState, nowMs: number, timing: SettleTiming): boolean {
  if (plan.lastTurnEndMs === null) return true;
  const due = plan.lastTurnEndMs + timing.settleQuietMs;
  if (nowMs < due + timing.settleGraceMs) return false;
  if (!timing.settleFiles) return true;
  if (!plan.needsFiling) return true;
  if (plan.organizedAtMs !== null && plan.organizedAtMs >= due - 1_000) return true;
  return nowMs >= due + timing.organizerTimeoutMs;
}

export function settleVerdict(snapshot: SettleSnapshot, timing: SettleTiming): SettleVerdict {
  const waitingOn: string[] = [];
  const live = snapshot.liveTurns - snapshot.blockedTurns;
  if (live > 0) waitingOn.push(`${live} live turn(s)`);
  if (snapshot.pendingJudgements > 0) waitingOn.push(`${snapshot.pendingJudgements} judgement(s) or filing(s)`);
  const due = snapshot.checkBackDueMs.filter((at) => at <= snapshot.deadlineMs).length;
  if (due > 0) waitingOn.push(`${due} check-back(s) due before the deadline`);
  if (snapshot.runningChecks > 0) waitingOn.push(`${snapshot.runningChecks} acceptance check(s) still running`);
  const unsettled = snapshot.plans.filter((plan) => !planSettled(plan, snapshot.nowMs, timing));
  if (unsettled.length > 0) waitingOn.push(`${unsettled.length} plan(s) not yet through the organizer's settle`);
  const quiet = snapshot.nowMs - snapshot.lastActivityMs;
  if (quiet < timing.quietMs) waitingOn.push(`quiet ${Math.max(0, Math.round(quiet / 1000))}s of ${Math.round(timing.quietMs / 1000)}s`);
  if (snapshot.nowMs - snapshot.stableSinceMs < timing.stableMs) waitingOn.push("state still changing");
  if (waitingOn.length > 0) return { state: "busy", waitingOn };
  if (snapshot.blockedTurns > 0) return { state: "blocked", waitingOn: [`${snapshot.blockedTurns} turn(s) waiting on you`] };
  return { state: "settled", waitingOn: [] };
}
