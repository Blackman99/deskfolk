/**
 * Holds (叫停): your stop, written down as state instead of a plan status a model can flip back
 * (ADR 0040, I2 and I7).
 *
 * A hold covers a scope — everything, one Bot, one conversation, one plan, one ticket, one Bot in
 * one plan, or one turn — plus the targets it was given when it was made (the work a Bot handed
 * on). Nothing it covers starts or wakes until you lift it, and nothing but a lift of yours does:
 * `liftHold` takes no caller but you, and a hold is never deleted. `held_scopes` (schema.ts) is
 * the one answer to "is this held?"; {@link heldSql} phrases the question against it once, so the
 * store asks it here and anything else that has to — a trigger, say — asks it the same way.
 *
 * What a hold changes in the store it changes in the same transaction that makes it, so that a
 * build that predates holds still reads the database right, and the confirmation you get lists
 * what actually happened (`effect`):
 * - A plan a hold on the plan or on its conversation covers reads as parked, in the status column
 *   and in its spec both — the board sends the spec's status back with every edit and the
 *   organizer builds on it, so either copy left at in progress would put the plan back. That
 *   includes a plan a newer one had moved aside, which reads parked in the column already but in
 *   progress in its spec; lifting puts it back to just that. Whatever later asks to put a held
 *   plan back in progress (the organizer, a resume) leaves it parked and only notes that lifting
 *   the hold should. A hold on a Bot, a ticket or a turn leaves plan status alone, since the rest
 *   of the plan goes on; so does one on everything, which would otherwise rewrite every plan there
 *   is — a plan's `held_by` names it instead. Parking a plan's spec and putting it back are each a
 *   version of the spec (`cause` hold, not yours), so a board still showing the one before has its
 *   edit refused instead of sending back the status the hold just changed.
 * - A pending check-back it covers is set aside: `suspended_at`, with `voided_at` beside it so an
 *   older build reads it as cancelled. Lifting the last hold over it brings it back.
 * - An inbox item waiting for the Bot's next turn that it covers is held (store/inbox.ts); lifting
 *   the last hold over it puts it back in line, for the next turn of that Bot there to read.
 */
import type { Hold, HoldEffect, HoldScope, HoldTarget, PlanStatus } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { refreshHeldInbox } from "./inbox";
import { parsePlanSpec } from "./plan-shape";
import { recordSpecRevision } from "./plan-spec";
import { ENGINE_LEVELS, readEngineLevel } from "./schema-gate";
import type { StoreContext } from "./shared";

export const HOLD_SCOPES: readonly HoldScope[] = ["global", "bot", "session", "plan", "ticket", "bot_plan", "turn"];
/** More targets than a Bot could have handed work on to is a caller's mistake, not a stop. */
export const HOLD_TARGETS_MAX = 200;

type HoldRow = {
  id: string;
  scope: HoldScope;
  scope_id: string | null;
  action: Hold["action"];
  cascade: number;
  source: Hold["source"];
  source_message_id: string | null;
  lift_on_next_user_message: number;
  targets: string;
  effect: string;
  created_at: string;
  lifted_at: string | null;
  lifted_by: Hold["lifted_by"];
  lifted_message_id: string | null;
  plan_title?: string | null;
};

/**
 * A hold row as clients read it: its columns, and the title of the plan it names, so a list of
 * your stops can say which job without reading the plan.
 */
const HOLD_COLUMNS = `h.*, (SELECT title FROM tasks WHERE id = CASE h.scope
    WHEN 'plan' THEN h.scope_id
    WHEN 'bot_plan' THEN substr(h.scope_id, instr(h.scope_id, ':') + 1)
    WHEN 'ticket' THEN (SELECT task_id FROM tickets WHERE id = h.scope_id)
  END) AS plan_title`;

type ParkedPlan = NonNullable<HoldEffect["parked_plans"]>[number];

function toHold(row: HoldRow): Hold {
  return {
    ...row,
    plan_title: row.plan_title ?? null,
    cascade: row.cascade === 1,
    lift_on_next_user_message: row.lift_on_next_user_message === 1,
    targets: JSON.parse(row.targets) as HoldTarget[],
    effect: JSON.parse(row.effect) as HoldEffect,
  };
}

/** `bot_plan`'s scope id: one Bot's work in one plan. */
export function botPlanScopeId(botId: string, taskId: string): string {
  return `${botId}:${taskId}`;
}

/**
 * What a turn, a wake or a row is about, each as an SQL expression: a column of the row being
 * checked (`NEW.bot_id`), or a named parameter (`$bot`). `turn` is the turn it goes back to — the
 * one that booked a check-back, or wrote the line that wakes a Bot.
 */
