/**
 * A working Bot's inbox (收件, ADR 0040 P4a): every line said to a Bot while a turn of its works,
 * kept from the moment it arrives to what the Bot said it did with it. The rows are the record; a
 * live turn's `inbox` list (engine/types.ts) is only its copy of the rows queued for it.
 *
 * An item is queued for one live turn and read at that turn's next tool boundary or hop. A turn
 * that ends first leaves it waiting for the Bot's next turn in the same conversation, which takes
 * it over when it opens ({@link adoptWaitingInbox}); one a stop of yours covers is held meanwhile,
 * and waits for the lift. Lines of yours the turn read and said nothing about become `unacked` when
 * it ends, so each one ends somewhere you can see. Clearing a conversation keeps the rows and their
 * words (`body_snapshot`), forgetting only the line and the turns they pointed at.
 */
import { INBOX_DISPOSITIONS, type InboxDisposition, type InboxState, type MessageDelivery } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { heldSql, turnHeldBy, type HeldSubject } from "./holds";
import type { StoreContext } from "./shared";

export type InboxSource = "user" | "annotation" | "delegation" | "delegation_reply" | "review" | "job" | "timer" | "system" | "peer_note";
export type InboxKind = "change" | "question" | "info" | "result" | "wake" | "control_note";

export type InboxItem = {
  seq: number;
  id: string;
  bot_id: string;
  work_item_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  source_turn_id: string | null;
  task_id: string | null;
  ticket_id: string | null;
  message_id: string | null;
  author: string;
  body_snapshot: string;
  said_in: string | null;
  source: InboxSource;
  kind: InboxKind;
  priority: number;
  wakes: number;
  state: InboxState;
  possible_control: number;
  delivered_turn_id: string | null;
  delivered_hop: number | null;
  disposition_note: string | null;
  created_at: string;
  disposed_at: string | null;
};

/** As much of a Bot's word on what it did with a line as is kept. */
export const DISPOSITION_NOTE_MAX = 500;

/** A live turn's statuses, as SQL. */
const LIVE = `('running', 'waiting_ask', 'waiting_approval')`;
const NOT_IN_LIVE_TURN = `(inbox_items.turn_id IS NULL OR NOT EXISTS (SELECT 1 FROM turns t WHERE t.id = inbox_items.turn_id AND t.status IN ${LIVE}))`;
const YOURS = `inbox_items.source IN ('user', 'annotation')`;

/** What a hold covers, for an item: its Bot, its conversation, the job it is about, the turn it was queued for. */
const INBOX: HeldSubject = {
  bot: "inbox_items.bot_id",
  session: "inbox_items.session_id",
  task: "inbox_items.task_id",
  ticket: "inbox_items.ticket_id",
  turn: "inbox_items.turn_id",
};
// The routing turn changes on adoption; the durable origin never does. Either stop still holds
// the item, so moving a delegation result to the next segment cannot bypass the original stop.
const INBOX_HELD = `(${heldSql(INBOX)} OR ${heldSql({ ...INBOX, turn: "inbox_items.source_turn_id" })})`;

/**
 * An item's id as the Bot reads it and writes it back in `end_turn`: a letter for who it is from —
 * U you, B a Bot, T its own check-back, A the app — and the row's number, which no other item has.
 */
export function inboxLabel(item: Pick<InboxItem, "source" | "seq">): string {
  const letter = item.source === "user" || item.source === "annotation"
    ? "U"
    : item.source === "timer"
      ? "T"
      : item.source === "system" || item.source === "job"
        ? "A"
        : "B";
  return `${letter}${item.seq}`;
}

