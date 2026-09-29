/**
 * The organizer's own trail (ADR 0040 P0's observability): one row per call that actually reached the
 * model, message-filing or settle, whether or not it ended up changing anything. Before this, the
 * organizer's raw answer was never kept and a filing that came to nothing left only a stderr line
 * — this is what `GET /v1/debug/organizer-runs?task_id=` reads instead. Written once, at the point
 * the call's outcome is known; there is no update path.
 */
import type { OrganizerRun } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { type StoreContext } from "./shared";

/** Rows a plan's debug query returns; recent history is what a filing bug is diagnosed from. */
export const ORGANIZER_RUNS_DEBUG_LIMIT = 200;

/**
 * Rows kept per session. The table gets a row per message filing and per settle, forever, so
 * without a cap it would grow for as long as the organizer runs (unlike `turn_runs` and acceptance
 * check runs, which prune themselves). More than this is not diagnosing anything a recent run
 * hasn't already shown, so the oldest are dropped on every write.
 */
export const ORGANIZER_RUNS_KEPT_PER_SESSION = 500;

/**
 * The newest stale row: the first one past the cap, walking the session's rows newest first.
 * Both statements stay on the `organizer_runs_session (session_id, created_at, id)` index — the
 * lookup steps through at most the cap's worth of index entries and the delete is a range on the
 * same index — so a write costs the same however long the session's history has grown, instead of
 * reading and sorting all of it.
 */
export const ORGANIZER_RUNS_PRUNE_EDGE_SQL = `SELECT created_at, id FROM organizer_runs
   WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?`;
export const ORGANIZER_RUNS_PRUNE_SQL = `DELETE FROM organizer_runs
   WHERE session_id = ? AND (created_at, id) <= (?, ?)`;

function pruneOrganizerRuns(ctx: StoreContext, sessionId: string): void {
  const edge = ctx.db
    .query<{ created_at: string; id: string }, [string, number]>(ORGANIZER_RUNS_PRUNE_EDGE_SQL)
    .get(sessionId, ORGANIZER_RUNS_KEPT_PER_SESSION);
  if (!edge) return;
  ctx.db.run(ORGANIZER_RUNS_PRUNE_SQL, [sessionId, edge.created_at, edge.id]);
}

export function recordOrganizerRun(
  ctx: StoreContext,
  input: {
    sessionId: string;
    taskId: string | null;
    mode: "message" | "settle";
    messageId: string | null;
    spendId: string | null;
    rawAnswer: string | null;
    failKind: string | null;
    decision: OrganizerRun["decision"];
    candidatesPayload: OrganizerRun["candidates_payload"];
    candidatesApply: OrganizerRun["candidates_apply"];
    candidatesAtParse: OrganizerRun["candidates_at_parse"];
    downgradeReason: string | null;
    applied: boolean;
    rejectReason: string | null;
    held: string[] | null;
    appliedTaskId: string | null;
    appliedTicketId: string | null;
    now?: Date;
  },
): OrganizerRun {
  const at = input.now ?? new Date(isoNow());
  const row: OrganizerRun = {
    id: ulid(at.getTime()),
    session_id: input.sessionId,
    task_id: input.taskId,
    mode: input.mode,
    message_id: input.messageId,
    spend_id: input.spendId,
    raw_answer: input.rawAnswer,
    fail_kind: input.failKind,
    decision: input.decision,
    candidates_payload: input.candidatesPayload,
    candidates_apply: input.candidatesApply,
    candidates_at_parse: input.candidatesAtParse,
    downgrade_reason: input.downgradeReason,
    applied: input.applied,
    reject_reason: input.rejectReason,
    held: input.held,
    applied_task_id: input.appliedTaskId,
    applied_ticket_id: input.appliedTicketId,
    created_at: at.toISOString(),
  };
  ctx.db.run(
    `INSERT INTO organizer_runs (
       id, session_id, task_id, mode, message_id, spend_id, raw_answer, fail_kind, decision,
       candidates_payload, candidates_apply, candidates_at_parse, downgrade_reason, applied,
       reject_reason, held, applied_task_id, applied_ticket_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.session_id,
      row.task_id,
      row.mode,
      row.message_id,
      row.spend_id,
      row.raw_answer,
      row.fail_kind,
      row.decision,
      JSON.stringify(row.candidates_payload),
      row.candidates_apply ? JSON.stringify(row.candidates_apply) : null,
      row.candidates_at_parse ? JSON.stringify(row.candidates_at_parse) : null,
      row.downgrade_reason,
      row.applied ? 1 : 0,
      row.reject_reason,
      row.held ? JSON.stringify(row.held) : null,
      row.applied_task_id,
      row.applied_ticket_id,
      row.created_at,
    ],
  );
  pruneOrganizerRuns(ctx, input.sessionId);
  return row;
}

type OrganizerRunRow = Omit<OrganizerRun, "candidates_payload" | "candidates_apply" | "candidates_at_parse" | "held" | "applied"> & {
  candidates_payload: string;
  candidates_apply: string | null;
  candidates_at_parse: string | null;
  held: string | null;
  applied: number;
};

function fromRow(row: OrganizerRunRow): OrganizerRun {
  return {
    ...row,
    candidates_payload: JSON.parse(row.candidates_payload) as OrganizerRun["candidates_payload"],
    candidates_apply: row.candidates_apply ? (JSON.parse(row.candidates_apply) as OrganizerRun["candidates_apply"]) : null,
    candidates_at_parse: row.candidates_at_parse ? (JSON.parse(row.candidates_at_parse) as OrganizerRun["candidates_at_parse"]) : null,
    held: row.held ? (JSON.parse(row.held) as string[]) : null,
    applied: row.applied === 1,
  };
}

/**
 * A plan's organizer runs, newest first: the ones that started against it (`task_id`), the ones a
 * `resume` or `join` landed on it instead (`applied_task_id`), and the ones that only *named* it as
 * the resume/join target — `candidates_apply` holds the answer's raw pick, before candidate-set
 * validation, so a target the parser downgraded (the race ADR 0040 P1 fixes: it qualified when the
 * payload was built, not once the call returned) or a target the app then refused to land on both
 * still turn up here even though neither `task_id` nor `applied_task_id` names this plan. The
 * `organizer_runs_resume_named`/`organizer_runs_join_named` expression indexes keep that last case
 * off a full table scan.
 */
export function organizerRunsForTask(ctx: StoreContext, taskId: string, limit = ORGANIZER_RUNS_DEBUG_LIMIT): OrganizerRun[] {
  return ctx.db
    .query<OrganizerRunRow, [string, string, string, string, number]>(
      `SELECT * FROM organizer_runs
       WHERE task_id = ? OR applied_task_id = ?
          OR json_extract(candidates_apply, '$.resume_plan_id') = ?
          OR json_extract(candidates_apply, '$.join_plan_id') = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(taskId, taskId, taskId, taskId, limit)
    .map(fromRow);
}