export type HeldSubject = { bot: string; session: string; task: string; ticket: string; turn: string };

/**
 * Whether a `held_scopes` row (aliased `alias`) covers the subject. A hold on a conversation also
 * covers every plan that belongs to it, wherever its work goes on — a Bot↔Bot direct on a group's
 * plan is still the group's. The plan's own row is looked up under an alias of its own, so a
 * subject of `tasks.id` (a statement over the tasks table) names the outer row, not the lookup's.
 */
export function heldBy(subject: HeldSubject, alias = "hs"): string {
  return `(${alias}.scope = 'global'
    OR (${alias}.scope = 'bot' AND ${alias}.scope_id = ${subject.bot})
    OR (${alias}.scope = 'session' AND (${alias}.scope_id = ${subject.session}
        OR ${alias}.scope_id = ${planSession(subject.task)}))
    OR (${alias}.scope = 'plan' AND ${alias}.scope_id = ${subject.task})
    OR (${alias}.scope = 'ticket' AND ${alias}.scope_id = ${subject.ticket})
    OR (${alias}.scope = 'bot_plan' AND ${alias}.scope_id = ${subject.bot} || ':' || ${subject.task})
    OR (${alias}.scope = 'turn' AND ${alias}.scope_id = ${subject.turn}))`;
}

/** `EXISTS` form of {@link heldBy}: true while any hold in force covers the subject. */
export function heldSql(subject: HeldSubject): string {
  return `EXISTS (SELECT 1 FROM held_scopes hs WHERE ${heldBy(subject)})`;
}

const PARAMS: HeldSubject = { bot: "$bot", session: "$session", task: "$task", ticket: "$ticket", turn: "$turn" };
const CHECK_BACK: HeldSubject = {
  bot: "check_backs.bot_id",
  session: "check_backs.session_id",
  task: "check_backs.task_id",
  ticket: "check_backs.ticket_id",
  turn: "check_backs.turn_id",
};

