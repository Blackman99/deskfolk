/**
 * A check-back: a Bot's one-shot appointment with itself to look at a job again later.
 *
 * It is not a routine (it fires once and is not on the calendar) and not a scheduler entity (no
 * step, no assignee, no plan). The Bot writes down when to come back and what to verify; the
 * daemon wakes it in the same session with that note as the trigger, and the turn inherits the
 * job's work dir through the turn that made the appointment. One pending check-back per Bot per
 * session — making another replaces it, so a Bot cannot pile up wake-ups. Stop on the turn that
 * made it, clearing or deleting the session, and deleting the Bot all void it. Nothing here opens
 * a turn; the engine does that when the scheduler finds a due row.
 */
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { aliveBot, isPresent, sessionRow, type StoreContext } from "./shared";

export type CheckBack = {
  id: string;
  bot_id: string;
  session_id: string;
  /** The turn that made the appointment. Its row may be gone by the time the check-back fires. */
  turn_id: string | null;
  /** The plan that turn worked in, so the woken turn lands in the same folder. */
  task_id: string | null;
  /** The ticket it worked in, when it had one. */
  ticket_id: string | null;
  note: string;
  due_at: string;
  created_at: string;
  fired_at: string | null;
  fired_turn_id: string | null;
  /** The system line it woke its Bot with. */
  message_id: string | null;
  voided_at: string | null;
};

export const CHECK_BACK_MIN_MINUTES = 1;
/** A week: long enough for "look again after the weekend", short enough to still be this job. */
export const CHECK_BACK_MAX_MINUTES = 7 * 24 * 60;
export const CHECK_BACK_NOTE_MAX = 500;

