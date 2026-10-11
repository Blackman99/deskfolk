/**
 * The app's own calls, one row per use (ADR 0083): what the flow board draws between your line and
 * the turns it woke. Written once, where a call's outcome is known and applied; there is no update
 * path. Before this, a reading lived in a work-log payload, a judgement's model nowhere, a
 * composer's answer nowhere, and none of them said which prompt revision it ran with.
 */
import type { BuiltinModelRole, CallRun, CallRunOutcome, CallRunVerdict, TraceStep } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { type StoreContext } from "./shared";

/**
 * Rows kept per session. Every line of yours makes a few (a reading, a filing, the scribe, one
 * judgement per Bot in a group) and every turn may add more, so like the organizer's run log the
 * oldest go on every write; past this a flow board has folded those rounds long ago.
 */
export const CALL_RUNS_KEPT_PER_SESSION = 2000;
/** As much of the model's answer as a row keeps. */
export const CALL_RUN_RAW_MAX = 4000;

const PRUNE_EDGE_SQL = `SELECT created_at, id FROM call_runs
   WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?`;
const PRUNE_SQL = `DELETE FROM call_runs WHERE session_id = ? AND (created_at, id) <= (?, ?)`;

function pruneCallRuns(ctx: StoreContext, sessionId: string): void {
  const edge = ctx.db
    .query<{ created_at: string; id: string }, [string, number]>(PRUNE_EDGE_SQL)
    .get(sessionId, CALL_RUNS_KEPT_PER_SESSION);
  if (!edge) return;
  ctx.db.run(PRUNE_SQL, [sessionId, edge.created_at, edge.id]);
}

export type CallRunInput = {
  role: BuiltinModelRole;
  prompt?: { id: string; revision_id: string | null; locale: string } | null;
  sessionId: string | null;
  messageId?: string | null;
  turnId?: string | null;
  taskId?: string | null;
  ticketId?: string | null;
  botId?: string | null;
  checkRunId?: string | null;
  providerId?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  outcome: CallRunOutcome;
  failKind?: string | null;
  verdict: CallRunVerdict | null;
  raw?: string | null;
  cached?: boolean;
  spendId?: string | null;
  ms?: number | null;
  now?: Date;
};

export function recordCallRun(ctx: StoreContext, input: CallRunInput): CallRun {
  const at = input.now ?? new Date(isoNow());
  const row: CallRun = {
    id: ulid(at.getTime()),
    role: input.role,
    prompt_id: input.prompt?.id ?? null,
    prompt_revision: input.prompt?.revision_id ?? null,
    prompt_locale: input.prompt?.locale ?? null,
    // A call made outside any conversation (a reflection on a job whose conversation is gone) keeps none.
    session_id: input.sessionId || null,
    message_id: input.messageId ?? null,
    turn_id: input.turnId ?? null,
    task_id: input.taskId ?? null,
    ticket_id: input.ticketId ?? null,
    bot_id: input.botId ?? null,
    check_run_id: input.checkRunId ?? null,
    provider_id: input.providerId || null,
    model: input.model ?? null,
    thinking_level: input.thinkingLevel ?? null,
    outcome: input.outcome,
    fail_kind: input.failKind ?? null,
    verdict: input.verdict,
    raw: input.raw ? input.raw.slice(0, CALL_RUN_RAW_MAX) : null,
    cached: input.cached ?? false,
    spend_id: input.spendId ?? null,
    ms: input.ms === undefined || input.ms === null ? null : Math.max(0, Math.round(input.ms)),
    created_at: at.toISOString(),
  };
  ctx.db.run(
    `INSERT INTO call_runs (
       id, role, prompt_id, prompt_revision, prompt_locale, session_id, message_id, turn_id, task_id,
       ticket_id, bot_id, check_run_id, provider_id, model, thinking_level, outcome, fail_kind,
       verdict, raw, cached, spend_id, ms, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.role, row.prompt_id, row.prompt_revision, row.prompt_locale, row.session_id,
      row.message_id, row.turn_id, row.task_id, row.ticket_id, row.bot_id, row.check_run_id,
      row.provider_id, row.model, row.thinking_level, row.outcome, row.fail_kind,
      row.verdict ? JSON.stringify(row.verdict) : null, row.raw, row.cached ? 1 : 0, row.spend_id,
      row.ms, row.created_at,
    ],
  );
  if (row.session_id) pruneCallRuns(ctx, row.session_id);
  return row;
}

type CallRunRow = Omit<CallRun, "verdict" | "cached"> & { verdict: string | null; cached: number };

function fromRow(row: CallRunRow): CallRun {
  let verdict: CallRunVerdict | null = null;
  try {
    verdict = row.verdict ? (JSON.parse(row.verdict) as CallRunVerdict) : null;
  } catch {
    // a verdict that does not parse shows as none; the row still says how the call came out
  }
  return { ...row, verdict, cached: row.cached === 1 };
}

function toStep(run: CallRun): TraceStep {
  const { raw: _raw, ...step } = run;
  return step;
}

export function getCallRun(ctx: StoreContext, id: string): CallRun | null {
  const row = ctx.db.query<CallRunRow, [string]>(`SELECT * FROM call_runs WHERE id = ?`).get(id);
  return row ? fromRow(row) : null;
}

/** The most a board asks for at once; a job past it shows its newest. */
const STEPS_MAX = 1500;

/**
 * The steps a board shows, oldest first: every call on the job, and every call about one of its
 * lines or turns (a reading of your line is made before the line is filed anywhere).
 */
export function traceSteps(
  ctx: StoreContext,
  scope: { taskId?: string | null; messageIds: readonly string[]; turnIds: readonly string[] },
): TraceStep[] {
  const byId = new Map<string, CallRun>();
  const add = (rows: CallRunRow[]) => {
    for (const row of rows) byId.set(row.id, fromRow(row));
  };
  if (scope.taskId) {
    add(ctx.db.query<CallRunRow, [string, number]>(
      `SELECT * FROM call_runs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(scope.taskId, STEPS_MAX));
  }
  for (const [column, ids] of [["message_id", scope.messageIds], ["turn_id", scope.turnIds]] as const) {
    // In chunks, so a long job never passes SQLite more parameters than it takes.
    for (let at = 0; at < ids.length; at += 400) {
      const chunk = ids.slice(at, at + 400);
      add(ctx.db.query<CallRunRow, string[]>(
        `SELECT * FROM call_runs WHERE ${column} IN (${chunk.map(() => "?").join(", ")})`,
      ).all(...chunk));
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .slice(-STEPS_MAX)
    .map(toStep);
}