export function getHold(ctx: StoreContext, id: string): Hold {
  const row = ctx.db.query<HoldRow, [string]>(`SELECT ${HOLD_COLUMNS} FROM holds h WHERE h.id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "hold not found");
  return toHold(row);
}

/** Newest first. `inForce` leaves out the ones you lifted. */
export function listHolds(ctx: StoreContext, opts: { inForce?: boolean; limit?: number } = {}): Hold[] {
  return ctx.db
    .query<HoldRow, [number]>(
      `SELECT ${HOLD_COLUMNS} FROM holds h ${opts.inForce ? "WHERE h.lifted_at IS NULL" : ""} ORDER BY h.created_at DESC, h.id DESC LIMIT ?`,
    )
    .all(opts.limit ?? 200)
    .map(toHold);
}

/** The holds in force over what a turn or a wake is about, oldest first; empty when nothing holds it. */
export function holdsCovering(
  ctx: StoreContext,
  subject: { botId?: string | null; sessionId?: string | null; taskId?: string | null; ticketId?: string | null; turnId?: string | null },
): Hold[] {
  return ctx.db
    .query<HoldRow, Record<string, string | null>>(
      `SELECT ${HOLD_COLUMNS} FROM holds h WHERE h.lifted_at IS NULL
         AND EXISTS (SELECT 1 FROM held_scopes hs WHERE hs.hold_id = h.id AND ${heldBy(PARAMS)})
       ORDER BY h.created_at ASC, h.id ASC`,
    )
    .all({
      bot: subject.botId ?? null,
      session: subject.sessionId ?? null,
      task: subject.taskId ?? null,
      ticket: subject.ticketId ?? null,
      turn: subject.turnId ?? null,
    })
    .map(toHold);
}

/** What holds the plan as a whole — on it, on its conversation, on everything — as `TaskDetail.held_by` reports. */
export function planHeldBy(ctx: StoreContext, taskId: string): Hold[] {
  return holdsCovering(ctx, { taskId });
}

/**
 * The holds in force over a turn itself: its Bot, its conversation, its plan and ticket, or the turn.
 * Empty for a turn that is gone. What the tool gate asks before a call with an effect (I3).
 */
export function turnHeldBy(ctx: StoreContext, turnId: string): Hold[] {
  const turn = ctx.db
    .query<{ bot_id: string; session_id: string; task_id: string | null; ticket_id: string | null }, [string]>(
      `SELECT bot_id, session_id, task_id, ticket_id FROM turns WHERE id = ?`,
    )
    .get(turnId);
  if (!turn) return [];
  return holdsCovering(ctx, { botId: turn.bot_id, sessionId: turn.session_id, taskId: turn.task_id, ticketId: turn.ticket_id, turnId });
}

/** What the database raises when a hold covers a turn being written (I2); see {@link HELD_TURN_TRIGGERS}. */
export const HELD_ABORT = "held";

const TURN_ROW: HeldSubject = {
  bot: "NEW.bot_id",
  session: "NEW.session_id",
  task: "NEW.task_id",
  ticket: "NEW.ticket_id",
  turn: "(SELECT m.turn_id FROM messages m WHERE m.id = NEW.trigger_message_id)",
};
const LIVE_ROW = `NEW.status IN ('running', 'waiting_approval', 'waiting_ask')`;

/**
 * I2 (ADR 0040): the database itself refuses a live turn a hold covers, whoever writes it. The
 * engine asks first and records what it turned away (engine/control.ts), so these catch a writer
 * that did not ask — an older build's included: a turn with no mode is held like any other, since a
 * stop comes before compatibility, and that build's write fails instead of going round it. The one
 * turn a hold lets open is the read-only one a line of yours opens to answer you. Moving a live
 * turn onto another plan, ticket or Bot, or changing its mode, is checked again with no exception,
 * so a read-only turn cannot become a working one in place. Created by the migration, after the
 * column they read.
 */
export const HELD_TURN_TRIGGERS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "turns_held_insert",
    sql: `CREATE TRIGGER turns_held_insert BEFORE INSERT ON turns
      WHEN ${LIVE_ROW}
        AND NOT (NEW.mode IS 'readonly' AND (SELECT m.kind FROM messages m WHERE m.id = NEW.trigger_message_id) IS 'user')
        AND ${heldSql(TURN_ROW)}
      BEGIN SELECT RAISE(ABORT, '${HELD_ABORT}'); END`,
  },
  {
    // A row already written can be the very turn a hold names — Stop on a turn with no plan — besides
    // the turn whose line opened it.
    name: "turns_held_update",
    sql: `CREATE TRIGGER turns_held_update BEFORE UPDATE OF task_id, ticket_id, bot_id, mode ON turns
      WHEN ${LIVE_ROW} AND (${heldSql(TURN_ROW)}
        OR EXISTS (SELECT 1 FROM held_scopes hs WHERE hs.scope = 'turn' AND hs.scope_id = NEW.id))
      BEGIN SELECT RAISE(ABORT, '${HELD_ABORT}'); END`,
  },
];

/** Whether `error` is the database refusing a turn a hold covers. */
export function isHeldAbort(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_TRIGGER" && error.message === HELD_ABORT;
}

/**
 * Makes a hold, and in the same write parks the plans and sets aside the check-backs it covers.
 * Holds are off until the engine level that brings them (ADR 0040's version gate): before then a
 * build older than holds may still share the database, and would not honor one.
 */
export function createHold(
  ctx: StoreContext,
  input: {
    scope: unknown;
    scopeId?: unknown;
    action?: unknown;
    cascade?: unknown;
    source: Hold["source"];
    sourceMessageId?: string | null;
    liftOnNextUserMessage?: unknown;
    targets?: unknown;
    now?: string;
  },
): Hold {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.holds) {
    throw new HttpError(409, "holds_unavailable", "holds are not on yet: the engine level has not reached them (GET /v1/capabilities)");
  }
  const scope = input.scope as HoldScope;
  if (!HOLD_SCOPES.includes(scope)) throw new HttpError(422, "invalid_args", `scope must be one of ${HOLD_SCOPES.join(", ")}`);
  const scopeId = input.scopeId ?? null;
  if (scope === "global") {
    if (scopeId !== null) throw new HttpError(422, "invalid_args", "a global hold has no scope_id");
  } else {
    if (typeof scopeId !== "string" || !scopeId) throw new HttpError(422, "invalid_args", "scope_id is required");
    assertScopeExists(ctx, scope, scopeId);
  }
  const action = input.action ?? "pause";
  if (action !== "pause" && action !== "cancel") throw new HttpError(422, "invalid_args", "action must be pause or cancel");
  const cascade = input.cascade ?? true;
  if (typeof cascade !== "boolean") throw new HttpError(422, "invalid_args", "cascade must be a boolean");
  const liftOnNext = input.liftOnNextUserMessage ?? false;
  if (typeof liftOnNext !== "boolean") throw new HttpError(422, "invalid_args", "lift_on_next_user_message must be a boolean");
  // Only a Stop's own hold goes when you next speak in that job; a stop you said or chose stays until you lift it.
  if (liftOnNext && scope !== "bot_plan" && scope !== "turn") {
    throw new HttpError(422, "invalid_args", "only a hold on one Bot's work in a plan, or on one turn, lifts on your next line");
  }
  if (input.source === "user_text" && !input.sourceMessageId) {
    throw new HttpError(422, "invalid_args", "a stop you said names the line you said it in");
  }
  if (input.sourceMessageId) assertUserLine(ctx, input.sourceMessageId);
  const targets = parseTargets(input.targets);
  const now = input.now ?? isoNow();
  const id = ulid(Date.parse(now));
  return ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO holds (id, scope, scope_id, action, cascade, source, source_message_id, lift_on_next_user_message, targets, effect, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
      [id, scope, scopeId, action, cascade ? 1 : 0, input.source, input.sourceMessageId ?? null, liftOnNext ? 1 : 0, JSON.stringify(targets), now],
    );
    parkHeldPlans(ctx, undefined, now);
    const suspended = suspendHeldCheckBacks(ctx, now);
    if (suspended.length > 0) addEffect(ctx, id, { suspended_check_backs: suspended });
    refreshHeldInbox(ctx);
    return getHold(ctx, id);
  })();
}

/**
 * Lifts a hold. Only you do that, by a line of yours or by a button (I7): there is no other `by`.
 * A plan it parked goes back to what it was unless another hold still parks it, which then carries
 * the plan's way back; a check-back it set aside is pending again unless another still covers it,
 * or the Bot booked another there since. Lifting one already lifted changes nothing.
 */
export function liftHold(ctx: StoreContext, id: string, input: { by: unknown; messageId?: string | null; now?: string }): Hold {
  if (input.by !== "user_text" && input.by !== "user_button") {
    throw new HttpError(422, "invalid_args", "only you lift a hold, by a line of yours or a button");
  }
  if (input.by === "user_text" && !input.messageId) throw new HttpError(422, "invalid_args", "a lift you said names the line you said it in");
  if (input.messageId) assertUserLine(ctx, input.messageId);
  const hold = getHold(ctx, id);
  if (hold.lifted_at) return hold;
  const now = input.now ?? isoNow();
  return ctx.db.transaction(() => {
    ctx.db.run(`UPDATE holds SET lifted_at = ?, lifted_by = ?, lifted_message_id = ? WHERE id = ? AND lifted_at IS NULL`, [
      now,
      input.by as string,
      input.messageId ?? null,
      id,
    ]);
    const restored: string[] = [];
    for (const record of hold.effect.parked_plans ?? []) {
      const task = ctx.db
        .query<{ status: PlanStatus }, [string]>(`SELECT status FROM tasks WHERE id = ?`)
        .get(record.task_id);
      if (!task) continue;
      if (parkingHolds(ctx, record.task_id).length > 0) {
        rememberParked(ctx, record.task_id, record.prior);
        continue;
      }
      // Something of yours moved it on meanwhile (you accepted it, say); that stands.
      if (task.status !== "parked") continue;
      restorePlanStatus(ctx, record.task_id, record.prior, now);
      restored.push(record.task_id);
    }
    const resumed = resumeUnheldCheckBacks(ctx);
    if (restored.length > 0 || resumed.length > 0) addEffect(ctx, id, { restored_plans: restored, resumed_check_backs: resumed });
    refreshHeldInbox(ctx);
    return getHold(ctx, id);
  })();
}

/**
 * Records holds in force as stops you mean to drop the job with (`action` cancel): the 作废 button
 * on a stop's receipt. Nothing else about them changes — they still hold what they held, and lifting
 * one reopens the job. Returns the holds as they now read; one already lifted is left as it was.
 */
export function cancelHolds(ctx: StoreContext, ids: readonly string[]): Hold[] {
  return ctx.db.transaction(() =>
    ids.map((id) => {
      ctx.db.run(`UPDATE holds SET action = 'cancel' WHERE id = ? AND lifted_at IS NULL AND action != 'cancel'`, [id]);
      return getHold(ctx, id);
    }),
  )();
}

/**
 * Setting a plan's status by hand, the way a client from before holds stops or resumes one (ADR
 * 0040): once holds are on, parking a plan is a hold on it, and moving it on — to in progress, or
 * accepting it as done — lifts the holds on it. A hold on its conversation or on everything still
 * stands; the plan's `held_by` says so. Before holds are on, the status is all there is.
 *
 * What counts as asking for a status is a status other than the spec's own: that is the one the
 * board sends back with every edit, so an edit of the goal that sends it back unchanged stops or
 * resumes nothing. The status column can say otherwise — a plan a newer one moved aside reads
 * parked there and in progress in its spec — and judging by it would read that edit as a resume.
 */
export function setPlanStatusByUser(
  ctx: StoreContext,
  task: { id: string; status: PlanStatus; spec: string | null },
  requested: PlanStatus,
  now: string,
): void {
  if (requested === (parsePlanSpec(task.spec)?.status ?? task.status)) return;
  if (requested === "parked") {
    if (readEngineLevel(ctx.db) < ENGINE_LEVELS.holds) return;
    const hold = createHold(ctx, { scope: "plan", scopeId: task.id, source: "user_button", now });
    // A plan you had already called done is not one the hold found in progress; lifting it puts back done.
    if (task.status === "done") rememberParked(ctx, task.id, "done", hold.id);
    return;
  }
  for (const hold of parkingHolds(ctx, task.id)) {
    if (hold.scope === "plan" && hold.scope_id === task.id) liftHold(ctx, hold.id, { by: "user_button", now });
  }
}

/**
 * The status a write asking for `requested` leaves on a plan, and whether a hold is why. While a
 * hold on the plan or its conversation is in force the plan stays parked, whatever the organizer or
 * a resume asks for; asking for in progress is noted on the hold, so lifting it gets there. Done
 * goes through: a plan finished is not something a hold is there to stop.
 */
export function planStatusUnderHolds(ctx: StoreContext, taskId: string, requested: PlanStatus): { status: PlanStatus; held: boolean } {
  if (requested === "done") return { status: requested, held: false };
  if (parkingHolds(ctx, taskId).length === 0) return { status: requested, held: false };
  if (requested === "active") rememberParked(ctx, taskId, "active");
  return { status: "parked", held: true };
}

/**
 * Parks every plan in progress that a hold on it or on its conversation covers, noting on the hold
 * what lifting it puts back. A plan a newer one moved aside is parked in its status column already
 * and in progress in its spec; only the spec changes, and lifting puts back that it was moved
 * aside (`aside`). Returns the plans it parked. Run by every hold made, by a plan opened where a
 * hold is in force, and at boot.
 */
export function parkHeldPlans(ctx: StoreContext, taskId?: string, now: string = isoNow()): string[] {
  const only = `(?1 = '' OR id = ?1) AND ${parksSql("tasks.id")}`;
  const aside = ctx.db
    .query<{ id: string }, [string]>(
      `UPDATE tasks SET spec = json_set(spec, '$.status', 'parked')
       WHERE status = 'parked' AND json_valid(spec) AND json_extract(spec, '$.status') = 'active' AND ${only}
       RETURNING id`,
    )
    .all(taskId ?? "")
    .map((row) => row.id);
  const active = ctx.db
    .query<{ id: string }, [string]>(
      `UPDATE tasks SET status = 'parked',
         spec = CASE WHEN json_valid(spec) THEN json_set(spec, '$.status', 'parked') ELSE spec END
       WHERE status = 'active' AND ${only}
       RETURNING id`,
    )
    .all(taskId ?? "")
    .map((row) => row.id);
  for (const id of aside) rememberParked(ctx, id, "aside");
  for (const id of active) rememberParked(ctx, id, "active");
  for (const id of [...aside, ...active]) recordHoldRevision(ctx, id, now);
  return [...aside, ...active];
}

/**
 * Plans a hold parks that a newer or resumed plan is about to move out of their conversation's
 * slot (`openTask`, `reopenTask`): lifting the hold puts each back moved aside, not in progress —
 * what the move would have left it at had nothing held it, and a plan out of the slot that read in
 * progress in its status column would have its Bots called back to it.
 */
export function noteHeldPlansMovedAside(ctx: StoreContext, taskIds: readonly string[]): void {
  for (const taskId of taskIds) {
    const record = parkingHolds(ctx, taskId)
      .flatMap((hold) => hold.effect.parked_plans ?? [])
      .find((row) => row.task_id === taskId);
    if (record?.prior === "active") rememberParked(ctx, taskId, "aside");
  }
}

/**
 * Before a deleted conversation's surviving plans lose it (`deleteSession`): each one a hold on that
 * conversation parks gets a plan hold of its own, source `migration`, carrying the way back. The
 * conversation's hold stops reaching a plan that no longer names the conversation, and the plan
 * would be left parked with nothing holding it. That includes a plan stopped the old way before the
 * hold (its status and its spec both say parked, and no hold noted a way back): it gets in progress
 * as its way back, as the boot import gives one (`reconcileHolds`). One a hold on the plan itself
 * also parks needs none, and one you moved on meanwhile (accepted it, say) is no longer parked.
 * Returns the new holds.
 */
export function holdPlansLeavingSession(ctx: StoreContext, sessionId: string, now: string = isoNow()): Hold[] {
  const plans = ctx.db
    .query<{ id: string; spec: string | null }, [string]>(
      `SELECT id, spec FROM tasks WHERE session_id = ? AND status = 'parked' ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId);
  const made: Hold[] = [];
  for (const { id, spec } of plans) {
    const holds = parkingHolds(ctx, id);
    const onPlan = holds.some((hold) => (hold.scope === "plan" && hold.scope_id === id) || hold.targets.some((target) => target.scope === "plan" && target.id === id));
    if (holds.length === 0 || onPlan) continue;
    const record =
      holds.flatMap((hold) => hold.effect.parked_plans ?? []).find((row) => row.task_id === id) ??
      (parsePlanSpec(spec)?.status === "parked" ? { task_id: id, prior: "active" as const } : null);
    if (!record) continue;
    const hold = createHold(ctx, { scope: "plan", scopeId: id, source: "migration", now });
    addEffect(ctx, hold.id, { parked_plans: [record] });
    made.push(getHold(ctx, hold.id));
  }
  return made;
}

