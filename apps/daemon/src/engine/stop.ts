/**
 * Carrying out your stops and go-ons (ADR 0040 P2): a stop line or button becomes holds, the work
 * they cover is ended at once, and the app — not a model turn — tells you what it did, from what
 * the holds recorded (`effect`).
 *
 * A line of yours is read first, before anything else happens to it but a status question
 * (`control-line.ts`). Only a line that is nothing but control is acted on here, and nothing else
 * happens with it: no filing, no turn, no model call. A line with more in it goes where any line
 * goes, marked with the buttons it might have meant (`possible_control`).
 *
 * A stop, in one write: a hold per scope the line names, each with the work the covered Bots handed
 * on and have not had back (`handedOn`); the plans and check-backs it covers are parked and set
 * aside by the hold itself (store/holds.ts); every live turn it covers ends as stopped, its
 * check-backs set aside for the lift rather than cancelled, and what it was doing recorded; then
 * the receipt. Once that is written, each ended turn's model call, MCP calls and command process
 * groups are aborted.
 *
 * A go on lifts the holds the words name, and each turn a lifted hold ended opens again on a note
 * with your words and where it was. Nothing held: the line is an ordinary one. Held by something
 * wider the words do not lift (a hold on the group, on everything): the answer says so and offers
 * the buttons. A Stop's hold goes with your next line about its job, and a 「继续」 that nothing else
 * holds back is that line; a go on to the Bot said away from that job, or one that names
 * everything, lifts it and opens the work again on the note, like any other. A go on to one Bot
 * leaves the other Bots' Stops alone.
 *
 * Work items and their inbox, external jobs and upstream waits (ADR 0040 P4) do not exist yet, so
 * "the work a hold covers" is live turns, check-backs and plans, and a delegation is the lineage of
 * turns and the lines that opened them.
 */
import {
  USER_MEMBER,
  type ControlOffer,
  type ControlScope,
  type HeldTurn,
  type Hold,
  type HoldScope,
  type HoldTarget,
  type Locale,
  type Message,
  type Session,
  type Turn,
} from "@real-bot/protocol";
import { readControlLine, type ControlLineInput } from "../control-line";
import { HttpError } from "../errors";
import {
  clockOf,
  continueReceiptBody,
  controlStatusBody,
  heldLines,
  resumeNote,
  saidOf,
  stopReceiptBody,
  type ControlTurnLine,
  type SaidLine,
} from "../prompts";
import type { TurnAdmission } from "../quiesce";
import { isStatusQuestion } from "../status-question";
import { botPlanScopeId, type Store } from "../store";
import type { TurnExecution } from "../store/routing";
import { ENGINE_LEVELS } from "../store/schema-gate";
import { recentToolCalls } from "../turn-inbox";
import type { Lifecycle } from "./lifecycle";
import type { Live } from "./types";

export type StopDeps = {
  store: Store;
  publishMessage: (message: Message) => void;
  publishTurn: (turn: Turn, partial?: string | null) => void;
  admission: TurnAdmission | undefined;
  lives: Map<string, Live>;
  executionOf: (live: Live | undefined) => TurnExecution | null;
  abortLive: (turnId: string) => void;
  startTurn: Lifecycle["startTurn"];
  hearOrStart: Lifecycle["hearOrStart"];
};

/** What `POST /v1/holds` asks for; `source` is always your button. */
export type HoldRequest = {
  scope: unknown;
  scopeId?: unknown;
  action?: unknown;
  cascade?: unknown;
  liftOnNextUserMessage?: unknown;
};

export type Stop = {
  /** Holds are on: the engine level has reached them (ADR 0040's version gate). */
  on: () => boolean;
  /**
   * Reads a line of yours for a stop or a go on and does what it says. True when that was all the
   * line was, and nothing else is to happen with it. A line it only marks (`possible_control`) and
   * any other line return false and go on as usual.
   */
  handleLine: (message: Message) => boolean;
  /**
   * Your line, once filed: a Stop's hold on the job it is about goes before the line wakes anyone,
   * so the Bot goes on from what you said. Only a line said after the Stop counts.
   */
  liftOnYourLine: (message: Message) => void;
  /**
   * Stop on a turn's card: a hold on this Bot's work in its plan (on the turn, when it has no plan)
   * that your next line about that job lifts, and the turn ends under it. Null before holds are
   * on, so the caller stops it the way it did before them.
   */
  stopByButton: (turnId: string, opts: { allowGroup?: boolean }) => Turn | null;
  /** `POST /v1/holds`: the hold, and the live turns it covers ended. */
  hold: (input: HoldRequest) => Hold;
  /** `POST /v1/holds/:id/lift`: lifted by your button, and the work it ended opened again. */
  lift: (id: string) => Hold;
  /** Ends every live turn a hold in force covers: after a hold made elsewhere (a plan parked from the board). */
  enforce: () => void;
  /**
   * For the status answer about a plan: your stops over it and the Bots that worked in it, a line
   * each, once anything still running under one has been ended and recorded as a violation.
   */
  heldLines: (taskId: string) => string[];
};

