/**
 * A check-back: a Bot's one-shot appointment with itself to look at a job again later.
 *
 * It is not a routine (it fires once and is not on the calendar) and not a scheduler entity (no
 * step, no assignee, no plan). The Bot writes down when to come back and what to verify; the
 * daemon wakes it in the same session with that note as the trigger, and the turn inherits the
 * job's work dir through the turn that made the appointment. Before P4c, one pending timer per Bot
 * per session; from P4c, one cause per exact work/job, so unrelated jobs cannot cancel each other's
 * waits. Real delegation event waits are never clock appointments or timer replacements. Stop on the turn that
 * made it, clearing or deleting the session, and deleting the Bot all void it. A hold over it only
 * sets it aside until the hold is lifted (store/holds.ts). Nothing here opens a turn; the engine
 * does that when the scheduler finds a due row.
 */
import { jobsOn, pendingJobNamed } from "./external-jobs";
import { looksLikeWorkspacePath, USER_MEMBER } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { takeCodePoints } from "../text";
import { suspendHeldCheckBacks } from "./holds";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { aliveBot, isPresent, sessionRow, type StoreContext } from "./shared";

export type CheckBack = {
  id: string;
  work_item_id: string | null;
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
  /** Null when the Bot booked it; `plan_nudge` when the app called a Bot back to a quiet plan. */
  kind: string | null;
  /** Why it wakes someone (see {@link CheckBackCause}); null on rows from before the column. */
  cause: CheckBackCause | null;
  /** What an event wait waits for; null for a wait on the clock, the only kind so far. */
  wait_spec: string | null;
  /** Set while a hold covers it; `voided_at` is set with it, and both clear when the hold is lifted. */
  suspended_at: string | null;
  /** What a new booking replaces; null on rows from before the column, which bot_id and session_id stand in for. */
  dedupe_key: string | null;
  attempts: number;
};

/**
 * Why a check-back wakes someone (ADR 0040): the Bot's own booking, a Bot↔Bot direct gone quiet,
 * the app calling a plan back. The waits of later phases add their own.
 */
export type CheckBackCause = "self" | "delegation" | "supervisor";

export const CHECK_BACK_MIN_MINUTES = 1;
/** A week: long enough for "look again after the weekend", short enough to still be this job. */
export const CHECK_BACK_MAX_MINUTES = 7 * 24 * 60;
export const CHECK_BACK_NOTE_MAX = 500;
/** The app's plan call-back lists the plan's open tickets or those awaiting review, and its failing checks' output, so it gets more room than a Bot's own note. */
export const PLAN_NUDGE_NOTE_MAX = 2500;

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
  // From level 6 (ADR 0047) waiting on the clock is for real waits, not polling: at least five
  // minutes, at most six bookings an hour, and never to look in on a job the daemon already polls.
  if (jobsOn(ctx)) {
    if (minutes < JOB_LEVEL_CHECK_BACK_MIN_MINUTES) {
      throw new HttpError(422, "invalid_args", `after_minutes must be at least ${JOB_LEVEL_CHECK_BACK_MIN_MINUTES}: shorter waits are polling, and the app polls jobs itself`);
    }
    const job = pendingJobNamed(ctx, note);
    if (job) {
      throw new HttpError(409, "job_polled", `the app already polls job ${job.request_id} and wakes you when it is done; no check-back is needed for it`);
    }
    // Per work item (bot × plan × ticket, §2.8): another job of the same Bot books on its own budget.
    // A booking a stop of yours suspended is not counted against it.
    const hourAgo = new Date(at.getTime() - 60 * 60_000).toISOString();
    const work = input.turnId ? ctx.db.query<{ task_id: string | null; ticket_id: string | null }, [string]>("SELECT task_id, ticket_id FROM turns WHERE id = ?").get(input.turnId) : null;
    const booked = ctx.db.query<{ n: number }, [string, string, string | null, string | null]>(`SELECT COUNT(*) AS n FROM check_backs WHERE bot_id = ? AND created_at > ?
      AND task_id IS ? AND ticket_id IS ? AND (cause = 'self' OR cause IS NULL) AND kind IS NULL AND suspended_at IS NULL`)
      .get(input.botId, hourAgo, work?.task_id ?? null, work?.ticket_id ?? null)!.n;
    if (booked >= JOB_LEVEL_CHECK_BACKS_PER_HOUR) {
      throw new HttpError(429, "too_many_check_backs", `you already booked ${booked} check-backs in the last hour; wait for what you are waiting on to come back instead`);
    }
  }
  return insertCheckBack(ctx, {
    botId: input.botId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    note,
    at,
    due: new Date(at.getTime() + minutes * 60_000),
    cause: "self",
  });
}

