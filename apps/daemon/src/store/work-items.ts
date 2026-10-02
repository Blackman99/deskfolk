/**
 * A piece of work a Bot has on (ADR 0040 P4b): one Bot on one plan, or, with no plan, one Bot in
 * one conversation. A turn binds to one when it opens, and the live-turn indexes then keep a Bot
 * to one live turn per plan.
 */
import type { Message } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { queueInboxItem, type InboxItem, type InboxKind, type InboxSource } from "./inbox";
import { getMessage, insertMessage } from "./messages";
import { heldSql } from "./holds";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { settingsCached } from "./settings";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

export type WorkItem = {
  id: string;
  bot_id: string;
  task_id: string | null;
  ticket_id: string | null;
  home_session_id: string;
  state: string;
};

/**
 * The open work item for this Bot on this plan (or, with no plan, in this conversation), made when
 * there is none. A ticket only narrows one that already names a plan.
 */
export function findOrCreateWorkItem(
  ctx: StoreContext,
  input: { botId: string; sessionId: string; taskId: string | null; ticketId: string | null },
): WorkItem {
  const existing = input.taskId
    ? ctx.db
        .query<WorkItem, [string, string, string | null]>(
          `SELECT * FROM work_items WHERE bot_id = ? AND task_id = ? AND ticket_id IS ? AND state <> 'closed' ORDER BY created_at LIMIT 1`,
        )
        .get(input.botId, input.taskId, input.ticketId)
    : ctx.db
        .query<WorkItem, [string, string]>(
          `SELECT * FROM work_items WHERE bot_id = ? AND task_id IS NULL AND home_session_id = ? AND state <> 'closed' ORDER BY created_at LIMIT 1`,
        )
        .get(input.botId, input.sessionId);
  if (existing) return existing;
  const now = isoNow();
  return ctx.db
    .query<WorkItem, Array<string | null>>(
      `INSERT INTO work_items (id, bot_id, task_id, ticket_id, home_session_id, role, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'own', 'running', ?, ?) RETURNING *`,
    )
    .get(ulid(Date.parse(now)), input.botId, input.taskId, input.ticketId, input.sessionId, now, now)!;
}

/** How many jobs one Bot works at once before the next one waits (ADR 0040 P4b). A desk turn is extra. */
export const PARALLEL_LIMIT = 2;

/**
 * Where a new turn for this Bot would stand in line: how many of its turns are already working on
 * other jobs. A turn on the same plan is not a queue, it is heard by that turn. Null when it can
 * start now.
 */
export function queuePlace(
  ctx: StoreContext,
  input: { botId: string; taskId: string | null },
): number | null {
  if (input.taskId === null) return null; // A desk answer has its own slot, not a job in the work queue.
  const working = ctx.db
    .query<{ task_id: string | null }, [string]>(
      `SELECT task_id FROM turns
       WHERE bot_id = ? AND status IN ('running', 'waiting_approval', 'waiting_ask')
         AND IFNULL(mode, 'work') NOT IN ('readonly', 'desk')`,
    )
    .all(input.botId);
  if (working.some((row) => row.task_id === input.taskId)) return null;
  const configured = ctx.db.query<{ parallel_limit: number | null }, [string]>("SELECT parallel_limit FROM bots WHERE id = ?").get(input.botId)?.parallel_limit;
  const limit = configured !== null && configured !== undefined && Number.isInteger(configured) && configured > 0 ? configured : PARALLEL_LIMIT;
  if (working.length < limit) return null;
  const waiting = ctx.db.query<{ task_id: string }, [string]>(`SELECT task_id FROM work_items
    WHERE bot_id = ? AND state = 'queued' AND task_id IS NOT NULL
    GROUP BY task_id ORDER BY MIN(created_at), MIN(id)`).all(input.botId);
  const index = waiting.findIndex((row) => row.task_id === input.taskId);
  return index < 0 ? waiting.length + 1 : index + 1;
}

export type QueueWorkInput = {
  botId: string;
  sessionId: string;
  taskId: string | null;
  ticketId: string | null;
  messageId: string | null;
  author: string;
  body: string;
  source?: InboxSource;
  kind?: InboxKind;
  priority?: number;
  turnId?: string | null;
  possibleControl?: boolean;
  wakes?: boolean;
  notice?: boolean;
};

