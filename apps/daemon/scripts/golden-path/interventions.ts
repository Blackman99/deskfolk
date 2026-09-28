/**
 * What a run needed you for, counted from the rows the app itself keeps. An intervention is
 * something that stops on the human in the real app:
 *
 * - an approval card (`approvals`, any status: a card that appeared is a card you had to answer);
 * - a question to you (`messages.kind = 'ask'`, the messenger's "等你回答");
 * - a plan that stopped and told you so (`notifications.kind = 'failure'` with
 *   `fail_kind = 'stalled_plan'`, ADR 0031's "这件事停下了").
 *
 * Plan nudges (`check_backs.kind = 'plan_nudge'`) are counted too but kept out of the total: the
 * app calls a Bot back on its own, nobody has to act. Failed and interrupted turns are reported
 * beside them for the same reason.
 */

export type InterventionRows = {
  approvals: ReadonlyArray<{ status: string; kind_key: string | null }>;
  asks: ReadonlyArray<{ id: string }>;
  notifications: ReadonlyArray<{ kind: string; fail_kind: string | null }>;
  checkBacks: ReadonlyArray<{ kind: string | null }>;
  /** `turn_route_decisions`: one row per turn that got as far as picking a model. */
  routes: ReadonlyArray<{ outcome: string | null }>;
  turns: ReadonlyArray<{ status: string }>;
};

export type Interventions = {
  /** approvals + asks + stalls: the times the human had to act. */
  total: number;
  approvals: number;
  /** Approval cards by kind key (`outbound-network`, `unconstrained-shell`, …). */
  approval_kinds: Record<string, number>;
  asks: number;
  stalls: number;
  /** The app's own call-backs to a quiet plan; not in the total. */
  plan_nudges: number;
  /** Turns whose completion failed (endpoint refused, cut off, …); not in the total. */
  turn_failures: number;
  /** Turns cut short by a stop or a daemon exit; not in the total. */
  interrupted: number;
};

export const STALLED_PLAN = "stalled_plan";
export const PLAN_NUDGE = "plan_nudge";

export function countInterventions(rows: InterventionRows): Interventions {
  const approvalKinds: Record<string, number> = {};
  for (const row of rows.approvals) {
    const key = row.kind_key ?? "unknown";
    approvalKinds[key] = (approvalKinds[key] ?? 0) + 1;
  }
  const approvals = rows.approvals.length;
  const asks = new Set(rows.asks.map((row) => row.id)).size;
  const stalls = rows.notifications.filter((row) => row.kind === "failure" && row.fail_kind === STALLED_PLAN).length;
  return {
    total: approvals + asks + stalls,
    approvals,
    approval_kinds: approvalKinds,
    asks,
    stalls,
    plan_nudges: rows.checkBacks.filter((row) => row.kind === PLAN_NUDGE).length,
    turn_failures: rows.routes.filter((row) => row.outcome === "failed").length,
    interrupted: rows.turns.filter((row) => row.status === "interrupted").length,
  };
}

/**
 * Whether a plan ended on the app telling you it stopped: a stall notice that nothing in the plan
 * moved after. ISO timestamps compare as strings.
 */
export function endedStalled(stallsAt: readonly string[], lastActivityAt: string | null): boolean {
  if (stallsAt.length === 0) return false;
  const latest = [...stallsAt].sort().at(-1)!;
  return lastActivityAt === null || latest >= lastActivityAt;
}