/** From level 6 (ADR 0047): the shortest wait a Bot may book on the clock, and how many it may book an hour. */
export const JOB_LEVEL_CHECK_BACK_MIN_MINUTES = 5;
export const JOB_LEVEL_CHECK_BACKS_PER_HOUR = 6;

/**
 * The app's check-back for a Bot whose Bot↔Bot direct went quiet: due now, in the session the
 * direct came from, hung on the direct's last turn. That turn being in another session is what
 * tells it apart from one the Bot booked itself, and what lets the trace draw the wake back across.
 * Like any booking it replaces the Bot's pending one there — what it was waiting on has come back.
 */
export function bookReportBack(
  ctx: StoreContext,
  input: { botId: string; sessionId: string; turnId: string; note: string; now?: Date },
): CheckBack {
  aliveBot(ctx, input.botId);
  sessionRow(ctx, input.sessionId);
  if (!isPresent(ctx, input.sessionId, input.botId)) {
    throw new HttpError(422, "not_a_member", "not in that session");
  }
  const at = input.now ?? new Date();
  return insertCheckBack(ctx, { ...input, note: input.note.replace(/\s+/g, " ").trim(), at, due: at, cause: "delegation" }).row;
}

/**
 * The app's call-back for a plan that went quiet with work left — tickets still to do or in
 * progress, or, in a group plan, everything handed over while its progress still lists work not
 * done: due now, in the plan's session, for the Bot on the first open ticket (landing in that
 * ticket's folder) or the Bot that spoke last in the plan (landing in the plan's). Like any
 * booking it replaces the Bot's pending one there.
 */
export function bookPlanNudge(
  ctx: StoreContext,
  input: { botId: string; sessionId: string; taskId: string; ticketId: string | null; note: string; now?: Date },
): CheckBack {
  aliveBot(ctx, input.botId);
  sessionRow(ctx, input.sessionId);
  if (!isPresent(ctx, input.sessionId, input.botId)) {
    throw new HttpError(422, "not_a_member", "not in that session");
  }
  // The store's clock, not the wall's: reconcile compares this against `acceptance_checks` rows
  // and plan versions (stamped with `isoNow()`), and `isoNow()` runs a little ahead of `Date.now()`
  // in a burst — a nudge stamped behind a check's own `defined_at`, or behind a settle filed just
  // before it, would wrongly read as pre-dating them.
  const at = input.now ?? new Date(isoNow());
  return insertCheckBack(ctx, {
    botId: input.botId,
    sessionId: input.sessionId,
    turnId: null,
    note: input.note.replace(/\s+/g, " ").trim(),
    at,
    due: at,
    lineage: { task_id: input.taskId, ticket_id: input.ticketId },
    kind: PLAN_NUDGE,
    cause: "supervisor",
  }).row;
}

export const PLAN_NUDGE = "plan_nudge";