/** The row number in an id a Bot wrote back (`U12`, `#12`, `12`); null when there is none. */
export function inboxSeqOf(label: string): number | null {
  const match = /^\s*[A-Za-z#]?\s*(\d+)\s*$/.exec(label);
  return match ? Number(match[1]) : null;
}

export function queueInboxItem(
  ctx: StoreContext,
  input: {
    botId: string;
    sessionId: string;
    turnId: string | null;
    sourceTurnId?: string | null;
    workItemId?: string | null;
    wakes?: boolean;
    taskId: string | null;
    ticketId: string | null;
    messageId: string | null;
    author: string;
    body: string;
    saidIn?: string | null;
    source: InboxSource;
    kind: InboxKind;
    priority: number;
    possibleControl?: boolean;
    now?: string;
  },
): InboxItem {
  const now = input.now ?? isoNow();
  if (input.messageId) {
    const existing = ctx.db.query<InboxItem, Array<string | null>>(`SELECT * FROM inbox_items WHERE bot_id = ?
      AND message_id = ? AND turn_id IS ? AND task_id IS ? AND ticket_id IS ? AND source = ?
      AND state IN ('queued','held','delivered') ORDER BY seq LIMIT 1`).get(input.botId, input.messageId,
        input.turnId, input.taskId, input.ticketId, input.source);
    if (existing) return existing;
  }
  return ctx.db
    .query<InboxItem, Array<string | number | null>>(
      `INSERT INTO inbox_items (id, bot_id, session_id, turn_id, task_id, ticket_id, message_id, author, body_snapshot, said_in,
         source, kind, priority, state, possible_control, created_at, work_item_id, wakes, source_turn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      ulid(Date.parse(now)),
      input.botId,
      input.sessionId,
      input.turnId,
      input.taskId,
      input.ticketId,
      input.messageId,
      input.author,
      input.body,
      input.saidIn ?? null,
      input.source,
      input.kind,
      input.priority,
      input.possibleControl ? 1 : 0,
      now,
      input.workItemId ?? null,
      input.wakes === false ? 0 : 1,
      input.sourceTurnId ?? null,
    )!;
}

export function getInboxItem(ctx: StoreContext, seq: number): InboxItem | null {
  return ctx.db.query<InboxItem, [number]>(`SELECT * FROM inbox_items WHERE seq = ?`).get(seq) ?? null;
}

/** Every item a turn was queued, or read, in order. */
export function turnInbox(ctx: StoreContext, turnId: string): InboxItem[] {
  return ctx.db
    .query<InboxItem, [string, string]>(`SELECT * FROM inbox_items WHERE turn_id = ? OR delivered_turn_id = ? ORDER BY seq`)
    .all(turnId, turnId);
}

/**
 * What waits for the Bot's next turn in a conversation, given to `turnId` (a turn of that Bot
 * there that has just opened, or a live one about to hear something): items queued for a turn no
 * longer live, and items a stop held that no stop holds any more. One a stop still covers stays
 * held. Oldest first.
 */
export function adoptWaitingInbox(ctx: StoreContext, input: { botId: string; sessionId: string; turnId: string }): InboxItem[] {
  return ctx.db.transaction(() => {
    refreshHeldInbox(ctx, { botId: input.botId, sessionId: input.sessionId });
    return ctx.db
      .query<InboxItem, [string, string, string, string]>(
        `UPDATE inbox_items SET turn_id = ?1,
            work_item_id = COALESCE(work_item_id, (SELECT work_item_id FROM turns WHERE id = ?1))
         WHERE bot_id = ?2 AND state = 'queued' AND turn_id IS NOT ?4 AND ${NOT_IN_LIVE_TURN}
            AND (work_item_id = (SELECT work_item_id FROM turns WHERE id = ?1)
              OR (work_item_id IS NULL AND session_id = ?3 AND task_id IS (SELECT task_id FROM turns WHERE id = ?1)))
         RETURNING *`,
      )
      .all(input.turnId, input.botId, input.sessionId, input.turnId)
      .sort((a, b) => a.seq - b.seq);
  })();
}

/**
 * Items read by `turnId` at step `hop`: queued ones only, and not one a stop now covers, which is
 * held instead. An item a redirect carries into a new turn is read by that turn.
 */
export function deliverInboxItems(ctx: StoreContext, seqs: readonly number[], turnId: string, hop: number): { delivered: InboxItem[]; held: InboxItem[] } {
  if (seqs.length === 0) return { delivered: [], held: [] };
  const list = JSON.stringify(seqs);
  return ctx.db.transaction(() => {
    // The segment the caller is delivering into is checked too, not just the item's stored route.
    // Bind held rows to that attempted destination so a refresh cannot immediately clear its hold.
    if (turnHeldBy(ctx, turnId).length > 0) {
      const held = ctx.db.query<InboxItem, [string, string]>(`UPDATE inbox_items SET state = 'held', turn_id = ?
        WHERE seq IN (SELECT value FROM json_each(?)) AND state = 'queued' RETURNING *`).all(turnId, list);
      return { delivered: [], held: held.sort((a, b) => a.seq - b.seq) };
    }
    const held = ctx.db
      .query<InboxItem, [string]>(
        `UPDATE inbox_items SET state = 'held'
         WHERE seq IN (SELECT value FROM json_each(?)) AND state = 'queued' AND ${INBOX_HELD} RETURNING *`,
      )
      .all(list);
    const delivered = ctx.db
      .query<InboxItem, [string, string, number, string]>(
        `UPDATE inbox_items SET state = 'delivered', turn_id = ?, delivered_turn_id = ?, delivered_hop = ?
         WHERE seq IN (SELECT value FROM json_each(?)) AND state = 'queued' RETURNING *`,
      )
      .all(turnId, turnId, hop, list);
    return { delivered: delivered.sort((a, b) => a.seq - b.seq), held };
  })();
}

/**
 * A turn ended. Lines of yours it read and said nothing about are `unacked`. What it had not read
 * waits for the Bot's next turn in its conversation, held when a stop covers it. Returns what is
 * still queued for it and not held, oldest first.
 */
export function releaseTurnInbox(ctx: StoreContext, turnId: string, now: string = isoNow()): InboxItem[] {
  return ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE inbox_items SET state = 'unacked', disposed_at = ? WHERE delivered_turn_id = ? AND state = 'delivered' AND ${YOURS}`,
      [now, turnId],
    );
    ctx.db.run(`UPDATE inbox_items SET state = 'held' WHERE turn_id = ? AND state = 'queued' AND ${INBOX_HELD}`, [turnId]);
    ctx.db.run(`UPDATE inbox_items SET work_item_id = (SELECT t.work_item_id FROM turns t WHERE t.id = inbox_items.turn_id)
      WHERE turn_id = ? AND work_item_id IS NULL AND state IN ('queued','held')`, [turnId]);
    // A final hop can receive durable mail without ever refreshing its live cache. Make that
    // authoritative unread work dispatchable once its last segment is terminal.
    ctx.db.run(`UPDATE work_items SET state = 'queued', updated_at = ? WHERE id IN (
      SELECT COALESCE(i.work_item_id, t.work_item_id) FROM inbox_items i JOIN turns t ON t.id = i.turn_id
      WHERE i.turn_id = ? AND i.state = 'queued' AND i.wakes = 1)
      AND state NOT IN ('closed','waiting','blocked','needs_attention')
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.work_item_id = work_items.id AND t.status IN ${LIVE})`, [now, turnId]);
    return ctx.db.query<InboxItem, [string]>(`SELECT * FROM inbox_items WHERE turn_id = ? AND state = 'queued' ORDER BY seq`).all(turnId);
  })();
}

