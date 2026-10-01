/**
 * The engine's two questions to your stops (ADR 0040): may this wake a Bot (I2), and may this turn
 * make a call with an effect (I3). Every way a Bot is woken asks the first before anything opens,
 * is heard or is booked — the three places a turn opens, right after `admission.assertNew()`, and
 * the wakes that do not go through them — and a wake a hold turns away leaves a `wake.suppressed`
 * row in the work log saying why, which cause and which holds. The database refuses a turn row a
 * hold covers as well (store/holds.ts), for a writer that did not ask.
 */
import type { Hold, Message } from "@real-bot/protocol";
import type { Store } from "../store";
import { ENGINE_LEVELS } from "../store/schema-gate";

/**
 * What would have woken the Bot, as the work log records it:
 * - `user_line`: a line of yours — the other side of a direct, a group's focused Bot, the Bots it
 *   names, or one that judged it its to join.
 * - `mention`: a Bot's line — the other side of a Bot↔Bot direct, or a Bot it names in a group.
 *   It is heard in that Bot's live turn there instead when it has one, and a hold turns that away
 *   the same.
 * - `heard_across`: your line filed under a plan, reaching the plan's turns in other conversations.
 * - `unheard`: a turn that ended with lines it never read, opening one more.
 * - `check_back`, `report_back`, `plan_nudge`: a Bot's own appointment, a Bot↔Bot direct gone quiet
 *   calling its opener back, the app calling a quiet plan's Bot back.
 * - `routine`: a routine's schedule.
 * - `continue`: your Continue on an interrupted turn.
 * - `resume`: work a stop of yours ended, going on once you lift it (engine/stop.ts).
 */
export type WakeCause =
  | "user_line"
  | "mention"
  | "heard_across"
  | "unheard"
  | "check_back"
  | "report_back"
  | "plan_nudge"
  | "routine"
  | "continue"
  | "resume";

export type Wake = {
  cause: WakeCause;
  botId: string;
  sessionId: string | null;
  taskId?: string | null;
  ticketId?: string | null;
  /** The turn it goes back to: the one that wrote the line or made the booking, or the live turn a line is heard in. */
  turnId?: string | null;
  /**
   * Another Bot whose work it is that wakes this one, where it did it: the author of a Bot's line,
   * or the other side of a Bot↔Bot direct gone quiet. A hold over that work turns the wake away
   * too, so a held Bot's line wakes nobody.
   */
  by?: { botId: string; sessionId: string; taskId: string | null; ticketId: string | null; turnId: string | null } | null;
};

/** The holds in force that turn this wake away; empty when it may go ahead. */
export function heldWake(store: Store, wake: Wake): Hold[] {
  const holds = store.holdsCovering({
    botId: wake.botId,
    sessionId: wake.sessionId,
    taskId: wake.taskId,
    ticketId: wake.ticketId,
    turnId: wake.turnId,
  });
  if (wake.by) holds.push(...store.holdsCovering(wake.by));
  return holds.filter((hold, index) => holds.findIndex((other) => other.id === hold.id) === index);
}

/**
 * True when nothing holds the wake. Otherwise it records the wake as suppressed and says no.
 * `once` names a wake that asks again and again for the same thing (a routine's due time, on every
 * tick): it is recorded the first time only.
 */
export function mayWake(store: Store, wake: Wake, opts: { once?: string } = {}): boolean {
  const holds = heldWake(store, wake);
  if (store.capabilities().engine_level >= ENGINE_LEVELS.work_items && wake.taskId && !store.isPlanRunnable(wake.taskId)) {
    store.recordWorkEvent({ kind: "wake.suppressed", actor: "app", botId: wake.botId, taskId: wake.taskId,
      sessionId: wake.sessionId, turnId: wake.turnId ?? null, payload: { cause: wake.cause, holds: holds.map((hold) => hold.id), reason: "plan_not_runnable" } });
    return false;
  }
  if (holds.length === 0) return true;
  if (opts.once && suppressedAlready(store, wake.botId, opts.once)) return false;
  store.recordWorkEvent({
    kind: "wake.suppressed",
    actor: "app",
    botId: wake.botId,
    sessionId: wake.sessionId,
    taskId: wake.taskId ?? null,
    ticketId: wake.ticketId ?? null,
    turnId: wake.turnId ?? null,
    payload: { cause: wake.cause, holds: holds.map((hold) => hold.id), ...(opts.once ? { once: opts.once } : {}) },
  });
  return false;
}

/**
 * The wake a trigger line would make, about the plan and ticket the turn it opens would land in —
 * read ahead, so that a wake a hold turns away changes nothing, not even a turn it would have
 * redirected.
 */
export function wakeOn(
  store: Store,
  cause: WakeCause,
  input: { sessionId: string; botId: string; trigger: Message; taskId?: string | null; ticketId?: string | null },
): Wake {
  const lands = store.turnLanding(input);
  const line = input.trigger;
  return {
    cause,
    botId: input.botId,
    sessionId: input.sessionId,
    taskId: lands.taskId,
    ticketId: lands.ticketId,
    turnId: line.turn_id,
    by:
      line.kind === "bot"
        ? { botId: line.author, sessionId: line.session_id, taskId: line.task_id ?? null, ticketId: line.ticket_id ?? null, turnId: line.turn_id }
        : null,
  };
}

/**
 * What a call a hold refused comes back with, for the model: what happened, and nothing about
 * what to do next.
 */
export const HELD_CALL = "The user stopped this work: calls that change anything do not run until they lift the stop. This one did not run.";

/**
 * I3: whether a turn may make a call with an effect now. A hold over the turn — its Bot, its
 * conversation, its plan or ticket, or the turn itself — says no; a read-only turn never may, held
 * or not: it is bound to no plan, so the hold that let it open need not cover it. I3's other half,
 * the work still being this turn's to do, needs work items and comes with them (ADR 0040 P4b).
 */
export function mayAct(store: Store, turnId: string): boolean {
  try {
    const turn = store.getTurn(turnId);
    if (turn.mode === "readonly") return false;
    if (turn.task_id && store.capabilities().engine_level >= ENGINE_LEVELS.work_items && !store.isPlanRunnable(turn.task_id)) return false;
  } catch {
    // a turn that is gone is held by nothing; the call's own checks turn it away
  }
  return store.turnHeldBy(turnId).length === 0;
}

function suppressedAlready(store: Store, botId: string, once: string): boolean {
  return Boolean(
    store.db
      .query(`SELECT 1 FROM work_events WHERE kind = 'wake.suppressed' AND bot_id = ? AND json_extract(payload, '$.once') = ? LIMIT 1`)
      .get(botId, once),
  );
}