/**
 * At boot, once holds are on: a plan parked before holds existed — its status and its spec both say
 * parked, which is how you or the organizer stopped it — and that no hold parks yet becomes a plan
 * hold of source `legacy`, so from here on only you put it back. A plan the organizer only moved
 * aside for a newer one keeps in progress in its spec and is left alone. Then whatever a hold
 * covers is parked and set aside again, in case a write between missed it. Returns the plans taken
 * over and the ones parked again.
 *
 * A stop you say makes a hold itself (engine/stop.ts). A plan the organizer still parks on a line
 * that only reads like one is only parked, and becomes a hold at the next boot: before that a resume
 * can still put it back in progress, after it only you can.
 */
export function reconcileHolds(ctx: StoreContext, now: string = isoNow()): { imported: string[]; reparked: string[] } {
  if (readEngineLevel(ctx.db) < ENGINE_LEVELS.holds) return { imported: [], reparked: [] };
  return ctx.db.transaction(() => {
    const legacy = ctx.db
      .query<{ id: string }, []>(
        `SELECT id FROM tasks
         WHERE status = 'parked' AND json_valid(spec) AND json_extract(spec, '$.status') = 'parked'
           AND NOT ${parksSql("tasks.id")}
         ORDER BY created_at ASC, id ASC`,
      )
      .all()
      .map((row) => row.id);
    for (const taskId of legacy) {
      const hold = createHold(ctx, { scope: "plan", scopeId: taskId, source: "legacy", now });
      rememberParked(ctx, taskId, "active", hold.id);
    }
    const reparked = parkHeldPlans(ctx, undefined, now);
    suspendHeldCheckBacks(ctx, now);
    resumeUnheldCheckBacks(ctx);
    return { imported: legacy, reparked };
  })();
}