/** The newest call-back the app made to this plan, fired or not; null when it never made one. */
export function lastPlanNudge(ctx: StoreContext, taskId: string): CheckBack | null {
  return (
    ctx.db
      .query<CheckBack, [string, string]>(
        `SELECT * FROM check_backs WHERE task_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId, PLAN_NUDGE) ?? null
  );
}

/** How many plan nudges the app has booked for this plan since `since` — the reconcile's hard budget. */
export function planNudgesSince(ctx: StoreContext, taskId: string, since: string): number {
  const row = ctx.db
    .query<{ n: number }, [string, string, string]>(`SELECT COUNT(*) AS n FROM check_backs WHERE task_id = ? AND kind = ? AND created_at > ?`)
    .get(taskId, PLAN_NUDGE, since);
  return row?.n ?? 0;
}

/** Appointments still pending in a plan, whoever booked them. */
export function pendingPlanCheckBacks(ctx: StoreContext, taskId: string): CheckBack[] {
  return ctx.db
    .query<CheckBack, [string]>(
      `SELECT * FROM check_backs WHERE task_id = ? AND fired_at IS NULL AND voided_at IS NULL ORDER BY due_at ASC, id ASC`,
    )
    .all(taskId);
}

function insertCheckBack(
  ctx: StoreContext,
  input: {
    botId: string;
    sessionId: string;
    turnId: string | null;
    note: string;
    at: Date;
    due: Date;
    /** Where the woken turn lands when no turn says so. */
    lineage?: { task_id: string | null; ticket_id: string | null };
    kind?: string | null;
    cause: CheckBackCause;
  },
): { row: CheckBack; replaced: boolean } {
  const now = input.at.toISOString();
  const due = input.due.toISOString();
  const id = ulid(input.at.getTime());
  const turn = input.turnId ? ctx.db.query<{ bot_id: string; work_item_id: string | null; task_id: string | null; ticket_id: string | null }, [string]>(
    "SELECT bot_id, work_item_id, task_id, ticket_id FROM turns WHERE id = ?").get(input.turnId) : null;
  const lineage = input.lineage ?? turn;
  const scoped = readEngineLevel(ctx.db) >= ENGINE_LEVELS.delegation;
  if (scoped && input.turnId && (!turn || turn.bot_id !== input.botId)) {
    throw new HttpError(422, "invalid_args", "check-back turn must belong to the booking Bot");
  }
  const workItemId = scoped ? turn?.work_item_id ?? null : null;
  const dedupeKey = scoped
    ? `${input.cause}:${workItemId ? `work:${workItemId}` : lineage?.task_id
      ? `job:${input.botId}:${lineage.task_id}:${lineage.ticket_id ?? ""}` : `desk:${input.botId}:${input.sessionId}`}`
    : `${input.botId}:${input.sessionId}`;
  let replaced = false;
  ctx.db.transaction(() => {
    // Below P4c keep the old Bot/session slot. At P4c one cause on one exact work/job replaces
    // only itself; legacy rows are narrowed by their stored lineage, not by a session-wide guess.
    const voided = ctx.db
      .query<{ id: string }, Array<string | number | null>>(
        `UPDATE check_backs SET voided_at = ?1, suspended_at = NULL
         WHERE bot_id = ?2 AND kind IS NOT 'delegation_wait' AND fired_at IS NULL AND (voided_at IS NULL OR suspended_at IS NOT NULL)
           AND ((?3 = 0 AND session_id = ?4) OR (?3 = 1 AND (dedupe_key = ?5 OR (
             (dedupe_key IS NULL OR dedupe_key = bot_id || ':' || session_id)
             AND COALESCE(cause, 'self') = ?6 AND task_id IS ?7 AND ticket_id IS ?8
             AND (?7 IS NOT NULL OR session_id = ?4)))))
         RETURNING id`,
      )
      .all(now, input.botId, scoped ? 1 : 0, input.sessionId, dedupeKey, input.cause, lineage?.task_id ?? null, lineage?.ticket_id ?? null);
    replaced = voided.length > 0;
    ctx.db.run(
      `INSERT INTO check_backs
         (id, bot_id, session_id, turn_id, task_id, ticket_id, note, due_at, created_at, fired_at, fired_turn_id, voided_at, kind, cause, dedupe_key, work_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
      [id, input.botId, input.sessionId, input.turnId, lineage?.task_id ?? null, lineage?.ticket_id ?? null, takeCodePoints(input.note, input.kind === PLAN_NUDGE ? PLAN_NUDGE_NOTE_MAX : CHECK_BACK_NOTE_MAX).text, due, now, input.kind ?? null, input.cause, dedupeKey, workItemId],
    );
    // Booked where a hold is in force, it waits for the lift like the ones the hold found.
    suspendHeldCheckBacks(ctx, now, [id]);
  })();
  return { row: getCheckBack(ctx, id), replaced };
}

