import {
  INTERRUPT_NOTE_BODY,
  USER_MEMBER,
  isContinuableNote,
  isInterruptNote,
  type Message,
  type RouteOutcome,
  type Turn,
  type TurnMode,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { isHeldAbort } from "./holds";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import { findOrCreateWorkItem, markSegmentCutOff, queuePlace, queueWork, settleRunningWork } from "./work-items";
import { lineCandidates } from "./filing";
import { releaseEndedInbox } from "./inbox";
import { getMessage } from "./messages";
import {
  createNotification,
  updateNotificationActionState,
} from "./notifications";
import { finishTurnRoute, type TurnExecution } from "./routing";
import { isPresent } from "./sessions";
import { annotationTaskOfMessage } from "./annotations";
import { voidCheckBacks } from "./check-backs";
import { findTurnTask, resolveTurnTask } from "./tasks";
import {
  aliveBot,
  isLive,
  messageRow,
  sessionRow,
  setSetting,
  toTurn,
  touchSession,
  type SettingRow,
  type StoreContext,
  type TurnRow,
} from "./shared";

export function createTurn(
  ctx: StoreContext,
  input: {
    sessionId: string;
    botId: string;
    triggerMessageId: string;
    routineId?: string | null;
    routineDueAt?: string | null;
    /**
     * The plan this turn continues, named outright: a check-back wakes the Bot into the plan it
     * made the appointment in, a routine fires into its standing plan.
     */
    taskId?: string | null;
    /** The ticket it works in, when the caller knows; otherwise inherited from the trigger. */
    ticketId?: string | null;
    /** What it may do; a working turn unless said otherwise (see `turns.mode`). */
    mode?: TurnMode;
  },
): Turn {
  sessionRow(ctx, input.sessionId);
  aliveBot(ctx, input.botId);
  const trigger = messageRow(ctx, input.triggerMessageId);
  const now = isoNow();
  const id = ulid();
  // Where it lands and the row itself go in together: a hold that refuses the row (I2) takes back
  // a plan the landing opened for it, too. A read-only turn lands on no plan and files nothing: it
  // answers you, it does not work on the job, and binding it to one later is refused (I2).
  const readOnly = input.mode === "readonly";
  ctx.db.transaction(() => {
    // No plan is opened in silence once work items are on (ADR 0040 P4b): a line the rows cannot
    // place stays unfiled, and the turn works without one until work_on or a later line places it.
    const landing = landingInput(ctx, { ...input, trigger });
    const workItems = readEngineLevel(ctx.db) >= ENGINE_LEVELS.work_items;
    // In the deterministic engine neither the current slot nor the waker's ticket decides work.
    const explicitTask = landing.taskId ?? trigger.task_id ?? null;
    const explicitTicket = landing.ticketId ?? trigger.ticket_id ?? null;
    const { taskId, ticketId, handedTicketId } = readOnly
      ? { taskId: null, ticketId: null, handedTicketId: null }
      : workItems
        ? { taskId: explicitTask, ticketId: explicitTicket, handedTicketId: explicitTicket }
        : resolveTurnTask(ctx, landing);
    const mode = readOnly ? "readonly" : workItems && !taskId ? "desk" : input.mode ?? "work";
    try {
      // Work items bind a turn once the engine level has them (ADR 0040 P4b). Below it a turn is
      // what it was: the one-live indexes only look at rows that carry one.
      const workItemId = readEngineLevel(ctx.db) >= ENGINE_LEVELS.work_items && !readOnly
        ? findOrCreateWorkItem(ctx, { botId: input.botId, sessionId: input.sessionId, taskId, ticketId }).id
        : null;
      ctx.db.run(
        `INSERT INTO turns
          (id, session_id, bot_id, status, trigger_message_id, task_id, ticket_id, routine_id, routine_due_at, last_activity_at, created_at, updated_at, mode, work_item_id)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.sessionId,
          input.botId,
          input.triggerMessageId,
          taskId,
          ticketId,
          input.routineId ?? null,
          input.routineDueAt ?? null,
          now,
          now,
          now,
          mode,
          workItemId,
        ],
      );
    } catch (error) {
      throw heldError(error);
    }
    // Capture once at admission: a later plan must not silently become a desk turn's candidate.
    // The jobs of the lines just before the trigger are among them (ADR 0057), as they were for
    // the reading of where the line belongs: what the reading could not place, the Bot can.
    if (readEngineLevel(ctx.db) >= ENGINE_LEVELS.work_items && !readOnly) {
      const candidates = lineCandidates(ctx, { sessionId: input.sessionId, botId: input.botId, messageId: input.triggerMessageId }).map((plan) => plan.id);
      if (taskId && !candidates.includes(taskId)) candidates.unshift(taskId);
      ctx.db.run(`UPDATE turns SET filing_candidates = ? WHERE id = ?`, [JSON.stringify(candidates), id]);
    }
    // The trigger belongs to the plan it opened, so the user's own message carries the anchor too —
    // with the ticket it came with, not the one this Bot happens to be on: one line can wake a team.
    if (readOnly) return;
    ctx.db.run(
      `UPDATE messages SET task_id = COALESCE(task_id, ?), ticket_id = COALESCE(ticket_id, ?) WHERE id = ?`,
      [taskId, handedTicketId, trigger.id],
    );
  })();
  return getTurn(ctx, id);
}

/**
 * The plan and ticket a turn opened on this trigger would land in, read without changing anything
 * — what a wake is about before anything opens, so the holds can be asked first. A null plan: the
 * turn would open a new one.
 */
export function turnLanding(
  ctx: StoreContext,
  input: { sessionId: string; botId: string; trigger: Message; taskId?: string | null; ticketId?: string | null },
): { taskId: string | null; ticketId: string | null } {
  const landing = landingInput(ctx, input);
  if (readEngineLevel(ctx.db) >= ENGINE_LEVELS.work_items) {
    return { taskId: landing.taskId ?? input.trigger.task_id ?? null, ticketId: landing.ticketId ?? input.trigger.ticket_id ?? null };
  }
  const { taskId, ticketId } = findTurnTask(ctx, landing);
  return { taskId, ticketId };
}

function landingInput(
  ctx: StoreContext,
  input: { sessionId: string; botId: string; trigger: Parameters<typeof resolveTurnTask>[1]["trigger"] & { id: string }; taskId?: string | null; ticketId?: string | null },
): Parameters<typeof resolveTurnTask>[1] {
  // A batch of annotations continues the plan and ticket that delivered this Bot's artifact.
  const annotated = input.taskId ? null : annotationTaskOfMessage(ctx, input.trigger.id, input.botId);
  return {
    sessionId: input.sessionId,
    botId: input.botId,
    trigger: input.trigger,
    taskId: input.taskId ?? annotated?.taskId ?? null,
    ticketId: input.ticketId ?? annotated?.ticketId ?? null,
  };
}

/** The database refusing a turn a hold covers (I2), as the API says it; anything else as it came. */
function heldError(error: unknown): unknown {
  if (!isHeldAbort(error)) return error;
  return new HttpError(409, "held", "a stop of yours covers this: nothing opens here until you lift it");
}

export function getTurn(ctx: StoreContext, id: string): Turn {
  const row = ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "turn not found");
  return toTurn(row);
}

export function listLiveTurns(
  ctx: StoreContext,
  filter: { sessionId?: string; botId?: string } = {},
): Turn[] {
  let sql = `SELECT * FROM turns WHERE status IN ('running', 'waiting_approval', 'waiting_ask')`;
  const args: string[] = [];
  if (filter.sessionId) {
    sql += ` AND session_id = ?`;
    args.push(filter.sessionId);
  }
  if (filter.botId) {
    sql += ` AND bot_id = ?`;
    args.push(filter.botId);
  }
  sql += ` ORDER BY last_activity_at DESC, id DESC`;
  return ctx.db.query<TurnRow, string[]>(sql).all(...args).map((row) => toTurn(row));
}

export function setTurnStatus(
  ctx: StoreContext,
  id: string,
  status: Turn["status"],
  execution: TurnExecution | null = null,
): Turn {
  const row = ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "turn not found");
  const now = isoNow();
  ctx.db.run(
    `UPDATE turns SET status = ?, end_reason = CASE WHEN ? IN ('completed','stopped','interrupted','redirected')
      THEN COALESCE(NULLIF(TRIM(end_reason), ''), ?) ELSE end_reason END, last_activity_at = ?, updated_at = ? WHERE id = ?`,
    [status, status, status, now, now, id],
  );
  const outcome = outcomeFor(status);
  if (outcome) finishTurnRoute(ctx, id, outcome, null, execution);
  return getTurn(ctx, id);
}

/** Terminal turn statuses map one-to-one onto route outcomes; live statuses close nothing. */
function outcomeFor(status: Turn["status"]): RouteOutcome | null {
  switch (status) {
    case "completed":
    case "redirected":
    case "interrupted":
    case "stopped":
      return status;
    default:
      return null;
  }
}

export function setTurnPartial(ctx: StoreContext, id: string, partial: string | null): void {
  ctx.db.run("UPDATE turns SET partial_text = ? WHERE id = ? AND status IN ('running', 'waiting_approval', 'waiting_ask') AND partial_text IS NOT ?", [partial, id, partial]);
}

export function voidPendingTurnActions(
  ctx: StoreContext,
  turnId: string,
  reason: string,
  now: string = isoNow(),
): void {
  const pendingApps = ctx.db
    .query<{ id: string }, [string]>("SELECT id FROM approvals WHERE turn_id = ? AND status = 'pending'")
    .all(turnId);
  for (const app of pendingApps) {
    updateNotificationActionState(ctx, `approval:${app.id}`, "voided", reason);
  }
  ctx.db.run(
    "UPDATE approvals SET status = 'voided', resolved_at = ? WHERE turn_id = ? AND status = 'pending'",
    [now, turnId],
  );

  const turn = ctx.db
    .query<{ pending_ask_id: string | null }, [string]>("SELECT pending_ask_id FROM turns WHERE id = ?")
    .get(turnId);
  if (turn?.pending_ask_id) {
    updateNotificationActionState(ctx, `ask:${turn.pending_ask_id}`, "voided", reason);
    ctx.db.run("UPDATE turns SET pending_ask_id = NULL WHERE id = ?", [turnId]);
  }
}

export function touchTurn(ctx: StoreContext, id: string): Turn {
  const now = isoNow();
  ctx.db.run(`UPDATE turns SET last_activity_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
  return getTurn(ctx, id);
}

export function redirectTurn(ctx: StoreContext, id: string, execution: TurnExecution | null = null): Turn {
  const row = ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "turn not found");
  if (!isLive(row.status)) return toTurn(row);
  const now = isoNow();
  ctx.db.transaction(() => {
    voidPendingTurnActions(ctx, id, "redirected", now);
    ctx.db.run(
      `UPDATE turns SET status = 'redirected', end_reason = 'redirected', last_activity_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
    finishTurnRoute(ctx, id, "redirected", null, execution);
  })();
  return getTurn(ctx, id);
}

export function pendingInterrupt(ctx: StoreContext, botId: string): boolean {
  return pendingInterruptSet(ctx).has(botId);
}

export function markInterruptPending(ctx: StoreContext, botId: string): void {
  const set = pendingInterruptSet(ctx);
  set.add(botId);
  writePendingInterrupts(ctx, set);
}

export function clearInterruptPending(ctx: StoreContext, botId: string): void {
  const set = pendingInterruptSet(ctx);
  if (!set.delete(botId)) return;
  writePendingInterrupts(ctx, set);
}

/**
 * Boot recovery: every turn the last run left live is interrupted. `previousRun` is that run's id
 * (`Store.previousBootId`), under which what it left live is remembered as cut off by its end.
 */
export function recoverInterruptedTurns(ctx: StoreContext, previousRun: string | null = null): void {
  // What a crash or a restart in place left live was cut off by it, the same as what a quit ends.
  noteTurnsCutByShutdown(ctx, previousRun);
  interruptRunningTurns(ctx);
  // Those turns read lines and never answered for them; with the turns over, the lines are unacked.
  releaseEndedInbox(ctx);
  // What they ran is not running any more (ADR 0040 §2.6).
  settleRunningWork(ctx);
}

/**
 * Settings key: the turns a shutdown found live, kept for the next boot to say where each job
 * stopped (ADR 0041), as `{run, at, turns}`: the id of the run whose end cut them off, when that
 * was first noted, and the turn ids. Taken, and so emptied, once at boot.
 */
const CUT_BY_SHUTDOWN_KEY = "_cut_by_shutdown";
/** Settings key: the id of the run that last opened the database (`Store.bootId`). */
const LAST_RUN_KEY = "_last_run";

type CutRecord = { run: string | null; at: string; turns: string[] };

/**
 * At open: the id of the run that opened the database before this one, replaced by `run`'s own.
 * Null on a database no run of this build has opened yet.
 */
export function swapLastRun(ctx: StoreContext, run: string): string | null {
  const previous = ctx.db.query<SettingRow, [string]>(`SELECT key, value FROM settings WHERE key = ?`).get(LAST_RUN_KEY)?.value ?? null;
  setSetting(ctx, LAST_RUN_KEY, run);
  return previous;
}

function readCutRecord(ctx: StoreContext): CutRecord | null {
  const raw = ctx.db.query<SettingRow, [string]>(`SELECT key, value FROM settings WHERE key = ?`).get(CUT_BY_SHUTDOWN_KEY)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CutRecord> | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.at !== "string" || !Array.isArray(parsed.turns)) return null;
    if (parsed.run !== null && typeof parsed.run !== "string") return null;
    return { run: parsed.run, at: parsed.at, turns: parsed.turns.filter((id): id is string => typeof id === "string") };
  } catch {
    return null;
  }
}

/**
 * Whether a record still tells of `run`'s end: written for that run, with no turn started since.
 * A record another run left — one that opened the database and ended before taking it — is not
 * this boot's to tell of. An installed copy too old to know the record never writes its run id, so
 * the turns it started meanwhile are how its run shows.
 */
function cutRecordIsOf(ctx: StoreContext, record: CutRecord, run: string | null): boolean {
  if (record.run !== run) return false;
  return !ctx.db.query(`SELECT 1 FROM turns WHERE created_at > ? LIMIT 1`).get(record.at);
}

/**
 * Remembers every live turn as cut off by the end of `run` now under way. Called where the daemon
 * starts ending every turn at once — the engine's `abortAll` and `close`, and boot recovery for
 * what a crash or a restart in place left live — before any of them ends: a turn that has ended
 * is not live to be found. A turn a stuck-turn sweep ends mid-run is not a restart's, so this is
 * not written where a single turn is interrupted. Adds to a record of the same run's end (a drain,
 * then the close); one left by any other run is replaced.
 */
export function noteTurnsCutByShutdown(ctx: StoreContext, run: string | null): void {
  const live = ctx.db
    .query<{ id: string }, []>(`SELECT id FROM turns WHERE status IN ('running', 'waiting_approval', 'waiting_ask')`)
    .all();
  if (live.length === 0) return;
  const kept = readCutRecord(ctx);
  const carried = kept && cutRecordIsOf(ctx, kept, run) ? kept : null;
  const cut = new Set(carried?.turns ?? []);
  for (const row of live) cut.add(row.id);
  const record: CutRecord = { run, at: carried?.at ?? isoNow(), turns: [...cut] };
  setSetting(ctx, CUT_BY_SHUTDOWN_KEY, JSON.stringify(record));
}

/** A drain you called off ended its turns without a restart to account for, so they are forgotten. */
export function forgetTurnsCutByShutdown(ctx: StoreContext): void {
  ctx.db.run(`DELETE FROM settings WHERE key = ?`, [CUT_BY_SHUTDOWN_KEY]);
}

/**
 * What the end of `previousRun` (the run this boot follows) cut off, taken once at boot after
 * recovery: each turn it remembered that is still interrupted, with the 「中断」 line its Continue
 * goes from, not yet continued. A turn that finished, was stopped or was continued since is not
 * cut off any more. A record of some other run's end is stale (see `cutRecordIsOf`): announced now
 * it would tell of an old shutdown under this restart's cause, so nothing is taken from it, and its
 * turns keep their own 「中断」 lines and notifications. Empties the record either way.
 */
export function takeTurnsCutByRestart(ctx: StoreContext, previousRun: string | null): Array<{ turn: Turn; note: Message }> {
  const record = readCutRecord(ctx);
  forgetTurnsCutByShutdown(ctx);
  if (!record || !cutRecordIsOf(ctx, record, previousRun)) return [];
  const cut: Array<{ turn: Turn; note: Message }> = [];
  for (const id of record.turns) {
    const row = ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id);
    if (!row || row.status !== "interrupted") continue;
    const note = ctx.db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM messages WHERE turn_id = ? AND kind = 'system' AND body = ? AND source_turn_id IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(id, INTERRUPT_NOTE_BODY);
    if (note) cut.push({ turn: toTurn(row), note: getMessage(ctx, note.id) });
  }
  return cut;
}

export function stopTurn(
  ctx: StoreContext,
  turnId?: string,
  opts: {
    allowGroup?: boolean;
    execution?: TurnExecution | null;
    /**
     * A hold of yours ended it: the appointments it made are set aside by that hold, to come back
     * when it is lifted, rather than cancelled (ADR 0040).
     */
    keepCheckBacks?: boolean;
  } = {},
): Turn | null {
  const id = turnId ?? latestStoppableTurn(ctx, opts);
  const row = id ? ctx.db.query<TurnRow, [string]>(`SELECT * FROM turns WHERE id = ?`).get(id) : null;
  if (!row) {
    if (turnId) throw new HttpError(404, "not_found", "turn not found");
    return null;
  }
  if (!isLive(row.status)) {
    throw new HttpError(422, "invalid_args", "turn is not in progress");
  }
  if (!opts.allowGroup) {
    const session = ctx.db
      .query<{ kind: string }, [string]>(`SELECT kind FROM sessions WHERE id = ?`)
      .get(row.session_id);
    if (session?.kind === "group") {
      throw new HttpError(422, "invalid_args", "group turns cannot be stopped");
    }
  }
  const now = isoNow();
  ctx.db.transaction(() => {
    voidPendingTurnActions(ctx, row.id, "stopped", now);
    // Stop means "not this"; an appointment this turn made to come back would undo it later.
    if (!opts.keepCheckBacks) voidCheckBacks(ctx, { turnId: row.id }, now);
    ctx.db.run(`UPDATE turns SET status = 'stopped', end_reason = 'stopped', updated_at = ? WHERE id = ?`, [now, row.id]);
    finishTurnRoute(ctx, row.id, "stopped", null, opts.execution ?? null);
  })();
  return { ...getTurn(ctx, row.id), partial_text: null };
}

/**
 * The turn a Stop with no turn named ends: the live one that did something last, in a direct unless
 * `allowGroup`. Null when there is none.
 */
export function latestStoppableTurn(ctx: StoreContext, opts: { allowGroup?: boolean } = {}): string | null {
  return (
    ctx.db
      .query<{ id: string }, []>(
        opts.allowGroup
          ? `SELECT id FROM turns
             WHERE status IN ('running', 'waiting_approval', 'waiting_ask')
             ORDER BY last_activity_at DESC LIMIT 1`
          : `SELECT t.id FROM turns t
             JOIN sessions s ON s.id = t.session_id
             WHERE t.status IN ('running', 'waiting_approval', 'waiting_ask')
               AND s.kind = 'direct'
             ORDER BY t.last_activity_at DESC LIMIT 1`,
      )
      .get()?.id ?? null
  );
}

export function interruptTurnRecord(
  ctx: StoreContext,
  turnId: string,
  execution: TurnExecution | null = null,
): { note: Message; turn: Turn } | null {
  const row = ctx.db.query<TurnRow, [string]>("SELECT * FROM turns WHERE id = ?").get(turnId);
  if (!row || !isLive(row.status)) return null;

  const now = isoNow();
  let note!: Message;
  let turn!: Turn;

  ctx.db.transaction(() => {
    voidPendingTurnActions(ctx, turnId, "interrupted", now);
    ctx.db.run(
      `UPDATE turns SET status = 'interrupted', end_reason = 'interrupted', updated_at = ? WHERE id = ?`,
      [now, turnId],
    );

    const noteId = ulid();
    ctx.db.run(
      `INSERT INTO messages (id, session_id, turn_id, parent_id, kind, author, body, source_turn_id, task_id, ticket_id, created_at)
       VALUES (?, ?, ?, NULL, 'system', ?, ?, NULL, ?, ?, ?)`,
      [noteId, row.session_id, row.id, row.bot_id, INTERRUPT_NOTE_BODY, row.task_id, row.ticket_id ?? null, now],
    );
    note = getMessage(ctx, noteId);

    markInterruptPending(ctx, row.bot_id);
    finishTurnRoute(ctx, row.id, "interrupted", null, execution);
    markSegmentCutOff(ctx, row.id, "interrupted");

    if (isPresent(ctx, row.session_id, USER_MEMBER)) {
      createNotification(ctx, {
        semantic_key: `interrupted:${row.id}`,
        kind: "interrupted",
        session_id: row.session_id,
        turn_id: row.id,
        message_id: noteId,
        created_at: now,
        action_state: "open",
      });
    }

    turn = getTurn(ctx, turnId);
  })();

  return { note, turn };
}

export function interruptRunningTurns(
  ctx: StoreContext,
  executionFor: (turnId: string) => TurnExecution | null = () => null,
): void {
  const live = ctx.db
    .query<TurnRow, []>(
      `SELECT * FROM turns WHERE status IN ('running', 'waiting_approval', 'waiting_ask')`,
    )
    .all();
  for (const turn of live) {
    interruptTurnRecord(ctx, turn.id, executionFor(turn.id));
  }
}

export function claimInterruptContinue(ctx: StoreContext, messageId: string): Turn {
  const note = getMessage(ctx, messageId);
  const isInterrupt = isInterruptNote(note);
  if (!isContinuableNote(note) || !note.turn_id) {
    throw new HttpError(422, "invalid_args", "message is not an interrupted turn");
  }
  if (note.source_turn_id) {
    throw new HttpError(422, "invalid_args", "interrupted turn already continued");
  }
  const cut = getTurn(ctx, note.turn_id);
  if (isInterrupt && cut.status !== "interrupted") {
    throw new HttpError(422, "invalid_args", "turn is not interrupted");
  }
  if (!isInterrupt && cut.status !== "completed" && cut.status !== "interrupted") {
    throw new HttpError(422, "invalid_args", "turn is not continuable");
  }
  if (cut.bot_id !== note.author) {
    throw new HttpError(422, "invalid_args", "turn author mismatch");
  }
  const session = sessionRow(ctx, note.session_id);
  if (session.archived_at) {
    throw new HttpError(422, "invalid_args", "session is archived");
  }
  const bot = aliveBot(ctx, cut.bot_id);
  if (bot.archived_at) {
    throw new HttpError(422, "invalid_args", "bot is archived");
  }
  if (!isPresent(ctx, note.session_id, cut.bot_id)) {
    throw new HttpError(422, "invalid_args", "bot is not in this session");
  }
  const deterministic = readEngineLevel(ctx.db) >= ENGINE_LEVELS.work_items;
  // Below the work items' level a Bot runs one turn per conversation. From it, one live segment
  // per Bot per job (I1b) and the parallel limit's queue decide, below: continuing one job while
  // the Bot works on another in the same conversation is two jobs, not a second turn on one.
  if (!deterministic && listLiveTurns(ctx, { sessionId: note.session_id, botId: cut.bot_id }).length > 0) {
    throw new HttpError(422, "invalid_args", "bot already has a live turn");
  }
  const now = isoNow();
  const id = ulid();
  ctx.db.transaction(() => {
    const lineage = ctx.db
      .query<{ task_id: string | null; ticket_id: string | null; work_item_id: string | null; mode: TurnMode | null; filing_candidates: string | null; work_dir_changes: number }, [string]>(
        `SELECT task_id, ticket_id, work_item_id, mode, filing_candidates, work_dir_changes FROM turns WHERE id = ?`,
      )
      .get(cut.id);
    const live = deterministic ? listLiveTurns(ctx, { botId: cut.bot_id }).filter((turn) => turn.mode !== "readonly") : [];
    if (lineage?.task_id ? live.some((turn) => turn.task_id === lineage.task_id)
      : live.some((turn) => turn.mode === "desk" && turn.session_id === note.session_id)) {
      throw new HttpError(409, "already_working", "this Bot already has a live segment on this job");
    }
    const queues = deterministic && lineage?.mode !== "desk" && lineage?.mode !== "readonly"
      && queuePlace(ctx, { botId: cut.bot_id, taskId: lineage?.task_id ?? null }) !== null;
    const workItem = deterministic && lineage?.mode !== "readonly"
      ? findOrCreateWorkItem(ctx, { botId: cut.bot_id, sessionId: note.session_id, taskId: lineage?.task_id ?? null, ticketId: lineage?.ticket_id ?? null })
      : null;
    try {
      ctx.db.run(
        `INSERT INTO turns
          (id, session_id, bot_id, status, trigger_message_id, task_id, ticket_id, last_activity_at, created_at, updated_at,
            mode, work_item_id, filing_candidates, work_dir_changes, end_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, note.session_id, cut.bot_id, queues ? "completed" : "running", note.id, lineage?.task_id ?? null, lineage?.ticket_id ?? null, now, now, now,
          lineage?.mode ?? "work", workItem?.id ?? null, lineage?.filing_candidates ?? null, lineage?.work_dir_changes ?? 0, queues ? "queued" : null],
      );
    } catch (error) {
      throw heldError(error);
    }
    if (queues) queueWork(ctx, { botId: cut.bot_id, sessionId: note.session_id, taskId: lineage?.task_id ?? null,
      ticketId: lineage?.ticket_id ?? null, messageId: note.id, author: note.author, body: note.body, source: "system", kind: "wake", priority: 1 });
    const updated = ctx.db.query<{ id: string }, [string, string]>(
      `UPDATE messages SET source_turn_id = ? WHERE id = ? AND source_turn_id IS NULL RETURNING id`,
    ).get(id, note.id);
    if (!updated) {
      throw new HttpError(422, "invalid_args", "interrupted turn already continued");
    }
    updateNotificationActionState(
      ctx,
      `interrupted:${cut.id}`,
      "resolved",
      "continued",
      true,
    );
    updateNotificationActionState(
      ctx,
      `failure:${cut.id}`,
      "resolved",
      "continued",
      true,
    );
  })();
  markInterruptPending(ctx, cut.bot_id);
  touchSession(ctx, note.session_id, now);
  return getTurn(ctx, id);
}

export function pendingInterruptSet(ctx: StoreContext): Set<string> {
  const raw = ctx.db
    .query<SettingRow, [string]>(`SELECT key, value FROM settings WHERE key = ?`)
    .get("_pending_interrupt_bots");
  if (!raw?.value) return new Set();
  try {
    const parsed = JSON.parse(raw.value) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function writePendingInterrupts(ctx: StoreContext, set: Set<string>): void {
  setSetting(ctx, "_pending_interrupt_bots", JSON.stringify([...set]));
}
