/** What a stop reaches: whether holds are on, the lineage of turns a Bot handed work down, and which holds cover a turn, a Bot, a line or a job. */
import { type ControlScope, type Message, type Hold, type HoldScope, type HoldTarget, type Turn, type HeldTurn, type Session, USER_MEMBER } from "@real-bot/protocol";
import { botPlanScopeId } from "../../store";
import { ENGINE_LEVELS } from "../../store/schema-gate";
import { recentToolCalls } from "../../turn-inbox";
import type { Live } from "../types";
import { LIVE_TURN_STATUSES } from "../../store/shared";
import type { StopDeps } from "../stop";

/** How far down a Bot's handoffs a stop reaches: its handoff, that one's, and one more. */
const HANDOFF_DEPTH = 3;
/** How many turns back one lineage walk goes, a Bot's own turns in a row included. */
const LINEAGE_STEPS = 12;
/** How many files a stopped turn's record keeps. */
const WRITTEN_MAX = 10;
/** How many of your latest lines in a conversation say which jobs are being talked about there, for the status answer. */
const RECENT_FILINGS = 20;

export function createStopReach(deps: StopDeps) {
  const { store, wakes } = deps;

  function on(): boolean {
    return store.capabilities().engine_level >= ENGINE_LEVELS.holds;
  }

  /**
   * The holds in force over what `scope` names, for `line` said where it was: for a Bot, those on
   * all its work and on its work there — the conversation, and the plan the line would put it in,
   * as a turn opened on the line would find them.
   */
  function scopeHolds(scope: ControlScope, line: Message): Hold[] {
    switch (scope.scope) {
      case "global":
        return store.listHolds({ inForce: true }).filter((hold) => hold.scope === "global");
      case "bot":
        return store.holdsCovering({ botId: scope.id, sessionId: line.session_id, taskId: landedPlan(line, scope.id) });
      case "session":
        return store.holdsCovering({ sessionId: scope.id });
      case "plan":
        return store.holdsCovering({ taskId: scope.id });
    }
  }

  /** The plan a Bot's turn opened on your line would be in: the one it is filed under, or would land on. */
  function landedPlan(line: Message, botId: string): string | null {
    return line.task_id ?? store.turnLanding({ sessionId: line.session_id, botId, trigger: line }).taskId;
  }

  /** A hold's scope as a line's buttons name it; a scope no line can name (one turn, say) has none. */
  function lineScopes(scope: HoldScope, scopeId: string | null): ControlScope[] {
    if (scope === "global") return [{ scope: "global", id: null }];
    if ((scope === "bot" || scope === "session" || scope === "plan") && scopeId) return [{ scope, id: scopeId }];
    return [];
  }

  /**
   * The work a scope handed on and has not had back: a turn of another Bot opened by a line of a
   * turn the scope covers — or by a line of such a turn, up to three handoffs down — that is still
   * running or still has an appointment to come back. Each becomes a `turn` target, which covers
   * that turn, what it booked and whom its lines would wake. Upstream work is left alone: stopping
   * a Bot does not stop the one that handed it the job.
   */
  function handedOn(scope: HoldScope, scopeId: string | null): HoldTarget[] {
    if (scope === "global" || scopeId === null) return [];
    if (store.capabilities().engine_level >= ENGINE_LEVELS.delegation) return store.delegationCascadeTargets({ scope, id: scopeId });
    const candidates = store.db
      .query<{ id: string }, []>(
        `SELECT id FROM turns WHERE status IN ${LIVE_TURN_STATUSES}
         UNION SELECT turn_id AS id FROM check_backs WHERE fired_at IS NULL AND voided_at IS NULL AND turn_id IS NOT NULL`,
      )
      .all()
      .map((row) => row.id);
    const targets: HoldTarget[] = [];
    for (const id of candidates) {
      const turn = turnRow(id);
      if (!turn || covers(scope, scopeId, turn)) continue;
      let child = turn;
      let handoffs = 0;
      for (let step = 0; step < LINEAGE_STEPS; step += 1) {
        const parent = openerOf(child);
        if (!parent) break;
        if (parent.bot_id !== child.bot_id) handoffs += 1;
        if (handoffs > HANDOFF_DEPTH) break;
        if (covers(scope, scopeId, parent)) {
          targets.push({ scope: "turn", id: turn.id });
          break;
        }
        child = parent;
      }
    }
    return targets;
  }

  type TurnFacts = { id: string; bot_id: string; session_id: string; task_id: string | null; trigger_message_id: string };
  type TurnSubject = { id: string; bot_id: string; session_id: string; task_id?: string | null };

  function turnRow(id: string): TurnFacts | null {
    return (
      store.db
        .query<TurnFacts, [string]>(`SELECT id, bot_id, session_id, task_id, trigger_message_id FROM turns WHERE id = ?`)
        .get(id) ?? null
    );
  }

  /** The turn that wrote the line this one opened on, or booked the appointment it opened on. */
  function openerOf(turn: TurnFacts): TurnFacts | null {
    const row = store.db.query<{ turn_id: string | null }, [string]>(`SELECT turn_id FROM messages WHERE id = ?`).get(turn.trigger_message_id);
    return row?.turn_id && row.turn_id !== turn.id ? turnRow(row.turn_id) : null;
  }

  /** Whether a hold on `scope` would cover the turn by its own scope (targets aside). */
  function covers(scope: HoldScope, scopeId: string, turn: TurnSubject): boolean {
    switch (scope) {
      case "bot":
        return turn.bot_id === scopeId;
      case "session":
        return turn.session_id === scopeId || (turn.task_id != null && planSession(turn.task_id) === scopeId);
      case "plan":
        return turn.task_id === scopeId;
      case "bot_plan":
        return turn.task_id != null && botPlanScopeId(turn.bot_id, turn.task_id) === scopeId;
      case "turn":
        return turn.id === scopeId;
      case "ticket":
        return store.db.query(`SELECT 1 FROM turns WHERE id = ? AND ticket_id = ?`).get(turn.id, scopeId) !== null;
      case "global":
        return true;
    }
  }

  function planSession(taskId: string): string | null {
    return store.db.query<{ session_id: string | null }, [string]>(`SELECT session_id FROM tasks WHERE id = ?`).get(taskId)?.session_id ?? null;
  }

  function heldTurn(turn: Turn, live: Live | undefined): HeldTurn {
    const written = live ? [...new Set(live.writtenPaths)].slice(-WRITTEN_MAX) : [];
    const recent = live ? recentToolCalls(live.loop) : store.turnRuns(turn.id).slice(-3).map((run) => run.command);
    return {
      turn_id: turn.id,
      bot_id: turn.bot_id,
      session_id: turn.session_id,
      task_id: turn.task_id ?? null,
      ticket_id: turn.ticket_id ?? null,
      written,
      recent,
    };
  }

  /**
   * The holds the words of a go on said in `session` lift, a Stop's aside (see `continueByLine`).
   * For a Bot: its own, on all its work or on part of it. For a plan: the one on it, and those on
   * a Bot's work in it. In a direct,
   * either also lifts what you stopped by a line said there, except a stop on another Bot: that
   * conversation is its Bot's. For the group: the one on it, and whatever you stopped by a line said
   * there. For everything: every hold you made — not the ones taken over from plans parked before
   * holds existed, which you put back on the board. Nothing wider than the words: 「@X 继续」 in a
   * group the whole group was stopped in lifts X's own stops, and the group's is left to the buttons.
   */
  function holdsToLift(session: Session, scopes: ControlScope[]): Hold[] {
    const direct = session.kind === "direct";
    const present = store.presentBotIds(session.id);
    const madeHere = (hold: Hold) => hold.scope !== "global" && hold.source_message_id !== null && messageSession(hold.source_message_id) === session.id;
    const madeInDirect = (hold: Hold) => direct && madeHere(hold) && (hold.scope !== "bot" || present.includes(hold.scope_id!));
    return store
      .listHolds({ inForce: true })
      .filter((hold) => !hold.lift_on_next_user_message)
      .filter((hold) =>
        scopes.some((scope) => {
          switch (scope.scope) {
            case "global":
              return hold.source === "user_text" || hold.source === "user_button";
            case "bot":
              return (hold.scope === "bot" && hold.scope_id === scope.id) || stopOnBot(hold, scope.id) || madeInDirect(hold);
            case "session":
              return (hold.scope === "session" && hold.scope_id === scope.id) || madeHere(hold);
            case "plan":
              return (hold.scope === "plan" && hold.scope_id === scope.id) || (hold.scope === "bot_plan" && hold.scope_id?.endsWith(`:${scope.id}`) === true) || madeInDirect(hold);
          }
        }),
      );
  }

  function messageSession(id: string): string | null {
    return store.db.query<{ session_id: string }, [string]>(`SELECT session_id FROM messages WHERE id = ?`).get(id)?.session_id ?? null;
  }

  /** Whether `sessionId` is your direct with a Bot, where any line of yours opens that Bot's turn. */
  function directWithYou(sessionId: string): boolean {
    try {
      return store.getSession(sessionId).kind !== "group" && store.isPresent(sessionId, USER_MEMBER);
    } catch {
      return false;
    }
  }

  /**
   * The Stops your line is about: on a Bot's work in the plan the line is filed under, or would
   * land on for that Bot; on a turn in the conversation it is said in. Only a line said to that Bot
   * (`saidTo`): in a group, a line to another Bot about the same job leaves the Stop where it is,
   * or the stopped Bot's appointments would come back and restart it without a word from you. Only
   * a line said after the Stop — one sent just before, still being filed when the Stop landed, is
   * not what you said to it.
   *
   * A group's stop menu makes the same kind of hold, a scope wider: on the group, any line of yours
   * in it; on a Bot's work, a line said to that Bot; on a job, a line said to a Bot it lands on
   * that job for. Stopping a group is "not this", like a Stop; what you say next there is what the
   * Bots go on from, not a question to answer read-only under a stop that is still on (2026-10-03:
   * 「从头再做一遍，之前的作废」 after the group's stop got a read-only turn that said nothing).
   */
  function stopsAbout(message: Message): Hold[] {
    return store.listHolds({ inForce: true }).filter((hold) => {
      if (!stopBefore(hold, message) || hold.scope_id === null) return false;
      switch (hold.scope) {
        case "turn": {
          const turn = turnRow(hold.scope_id);
          return turn !== null && turn.session_id === message.session_id && saidTo(message, turn.bot_id);
        }
        case "bot_plan": {
          const [botId, taskId] = hold.scope_id.split(":");
          return saidTo(message, botId!) && landedPlan(message, botId!) === taskId;
        }
        case "session":
          return message.session_id === hold.scope_id;
        case "bot":
          return saidTo(message, hold.scope_id);
        case "plan":
          return message.task_id === hold.scope_id || wakes(message).some((botId) => landedPlan(message, botId) === hold.scope_id);
        case "ticket":
          return message.ticket_id === hold.scope_id && saidToBots(message).length > 0;
        default:
          return false;
      }
    }).concat(
      // A stop on everything is a stop for now too (ADR 0071): any line said to a Bot is about it.
      store.listHolds({ inForce: true }).filter((hold) => hold.scope === "global" && stopBefore(hold, message) && saidToBots(message).length > 0),
    );
  }

  /** The Bots here your line is said to (`saidTo`): the ones a stop over more than one of them lets go of. */
  function saidToBots(message: Message): string[] {
    return store.presentBotIds(message.session_id).filter((botId) => saidTo(message, botId));
  }

  /**
   * Whether your line is said to `botId`: any line in its direct with you; elsewhere one that wakes
   * it as any line would — naming it (quoting its line puts its @name in front), naming everyone,
   * or naming nobody in a group it is in, which every Bot there hears.
   */
  function saidTo(message: Message, botId: string): boolean {
    let session: Session;
    try {
      session = store.getSession(message.session_id);
    } catch {
      return false;
    }
    if (session.kind === "direct") return store.presentBotIds(session.id).includes(botId);
    return wakes(message).includes(botId);
  }

  /** Your Stops on the work of the Bots a go on names, wherever that work was; pressed before the line. */
  function stopsOnBots(message: Message, scopes: ControlScope[]): Hold[] {
    const bots = scopes.flatMap((scope) => (scope.scope === "bot" ? [scope.id] : []));
    if (bots.length === 0) return [];
    return store.listHolds({ inForce: true }).filter((hold) => stopBefore(hold, message) && bots.some((bot) => stopOnBot(hold, bot)));
  }

  /** A hold that lifts on your next line (a Stop's, or a group stop menu's), made before `message` was said. */
  function stopBefore(hold: Hold, message: Message): boolean {
    return hold.lift_on_next_user_message && message.created_at > hold.created_at;
  }

  /**
   * Of `turns`, those doing what is said in `line`'s conversation although a stop there does not
   * reach them: on a job this line or one of your last lines there is filed under, or in a Bot↔Bot
   * direct opened from it. A job keeps the conversation it was opened in, so a group's lines filed
   * under a job opened in a direct are worked on where a stop in the group does not cover
   * (2026-10-03: 「此刻在跑：无」 in the group while 审片员 reviewed that job in a direct).
   */
  function workOnHere(line: Message, turns: Turn[]): Turn[] {
    if (turns.length === 0) return [];
    const filed = store.db
      .query<{ task_id: string }, [string]>(
        `SELECT task_id FROM (SELECT task_id FROM messages WHERE session_id = ? AND kind = 'user' ORDER BY created_at DESC, rowid DESC LIMIT ${RECENT_FILINGS})
         WHERE task_id IS NOT NULL`,
      )
      .all(line.session_id)
      .map((row) => row.task_id);
    const plans = new Set([line.task_id, ...filed].filter((id): id is string => !!id));
    const openedHere = (sessionId: string) =>
      store.db.query<{ origin_session_id: string | null }, [string]>(`SELECT origin_session_id FROM sessions WHERE id = ?`).get(sessionId)?.origin_session_id === line.session_id;
    return turns.filter((turn) => (turn.task_id != null && plans.has(turn.task_id)) || openedHere(turn.session_id));
  }

  /**
   * The holds in force over what `scopes` name, asked about in `here`, oldest first: those covering
   * the Bot (its work here included, in the plan `line` would put it in when there is a line), the
   * conversation or the plan, and for a Bot or a plan also those on part of its work.
   */
  function heldAbout(scopes: ControlScope[], here: string | null, line: Message | null = null): Hold[] {
    const inForce = store.listHolds({ inForce: true }).reverse();
    const ids = new Set<string>();
    for (const scope of scopes) {
      const over =
        scope.scope === "global"
          ? inForce
          : scope.scope === "bot"
            ? [
                ...store.holdsCovering({ botId: scope.id, sessionId: here, taskId: line ? landedPlan(line, scope.id) : null }),
                ...inForce.filter((hold) => stopOnBot(hold, scope.id)),
              ]
            : scope.scope === "session"
              ? store.holdsCovering({ sessionId: scope.id })
              : [...store.holdsCovering({ taskId: scope.id }), ...inForce.filter((hold) => hold.scope === "bot_plan" && hold.scope_id?.endsWith(`:${scope.id}`) === true)];
      for (const hold of over) ids.add(hold.id);
    }
    return inForce.filter((hold) => ids.has(hold.id));
  }

  /**
   * A hold on a Bot's own work, as a Stop makes — on it in one plan, or on one of its turns — or as
   * a group's stop menu makes on all of it.
   */
  function stopOnBot(hold: Hold, botId: string): boolean {
    if (hold.scope === "bot") return hold.scope_id === botId;
    if (hold.scope === "bot_plan") return hold.scope_id?.startsWith(`${botId}:`) === true;
    return hold.scope === "turn" && hold.scope_id !== null && turnRow(hold.scope_id)?.bot_id === botId;
  }

  function inScope(scope: ControlScope, turn: Turn): boolean {
    return scope.scope === "global" || covers(scope.scope, scope.id, turn);
  }

  /** The Bots a go on names: the Bot itself; the Bots in a conversation; the Bots that worked in a plan. */
  function botsNamed(scopes: ControlScope[], here: string): string[] {
    return scopes.flatMap((scope) => {
      if (scope.scope === "bot") return [scope.id];
      if (scope.scope === "session") return store.presentBotIds(scope.id);
      if (scope.scope === "plan") {
        return store.db.query<{ bot_id: string }, [string]>(`SELECT DISTINCT bot_id FROM turns WHERE task_id = ?`).all(scope.id).map((row) => row.bot_id);
      }
      return [];
    });
  }

  /** A stop over more than one Bot's work. */
  function isWide(hold: Hold): boolean {
    return hold.scope === "global" || hold.scope === "session" || hold.scope === "plan";
  }

  return { on, scopeHolds, landedPlan, lineScopes, handedOn, turnRow, heldTurn, holdsToLift, messageSession, directWithYou, stopsAbout, saidTo, saidToBots, stopsOnBots, stopBefore, workOnHere, heldAbout, stopOnBot, inScope, botsNamed, isWide };
}

export type StopReach = ReturnType<typeof createStopReach>;