/**
 * Sets aside the pending check-backs a hold covers (all of them, or just `ids`), with `voided_at`
 * beside `suspended_at` so an older build never fires one. Returns the ones it set aside.
 */
export function suspendHeldCheckBacks(ctx: StoreContext, now: string, ids?: string[]): string[] {
  const only = ids ? `AND id IN (SELECT value FROM json_each(?))` : "";
  return ctx.db
    .query<{ id: string }, string[]>(
      `UPDATE check_backs SET suspended_at = ?, voided_at = ?
       WHERE fired_at IS NULL AND voided_at IS NULL ${only} AND ${heldSql(CHECK_BACK)}
       RETURNING id`,
    )
    .all(...(ids ? [now, now, JSON.stringify(ids)] : [now, now]))
    .map((row) => row.id);
}

/**
 * Brings back the set-aside check-backs no hold covers any more. One whose Bot booked another in
 * the same conversation meanwhile stays cancelled: a Bot has one pending there, and the newer
 * booking is the one it meant.
 */
export function resumeUnheldCheckBacks(ctx: StoreContext): string[] {
  const unheld = `suspended_at IS NOT NULL AND fired_at IS NULL AND NOT ${heldSql(CHECK_BACK)}`;
  ctx.db.run(
    `UPDATE check_backs SET suspended_at = NULL
     WHERE ${unheld} AND EXISTS (
       SELECT 1 FROM check_backs other
       WHERE other.bot_id = check_backs.bot_id AND other.session_id = check_backs.session_id
         AND other.fired_at IS NULL AND other.voided_at IS NULL)`,
  );
  return ctx.db
    .query<{ id: string }, []>(`UPDATE check_backs SET suspended_at = NULL, voided_at = NULL WHERE ${unheld} RETURNING id`)
    .all()
    .map((row) => row.id);
}