/**
 * From the supervisor's level (ADR 0045) the app's own call-backs of the levels before — a plan
 * nudge, a report-back to the opener of a quiet Bot↔Bot direct — are the supervisor's to make, so
 * one still pending from before is voided instead of firing. True when it was one of those.
 */
export function voidRetiredCallBack(ctx: StoreContext, id: string, now: string = isoNow()): boolean {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.supervision) return false;
  return ctx.db.query(`UPDATE check_backs SET voided_at = ?, suspended_at = NULL
    WHERE id = ? AND fired_at IS NULL AND (kind = ? OR (kind IS NULL AND cause = 'delegation')) RETURNING id`).get(now, id, PLAN_NUDGE) !== null;
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
       WHERE fired_at IS NULL AND voided_at IS NULL AND kind IS NOT 'delegation_wait' AND due_at <= ?
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

/**
 * Gives back an appointment a live turn heard (its line, `messageId`) but ended without reading,
 * when a hold turned away the turn that would have read it: pending again, and set aside at once
 * if a hold covers it, so the lift brings it back like any other. It keeps its line, which wakes
 * the Bot again when it fires. One whose Bot has booked another in that conversation since stays
 * spent: the newer booking is the one it meant. Returns whether it was given back.
 */
export function returnUnreadCheckBack(ctx: StoreContext, messageId: string, now: string): boolean {
  const sameWait = readEngineLevel(ctx.db) >= ENGINE_LEVELS.delegation
    ? `(other.dedupe_key = check_backs.dedupe_key OR (
        (other.dedupe_key IS NULL OR other.dedupe_key = other.bot_id || ':' || other.session_id)
        AND (check_backs.dedupe_key IS NULL OR check_backs.dedupe_key = check_backs.bot_id || ':' || check_backs.session_id)
        AND other.kind IS NOT 'delegation_wait' AND check_backs.kind IS NOT 'delegation_wait'
        AND COALESCE(other.cause, 'self') = COALESCE(check_backs.cause, 'self')
        AND other.task_id IS check_backs.task_id AND other.ticket_id IS check_backs.ticket_id
        AND (check_backs.task_id IS NOT NULL OR other.session_id = check_backs.session_id)))`
    : `other.session_id = check_backs.session_id AND other.kind IS NOT 'delegation_wait'`;
  return ctx.db.transaction(() => {
    const row = ctx.db
      .query<{ id: string }, [string]>(
        `UPDATE check_backs SET fired_at = NULL, fired_turn_id = NULL
         WHERE message_id = ? AND fired_at IS NOT NULL AND voided_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM check_backs other
             WHERE other.id <> check_backs.id AND other.bot_id = check_backs.bot_id
               AND ${sameWait} AND other.fired_at IS NULL
               AND (other.voided_at IS NULL OR other.suspended_at IS NOT NULL))
         RETURNING id`,
      )
      .get(messageId);
    if (!row) return false;
    suspendHeldCheckBacks(ctx, now, [row.id]);
    return true;
  })();
}

/** Written in the transaction that inserts the line, so the commit's events already leave it out. */
export function recordCheckBackLine(ctx: StoreContext, id: string, messageId: string): void {
  ctx.db.run(`UPDATE check_backs SET message_id = ? WHERE id = ?`, [messageId, id]);
}

/**
 * A line only the Bot it wakes reads. The line a check-back wakes its Bot with is the Bot's note to
 * itself, like a reminder on a phone (`check_backs.message_id`); the note stopped work opens again
 * on once you lift the stop is the app's note to that Bot (`messages.bot_only`, ADR 0041). The woken
 * turn reads it as its trigger (a turn the Bot already has there hears it instead) and the flow
 * board draws the wake, but the conversation, other Bots' transcripts, the organizer, search,
 * unread counts, the last-message preview and the event stream leave it out. `table` is the alias
 * the query this goes into gives `messages`, when it gives one.
 */
