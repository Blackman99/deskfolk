/**
 * Your words (原话, ADR 0040): a copy of what you said, taken in the same write as the line, the
 * answer, the annotation or the board edit itself, and kept apart from the transcript. Clearing a
 * conversation deletes the transcript; these stay, with only the id of what went nulled, so the
 * requirements ledger and the checks drawn from your words still have them to stand on. Nothing
 * here needs a model.
 */
import { isoNow, ulid } from "../ids";
import { codePointCount, takeCodePoints } from "../text";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

export type QuoteVia = "message" | "ask_answer" | "annotation" | "board";

export type UserQuote = {
  id: string;
  message_id: string | null;
  session_id: string | null;
  task_id: string | null;
  ticket_id: string | null;
  part_key: string | null;
  via: QuoteVia;
  body: string;
  created_at: string;
  /** Set once you erased it; `body` is empty from then on. */
  redacted_at: string | null;
};

/** As much of one thing you said as a quote keeps. */
export const QUOTE_MAX = 2000;

/**
 * At most {@link QUOTE_MAX} code points. A longer one keeps its head and its tail — where a request
 * usually says what it wants and then what it must not do — around a marker with how much went.
 */
export function clipQuote(text: string): string {
  const total = codePointCount(text);
  if (total <= QUOTE_MAX) return text;
  // Sized for the widest count a marker can carry, so the result never runs over.
  const room = QUOTE_MAX - `\n[…${total}…]\n`.length;
  const head = takeCodePoints(text, Math.ceil(room * 0.6)).text;
  const tailLength = room - codePointCount(head);
  const tail = text.slice(takeCodePoints(text, total - tailLength).text.length);
  return `${head}\n[…${total - codePointCount(head) - tailLength}…]\n${tail}`;
}

// Where a clause of a board field ends (as in derived-checks.ts): a comma, a stop, a question or
// exclamation mark, a new line; a point only when no digit follows it.
const CLAUSE_BREAK = /[，。,;；!?！？\n]|\.(?!\d)/;

/**
 * The words you changed in a board field, whole clauses of it: what differs between `before` and
 * `after`, widened to the clauses it falls in. Adding 「，加字幕」 to 「剪一支约 60 秒的宣传片」 is
 * 「加字幕」; changing 「约 60 秒」 to 「约 90 秒」 is the clause 「剪一支约 90 秒的宣传片」. Text you only
 * kept — the organizer's, or your own from before — is not said again. Empty when you only deleted.
 */
export function changedWords(before: string, after: string): string {
  const a = [...before];
  const b = [...after];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  let from = prefix;
  let to = b.length - suffix;
  if (from >= to) return "";
  while (from < to && CLAUSE_BREAK.test(b[from]!)) from++;
  while (from > 0 && !CLAUSE_BREAK.test(b[from - 1]!)) from--;
  while (to < b.length && !CLAUSE_BREAK.test(b[to]!)) to++;
  return b.slice(from, to).join("").trim();
}

/**
 * Keeps one thing you said. Called inside the write that makes the line, answer, annotation or
 * edit, so the two land or fail together. Nothing is kept for words that are only whitespace.
 */