/** A cleared or deleted conversation takes its lines; the holds made or lifted there stay, pointing at none. */
export function forgetHoldLines(ctx: StoreContext, sessionId: string): void {
  for (const column of ["source_message_id", "lifted_message_id"]) {
    ctx.db.run(`UPDATE holds SET ${column} = NULL WHERE ${column} IN (SELECT id FROM messages WHERE session_id = ?)`, [sessionId]);
  }
}

/**
 * Adds to what a hold changed. Lists grow; a plan's way back replaces the one noted before it.
 * The stop sequence (engine/stop.ts) adds the turns it ended and what it found beside them.
 */
export function addEffect(ctx: StoreContext, id: string, patch: HoldEffect): void {
  const effect = getHold(ctx, id).effect as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (!Array.isArray(value)) continue;
    const before = Array.isArray(effect[key]) ? (effect[key] as unknown[]) : [];
    effect[key] =
      key === "parked_plans"
        ? [...(before as ParkedPlan[]).filter((row) => !(value as ParkedPlan[]).some((next) => next.task_id === row.task_id)), ...value]
        : [...before, ...value.filter((item) => !before.includes(item))];
  }
  ctx.db.run(`UPDATE holds SET effect = ? WHERE id = ?`, [JSON.stringify(effect), id]);
}

