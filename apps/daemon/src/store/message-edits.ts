/**
 * Changing a line of yours after it went out (编辑, ADR 0063). The transcript shows the new words;
 * what it said before is kept beside it (`message_edits`) and, as your words, in `user_quotes`,
 * where an edit only ever adds the clauses you changed. A Bot that had not read the line yet reads
 * the new words and nothing else; one that had gets a line of yours saying what you changed, at
 * its next step, or woken for it. All of it is decided in the write that changes the words, as a
 * refile is (`refileMessage`): a line still on its way to a Bot has no reader yet, and the intake
 * reads it again before routing it (turn-engine.ts), so it goes out as it now reads.
 */
import type { Database } from "bun:sqlite";
import { FILE_DROP_SESSION_ID, USER_MEMBER, type Locale, type Message, type MessageTakenAs, type MessageVersion } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { heldSql } from "./holds";
import { assertUserMayPost, getMessage, withReplyMention } from "./messages";
import { changedWords, recordQuote, type UserQuote } from "./quotes";
import { settingsCached } from "./settings";
import { messageRow, sessionRow, LIVE_TURN_STATUSES, type MessageRow, type StoreContext } from "./shared";
import { lineTicketFor } from "./turns";
import { recordWorkEvent } from "./work-events";
import { findOrCreateWorkItem } from "./work-items";

export type MessageEdit = {
  id: string;
  message_id: string;
  body_before: string;
  body_after: string;
  created_at: string;
};

export type EditMessageResult = {
  message: Message;
  /** Null when the words did not change: nothing was written. */
  edit: MessageEdit | null;
  /** The clauses you changed, kept as your words; null when you only took words out. */
  quote: UserQuote | null;
  /** How many Bots are told of the change: one row each, wherever each reads it. */
  told: number;
};

const UNREAD = `('queued', 'held')`;
/** Every state of an item a turn read (`refileMessage` reads the same list). */
const READ = `('delivered', 'adopted', 'answered', 'declined', 'deferred', 'unacked', 'merged')`;
/** How much of the old wording a correction carries. The new one comes first; the note clips both at `HEARD_BODY_MAX`. */
const BEFORE_MAX = 600;

