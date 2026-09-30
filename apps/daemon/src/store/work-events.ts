/**
 * The work log (ADR 0040): what happened to the work, appended one event at a time and read back in
 * the order it was written. The state tables stay what is true; this is the account of how it got
 * there, to check afterwards and for later phases to draw from. Rows are never updated or deleted.
 */
import { isoNow } from "../ids";
import type { StoreContext } from "./shared";

export type WorkEvent = {
  seq: number;
  at: string;
  kind: string;
  actor: string;
  bot_id: string | null;
  task_id: string | null;
  ticket_id: string | null;
  part_key: string | null;
  work_item_id: string | null;
  turn_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
};

type WorkEventRow = Omit<WorkEvent, "payload"> & { payload: string };

function toWorkEvent(row: WorkEventRow): WorkEvent {
  return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}

export function recordWorkEvent(
  ctx: StoreContext,
  input: {
    kind: string;
    actor: string;
    botId?: string | null;
    taskId?: string | null;
    ticketId?: string | null;
    turnId?: string | null;
    sessionId?: string | null;
    payload?: Record<string, unknown>;
  },
): WorkEvent {
  const row = ctx.db
    .query<WorkEventRow, Array<string | null>>(
      `INSERT INTO work_events (at, kind, actor, bot_id, task_id, ticket_id, turn_id, session_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      isoNow(),
      input.kind,
      input.actor,
      input.botId ?? null,
      input.taskId ?? null,
      input.ticketId ?? null,
      input.turnId ?? null,
      input.sessionId ?? null,
      JSON.stringify(input.payload ?? {}),
    )!;
  return toWorkEvent(row);
}

/** Oldest first; `kind` narrows to one kind, `afterSeq` to what came after an event already read. */
export function listWorkEvents(ctx: StoreContext, opts: { kind?: string; afterSeq?: number; limit?: number } = {}): WorkEvent[] {
  return ctx.db
    .query<WorkEventRow, [string | null, number, number]>(
      `SELECT * FROM work_events WHERE (?1 IS NULL OR kind = ?1) AND seq > ?2 ORDER BY seq ASC LIMIT ?3`,
    )
    .all(opts.kind ?? null, opts.afterSeq ?? 0, opts.limit ?? 500)
    .map(toWorkEvent);
}