/**
 * `EXISTS` over every hold, lifted ones too, that names the plan: by its scope — the plan, one
 * Bot's work in it, one of its tickets — or among its targets. Clearing a conversation keeps such a
 * plan, as it keeps the holds (a hold naming a plan that is gone would sit in the list for good).
 */
export function holdNamesPlanSql(task: string): string {
  const names = (scope: string, id: string) => `((${scope} = 'plan' AND ${id} = ${task})
      OR (${scope} = 'bot_plan' AND substr(${id}, instr(${id}, ':') + 1) = ${task})
      OR (${scope} = 'ticket' AND ${id} IN (SELECT k.id FROM tickets k WHERE k.task_id = ${task})))`;
  return `(EXISTS (SELECT 1 FROM holds h WHERE ${names("h.scope", "h.scope_id")})
    OR EXISTS (SELECT 1 FROM holds h, json_each(h.targets) ht
      WHERE ${names("json_extract(ht.value, '$.scope')", "json_extract(ht.value, '$.id')")}))`;
}

/** The conversation a plan belongs to, looked up under an alias so that `tasks.id` still names the outer row. */
function planSession(task: string): string {
  return `(SELECT t.session_id FROM tasks t WHERE t.id = ${task})`;
}

/** Whether a `held_scopes` row (`hs`) reads as the plan parked: a hold on the plan itself, or on its conversation. */
function parks(task: string): string {
  return `((hs.scope = 'plan' AND hs.scope_id = ${task}) OR (hs.scope = 'session' AND hs.scope_id = ${planSession(task)}))`;
}

/** `EXISTS` form of {@link parks}. */
function parksSql(task: string): string {
  return `EXISTS (SELECT 1 FROM held_scopes hs WHERE ${parks(task)})`;
}

/** The holds in force that park this plan, newest first. */
function parkingHolds(ctx: StoreContext, taskId: string): Hold[] {
  return ctx.db
    .query<HoldRow, Record<string, string>>(
      `SELECT ${HOLD_COLUMNS} FROM holds h WHERE h.lifted_at IS NULL
         AND EXISTS (SELECT 1 FROM held_scopes hs WHERE hs.hold_id = h.id AND ${parks("$task")})
       ORDER BY h.created_at DESC, h.id DESC`,
    )
    .all({ task: taskId })
    .map(toHold);
}

/**
 * Notes what lifting the holds over a plan should put back. One hold carries it: the one already
 * carrying it, else `on`, else the newest that parks the plan; lifting that one hands it on to the
 * next if the plan is still parked by another.
 */
function rememberParked(ctx: StoreContext, taskId: string, prior: ParkedPlan["prior"], on?: string): void {
  const holds = parkingHolds(ctx, taskId);
  const owner = holds.find((hold) => hold.effect.parked_plans?.some((row) => row.task_id === taskId))?.id ?? on ?? holds[0]?.id;
  if (owner) addEffect(ctx, owner, { parked_plans: [{ task_id: taskId, prior }] });
}