export function notBotOnlyLine(table?: string): string {
  const prefix = table ? `${table}.` : "";
  return `${prefix}bot_only = 0 AND ${prefix}id NOT IN (SELECT cb.message_id FROM check_backs cb WHERE cb.message_id IS NOT NULL)`;
}

export function isBotOnlyLine(ctx: StoreContext, messageId: string): boolean {
  return Boolean(
    ctx.db.query(`SELECT 1 FROM messages WHERE id = ? AND bot_only = 1`).get(messageId) ??
      ctx.db.query(`SELECT 1 FROM check_backs WHERE message_id = ?`).get(messageId),
  );
}

/**
 * The text a reply repeats, so a plan call-back that only says again what this Bot already said in
 * the same session and plan can end without posting it. Markdown dressing comes off, the way a chat
 * list reads a line, and whitespace collapses: two translations that differ by a bullet or a blank
 * line are the same answer. A path, a link and a code fence stay in, so a reply that names a new
 * file is not the same answer.
 */
export function repeatKey(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/\s+/g, " "))
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1 $2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

// Compare only light prose edits. Numbers, negations and content words stay; literals must match.
function samePlanAnswer(previous: string, body: string): boolean {
  const key = repeatKey(body);
  if (repeatKey(previous) === key) return true;
  const literals = (text: string) => JSON.stringify([
    text.match(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|!?\[[^\]]*\]\([^)]*\)|https?:\/\/[^\s)]+|@[\p{L}\p{N}_-]+|\d+(?:[.:/-]\d+)*|[?？]/gu) ?? [],
    text.split(/\s+/).filter(looksLikeWorkspacePath),
  ]);
  if (literals(previous) !== literals(body)) return false;
  const proseWords = (text: string) => repeatKey(text)
    .toLowerCase()
    .replace(/\bthat runs?\s+(?=(?:longer|shorter)\b)/g, "")
    .replace(/\b(?:runs?|be)\s+(?=(?:longer|shorter)\b)/g, "")
    .match(/[\p{L}\p{N}]+|[<>=+%]/gu)
    ?.filter((word) => !["a", "an", "the"].includes(word)) ?? [];
  const words = proseWords(body);
  return words.length >= 12 && JSON.stringify(proseWords(previous)) === JSON.stringify(words);
}

/**
 * Whether a turn the app's plan call-back woke is about to post a reply this Bot already posted in
 * the same session and plan. The call-back exists to move a ticket that is still open; saying the
 * same thing again moves nothing, and the conversation should not show it twice. `planNudge` is
 * what the turn was opened as: the appointment is marked fired only after the reply can go out, so
 * the row cannot say it yet. A reply with nothing left once the dressing comes off says nothing, so
 * it is not a repeat. The turn's own messages, and the line that woke it, do not count.
 */
export function repeatsPlanAnswer(
  ctx: StoreContext,
  input: { turnId: string; sessionId: string; author: string; body: string; planNudge: boolean },
): boolean {
  if (!input.planNudge) return false;
  const key = repeatKey(input.body);
  if (!key) return false;
  const turn = ctx.db
    .query<{ task_id: string | null; trigger_message_id: string }, [string]>(
      `SELECT task_id, trigger_message_id FROM turns WHERE id = ?`,
    )
    .get(input.turnId);
  if (!turn?.task_id) return false;
  const rows = ctx.db
    .query<{ body: string }, [string, string, string, string, string]>(
      `SELECT body FROM messages
       WHERE session_id = ? AND author = ? AND kind = 'bot' AND task_id = ?
         AND (turn_id IS NULL OR turn_id != ?) AND id != ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 40`,
    )
    .all(input.sessionId, input.author, turn.task_id, input.turnId, turn.trigger_message_id);
  return rows.some((row) => samePlanAnswer(row.body, input.body));
}