/**
 * Boot: the turns the last run left live are over, so the same as {@link releaseTurnInbox} for each
 * of them — and for any turn that ended without it, a cleared one included.
 */
/** What is queued for a live turn, oldest first: the copy `Live.inbox` is built from. */
export function queuedForTurn(ctx: StoreContext, turnId: string): InboxItem[] {
  return ctx.db.query<InboxItem, [string]>(`SELECT * FROM inbox_items WHERE turn_id = ? AND state = 'queued' ORDER BY seq`).all(turnId);
}

export function releaseEndedInbox(ctx: StoreContext, now: string = isoNow()): void {
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE inbox_items SET state = 'unacked', disposed_at = ?
       WHERE state = 'delivered' AND ${YOURS}
         AND (delivered_turn_id IS NULL OR NOT EXISTS (SELECT 1 FROM turns t WHERE t.id = inbox_items.delivered_turn_id AND t.status IN ${LIVE}))`,
      [now],
    );
    refreshHeldInbox(ctx);
  })();
}

/** Marks items held by a stop, whatever {@link refreshHeldInbox} would make of them: a wake a hold turned away. */
export function holdInboxItems(ctx: StoreContext, seqs: readonly number[]): void {
  if (seqs.length === 0) return;
  ctx.db.run(`UPDATE inbox_items SET state = 'held' WHERE seq IN (SELECT value FROM json_each(?)) AND state = 'queued'`, [JSON.stringify(seqs)]);
}

/** Takes items out of the inbox for good: answered where they were said, or about to fire again as the check-back they came from. */
export function supersedeInboxItems(ctx: StoreContext, seqs: readonly number[], now: string = isoNow()): void {
  if (seqs.length === 0) return;
  ctx.db.run(
    `UPDATE inbox_items SET state = 'superseded', disposed_at = ? WHERE seq IN (SELECT value FROM json_each(?)) AND state IN ('queued', 'held')`,
    [now, JSON.stringify(seqs)],
  );
}

/**
 * Puts the items no live turn has (a Bot's or a conversation's only, when given) in line with the
 * holds: one a stop covers is held, one none covers any more is queued again. Called in the write
 * that makes or lifts a hold, so what you see under a line of yours says whether a stop holds it.
 */
export function refreshHeldInbox(ctx: StoreContext, only: { botId?: string; sessionId?: string } = {}): void {
  const scope = [only.botId ? `AND inbox_items.bot_id = $bot` : "", only.sessionId ? `AND inbox_items.session_id = $session` : ""].join(" ");
  const params = { ...(only.botId ? { bot: only.botId } : {}), ...(only.sessionId ? { session: only.sessionId } : {}) } as Record<string, string>;
  ctx.db.query(`UPDATE inbox_items SET state = 'held' WHERE state = 'queued' AND ${NOT_IN_LIVE_TURN} ${scope} AND ${INBOX_HELD}`).run(params);
  ctx.db.query(`UPDATE inbox_items SET state = 'queued' WHERE state = 'held' ${scope} AND NOT ${INBOX_HELD}`).run(params);
}

/**
 * `end_turn`'s `inbox`: what the Bot says it did with each item it read this turn, recorded on the
 * item. An item another turn read, or one this turn never read, is not this turn's to answer for;
 * nor is an id that names none. Said twice, the later word stands.
 */
export function disposeInboxItems(
  ctx: StoreContext,
  turnId: string,
  entries: unknown,
  now: string = isoNow(),
): { recorded: string[]; notRecorded: Array<{ id: string; reason: string }> } {
  const recorded: string[] = [];
  const notRecorded: Array<{ id: string; reason: string }> = [];
  if (entries === undefined || entries === null) return { recorded, notRecorded };
  if (!Array.isArray(entries)) {
    return { recorded, notRecorded: [{ id: "inbox", reason: "inbox must be an array of { id, disposition, note }" }] };
  }
  ctx.db.transaction(() => {
    for (const entry of entries) {
      const raw = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const label = typeof raw.id === "string" ? raw.id : typeof raw.id === "number" ? String(raw.id) : "";
      const seq = inboxSeqOf(label);
      const row = seq === null ? null : getInboxItem(ctx, seq);
      if (!row) {
        notRecorded.push({ id: label, reason: "no inbox item has this id" });
        continue;
      }
      if (row.delivered_turn_id !== turnId) {
        notRecorded.push({ id: label, reason: "this turn did not read it" });
        continue;
      }
      const disposition = raw.disposition as InboxDisposition;
      if (!INBOX_DISPOSITIONS.includes(disposition)) {
        notRecorded.push({ id: label, reason: `disposition must be one of ${INBOX_DISPOSITIONS.join(", ")}` });
        continue;
      }
      const note = typeof raw.note === "string" && raw.note.trim() ? takeCodePoints(raw.note.trim(), DISPOSITION_NOTE_MAX).text : null;
      ctx.db.run(`UPDATE inbox_items SET state = ?, disposition_note = ?, disposed_at = ? WHERE seq = ?`, [disposition, note, now, row.seq]);
      recorded.push(inboxLabel(row));
    }
  })();
  return { recorded, notRecorded };
}

/**
 * Where a line stands in its own conversation's inbox, for `Message.delivery`: the first item for it
 * there. A copy heard in another conversation, about the same job, is that turn's business.
 */
export function messageDelivery(ctx: StoreContext, messageId: string, sessionId: string): MessageDelivery | undefined {
  const row = ctx.db
    .query<Pick<InboxItem, "bot_id" | "state" | "delivered_hop" | "disposition_note">, [string, string]>(
      `SELECT bot_id, state, delivered_hop, disposition_note FROM inbox_items WHERE message_id = ? AND session_id = ? ORDER BY seq LIMIT 1`,
    )
    .get(messageId, sessionId);
  if (!row) return undefined;
  return { bot_id: row.bot_id, state: row.state, hop: row.delivered_hop, note: row.disposition_note };
}

/**
 * A conversation's history is cleared, or the conversation deleted: the items keep their words and
 * forget the lines and turns that go with it. Deleted, what still waits to be heard there never
 * will be, and is taken out of the inbox.
 */
export function forgetInboxSources(ctx: StoreContext, sessionId: string, opts: { sessionGone: boolean }, now: string = isoNow()): void {
  ctx.db.run(`UPDATE inbox_items SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`, [sessionId]);
  for (const column of ["turn_id", "delivered_turn_id"]) {
    ctx.db.run(`UPDATE inbox_items SET ${column} = NULL WHERE ${column} IN (SELECT id FROM turns WHERE session_id = ?)`, [sessionId]);
  }
  if (!opts.sessionGone) return;
  ctx.db.run(
    `UPDATE inbox_items SET state = 'superseded', disposed_at = ? WHERE session_id = ? AND state IN ('queued', 'held')`,
    [now, sessionId],
  );
  ctx.db.run(`UPDATE inbox_items SET session_id = NULL WHERE session_id = ?`, [sessionId]);
}