/**
 * Puts a plan the hold parked back. In progress takes the conversation's current slot again when
 * nothing else took it meanwhile, the same as setting it back by hand does (`setTaskSpec`). One a
 * newer plan had moved aside before the hold found it, and that is still out of the slot, goes
 * back to just that — in progress in its spec, parked in the column, the way opening the newer
 * plan left it: it was not in progress when you stopped it, and set in progress the plan-watch
 * would start calling its Bots back to it.
 */
function restorePlanStatus(ctx: StoreContext, taskId: string, prior: ParkedPlan["prior"], now: string): void {
  if (prior === "aside") {
    const moved = ctx.db.run(`UPDATE tasks SET spec = json_set(spec, '$.status', 'active') WHERE id = ? AND closed_at IS NOT NULL AND json_valid(spec)`, [
      taskId,
    ]);
    if (moved.changes > 0) {
      recordHoldRevision(ctx, taskId, now);
      return;
    }
  }
  const status = prior === "aside" ? "active" : prior;
  ctx.db.run(
    `UPDATE tasks SET status = ?1,
       spec = CASE WHEN json_valid(spec) THEN json_set(spec, '$.status', ?1) ELSE spec END
     WHERE id = ?2`,
    [status, taskId],
  );
  recordHoldRevision(ctx, taskId, now);
  if (status === "done") {
    ctx.db.run(`UPDATE tasks SET closed_at = COALESCE(closed_at, ?) WHERE id = ?`, [now, taskId]);
    return;
  }
  ctx.db.run(
    `UPDATE tasks SET closed_at = NULL
     WHERE id = ?1 AND closed_at IS NOT NULL AND session_id IS NOT NULL AND routine_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM tasks other
         WHERE other.session_id = tasks.session_id AND other.closed_at IS NULL AND other.routine_id IS NULL AND other.id != ?1)`,
    [taskId],
  );
}

/**
 * The plan's spec as a hold just left it, recorded as a version of its own: not yours, and no
 * filing (`cause` hold), so what you typed stays yours and the organizer still reads what came
 * before the stop. A plan with no spec yet has nothing a board could send back.
 */
function recordHoldRevision(ctx: StoreContext, taskId: string, now: string): void {
  const row = ctx.db.query<{ spec: string | null }, [string]>(`SELECT spec FROM tasks WHERE id = ?`).get(taskId);
  const spec = parsePlanSpec(row?.spec ?? null);
  if (spec) recordSpecRevision(ctx, { taskId, spec, actor: "app", cause: "hold", now });
}

function assertScopeExists(ctx: StoreContext, scope: Exclude<HoldScope, "global">, scopeId: string): void {
  const exists = (table: string, id: string) => Boolean(ctx.db.query(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
  const found =
    scope === "bot_plan"
      ? (() => {
          const [botId, taskId, extra] = scopeId.split(":");
          return !extra && Boolean(botId && taskId) && exists("bots", botId!) && exists("tasks", taskId!);
        })()
      : exists({ bot: "bots", session: "sessions", plan: "tasks", ticket: "tickets", turn: "turns" }[scope], scopeId);
  if (!found) throw new HttpError(404, "not_found", `${scope} ${scopeId} not found`);
}

/** I7: a line that makes or lifts a hold is one you wrote. */
function assertUserLine(ctx: StoreContext, messageId: string): void {
  const row = ctx.db.query<{ kind: string }, [string]>(`SELECT kind FROM messages WHERE id = ?`).get(messageId);
  if (!row) throw new HttpError(404, "not_found", "message not found");
  if (row.kind !== "user") throw new HttpError(422, "invalid_args", "only a line of yours makes or lifts a hold");
}

function parseTargets(raw: unknown): HoldTarget[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > HOLD_TARGETS_MAX) {
    throw new HttpError(422, "invalid_args", `targets must be a list of at most ${HOLD_TARGETS_MAX}`);
  }
  return raw.map((entry) => {
    const target = entry as { scope?: unknown; id?: unknown } | null;
    if (!target || typeof target.id !== "string" || !target.id || target.scope === "global" || !HOLD_SCOPES.includes(target.scope as HoldScope)) {
      throw new HttpError(422, "invalid_args", "each target is {scope, id} with a scope other than global");
    }
    return { scope: target.scope as HoldTarget["scope"], id: target.id };
  });
}