export function recordQuote(
  ctx: StoreContext,
  input: {
    via: QuoteVia;
    body: string;
    messageId?: string | null;
    sessionId?: string | null;
    taskId?: string | null;
    ticketId?: string | null;
    now?: string;
  },
): UserQuote | null {
  if (!input.body.trim()) return null;
  return ctx.db
    .query<UserQuote, Array<string | null>>(
      `INSERT INTO user_quotes (id, message_id, session_id, task_id, ticket_id, via, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      ulid(),
      input.messageId ?? null,
      input.sessionId ?? null,
      input.taskId ?? null,
      input.ticketId ?? null,
      input.via,
      clipQuote(input.body),
      input.now ?? isoNow(),
    )!;
}

export function getQuote(ctx: StoreContext, id: string): UserQuote | null {
  return ctx.db.query<UserQuote, [string]>(`SELECT * FROM user_quotes WHERE id = ?`).get(id);
}

/** The quote a line of yours (`message`) or your answer to a question (`ask_answer`) was kept as. */
export function quoteOfMessage(ctx: StoreContext, messageId: string, via: "message" | "ask_answer"): UserQuote | null {
  return ctx.db
    .query<UserQuote, [string, string]>(`SELECT * FROM user_quotes WHERE message_id = ? AND via = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(messageId, via);
}

/** Whether the scribe has read this quote against a plan already: its answer is in the work log. */
export function quoteScribed(ctx: StoreContext, quoteId: string): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM work_events WHERE kind = 'scribe.answer' AND json_extract(payload, '$.quote') = ? LIMIT 1`).get(quoteId));
}

/** Oldest first, narrowed by what they are about or where they came from. */
export function listQuotes(ctx: StoreContext, filter: { taskId?: string; sessionId?: string; messageId?: string } = {}): UserQuote[] {
  return ctx.db
    .query<UserQuote, [string | null, string | null, string | null]>(
      `SELECT * FROM user_quotes
       WHERE (?1 IS NULL OR task_id = ?1) AND (?2 IS NULL OR session_id = ?2) AND (?3 IS NULL OR message_id = ?3)
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(filter.taskId ?? null, filter.sessionId ?? null, filter.messageId ?? null);
}

/**
 * Erases what you said, when you ask for it (ADR 0040): the body goes and the row says it was erased.
 * An entry of the ledger that stood on one of these loses its words and your restated version with
 * them, and is waived unless something already replaced it: a requirement nobody can read is not
 * one anybody can meet.
 */
export function eraseQuotes(ctx: StoreContext, ids: readonly string[], now: string = isoNow()): { quotes: string[]; waived: string[] } {
  const quotes: string[] = [];
  const waived: string[] = [];
  for (const id of ids) {
    const erased = ctx.db.run(`UPDATE user_quotes SET body = '', redacted_at = ? WHERE id = ? AND redacted_at IS NULL`, [now, id]);
    if (erased.changes === 0) continue;
    quotes.push(id);
    const rows = ctx.db
      .query<{ id: string }, [string, string]>(
        `UPDATE requirements SET quote = '', restated = NULL, updated_at = ?1,
           status = CASE WHEN status = 'superseded' THEN status ELSE 'waived' END
         WHERE source_quote_id = ?2 RETURNING id`,
      )
      .all(now, id);
    waived.push(...rows.map((row) => row.id));
  }
  if (quotes.length > 0) recordWorkEvent(ctx, { kind: "quotes.erased", actor: "user", payload: { quotes, waived } });
  return { quotes, waived };
}

/** What you said in this conversation, erased or not: what "erase what I said here" reaches. */
export function quoteIdsOfSession(ctx: StoreContext, sessionId: string): string[] {
  return ctx.db
    .query<{ id: string }, [string]>(`SELECT id FROM user_quotes WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(sessionId)
    .map((row) => row.id);
}

/**
 * Before this conversation's messages are deleted: the quotes keep their words and lose only the
 * line they point at. When the conversation itself goes, the place they were said goes too.
 */
export function forgetQuoteSources(ctx: StoreContext, sessionId: string, opts: { sessionGone: boolean }): void {
  ctx.db.run(`UPDATE user_quotes SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`, [sessionId]);
  if (opts.sessionGone) ctx.db.run(`UPDATE user_quotes SET session_id = NULL WHERE session_id = ?`, [sessionId]);
}

/**
 * A line of yours, or a question you answered, is filed under a plan after it lands (by the turn it
 * opens, or the organizer); its quote follows the filing, whoever writes it — an older build
 * sharing the database included. A batch of annotations quotes each one under the delivery it is
 * about, so those are left as they are. Created by the migration, after the columns they read.
 */
export const QUOTE_TRIGGERS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "user_quotes_follow_filing",
    sql: `CREATE TRIGGER user_quotes_follow_filing AFTER UPDATE OF task_id, ticket_id ON messages
      WHEN NEW.kind IN ('user', 'ask') AND (NEW.task_id IS NOT OLD.task_id OR NEW.ticket_id IS NOT OLD.ticket_id)
      BEGIN
        UPDATE user_quotes SET task_id = NEW.task_id, ticket_id = NEW.ticket_id
        WHERE message_id = NEW.id AND via IN ('message', 'ask_answer');
      END`,
  },
];