/** Admission is one durable write: the queued work, its wake, and its visible position. */
export function queueWork(ctx: StoreContext, input: QueueWorkInput): {
  workItem: WorkItem; inbox: InboxItem; message: Message | null; position: number;
} {
  return ctx.tx.run(() => {
    const workItem = findOrCreateWorkItem(ctx, input);
    const previous = input.messageId ? ctx.db.query<InboxItem, [string, string]>(`SELECT * FROM inbox_items
      WHERE work_item_id = ? AND message_id = ? AND state IN ('queued','held','delivered') ORDER BY seq LIMIT 1`)
      .get(workItem.id, input.messageId) : null;
    if (!previous) ctx.db.run("UPDATE work_items SET state = 'queued', updated_at = ? WHERE id = ?", [isoNow(), workItem.id]);
    const inbox = previous ?? queueInboxItem(ctx, {
      ...input, turnId: input.turnId ?? null, workItemId: workItem.id,
      source: input.source ?? (input.author === "user" ? "user" : "system"),
      kind: input.kind ?? "change", priority: input.priority ?? (input.author === "user" ? 1 : 3),
    });
    const position = queuePlace(ctx, input) ?? 1;
    const message = !previous && input.notice !== false ? insertMessage(ctx, {
      sessionId: input.sessionId, kind: "system", author: input.botId, hiddenFromBots: true,
      body: settingsCached(ctx).locale === "en"
        ? `Queued, at position ${position}. It starts once one of the jobs in hand finishes.`
        : `排在第 ${position} 位。手上的一件做完就轮到这件。`,
    }) : null;
    return { workItem: ctx.db.query<WorkItem, [string]>("SELECT * FROM work_items WHERE id = ?").get(workItem.id)!, inbox, message, position };
  });
}

/** I3 lease half: a live actor owns exactly one open matching work item. */
export function hasWorkAuthority(ctx: StoreContext, turnId: string): boolean {
  return ctx.db.query<{ id: string }, [string]>(`SELECT t.id FROM turns t JOIN bots b ON b.id = t.bot_id
    JOIN work_items w ON w.id = t.work_item_id AND w.bot_id = t.bot_id AND w.task_id IS t.task_id AND w.ticket_id IS t.ticket_id
    WHERE t.id = ? AND t.status = 'running' AND t.mode <> 'readonly'
      AND b.deleted_at IS NULL AND b.archived_at IS NULL AND w.state <> 'closed'`).get(turnId) !== null;
}

