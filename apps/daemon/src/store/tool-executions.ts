/** Effect-start evidence precedes dispatch; it is never a replay queue or a fabricated receipt. */
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { holdsCovering } from "./holds";
import { requireNonEmpty, type StoreContext } from "./shared";
import { hasWorkAuthority, isPlanRunnable } from "./work-items";

export type ToolExecutionOutcome = "succeeded" | "refused" | "failed" | "unknown";
export type ToolExecution = {
  id: string; work_item_id: string | null; task_id: string | null; ticket_id: string | null;
  bot_id: string; turn_id: string; tool_call_id: string; tool: string; side_effect: number;
  started_at: string; finished_at: string | null; outcome: ToolExecutionOutcome | null; error_code: string | null;
};
export type ToolExecutionFilter = { turnId?: string; workItemId?: string };
export type LegacyAmbiguousExecution = { id: string; turn_id: string; tool: string; created_at: string };
export type ExecutionRecoveryFacts = {
  executions: ToolExecution[];
  pending: ToolExecution[];
  uncertain: ToolExecution[];
  legacyAmbiguous: LegacyAmbiguousExecution[];
  hasUncertainEffects: boolean;
  coverage: "none" | "ledger" | "legacy" | "partial";
};
type Actor = { bot_id: string; task_id: string | null; ticket_id: string | null; work_item_id: string | null; session_id: string };

function at(value: string | undefined): string {
  if (value === undefined) return isoNow();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new HttpError(422, "invalid_args", "now must be a valid timestamp");
  return new Date(value).toISOString();
}
function filterOf(filter: ToolExecutionFilter): [string | null, string | null] {
  const turnId = filter.turnId === undefined ? null : requireNonEmpty("turnId", filter.turnId);
  const workItemId = filter.workItemId === undefined ? null : requireNonEmpty("workItemId", filter.workItemId);
  if (!turnId && !workItemId) throw new HttpError(422, "invalid_args", "tool execution reads need an exact turn or work item");
  return [turnId, workItemId];
}
export function getToolExecution(ctx: StoreContext, input: { turnId: string; toolCallId: string }): ToolExecution | null {
  return ctx.db.query<ToolExecution, [string, string]>("SELECT * FROM tool_executions WHERE turn_id = ? AND tool_call_id = ?")
    .get(requireNonEmpty("turnId", input.turnId), requireNonEmpty("toolCallId", input.toolCallId)) ?? null;
}
export function pendingToolExecutions(ctx: StoreContext, filter: ToolExecutionFilter): ToolExecution[] {
  return ctx.db.query<ToolExecution, [string | null, string | null]>(`SELECT * FROM tool_executions
    WHERE (?1 IS NULL OR turn_id = ?1) AND (?2 IS NULL OR work_item_id = ?2) AND finished_at IS NULL ORDER BY started_at, rowid`)
    .all(...filterOf(filter));
}
/** Facts only. The engine supplies the resume policy and must never replay a begun identity. */
export function executionRecoveryFacts(ctx: StoreContext, filter: ToolExecutionFilter): ExecutionRecoveryFacts {
  const executions = ctx.db.query<ToolExecution, [string | null, string | null]>(`SELECT * FROM tool_executions
    WHERE (?1 IS NULL OR turn_id = ?1) AND (?2 IS NULL OR work_item_id = ?2) ORDER BY started_at, rowid`).all(...filterOf(filter));
  const pending = executions.filter((execution) => execution.finished_at === null);
  const uncertain = executions.filter((execution) => execution.side_effect === 1 && (execution.finished_at === null || execution.outcome === "unknown"));
  // Old turn_runs have no tool_call_id or side-effect bit. Complete receipt counts can account
  // for newly instrumented calls, not prove an old success was idempotent or an external job exists.
  const runs = ctx.db.query<LegacyAmbiguousExecution, [string | null, string | null]>(`SELECT r.id, r.turn_id, r.tool, r.created_at
    FROM turn_runs r JOIN turns t ON t.id = r.turn_id
    WHERE (?1 IS NULL OR r.turn_id = ?1) AND (?2 IS NULL OR t.work_item_id = ?2)
      AND (r.tool = 'shell' OR r.tool GLOB 'mcp_*') ORDER BY r.created_at, r.rowid`).all(...filterOf(filter));
  const legacyAmbiguous: LegacyAmbiguousExecution[] = [];
  const counted = new Map<string, number>();
  for (const run of runs) {
    const key = `${run.turn_id}\u0000${run.tool}`;
    const ordinal = (counted.get(key) ?? 0) + 1;
    counted.set(key, ordinal);
    const completed = executions.filter((execution) => execution.turn_id === run.turn_id && execution.tool === run.tool
      && execution.side_effect === 1 && execution.finished_at !== null && execution.finished_at <= run.created_at).length;
    if (ordinal > completed) legacyAmbiguous.push(run);
  }
  return { executions, pending, uncertain, legacyAmbiguous, hasUncertainEffects: uncertain.length > 0 || legacyAmbiguous.length > 0,
    coverage: legacyAmbiguous.length ? executions.length ? "partial" : "legacy" : executions.length ? "ledger" : "none" };
}

