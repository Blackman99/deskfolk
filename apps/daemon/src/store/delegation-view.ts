/** Read-only handoff projection: thread UI consumes persisted records, never infers contracts from prose. */
import type { DelegationView } from "@real-bot/protocol";
import { HttpError } from "../errors";
import type { StoreContext } from "./shared";

type Context = Pick<StoreContext, "db">;
type Row = {
  id: string; task_id: string; ticket_id: string | null; thread_session_id: string;
  from_bot_id: string; to_bot_id: string; ask: string; expects: DelegationView["expects"];
  status: DelegationView["status"]; part_keys: string; requirement_ids: string; created_at: string;
  reply_ref: string | null; due_at: string | null; request_message_id: string | null; result_message_id: string | null;
  reply_body: string | null; reply_at: string | null;
};

const SELECT = `SELECT d.*, sender.bot_id AS from_bot_id,
  request.message_id AS request_message_id, result.message_id AS result_message_id,
  result.body_snapshot AS reply_body, result.created_at AS reply_at
  FROM delegations d JOIN work_items sender ON sender.id = d.from_work_item_id
  LEFT JOIN inbox_items request ON request.seq = d.request_inbox_seq
  LEFT JOIN inbox_items result ON result.seq = d.result_inbox_seq`;

function view(ctx: Context, row: Row): DelegationView {
  const wait = ctx.db.query<{ created_at: string; fired_at: string | null; voided_at: string | null; suspended_at: string | null }, [string]>(
    "SELECT created_at, fired_at, voided_at, suspended_at FROM check_backs WHERE kind = 'delegation_wait' AND dedupe_key = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(`delegation:${row.id}`);
  const waiting = row.status === "open" && wait && wait.fired_at === null && (wait.voided_at === null || wait.suspended_at !== null);
  return {
    id: row.id, task_id: row.task_id, ticket_id: row.ticket_id, thread_session_id: row.thread_session_id,
    from_bot_id: row.from_bot_id, to_bot_id: row.to_bot_id, ask: row.ask, expects: row.expects,
    status: row.status, part_keys: JSON.parse(row.part_keys) as string[], requirement_ids: JSON.parse(row.requirement_ids) as string[],
    created_at: row.created_at, request_message_id: row.request_message_id, result_message_id: row.result_message_id,
    reply: row.reply_body !== null && row.reply_at !== null ? { body: row.reply_body, created_at: row.reply_at, ref: row.reply_ref } : null,
    wait: waiting ? { state: wait.suspended_at !== null ? "held" : "waiting", since: wait.created_at, due_at: row.due_at } : null,
  };
}

export function getDelegationView(ctx: Context, id: string): DelegationView | null {
  const row = ctx.db.query<Row, [string]>(`${SELECT} WHERE d.id = ?`).get(id);
  return row ? view(ctx, row) : null;
}

export function delegationViews(ctx: Context, filter: { taskId?: string; sessionId?: string }): { items: DelegationView[] } {
  if (filter.taskId && !ctx.db.query("SELECT 1 FROM tasks WHERE id = ?").get(filter.taskId)) throw new HttpError(404, "not_found", "plan not found");
  if (filter.sessionId && !ctx.db.query("SELECT 1 FROM sessions WHERE id = ?").get(filter.sessionId)) throw new HttpError(404, "not_found", "session not found");
  const rows = ctx.db.query<Row, [string | null, string | null]>(
    `${SELECT} WHERE (?1 IS NULL OR d.task_id = ?1) AND (?2 IS NULL OR d.thread_session_id = ?2) ORDER BY d.created_at, d.rowid`,
  ).all(filter.taskId ?? null, filter.sessionId ?? null);
  return { items: rows.map((row) => view(ctx, row)) };
}