/** A lift only removes a stop; it cannot reopen a terminal or dormant plan. */
export function isPlanRunnable(ctx: StoreContext, taskId: string): boolean {
  return ctx.db.query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE id = ? AND dormant_since IS NULL
    AND COALESCE(stage, CASE WHEN status = 'done' THEN 'delivered' ELSE 'active' END) IN ('active', 'delivered')`).get(taskId) !== null;
}

export type QueuedWork = Pick<WorkItem, "id" | "bot_id" | "home_session_id" | "task_id" | "ticket_id"> & {
  message_id: string | null;
};

/** Oldest waking mail per work item, ordered by its priority then arrival, ready for admission. */
export function dispatchableWork(ctx: StoreContext): QueuedWork[] {
  const queued = ctx.db.query<QueuedWork, []>(`SELECT w.id, w.bot_id, COALESCE(CASE WHEN i.source = 'delegation' THEN i.session_id END, w.thread_session_id, w.home_session_id) AS home_session_id,
      w.task_id, w.ticket_id, i.message_id
    FROM work_items w JOIN inbox_items i ON i.work_item_id = w.id AND i.state = 'queued' AND i.wakes = 1
    JOIN bots b ON b.id = w.bot_id AND b.archived_at IS NULL AND b.deleted_at IS NULL
    JOIN sessions s ON s.id = COALESCE(CASE WHEN i.source = 'delegation' THEN i.session_id END, w.thread_session_id, w.home_session_id) AND s.archived_at IS NULL
    JOIN session_participants member ON member.session_id = s.id AND member.member = w.bot_id AND member.left_at IS NULL
    WHERE w.state = 'queued'
      AND (w.task_id IS NULL OR EXISTS (SELECT 1 FROM tasks p WHERE p.id = w.task_id AND p.dormant_since IS NULL
        AND COALESCE(p.stage, CASE WHEN p.status = 'done' THEN 'delivered' ELSE 'active' END) IN ('active', 'delivered')))
      AND i.seq = (SELECT MIN(j.seq) FROM inbox_items j WHERE j.work_item_id = w.id AND j.state = 'queued' AND j.wakes = 1)
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.bot_id = w.bot_id AND t.task_id IS w.task_id
        AND t.status IN ('running', 'waiting_approval', 'waiting_ask') AND IFNULL(t.mode, 'work') <> 'readonly')
      AND NOT ${heldSql({ bot: "w.bot_id", session: "COALESCE(CASE WHEN i.source = 'delegation' THEN i.session_id END, w.thread_session_id, w.home_session_id)", task: "w.task_id", ticket: "w.ticket_id", turn: "i.turn_id" })}
    ORDER BY i.priority, i.seq`).all();
  return queued.filter((item) => queuePlace(ctx, { botId: item.bot_id, taskId: item.task_id }) === null);
}

/** Clearing history forgets pointers, not work: only an eligible resumed item recreates its trigger. */
export function prepareQueuedTrigger(ctx: StoreContext, id: string): Message | null {
  return ctx.tx.run(() => {
    const item = dispatchableWork(ctx).find((row) => row.id === id);
    if (!item) return null;
    if (item.message_id) return getMessage(ctx, item.message_id);
    const inbox = ctx.db.query<InboxItem, [string]>(`SELECT * FROM inbox_items
      WHERE work_item_id = ? AND state = 'queued' AND wakes = 1 ORDER BY seq LIMIT 1`).get(id);
    if (!inbox) return null;
    const message = insertMessage(ctx, { sessionId: item.home_session_id, kind: "system", author: item.bot_id,
      body: inbox.body_snapshot, botOnly: true });
    ctx.db.run("UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?", [item.task_id, item.ticket_id, message.id]);
    ctx.db.run("UPDATE inbox_items SET message_id = ? WHERE seq = ? AND message_id IS NULL", [message.id, inbox.seq]);
    return getMessage(ctx, message.id);
  });
}

/** The running mark follows the committed admission, never overwriting closed or waiting work. */
export function markWorkRunning(ctx: StoreContext, id: string): void {
  ctx.db.run("UPDATE work_items SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'", [isoNow(), id]);
}

/**
 * A job's segment was cut off — interrupted, or failed past its retry — rather than ended (§2.6
 * running → needs_attention). From the supervisor's level (ADR 0045) its work item needs
 * attention, which the supervisor picks up from; below it, and for work on no plan, nothing
 * changes. Another live segment on the item (there is none, by I1) would leave it alone.
 */
export function markSegmentCutOff(ctx: StoreContext, turnId: string, reason: string): void {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.supervision) return;
  const turn = ctx.db.query<{ work_item_id: string | null; task_id: string | null; ticket_id: string | null; bot_id: string; session_id: string }, [string]>(
    "SELECT work_item_id, task_id, ticket_id, bot_id, session_id FROM turns WHERE id = ?").get(turnId);
  if (!turn?.work_item_id || !turn.task_id) return;
  const changed = ctx.db.query<{ id: string }, [string, string, string]>(`UPDATE work_items SET state = 'needs_attention', updated_at = ?
    WHERE id = ? AND state IN ('running', 'queued', 'idle')
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.work_item_id = work_items.id AND t.id <> ?3
        AND t.status IN ('running', 'waiting_approval', 'waiting_ask')) RETURNING id`).get(isoNow(), turn.work_item_id, turnId);
  if (changed) recordWorkEvent(ctx, { kind: "work.needs_attention", actor: "app", botId: turn.bot_id, taskId: turn.task_id,
    ticketId: turn.ticket_id, turnId, sessionId: turn.session_id, payload: { work_item_id: turn.work_item_id, reason } });
}

const LIVE_SEGMENT = "('running', 'waiting_approval', 'waiting_ask')";

/**
 * A segment ended and its work item still says `running` (ADR 0040 §2.6): at engine level 2 no end
 * contract moves it, and at any level a Stop, an ending the contract did not see, or a lost process
 * leaves it there — where nothing reads it as waiting for a call-back, and dormancy reads it as work
 * still going on. With no other segment live on it, work on no plan (a desk) is closed and work on a
 * plan is idle, from where your next line, its queue or the supervisor takes it up. A segment cut
 * off at the supervisor's level has already left it needing attention (`markSegmentCutOff`).
 */
export function settleEndedSegment(ctx: StoreContext, turnId: string): void {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.work_items) return;
  const turn = ctx.db.query<{ work_item_id: string | null; status: string }, [string]>("SELECT work_item_id, status FROM turns WHERE id = ?").get(turnId);
  if (!turn?.work_item_id || ["running", "waiting_approval", "waiting_ask"].includes(turn.status)) return;
  settleWorkItems(ctx, { workItemId: turn.work_item_id });
}

/**
 * Every `running` work item no segment runs any more, settled as {@link settleEndedSegment} does:
 * at boot, for what the last run left. From the supervisor's level only desks: a job there is the
 * supervisor's to repair, by how its last segment ended (store/supervisor.ts).
 */
export function settleRunningWork(ctx: StoreContext): number {
  const level = readEngineLevel(ctx.db);
  if (level < ENGINE_LEVELS.work_items) return 0;
  return settleWorkItems(ctx, { desksOnly: level >= ENGINE_LEVELS.supervision });
}

function settleWorkItems(ctx: StoreContext, only: { workItemId?: string; desksOnly?: boolean }): number {
  const now = isoNow();
  return ctx.db.query<{ id: string }, [string, string | null, number]>(`UPDATE work_items
    SET state = CASE WHEN task_id IS NULL THEN 'closed' ELSE 'idle' END,
      closed_at = CASE WHEN task_id IS NULL THEN ?1 ELSE closed_at END, updated_at = ?1
    WHERE state = 'running' AND (?2 IS NULL OR id = ?2) AND (?3 = 0 OR task_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.work_item_id = work_items.id AND t.status IN ${LIVE_SEGMENT})
    RETURNING id`).all(now, only.workItemId ?? null, only.desksOnly ? 1 : 0).length;
}

/** Marks a work item closed once no live turn still runs it. */
export function closeWorkItemIfIdle(ctx: StoreContext, id: string | null): void {
  if (!id) return;
  const live = ctx.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM turns WHERE work_item_id = ? AND status IN ('running', 'waiting_approval', 'waiting_ask')`,
    )
    .get(id)!.n;
  if (live > 0) return;
  ctx.db.run(`UPDATE work_items SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND state <> 'closed'`, [isoNow(), isoNow(), id]);
}