export function scheduleCheckBack(
  ctx: StoreContext,
  input: {
    botId: string;
    sessionId: string;
    turnId: string | null;
    note: unknown;
    afterMinutes: unknown;
    now?: Date;
  },
): { row: CheckBack; replaced: boolean } {
  aliveBot(ctx, input.botId);
  sessionRow(ctx, input.sessionId);
  if (!isPresent(ctx, input.sessionId, input.botId)) {
    throw new HttpError(422, "not_a_member", "you are not in that session");
  }
  const note = typeof input.note === "string" ? input.note.replace(/\s+/g, " ").trim() : "";
  if (!note) throw new HttpError(422, "invalid_args", "note is required");
  const minutes = input.afterMinutes;
  if (
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < CHECK_BACK_MIN_MINUTES ||
    minutes > CHECK_BACK_MAX_MINUTES
  ) {
    throw new HttpError(
      422,
      "invalid_args",
      `after_minutes must be an integer between ${CHECK_BACK_MIN_MINUTES} and ${CHECK_BACK_MAX_MINUTES}`,
    );
  }
  const at = input.now ?? new Date();
  const now = at.toISOString();
  const due = new Date(at.getTime() + minutes * 60_000).toISOString();
  const id = ulid(at.getTime());
  const lineage = input.turnId
    ? ctx.db
        .query<{ task_id: string | null; ticket_id: string | null }, [string]>(
          `SELECT task_id, ticket_id FROM turns WHERE id = ?`,
        )
        .get(input.turnId)
    : null;
  let replaced = false;
  ctx.db.transaction(() => {
    const voided = ctx.db
      .query<{ id: string }, [string, string, string]>(
        `UPDATE check_backs SET voided_at = ?
         WHERE bot_id = ? AND session_id = ? AND fired_at IS NULL AND voided_at IS NULL
         RETURNING id`,
      )
      .all(now, input.botId, input.sessionId);
    replaced = voided.length > 0;
    ctx.db.run(
      `INSERT INTO check_backs
         (id, bot_id, session_id, turn_id, task_id, ticket_id, note, due_at, created_at, fired_at, fired_turn_id, voided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [id, input.botId, input.sessionId, input.turnId, lineage?.task_id ?? null, lineage?.ticket_id ?? null, takeCodePoints(note, CHECK_BACK_NOTE_MAX).text, due, now],
    );
  })();
  return { row: getCheckBack(ctx, id), replaced };
}

export function getCheckBack(ctx: StoreContext, id: string): CheckBack {
  const row = ctx.db.query<CheckBack, [string]>(`SELECT * FROM check_backs WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "check-back not found");
  return row;
}

/** The one appointment this Bot still has in this session, if any. */
export function pendingCheckBack(ctx: StoreContext, botId: string, sessionId: string): CheckBack | null {
  return (
    ctx.db
      .query<CheckBack, [string, string]>(
        `SELECT * FROM check_backs
         WHERE bot_id = ? AND session_id = ? AND fired_at IS NULL AND voided_at IS NULL
         ORDER BY due_at ASC, id ASC LIMIT 1`,
      )
      .get(botId, sessionId) ?? null
  );
}

export function listPendingCheckBacks(ctx: StoreContext, sessionId?: string): CheckBack[] {
  return sessionId
    ? ctx.db
        .query<CheckBack, [string]>(
          `SELECT * FROM check_backs WHERE session_id = ? AND fired_at IS NULL AND voided_at IS NULL
           ORDER BY due_at ASC, id ASC`,
        )
        .all(sessionId)
    : ctx.db
        .query<CheckBack, []>(
          `SELECT * FROM check_backs WHERE fired_at IS NULL AND voided_at IS NULL ORDER BY due_at ASC, id ASC`,
        )
        .all();
}

/** Appointments whose time has come, oldest first. Includes ones the daemon slept through. */
export function dueCheckBacks(ctx: StoreContext, now: Date = new Date()): CheckBack[] {
  return ctx.db
    .query<CheckBack, [string]>(
      `SELECT * FROM check_backs
       WHERE fired_at IS NULL AND voided_at IS NULL AND due_at <= ?
       ORDER BY due_at ASC, id ASC`,
    )
    .all(now.toISOString());
}

/**
 * Stamps the appointment as fired and returns it, or null when another tick already took it or
 * it was voided meanwhile. Compare-and-set, so two ticks never wake the Bot twice.
 */
export function claimCheckBack(ctx: StoreContext, id: string, now: Date = new Date()): CheckBack | null {
  return (
    ctx.db
      .query<CheckBack, [string, string]>(
        `UPDATE check_backs SET fired_at = ?
         WHERE id = ? AND fired_at IS NULL AND voided_at IS NULL
         RETURNING *`,
      )
      .get(now.toISOString(), id) ?? null
  );
}

export function markCheckBackFired(ctx: StoreContext, id: string, turnId: string): void {
  ctx.db.run(`UPDATE check_backs SET fired_turn_id = ? WHERE id = ?`, [turnId, id]);
}

/** Written in the transaction that inserts the line, so the commit's events already leave it out. */
export function recordCheckBackLine(ctx: StoreContext, id: string, messageId: string): void {
  ctx.db.run(`UPDATE check_backs SET message_id = ? WHERE id = ?`, [messageId, id]);
}

/**
 * The line a check-back wakes its Bot with is the Bot's note to itself, like a reminder on a
 * phone: the woken turn reads it as its trigger and the flow board draws the wake, but the
 * conversation, other Bots' transcripts, the organizer, search and unread counts leave it out.
 * `column` is the message id column of the query this goes into.
 */
export function notCheckBackLine(column = "id"): string {
  return `${column} NOT IN (SELECT cb.message_id FROM check_backs cb WHERE cb.message_id IS NOT NULL)`;
}

export function isCheckBackLine(ctx: StoreContext, messageId: string): boolean {
  return Boolean(ctx.db.query(`SELECT 1 FROM check_backs WHERE message_id = ?`).get(messageId));
}

/**
 * Cancels pending appointments: the turn that made them was stopped, the session they were for is
 * cleared or gone, or the Bot is. Returns how many were still pending.
 */
export function voidCheckBacks(
  ctx: StoreContext,
  where: { turnId?: string; sessionId?: string; botId?: string },
  now: string = isoNow(),
): number {
  const conditions: string[] = [];
  const params: string[] = [now];
  if (where.turnId) {
    conditions.push(`turn_id = ?`);
    params.push(where.turnId);
  }
  if (where.sessionId) {
    conditions.push(`session_id = ?`);
    params.push(where.sessionId);
  }
  if (where.botId) {
    conditions.push(`bot_id = ?`);
    params.push(where.botId);
  }
  if (conditions.length === 0) return 0;
  return ctx.db
    .query<{ id: string }, string[]>(
      `UPDATE check_backs SET voided_at = ?
       WHERE fired_at IS NULL AND voided_at IS NULL AND ${conditions.join(" AND ")}
       RETURNING id`,
    )
    .all(...params).length;
}