/** How far down a Bot's handoffs a stop reaches: its handoff, that one's, and one more. */
const HANDOFF_DEPTH = 3;
/** How many turns back one lineage walk goes, a Bot's own turns in a row included. */
const LINEAGE_STEPS = 12;
/** How many files a stopped turn's record keeps. */
const WRITTEN_MAX = 10;
/** A Bot's lines this far back tell who 「你」 is in a group (control-line.ts reads the window). */
const RECENT_WINDOW_MS = 10 * 60_000;

type Ended = { turn: Turn; record: HeldTurn; hold: string };

export function createStop(deps: StopDeps): Stop {
  const { store, publishMessage, publishTurn, admission, lives, executionOf, abortLive, startTurn, hearOrStart } = deps;

  function on(): boolean {
    return store.capabilities().engine_level >= ENGINE_LEVELS.holds;
  }

  function locale(): Locale {
    return store.settingsCached().locale;
  }

  // ── Reading the line ──────────────────────────────────────────────────────────────────────────

  function handleLine(message: Message): boolean {
    if (message.kind !== "user" || admission?.draining || !on()) return false;
    let session: Session;
    try {
      session = store.getSession(message.session_id);
    } catch {
      return false;
    }
    const reading = readControlLine(lineInput(message, session));
    switch (reading.kind) {
      case "none":
        return false;
      case "status":
        // A plain status question the plan's status answer did not take (no plan to report on)
        // takes the path it always took, unless a stop covers what it asks about.
        if (isStatusQuestion(message) && !reading.scopes.some((scope) => scopeHolds(scope, message).length > 0)) return false;
        answerStatus(message, reading.scopes, { offerStop: reading.offerStop });
        return true;
      case "reaffirm":
        answerStatus(message, reading.scopes, { offerStop: false });
        return true;
      case "stop":
        stopByLine(message, reading.scopes, reading.offerCancel);
        return true;
      case "continue":
        return continueByLine(message, session, reading.scopes);
      case "abandon":
        // 「算了」 alone: nothing is stopped or dropped by text; the buttons ask which you meant.
        mark(message, ["stop", "cancel"], reading.scopes);
        return false;
      case "possible_control":
        mark(message, reading.offer, reading.scopes);
        return false;
    }
  }

  function lineInput(message: Message, session: Session): ControlLineInput {
    let parent: Message | null = null;
    if (message.parent_id) {
      try {
        parent = store.getMessage(message.parent_id);
      } catch {
        parent = null;
      }
    }
    const since = new Date(Date.parse(message.created_at) - RECENT_WINDOW_MS).toISOString();
    const recent = store.db
      .query<{ kind: Message["kind"]; author: string; created_at: string }, [string, string, string]>(
        `SELECT kind, author, created_at FROM messages WHERE session_id = ? AND created_at >= ? AND id != ? ORDER BY created_at, rowid`,
      )
      .all(session.id, since, message.id);
    return {
      message,
      sessionKind: session.kind,
      roster: store.listBots().map((bot) => ({ id: bot.id, name: bot.name })),
      present: store.presentBotIds(session.id),
      parent,
      recent,
      planId: store.sessionCurrentTask(session.id)?.id ?? null,
      annotated: Boolean(store.db.query(`SELECT 1 FROM annotations WHERE message_id = ? LIMIT 1`).get(message.id)),
      held: (scopes) => scopes.every((scope) => scopeHolds(scope, message).length > 0),
    };
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

  /** A line that may have meant a stop or a go on: the Bots get it as usual, and it carries the buttons. */
  function mark(message: Message, offer: ControlOffer[], scopes: ControlScope[]): void {
    store.transaction(() => store.setMessageControl(message.id, { kind: "possible_control", offer, scopes }));
  }

  // ── Stopping ──────────────────────────────────────────────────────────────────────────────────

  function stopByLine(message: Message, scopes: ControlScope[], offerCancel: boolean): void {
    const { ended, receipt } = store.transaction(() => {
      const made = scopes.map((scope) =>
        store.createHold({
          scope: scope.scope,
          scopeId: scope.id,
          source: "user_text",
          sourceMessageId: message.id,
          targets: handedOn(scope.scope, scope.id),
        }),
      );
      const ended = endCovered(made);
      const holds = settle(made, ended, message.session_id);
      const offer: ControlOffer[] = ["undo", ...(holds.some((hold) => hold.scope === "global") ? [] : ["stop_all" as const]), ...(offerCancel ? ["cancel" as const] : [])];
      const receipt = store.insertMessage({
        sessionId: message.session_id,
        kind: "system",
        author: authorIn(message.session_id, scopes),
        body: stopReceipt(holds, message.session_id),
        hiddenFromBots: true,
        control: { kind: "receipt", verb: "stop", hold_ids: holds.map((hold) => hold.id), offer, scopes },
      });
      return { ended, receipt };
    });
    for (const { turn } of ended) publishTurn(turn, null);
    publishMessage(receipt);
  }

  function stopByButton(turnId: string, opts: { allowGroup?: boolean }): Turn | null {
    if (!on()) return null;
    const turn = store.getTurn(turnId);
    const bot = turn.bot_id;
    const task = turn.task_id ?? null;
    const scope: HoldScope = task ? "bot_plan" : "turn";
    const scopeId = task ? botPlanScopeId(bot, task) : turn.id;
    // The same refusals as a Stop before holds: a turn already over, a group's turn.
    if (!["running", "waiting_approval", "waiting_ask"].includes(turn.status)) throw new HttpError(422, "invalid_args", "turn is not in progress");
    if (!opts.allowGroup && store.getSession(turn.session_id).kind === "group") throw new HttpError(422, "invalid_args", "group turns cannot be stopped");
    const result = store.transaction(() => {
      const hold = store.createHold({ scope, scopeId, source: "user_button", liftOnNextUserMessage: true, targets: handedOn(scope, scopeId) });
      const ended = endCovered([hold], new Set([turn.id]));
      const [settled] = settle([hold], ended, null);
      let receipt: Message | null = null;
      // Said where you pressed it, when you are there to read it; a Bot↔Bot direct has nobody.
      if (store.isPresent(turn.session_id, USER_MEMBER)) {
        receipt = store.insertMessage({
          sessionId: turn.session_id,
          kind: "system",
          author: bot,
          body: stopReceipt([settled!], turn.session_id),
          hiddenFromBots: true,
          control: { kind: "receipt", verb: "stop", hold_ids: [hold.id], offer: ["undo"], scopes: [] },
        });
      }
      return { ended, receipt };
    });
    for (const { turn: ended } of result.ended) publishTurn(ended, null);
    if (result.receipt) publishMessage(result.receipt);
    return result.ended.find((row) => row.turn.id === turnId)?.turn ?? store.getTurn(turnId);
  }

  function hold(input: HoldRequest): Hold {
    const { ended, made } = store.transaction(() => {
      const scope = input.scope as HoldScope;
      const scopeId = (input.scopeId ?? null) as string | null;
      const cascade = input.cascade ?? true;
      const created = store.createHold({
        scope: input.scope,
        scopeId: input.scopeId,
        action: input.action,
        cascade: input.cascade,
        liftOnNextUserMessage: input.liftOnNextUserMessage,
        source: "user_button",
        targets: cascade === true && typeof scopeId === "string" ? handedOn(scope, scopeId) : [],
      });
      const ended = endCovered([created]);
      const [made] = settle([created], ended, null);
      return { ended, made: made! };
    });
    for (const { turn } of ended) publishTurn(turn, null);
    return made;
  }

  function enforce(): void {
    if (!on()) return;
    const ended = store.transaction(() => endCovered(null));
    for (const { turn } of ended) publishTurn(turn, null);
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
    const candidates = store.db
      .query<{ id: string }, []>(
        `SELECT id FROM turns WHERE status IN ('running', 'waiting_approval', 'waiting_ask')
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

  /**
   * Ends every live turn a hold covers — only those `made` covers, when given — as stopped, keeping
   * its check-backs for the lift, and records on that hold what each was doing. A read-only turn
   * a hold let open is left to answer, unless it is one `also` names. The abort itself runs once
   * the write is in: the turn's model call, its MCP calls and its commands' process groups.
   */
  function endCovered(made: Hold[] | null, also: Set<string> = new Set()): Ended[] {
    const ended: Ended[] = [];
    for (const turn of store.listLiveTurns()) {
      if (turn.mode === "readonly" && !also.has(turn.id)) continue;
      const covering = store.turnHeldBy(turn.id);
      const owner = [...covering].reverse().find((hold) => made === null || made.some((row) => row.id === hold.id));
      if (!owner) continue;
      const live = lives.get(turn.id);
      const record = heldTurn(turn, live);
      const stopped = store.stopTurn(turn.id, { allowGroup: true, execution: executionOf(live), keepCheckBacks: true });
      if (!stopped) continue;
      store.addHoldEffect(owner.id, { stopped_turns: [record] });
      abortLive(turn.id);
      ended.push({ turn: stopped, record, hold: owner.id });
    }
    return ended;
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
   * What the receipt says beside what was ended, measured now and recorded on each hold: the other
   * Bots' turns in the same plans that it does not cover, and anything it covers still running.
   * Records a `control.hold` in the work log for each. Returns the holds as they now read.
   */
  function settle(made: Hold[], ended: Ended[], sessionId: string | null): Hold[] {
    const live = store.listLiveTurns();
    return made.map((hold) => {
      const mine = ended.filter((row) => row.hold === hold.id);
      const plans = new Set(mine.map((row) => row.record.task_id).filter((id): id is string => id !== null));
      const oneBot = hold.scope === "bot" || hold.scope === "bot_plan" || hold.scope === "turn";
      const beside = oneBot
        ? live
            .filter((turn) => turn.task_id && plans.has(turn.task_id) && store.turnHeldBy(turn.id).length === 0)
            .map((turn) => ({ turn_id: turn.id, bot_id: turn.bot_id, task_id: turn.task_id ?? null, ticket_id: turn.ticket_id ?? null }))
        : [];
      const still = live.filter((turn) => turn.mode !== "readonly" && store.turnHeldBy(turn.id).some((row) => row.id === hold.id)).map((turn) => turn.id);
      store.addHoldEffect(hold.id, { working_beside: beside, still_running: still });
      store.recordWorkEvent({
        kind: "control.hold",
        actor: "user",
        sessionId,
        payload: { hold: hold.id, scope: hold.scope, scope_id: hold.scope_id, source: hold.source, stopped: mine.map((row) => row.turn.id) },
      });
      return store.getHold(hold.id);
    });
  }

  // ── Going on ──────────────────────────────────────────────────────────────────────────────────

  function continueByLine(message: Message, session: Session, scopes: ControlScope[]): boolean {
    const named = holdsToLift(session, scopes);
    const everything = scopes.some((scope) => scope.scope === "global");
    // The Stops the line is about, those on a Bot the words leave out aside: 「@X 继续」 in a group
    // says nothing to the other Bots on the plan it lands on, and their Stops stay.
    const about = stopsAbout(message).filter((hold) => everything || scopes.some((scope) => scope.scope !== "bot" || stopOnBot(hold, scope.id)));
    const withLine = new Set(about.map((hold) => hold.id));
    // Your Stops on the work of a Bot the words name, on a job the line does not land on (one it
    // was doing in a direct with another Bot, say): 「继续」 to that Bot is about them all the same,
    // and no line of yours there would ever lift them. A go on that names everything is about
    // every Stop you pressed before it, wherever it was.
    const away = (everything ? store.listHolds({ inForce: true }).filter((hold) => stopBefore(hold, message)) : stopsOnBots(message, scopes)).filter(
      (hold) => !withLine.has(hold.id),
    );
    if (named.length === 0 && away.length === 0) {
      // Nothing the words lift, and nothing wider holding what they name: 「继续」 is how you tell a
      // Bot to go on with its next step, an ordinary line. A Stop's hold on the job it is about
      // goes with it once it is filed (`liftOnYourLine`), and the Bot goes on from it.
      if (!scopes.some((scope) => scopeHolds(scope, message).some((hold) => !withLine.has(hold.id)))) return false;
      answerStatus(message, scopes, { offerStop: false, offerContinue: true });
      return true;
    }
    // The line goes nowhere else now, so the Stops it is about go with it here, and their work
    // opens again on the same note as the rest: the note is how your words reach it.
    const ids = new Set([...named, ...about, ...away].map((hold) => hold.id));
    // Oldest first, the way they were made.
    const toLift = store.listHolds({ inForce: true }).reverse().filter((hold) => ids.has(hold.id));
    const { receipt, resumed } = store.transaction(() => {
      const said = saidOf(message);
      const lifted = toLift.map((hold) => store.liftHold(hold.id, { by: "user_text", messageId: message.id }));
      for (const hold of lifted) {
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: message.session_id, payload: { hold: hold.id, by: "user_text" } });
      }
      const resumed = resumeLifted(lifted, said, { stops: true });
      const current = lifted.map((hold) => store.getHold(hold.id));
      const stillHeld = heldAbout(scopes, session.id, message);
      const receipt = store.insertMessage({
        sessionId: message.session_id,
        kind: "system",
        author: authorIn(message.session_id, scopes),
        body: continueReceiptBody(locale(), {
          lifted: current.map((hold) => ({ scope: scopeLabel(hold, message.session_id), said: holdSaid(hold) })),
          resumed: resumed.map((row) => turnLine(row.record, message.session_id, headingBots(scopes))),
          resumedCheckBacks: current.reduce((sum, hold) => sum + (hold.effect.resumed_check_backs?.length ?? 0), 0),
          restored: current.flatMap((hold) => hold.effect.restored_plans ?? []).map((id) => planTitle(id) ?? id),
          stillHeld: stillHeld.map((hold) => ({ scope: scopeLabel(hold, message.session_id), said: holdSaid(hold) })),
        }),
        hiddenFromBots: true,
        control: {
          kind: "receipt",
          verb: "continue",
          hold_ids: current.map((hold) => hold.id),
          // The buttons are for a wider stop the words could not lift; a Stop's goes with your next line about its job.
          offer: stillHeld.some((hold) => !hold.lift_on_next_user_message) ? ["continue_only", "continue_all"] : [],
          scopes,
        },
      });
      return { receipt, resumed };
    });
    publishMessage(receipt);
    for (const row of resumed) publishMessage(row.line);
    return true;
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

  /**
   * Opens again the turns the lifted holds ended, each on a note with your words and where it was;
   * one another hold still covers is handed to that hold, to go on when it is lifted — to one that
   * opens its work again then, when there is one. A Stop's hold opens nothing again unless `stops`
   * says so (a go on that lifted it along with the rest): Stop means "not this", and your next line
   * is what the Bot goes on from.
   */
  function resumeLifted(lifted: Hold[], said: SaidLine, opts: { stops: boolean }): Array<{ record: HeldTurn; line: Message; turn: Turn }> {
    const resumed: Array<{ record: HeldTurn; line: Message; turn: Turn }> = [];
    const seen = new Set<string>();
    for (const hold of lifted) {
      if (hold.lift_on_next_user_message && !opts.stops) continue;
      for (const record of [...(hold.effect.stopped_turns ?? []), ...(hold.effect.held_over ?? [])]) {
        const key = `${record.bot_id}|${record.session_id}|${record.task_id ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const still = store.holdsCovering({
          botId: record.bot_id,
          sessionId: record.session_id,
          taskId: record.task_id,
          ticketId: record.ticket_id,
          turnId: record.turn_id,
        });
        if (still.length > 0) {
          const heir = [...still].reverse().find((row) => !row.lift_on_next_user_message) ?? still.at(-1)!;
          store.addHoldEffect(heir.id, { held_over: [record] });
          continue;
        }
        const opened = resume(record, said);
        if (!opened) continue;
        store.addHoldEffect(hold.id, { resumed_turns: [opened.turn.id] });
        resumed.push({ record, ...opened });
      }
    }
    return resumed;
  }

  /** One stopped turn's work, opened again on a note in the conversation it ran in. */
  function resume(record: HeldTurn, said: SaidLine): { line: Message; turn: Turn } | null {
    if (admission?.draining) return null;
    let session: Session;
    try {
      session = store.getSession(record.session_id);
      if (store.getBot(record.bot_id).archived_at) return null;
    } catch {
      return null;
    }
    if (!store.isPresent(session.id, record.bot_id)) return null;
    // The work went on some other way meanwhile: the Bot is at it there already (a read-only turn
    // answering you is at nothing).
    const atIt = store.listLiveTurns({ sessionId: session.id, botId: record.bot_id }).some((turn) => turn.mode !== "readonly" && (turn.task_id ?? null) === record.task_id);
    if (atIt) return null;
    const line = store.insertMessage({
      sessionId: session.id,
      turnId: record.turn_id,
      kind: "system",
      author: record.bot_id,
      body: resumeNote(locale(), { said, plan: planTag(record.task_id, record.ticket_id), written: record.written, recent: record.recent }),
    });
    const lands = { taskId: record.task_id, ticketId: record.task_id ? record.ticket_id : null };
    // In a direct with you, beside whatever the Bot took up there meanwhile, as a line of yours
    // would, never cutting it off. Elsewhere a Bot works one turn at a time (ADR 0016): one it has
    // there already hears the note instead, and a new one opens only beside a turn that cannot.
    const withYou = session.kind !== "group" && store.isPresent(session.id, USER_MEMBER);
    const turn = withYou
      ? startTurn(session.id, record.bot_id, line, "fork", { cause: "resume", ...lands })
      : hearOrStart(
          session.id,
          record.bot_id,
          line,
          { item: { author: locale() === "en" ? "App" : "应用", body: line.body, checkBack: false } },
          { cause: "resume", ...lands, otherwise: "fork" },
        );
    return turn ? { line, turn } : null;
  }

  function lift(id: string): Hold {
    const { hold, resumed } = store.transaction(() => {
      // Lifting one already lifted changes nothing, and opens nothing again.
      if (store.getHold(id).lifted_at) return { hold: store.getHold(id), resumed: [] };
      const lifted = store.liftHold(id, { by: "user_button" });
      const resumed = resumeLifted([lifted], null, { stops: false });
      store.recordWorkEvent({ kind: "control.lift", actor: "user", payload: { hold: id, by: "user_button" } });
      return { hold: store.getHold(id), resumed };
    });
    for (const row of resumed) publishMessage(row.line);
    return hold;
  }

  function liftOnYourLine(message: Message): void {
    if (message.kind !== "user" || message.control || !on()) return;
    const about = stopsAbout(message);
    if (about.length === 0) return;
    store.transaction(() => {
      for (const hold of about) {
        store.liftHold(hold.id, { by: "user_text", messageId: message.id });
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: message.session_id, payload: { hold: hold.id, by: "user_text", next_line: true } });
      }
    });
  }

  /**
   * The Stops your line is about: on a Bot's work in the plan the line is filed under, or would
   * land on for that Bot; on a turn in the conversation it is said in. Only a line said after the
   * Stop — one sent just before, still being filed when the Stop landed, is not what you said to it.
   */
  function stopsAbout(message: Message): Hold[] {
    return store.listHolds({ inForce: true }).filter((hold) => {
      if (!stopBefore(hold, message) || hold.scope_id === null) return false;
      if (hold.scope === "turn") return turnRow(hold.scope_id)?.session_id === message.session_id;
      if (hold.scope !== "bot_plan") return false;
      const [botId, taskId] = hold.scope_id.split(":");
      return landedPlan(message, botId!) === taskId;
    });
  }

  /** Your Stops on the work of the Bots a go on names, wherever that work was; pressed before the line. */
  function stopsOnBots(message: Message, scopes: ControlScope[]): Hold[] {
    const bots = scopes.flatMap((scope) => (scope.scope === "bot" ? [scope.id] : []));
    if (bots.length === 0) return [];
    return store.listHolds({ inForce: true }).filter((hold) => stopBefore(hold, message) && bots.some((bot) => stopOnBot(hold, bot)));
  }

  /** A Stop's hold, pressed before `message` was said. */
  function stopBefore(hold: Hold, message: Message): boolean {
    return hold.lift_on_next_user_message && message.created_at > hold.created_at;
  }

  // ── Answering ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The answer to 「停了吗」 and 「你没停」: what holds the work asked about and what of it runs,
   * checked afresh — anything found still running under one of those holds is ended first and
   * recorded as a violation (there should never be any). `offerContinue`: a go on the words could
   * not lift, since something wider holds it; the answer offers the buttons.
   */
  function answerStatus(message: Message, scopes: ControlScope[], opts: { offerStop: boolean; offerContinue?: boolean }): void {
    const here = message.session_id;
    const { answer, ended } = store.transaction(() => {
      const holds = heldAbout(scopes, here, message);
      const ended = endViolations(holds);
      const running = store.listLiveTurns().filter((turn) => turn.mode !== "readonly" && scopes.some((scope) => inScope(scope, turn)));
      const offerStop = opts.offerStop && holds.length === 0;
      const offer: ControlOffer[] = offerStop ? ["stop"] : opts.offerContinue ? ["continue_only", "continue_all"] : [];
      const heading = headingBots(scopes);
      const answer = store.insertMessage({
        sessionId: here,
        kind: "system",
        author: authorIn(here, scopes),
        body: controlStatusBody(locale(), {
          about: scopes.map((scope) => aboutLabel(scope, here)).join(locale() === "en" ? ", " : "、"),
          holds: holds.map((hold) => ({ scope: scopeLabel(hold, here), said: holdSaid(hold), since: clockOf(hold.created_at) })),
          running: running.map((turn) => turnLine(heldTurn(turn, lives.get(turn.id)), here, heading)),
          ended: ended.map((row) => turnLine(row.record, here, heading)),
          offerStop,
        }),
        hiddenFromBots: true,
        control: { kind: "status", hold_ids: holds.map((hold) => hold.id), offer, scopes },
      });
      return { answer, ended };
    });
    for (const { turn } of ended) publishTurn(turn, null);
    publishMessage(answer);
  }

  /**
   * Ends whatever still runs under these holds, records each as a violation on the hold and in the
   * work log (`hold.violation`), and returns them. A stop ends what it covers when it is made, so
   * this finds something only when that went wrong.
   */
  function endViolations(holds: Hold[]): Ended[] {
    if (holds.length === 0) return [];
    const ended = endCovered(holds);
    for (const row of ended) {
      store.addHoldEffect(row.hold, { violations: [row.turn.id] });
      store.recordWorkEvent({
        kind: "hold.violation",
        actor: "app",
        botId: row.turn.bot_id,
        sessionId: row.turn.session_id,
        taskId: row.turn.task_id ?? null,
        turnId: row.turn.id,
        payload: { hold: row.hold },
      });
    }
    return ended;
  }

  function heldLinesFor(taskId: string): string[] {
    if (!on()) return [];
    // The plan as a whole, a Stop on part of it, and the Bots that have worked in it.
    const bots = store.db.query<{ bot_id: string }, [string]>(`SELECT DISTINCT bot_id FROM turns WHERE task_id = ?`).all(taskId);
    const scopes: ControlScope[] = [{ scope: "plan", id: taskId }, ...bots.map((row) => ({ scope: "bot" as const, id: row.bot_id }))];
    const home = store.getTask(taskId).session_id ?? null;
    const { holds, ended } = store.transaction(() => {
      const holds = heldAbout(scopes, home);
      return { holds, ended: endViolations(holds) };
    });
    for (const { turn } of ended) publishTurn(turn, null);
    if (holds.length === 0) return [];
    const here = home ?? "";
    return heldLines(locale(), {
      about: null,
      holds: holds.map((hold) => ({ scope: scopeLabel(hold, here), said: holdSaid(hold), since: clockOf(hold.created_at) })),
      ended: ended.map((row) => turnLine(row.record, here, new Set())),
    });
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

  /** A hold on part of a Bot's work, as a Stop makes: on it in one plan, or on one of its turns. */
  function stopOnBot(hold: Hold, botId: string): boolean {
    if (hold.scope === "bot_plan") return hold.scope_id?.startsWith(`${botId}:`) === true;
    return hold.scope === "turn" && hold.scope_id !== null && turnRow(hold.scope_id)?.bot_id === botId;
  }

  function inScope(scope: ControlScope, turn: Turn): boolean {
    return scope.scope === "global" || covers(scope.scope, scope.id, turn);
  }

  // ── Words ─────────────────────────────────────────────────────────────────────────────────────

  function stopReceipt(holds: Hold[], here: string): string {
    const heading = new Set(holds.flatMap((hold) => (hold.scope === "bot" ? [hold.scope_id!] : hold.scope === "bot_plan" ? [hold.scope_id!.split(":")[0]!] : [])));
    const effects = holds.map((hold) => hold.effect);
    return stopReceiptBody(locale(), {
      scopes: holds.map((hold) => scopeLabel(hold, here)),
      said: holdSaid(holds[0]!),
      stopped: effects.flatMap((effect) => effect.stopped_turns ?? []).map((record) => turnLine(record, here, heading)),
      suspended: effects.reduce((sum, effect) => sum + (effect.suspended_check_backs?.length ?? 0), 0),
      parked: effects.flatMap((effect) => effect.parked_plans ?? []).map((row) => planTitle(row.task_id) ?? row.task_id),
      beside: effects
        .flatMap((effect) => effect.working_beside ?? [])
        .map((row) => ({ bot: botName(row.bot_id), plan: planTitle(row.task_id!) ?? "", ticket: row.ticket_id ? ticketLabel(row.ticket_id) : null })),
      stillRunning: effects.flatMap((effect) => effect.still_running ?? []).flatMap((id) => {
        const turn = safeTurn(id);
        return turn ? [turnLine(heldTurn(turn, lives.get(id)), here, heading)] : [];
      }),
      liftOnNextLine: holds.some((hold) => hold.lift_on_next_user_message),
      global: holds.some((hold) => hold.scope === "global"),
    });
  }

  function turnLine(record: HeldTurn, here: string, heading: Set<string>): ControlTurnLine {
    return {
      bot: heading.has(record.bot_id) ? null : botName(record.bot_id),
      plan: record.task_id ? planTitle(record.task_id) : null,
      where: record.session_id === here ? null : placeOf(record.session_id),
      lastStep: record.recent.at(-1) ?? null,
    };
  }

  function headingBots(scopes: ControlScope[]): Set<string> {
    return new Set(scopes.flatMap((scope) => (scope.scope === "bot" ? [scope.id] : [])));
  }

  /** A hold's scope in words, for you. */
  function scopeLabel(hold: Hold, here: string): string {
    const en = locale() === "en";
    const id = hold.scope_id ?? "";
    switch (hold.scope) {
      case "global":
        return en ? "every Bot's work" : "所有 Bot 的工作";
      case "bot":
        return en ? `all of ${botName(id)}'s work` : `${botName(id)}的全部工作`;
      case "session":
        return id === here ? (en ? "the work here" : "这里的工作") : en ? `the work in ${placeOf(id)}` : `${placeOf(id)}里的工作`;
      case "plan":
        return en ? `the job "${planTitle(id) ?? id}"` : `「${planTitle(id) ?? id}」这件事`;
      case "ticket":
        return ticketLabel(id);
      case "bot_plan": {
        const [botId, taskId] = id.split(":");
        return en ? `${botName(botId!)}'s work on "${planTitle(taskId!) ?? taskId}"` : `${botName(botId!)}在「${planTitle(taskId!) ?? taskId}」上的工作`;
      }
      case "turn": {
        const turn = turnRow(id);
        return en ? `${turn ? botName(turn.bot_id) : "a Bot"}'s turn` : `${turn ? botName(turn.bot_id) : "一个 Bot"}的这一段`;
      }
    }
  }

  /** What you asked about, in words. */
  function aboutLabel(scope: ControlScope, here: string): string {
    const en = locale() === "en";
    switch (scope.scope) {
      case "global":
        return en ? "every Bot" : "所有 Bot";
      case "bot":
        return botName(scope.id);
      case "session":
        return scope.id === here ? (en ? "this conversation" : "这里") : (placeOf(scope.id) ?? scope.id);
      case "plan":
        return en ? `"${planTitle(scope.id) ?? scope.id}"` : `「${planTitle(scope.id) ?? scope.id}」`;
    }
  }

  /** A conversation, as you would name it. */
  function placeOf(sessionId: string): string {
    const en = locale() === "en";
    let session: Session;
    try {
      session = store.getSession(sessionId);
    } catch {
      return en ? "a conversation since deleted" : "一个已删除的会话";
    }
    if (session.kind === "group") return session.name ? (en ? `group "${session.name}"` : `群「${session.name}」`) : en ? "a group" : "一个群";
    const bots = store.presentBotIds(sessionId).map(botName);
    if (store.isPresent(sessionId, USER_MEMBER)) return en ? `your direct with ${bots[0] ?? "?"}` : `你和${bots[0] ?? "?"}的私聊`;
    return en ? `the direct between ${bots.join(" and ")}` : `${bots.join("和")}的私聊`;
  }

  /** The line that made a hold, as a receipt quotes it; null for a button or a line since cleared. */
  function holdSaid(hold: Hold): SaidLine {
    if (!hold.source_message_id) return null;
    try {
      return saidOf(store.getMessage(hold.source_message_id));
    } catch {
      return null;
    }
  }

  function planTag(taskId: string | null, ticketId: string | null): string | null {
    if (!taskId) return null;
    const en = locale() === "en";
    const title = planTitle(taskId) ?? taskId;
    const plan = en ? `the plan "${title}"` : `规划「${title}」`;
    return ticketId ? (en ? `${plan}, ${ticketLabel(ticketId)}` : `${plan}的${ticketLabel(ticketId)}`) : plan;
  }

  function ticketLabel(ticketId: string): string {
    const en = locale() === "en";
    try {
      const ticket = store.getTicket(ticketId);
      const seq = String(ticket.seq).padStart(2, "0");
      return en ? `ticket ${seq} "${ticket.title}"` : `任务 ${seq}《${ticket.title}》`;
    } catch {
      return en ? "a ticket" : "一个任务";
    }
  }

  function botName(id: string): string {
    try {
      return store.getBot(id).name;
    } catch {
      return id;
    }
  }

  function planTitle(id: string): string | null {
    try {
      return store.getTask(id).title;
    } catch {
      return null;
    }
  }

  function safeTurn(id: string): Turn | null {
    try {
      return store.getTurn(id);
    } catch {
      return null;
    }
  }

  /**
   * Who the app's line stands under: in a direct, its Bot, as a status answer does; elsewhere the
   * Bot the line names, else nobody in particular.
   */
  function authorIn(sessionId: string, scopes: ControlScope[]): string {
    try {
      if (store.getSession(sessionId).kind === "direct") {
        const bot = store.presentBotIds(sessionId)[0];
        if (bot) return bot;
      }
    } catch {
      // the conversation is gone; the line below has nowhere to go either
    }
    const named = scopes.find((scope) => scope.scope === "bot");
    return named?.scope === "bot" ? named.id : USER_MEMBER;
  }

  return { on, handleLine, liftOnYourLine, stopByButton, hold, lift, enforce, heldLines: heldLinesFor };
}