export function beginToolExecution(ctx: StoreContext, input: {
  turnId: string; toolCallId: string; tool: string; sideEffect: boolean; now?: string;
}): { execution: ToolExecution; begun: boolean } {
  return ctx.commit(() => {
    const turnId = requireNonEmpty("turnId", input.turnId);
    const toolCallId = requireNonEmpty("toolCallId", input.toolCallId);
    const tool = requireNonEmpty("tool", input.tool);
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(tool) || typeof input.sideEffect !== "boolean") {
      throw new HttpError(422, "invalid_args", "tool must be a tool name and sideEffect must be boolean");
    }
    const now = at(input.now);
    const existing = getToolExecution(ctx, { turnId, toolCallId });
    if (existing) {
      if (existing.tool !== tool || existing.side_effect !== Number(input.sideEffect)) throw new HttpError(409, "execution_conflict", "this call identity already names another execution");
      return { execution: existing, begun: false };
    }
    const actor = ctx.db.query<Actor, [string]>("SELECT * FROM turns WHERE id = ?").get(turnId);
    if (!actor || !hasWorkAuthority(ctx, turnId) || (actor.task_id && !isPlanRunnable(ctx, actor.task_id))) {
      throw new HttpError(409, "no_work_authority", "this segment no longer owns executable work");
    }
    if (holdsCovering(ctx, { botId: actor.bot_id, sessionId: actor.session_id, taskId: actor.task_id, ticketId: actor.ticket_id, turnId }).length) {
      throw new HttpError(409, "held", "this work is held");
    }
    const execution = ctx.db.query<ToolExecution, Array<string | number | null>>(`INSERT INTO tool_executions
      (id, work_item_id, task_id, ticket_id, bot_id, turn_id, tool_call_id, tool, side_effect, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(ulid(Date.parse(now)), actor.work_item_id, actor.task_id,
        actor.ticket_id, actor.bot_id, turnId, toolCallId, tool, Number(input.sideEffect), now)!;
    return { execution, begun: true };
  });
}

export function finishToolExecution(ctx: StoreContext, input: {
  turnId: string; toolCallId: string; outcome: ToolExecutionOutcome; errorCode?: string | null; now?: string;
}): ToolExecution {
  return ctx.commit(() => {
    if (!["succeeded", "refused", "failed", "unknown"].includes(input.outcome)) throw new HttpError(422, "invalid_args", "invalid execution outcome");
    const errorCode = input.errorCode ?? null;
    if (errorCode !== null && (typeof errorCode !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(errorCode))) {
      throw new HttpError(422, "invalid_args", "errorCode must be a stable code, not an error message");
    }
    const now = at(input.now);
    const execution = getToolExecution(ctx, input);
    if (!execution) throw new HttpError(404, "not_found", "tool execution was not started");
    if (execution.finished_at !== null) return execution;
    if (now < execution.started_at) throw new HttpError(422, "invalid_args", "an execution cannot finish before it started");
    const revoked = execution.side_effect === 1 && input.outcome === "succeeded" && !hasWorkAuthority(ctx, execution.turn_id);
    return ctx.db.query<ToolExecution, [string, string, string | null, string]>(`UPDATE tool_executions
      SET outcome = ?, finished_at = ?, error_code = ? WHERE id = ? AND finished_at IS NULL RETURNING *`)
      .get(revoked ? "unknown" : input.outcome, now, revoked ? "authority_revoked" : errorCode, execution.id)!;
  });
}