/** Additive only, like the other catch-ups: three columns, and `message_edits` comes from `SCHEMA_SQL`. */
export function migrateMessageEdits(db: Database): void {
  for (const [table, definitions] of [
    ["messages", [["edited_at", "TEXT"], ["taken_as", "TEXT CHECK (taken_as IS NULL OR taken_as IN ('app', 'answer'))"]]],
    ["user_quotes", [["edit_of", "TEXT"]]],
    ["inbox_items", [["edit_id", "TEXT"]]],
  ] as const) {
    const names = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    for (const [name, definition] of definitions) {
      if (!names.includes(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

/**
 * Why this line cannot be changed, or null when it can. Only a plain line of yours, in a
 * conversation you can still write in, that went to the Bots as words: one the app carried out
 * itself or took as your answer was done with when it arrived, and a batch of annotations is
 * changed through its annotations.
 */
export function editRefusal(ctx: StoreContext, row: MessageRow): string | null {
  if (row.kind !== "user" || row.author !== USER_MEMBER || row.bot_only) return "only a line of yours can be changed";
  if (row.withdrawn_at) return "you took this line back; send it again instead";
  if (row.taken_as === "answer") return "this line was your answer to a question, and a question is answered once";
  if (row.taken_as === "app") return "the app already carried this line out";
  if (row.annotation_source_message_id || ctx.db.query(`SELECT 1 FROM annotations WHERE message_id = ? LIMIT 1`).get(row.id)) {
    return "a batch of annotations is changed through its annotations";
  }
  const session = sessionRow(ctx, row.session_id);
  if (session.archived_at) return "the conversation is archived";
  if (session.kind === "direct" && session.id !== FILE_DROP_SESSION_ID && !ctx.db.query(
    `SELECT 1 FROM session_participants p JOIN bots b ON b.id = p.member
     WHERE p.session_id = ? AND p.left_at IS NULL AND b.deleted_at IS NULL LIMIT 1`,
  ).get(row.session_id)) {
    return "the Bot of this direct is gone";
  }
  return null;
}

/** A line of yours the app carried out, or took as your answer: done with as words when it arrived. */
export function markLineTaken(ctx: StoreContext, id: string, as: MessageTakenAs): void {
  ctx.db.run(`UPDATE messages SET taken_as = ? WHERE id = ? AND kind = 'user' AND taken_as IS NOT ?`, [as, id, as]);
}

/** Sent on again as an ordinary line once you undid what was made of it: yours to change again. */
export function clearLineTaken(ctx: StoreContext, id: string): void {
  ctx.db.run(`UPDATE messages SET taken_as = NULL WHERE id = ? AND taken_as IS NOT NULL`, [id]);
}

export function editMessage(ctx: StoreContext, id: string, input: { body: unknown; userActionId: string }): EditMessageResult {
  return ctx.commit(() => {
    const row = messageRow(ctx, id);
    // Not yours to write in — a Bot↔Bot direct — is refused as a post there would be.
    assertUserMayPost(ctx, row.session_id);
    const refusal = editRefusal(ctx, row);
    if (refusal) throw new HttpError(422, "not_editable", refusal);
    if (typeof input.body !== "string") throw new HttpError(422, "invalid_args", "body must be a string");
    // Spelled as a post spells it: a reply to a Bot keeps naming that Bot.
    const parent = row.parent_id
      ? ctx.db.query<MessageRow, [string]>(`SELECT * FROM messages WHERE id = ?`).get(row.parent_id) ?? null
      : null;
    const body = withReplyMention(ctx, input.body, parent, USER_MEMBER);
    if (!body.trim() && !ctx.db.query(`SELECT 1 FROM attachments WHERE message_id = ? LIMIT 1`).get(id)) {
      throw new HttpError(422, "invalid_args", "a line with no files needs words");
    }
    if (body === row.body) return { message: getMessage(ctx, id), edit: null, quote: null, told: 0 };
    const now = isoNow();
    ctx.db.run(`UPDATE messages SET body = ?, edited_at = ? WHERE id = ?`, [body, now, id]);
    const edit = ctx.db
      .query<MessageEdit, [string, string, string, string, string]>(
        `INSERT INTO message_edits (id, message_id, body_before, body_after, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(ulid(Date.parse(now)), id, row.body, body, now)!;
    // The file drop has no Bot: nothing said there is asked of anyone, so nothing is kept of it.
    const quote = row.session_id === FILE_DROP_SESSION_ID ? null : quoteChange(ctx, row, body, now);
    const told = tellReaders(ctx, row, edit);
    recordWorkEvent(ctx, {
      kind: "message.edited",
      actor: "user",
      sessionId: row.session_id,
      taskId: row.task_id ?? null,
      ticketId: row.ticket_id ?? null,
      payload: { message: id, edit: edit.id, user_action_id: input.userActionId, quote: quote?.id ?? null, told },
    });
    return { message: getMessage(ctx, id), edit, quote, told };
  });
}

/** What the line said before each change, oldest first; what it says now is the line itself. */
export function messageVersions(ctx: StoreContext, id: string): MessageVersion[] {
  const row = messageRow(ctx, id);
  const edits = ctx.db
    .query<MessageEdit, [string]>(`SELECT * FROM message_edits WHERE message_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(id);
  return edits.map((edit, at) => ({ body: edit.body_before, created_at: at === 0 ? row.created_at : edits[at - 1]!.created_at }));
}

/**
 * The clauses you changed, kept as your words the way a board edit's are (`changedWords`): what
 * you only kept is not said again, so the scribe reads only what is new and a requirement you left
 * alone is not counted as said twice. Pointing at the line's first quote (`edit_of`) makes all of
 * a line's quotes one source of what you said. Filed where the line is, on every target.
 */
function quoteChange(ctx: StoreContext, row: MessageRow, body: string, now: string): UserQuote | null {
  const changed = changedWords(row.body, body);
  if (!changed) return null;
  const root = ctx.db
    .query<{ id: string }, [string]>(
      `SELECT id FROM user_quotes WHERE message_id = ? AND via = 'message' AND edit_of IS NULL ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
    .get(row.id);
  const quote = recordQuote(ctx, {
    via: "message",
    body: changed,
    messageId: row.id,
    sessionId: row.session_id,
    taskId: row.task_id ?? null,
    ticketId: row.ticket_id ?? null,
    editOf: root?.id ?? null,
    now,
  });
  if (!quote) return null;
  const part = ctx.db
    .query<{ part_key: string | null }, [string]>(
      `SELECT part_key FROM message_filings WHERE message_id = ? ORDER BY is_primary DESC, rowid ASC LIMIT 1`,
    )
    .get(row.id)?.part_key ?? null;
  if (part) ctx.db.run(`UPDATE user_quotes SET part_key = ? WHERE id = ?`, [part, quote.id]);
  ctx.db.run(
    `INSERT OR IGNORE INTO user_quote_filings (quote_id, task_id, ticket_id, part_key)
     SELECT ?, task_id, ticket_id, part_key FROM message_filings WHERE message_id = ?`,
    [quote.id, row.id],
  );
  return ctx.db.query<UserQuote, [string]>(`SELECT * FROM user_quotes WHERE id = ?`).get(quote.id)!;
}

type UnreadItem = { seq: number; bot_id: string; body_snapshot: string; edit_id: string | null };
type Reader = { botId: string; turnId: string | null; saidIn: string | null; sessionId: string | null };
type LiveTurn = { id: string; session_id: string; work_item_id: string | null; task_id: string | null; ticket_id: string | null };
type Route = {
  turnId: string | null;
  sessionId: string;
  workItemId: string | null;
  taskId: string | null;
  ticketId: string | null;
  held: boolean;
};

/**
 * Unread copies of the line say the new words; every Bot that read the old ones gets a line of
 * yours saying what changed. A copy is the line's words, with files listed after them (heard in
 * another conversation) or a note before them (a refile's): the old words are swapped where they
 * open or close it, and a copy where they do neither is left as it is, its Bot told instead.
 */
function tellReaders(ctx: StoreContext, line: MessageRow, edit: MessageEdit): number {
  const locale = settingsCached(ctx).locale;
  const unread = ctx.db
    .query<UnreadItem, [string]>(
      `SELECT seq, bot_id, body_snapshot, edit_id FROM inbox_items WHERE message_id = ? AND state IN ${UNREAD} ORDER BY seq`,
    )
    .all(line.id);
  const rebuilt = new Set<string>();
  const unswapped: string[] = [];
  for (const item of unread) {
    if (item.edit_id) {
      // A change it has not read yet: it now says what the line says, against what that Bot last read.
      const read = ctx.db
        .query<{ body_before: string }, [string]>(`SELECT body_before FROM message_edits WHERE id = ?`)
        .get(item.edit_id)?.body_before ?? edit.body_before;
      ctx.db.run(`UPDATE inbox_items SET body_snapshot = ? WHERE seq = ?`, [correctionBody(locale, edit.body_after, read), item.seq]);
      rebuilt.add(item.bot_id);
      continue;
    }
    const swapped = swapWords(item.body_snapshot, edit.body_before, edit.body_after);
    if (swapped === null) {
      unswapped.push(item.bot_id);
      continue;
    }
    ctx.db.run(`UPDATE inbox_items SET body_snapshot = ? WHERE seq = ?`, [swapped, item.seq]);
  }
  const readers: Reader[] = [
    // An item read: the line, heard where the Bot was working, or a note about it.
    ...ctx.db
      .query<Reader, [string]>(
        `SELECT bot_id AS botId, delivered_turn_id AS turnId, said_in AS saidIn, session_id AS sessionId
         FROM inbox_items WHERE message_id = ? AND state IN ${READ} ORDER BY seq`,
      )
      .all(line.id),
    // A working turn it opened read it as its trigger. A read-only answer under a stop is no
    // reader: lifting the stop hands the line back as it then reads (stop.ts `takeUpLine`).
    ...ctx.db
      .query<Reader, [string]>(
        `SELECT bot_id AS botId, id AS turnId, NULL AS saidIn, session_id AS sessionId
         FROM turns WHERE trigger_message_id = ? AND IFNULL(mode, 'work') <> 'readonly' ORDER BY created_at, id`,
      )
      .all(line.id),
    ...unswapped.map((botId): Reader => ({ botId, turnId: null, saidIn: null, sessionId: null })),
  ];
  const told = new Set<string>();
  const body = correctionBody(locale, edit.body_after, edit.body_before);
  const now = isoNow();
  for (const reader of readers) {
    if (rebuilt.has(reader.botId)) continue;
    const route = correctionRoute(ctx, line, reader);
    if (!route) continue;
    const key = `${reader.botId}:${route.turnId ?? route.workItemId ?? route.sessionId}`;
    if (told.has(key)) continue;
    told.add(key);
    // Written here, not through `queueInboxItem` or `queueWork`: both take a row already about this
    // line for this one. Never through `hearIn` either: a turn waiting on your answer would take it
    // as the answer, and a stop would drop it rather than hold it.
    ctx.db.run(
      `INSERT INTO inbox_items (id, bot_id, work_item_id, session_id, turn_id, task_id, ticket_id, message_id, author,
         body_snapshot, said_in, source, kind, priority, wakes, state, possible_control, created_at, edit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, 'user', 'change', 1, 1, ?, 0, ?, ?)`,
      [
        ulid(Date.parse(now)),
        reader.botId,
        route.workItemId,
        route.sessionId,
        route.turnId,
        line.task_id ?? route.taskId,
        line.task_id ? line.ticket_id ?? null : route.ticketId,
        line.id,
        body,
        reader.sessionId === route.sessionId ? reader.saidIn : null,
        route.held ? "held" : "queued",
        now,
        edit.id,
      ],
    );
  }
  return told.size;
}

/** The old words swapped for the new where they open or close the copy; null where they do neither. */
export function swapWords(snapshot: string, before: string, after: string): string | null {
  if (snapshot === before) return after;
  if (snapshot.startsWith(before)) return after + snapshot.slice(before.length);
  if (snapshot.endsWith(before)) return snapshot.slice(0, snapshot.length - before.length) + after;
  return null;
}

/** What a Bot that read the line is told: the new words first and whole, then what it read. */
export function correctionBody(locale: Locale, after: string, before: string): string {
  const cut = takeCodePoints(before.trim(), BEFORE_MAX);
  const was = cut.truncated ? `${cut.text}…` : cut.text;
  return locale === "en"
    ? `You changed this line. It now reads: “${after.trim()}” (it was: “${was}”)`
    : `你改了这句。现在是：「${after.trim()}」（原来是：「${was}」）`;
}

/**
 * Where a Bot that read the line reads the change: the segment that read it, while it still works;
 * else its segment on the line's job (its desk in the line's conversation, for a line on no job);
 * else its work on that job, queued so the next turn opens on the line and reads the change first —
 * the work item that turn binds, or the turn's opening would take the row for a stale copy of its
 * trigger. Held while a stop covers it, delivered once the stop lifts.
 */
function correctionRoute(ctx: StoreContext, line: MessageRow, reader: Reader): Route | null {
  if (!ctx.db.query(`SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL AND archived_at IS NULL`).get(reader.botId)) return null;
  const liveCols = `id, session_id, work_item_id, task_id, ticket_id`;
  let live: LiveTurn | null = reader.turnId
    ? ctx.db
        .query<LiveTurn, [string]>(
          `SELECT ${liveCols} FROM turns WHERE id = ? AND status IN ${LIVE_TURN_STATUSES} AND IFNULL(mode, 'work') <> 'readonly'`,
        )
        .get(reader.turnId) ?? null
    : null;
  live ??= line.task_id
    ? ctx.db
        .query<LiveTurn, [string, string]>(
          `SELECT ${liveCols} FROM turns WHERE bot_id = ? AND task_id = ? AND status IN ${LIVE_TURN_STATUSES}
             AND IFNULL(mode, 'work') <> 'readonly' ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(reader.botId, line.task_id) ?? null
    : ctx.db
        .query<LiveTurn, [string, string]>(
          `SELECT ${liveCols} FROM turns WHERE bot_id = ? AND session_id = ? AND mode = 'desk' AND status IN ${LIVE_TURN_STATUSES}
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(reader.botId, line.session_id) ?? null;
  if (live) {
    return {
      turnId: live.id,
      sessionId: live.session_id,
      workItemId: live.work_item_id,
      taskId: live.task_id,
      ticketId: live.ticket_id,
      held: held(ctx, reader.botId, live.session_id, live.task_id, live.ticket_id, live.id),
    };
  }
  const work = findOrCreateWorkItem(ctx, {
    botId: reader.botId,
    sessionId: line.session_id,
    taskId: line.task_id ?? null,
    ticketId: line.task_id ? lineTicketFor(ctx, line.ticket_id ?? null, reader.botId) : null,
  });
  // Queued as a turn's unread mail is when it ends (`releaseTurnInbox`); work waiting on something
  // else, or needing you, reads it when it next runs.
  ctx.db.run(
    `UPDATE work_items SET state = 'queued', updated_at = ? WHERE id = ? AND state NOT IN ('closed', 'waiting', 'blocked', 'needs_attention')
       AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.work_item_id = work_items.id AND t.status IN ${LIVE_TURN_STATUSES})`,
    [isoNow(), work.id],
  );
  // A job set aside is taken up again by what you said about it, as a new line about it would.
  if (work.task_id) ctx.db.run(`UPDATE tasks SET dormant_since = NULL WHERE id = ? AND dormant_since IS NOT NULL`, [work.task_id]);
  const where = ctx.db
    .query<{ session_id: string }, [string]>(`SELECT COALESCE(thread_session_id, home_session_id) AS session_id FROM work_items WHERE id = ?`)
    .get(work.id)!.session_id;
  return {
    turnId: null,
    sessionId: where,
    workItemId: work.id,
    taskId: work.task_id,
    ticketId: work.ticket_id,
    held: held(ctx, reader.botId, where, work.task_id, work.ticket_id, null),
  };
}

function held(ctx: StoreContext, botId: string, sessionId: string, taskId: string | null, ticketId: string | null, turnId: string | null): boolean {
  return Boolean(
    ctx.db
      .query<{ held: number }, Array<string | null>>(
        `SELECT ${heldSql({ bot: "?1", session: "?2", task: "?3", ticket: "?4", turn: "?5" })} AS held`,
      )
      .get(botId, sessionId, taskId, ticketId, turnId)?.held,
  );
}