/** What a quiet Bot↔Bot direct would report back with, read when its quiet clock runs out. */
export type QuietDirect = {
  /** Where the direct came from, which is where its opener reports. */
  originSessionId: string;
  /** The Bot that opened it: the author of its first message. */
  openerId: string;
  peerId: string;
  /** The newest line in the direct since its last report-back, or since it opened. Null: nothing new. */
  latest: { author: string; body: string } | null;
  /** The peer said something in that stretch — a reply, or the line its failed turn left. */
  peerSpoke: boolean;
  /** The turn that opened the direct was itself woken by a report-back. */
  openedFromReportBack: boolean;
};

/**
 * Null unless this is a live Bot↔Bot direct that came from a session still there, whose opener
 * is still in it. A report-back is recognised by hanging on a turn from another session.
 */
export function quietDirect(ctx: StoreContext, directId: string): QuietDirect | null {
  const direct = ctx.db
    .query<{ kind: string; origin_session_id: string | null; origin_message_id: string | null; archived_at: string | null }, [string]>(
      `SELECT kind, origin_session_id, origin_message_id, archived_at FROM sessions WHERE id = ?`,
    )
    .get(directId);
  if (!direct || direct.kind !== "direct" || !direct.origin_session_id || direct.archived_at) return null;
  if (isPresent(ctx, directId, USER_MEMBER)) return null;
  const origin = ctx.db
    .query<{ archived_at: string | null }, [string]>(`SELECT archived_at FROM sessions WHERE id = ?`)
    .get(direct.origin_session_id);
  if (!origin || origin.archived_at) return null;
  const opener = ctx.db
    .query<{ author: string }, [string]>(
      `SELECT author FROM messages WHERE session_id = ? AND kind = 'bot' ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
    .get(directId)?.author;
  if (!opener || !isPresent(ctx, direct.origin_session_id, opener)) return null;
  const peerId = ctx.db
    .query<{ member: string }, [string, string]>(
      `SELECT member FROM session_participants WHERE session_id = ? AND member != ? AND left_at IS NULL LIMIT 1`,
    )
    .get(directId, opener)?.member;
  if (!peerId) return null;
  const since =
    ctx.db
      .query<{ created_at: string }, [string, string, string]>(
        `SELECT cb.created_at FROM check_backs cb JOIN turns t ON t.id = cb.turn_id
         WHERE cb.bot_id = ? AND cb.session_id = ? AND t.session_id = ?
         ORDER BY cb.created_at DESC LIMIT 1`,
      )
      .get(opener, direct.origin_session_id, directId)?.created_at ?? "";
  const fresh = `session_id = ? AND kind IN ('bot', 'system') AND created_at > ? AND ${notBotOnlyLine()}`;
  const latest =
    ctx.db
      .query<{ author: string; body: string }, [string, string]>(
        `SELECT author, body FROM messages WHERE ${fresh} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(directId, since) ?? null;
  const peerSpoke = Boolean(
    ctx.db.query(`SELECT 1 FROM messages WHERE ${fresh} AND author = ? LIMIT 1`).get(directId, since, peerId),
  );
  const openedFromReportBack = direct.origin_message_id
    ? Boolean(
        ctx.db
          .query(
            `SELECT 1 FROM check_backs cb JOIN turns t ON t.id = cb.turn_id
             WHERE cb.message_id = ? AND t.session_id != cb.session_id`,
          )
          .get(direct.origin_message_id),
      )
    : false;
  return { originSessionId: direct.origin_session_id, openerId: opener, peerId, latest, peerSpoke, openedFromReportBack };
}

/**
 * Cancels pending appointments: the turn that made them was stopped, the session they were for is
 * cleared or gone, or the Bot is. One a hold set aside is cancelled for good too, so lifting the
 * hold does not bring it back. Returns how many were still pending or set aside.
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
      `UPDATE check_backs SET voided_at = ?, suspended_at = NULL
       WHERE fired_at IS NULL AND (voided_at IS NULL OR suspended_at IS NOT NULL) AND ${conditions.join(" AND ")}
       RETURNING id`,
    )
    .all(...params).length;
}
