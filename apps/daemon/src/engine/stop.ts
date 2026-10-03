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
 * the buttons. A Stop's hold goes with your next line to its Bot about its job, and a 「继续」 that
 * nothing else holds back is that line; a go on to the Bot said away from that job, or one that
 * names everything, lifts it and opens the work again on the note, like any other. A line or a go
 * on to one Bot leaves the other Bots' Stops alone. A group's stop menu stops the same way, on the
 * group, a Bot or a job: your next line there is what the Bots go on from. Your line to a Bot a
 * stop that stays still holds gets a read-only answer; one that says nothing is answered by the
 * app instead, with the buttons to go on.
 *
 * The app's lines about your stops carry buttons (`MessageControl`), and `act` carries them out:
 * undo a stop (a line read as one then reaches the Bots as any line), widen it to every Bot or to
 * the plan other Bots are working in, narrow a stop on a Bot to one plan, drop the job, or let one
 * Bot go on under a wider stop by splitting that stop into one per other Bot. A stop from a menu
 * or a button gets the same receipt as one you said.
 *
 * Work items and their inbox, external jobs and upstream waits (ADR 0040 P4) do not exist yet, so
 * "the work a hold covers" is live turns, check-backs and plans, and a delegation is the lineage of
 * turns and the lines that opened them.
 */
import {
  USER_MEMBER,
  type ControlActionResult,
  type ControlOffer,
  type ControlPlanOffer,
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
import { controlScopes, readControlLine, type ControlLineInput } from "../control-line";
import { HttpError } from "../errors";
import type { UserLineReading } from "../line-reading";
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
  /** Sends a line of yours on as any line — filed, heard, waking whom it wakes — without reading it for control again. */
  redeliver: (message: Message) => void;
  /** The Bots a line is about to wake, as participation reads it before anything opens. */
  wakes: (message: Message) => string[];
};

/** What `POST /v1/holds` asks for; `source` is always your button. */
export type HoldRequest = {
  scope: unknown;
  scopeId?: unknown;
  action?: unknown;
  cascade?: unknown;
  liftOnNextUserMessage?: unknown;
  /** The conversation the stop menu was in: the receipt goes there when you are in it. */
  sessionId?: unknown;
};

/** What the rules made of a line of yours (see `Stop.ruleLine`). */
export type RuledLine = { done: boolean; decided: boolean };
const DONE: RuledLine = { done: true, decided: true };
const OPEN: RuledLine = { done: false, decided: false };

export type Stop = {
  /** Holds are on: the engine level has reached them (ADR 0040's version gate). */
  on: () => boolean;
  /**
   * Reads a line of yours by the fixed rules (`control-line.ts`), before any model reads it: a line
   * that is nothing but a stop, a go on, 「没停」, 「算了」 or a question about stopping is carried
   * out at once. `done` when nothing else is to happen with the line; `decided` when the rules have
   * said all there is about it as control, so `readLine` is not asked.
   */
  ruleLine: (message: Message) => RuledLine;
  /**
   * The rest, once the line is read (ADR 0055): a line the model read as nothing but a stop or a go
   * on is carried out like one the rules found; one that says it beside something else carries the
   * buttons; one that only asks where the work stands, under a stop, gets the status answer. Read by
   * the word lists, the rules' own reading stands. True when nothing else is to happen with it.
   */
  readLine: (message: Message, reading: UserLineReading) => boolean;
  /**
   * Your line, once filed: a Stop's hold on the job it is about, on a Bot the line is said to, goes
   * before the line wakes anyone, so the Bot goes on from what you said; so does a group stop
   * menu's hold, on the group, a Bot or a job, that the line is about. Only a line said after the
   * stop counts.
   */
  liftOnYourLine: (message: Message) => void;
  /**
   * A read-only answer under a stop that ended having said nothing: in its place the app says the
   * Bot is stopped, with the buttons to go on, which also open its work on your line.
   */
  unanswered: (turn: Turn) => void;
  /**
   * Stop on a turn's card, in a direct or a group: a hold on this Bot's work in its plan (on the
   * turn, when it has no plan) that your next line about that job lifts, and the turn ends under it.
   * Null before holds are on, so the caller stops it the way it did before them.
   */
  stopByButton: (turnId: string) => Turn | null;
  /** `POST /v1/holds`: the hold, and the live turns it covers ended; with a conversation, its receipt there. */
  hold: (input: HoldRequest) => Hold;
  /**
   * `POST /v1/messages/:id/control`: a button on a line `control` marks, carried out. Refused unless
   * the line offers it; a line already pressed on does nothing more (a second tap, a retry).
   */
  act: (messageId: string, input: { action: unknown; taskId?: unknown }) => ControlActionResult;
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
/** How many of your latest lines in a conversation say which jobs are being talked about there, for the status answer. */
const RECENT_FILINGS = 20;
/** How many plans a receipt offers to widen a stop to, and as many to narrow it to. */
const PLAN_OFFERS_MAX = 3;

type Ended = { turn: Turn; record: HeldTurn; hold: string };

export function createStop(deps: StopDeps): Stop {
  const { store, publishMessage, publishTurn, admission, lives, executionOf, abortLive, startTurn, hearOrStart, redeliver, wakes } = deps;

  function on(): boolean {
    return store.capabilities().engine_level >= ENGINE_LEVELS.holds;
  }

  function locale(): Locale {
    return store.settingsCached().locale;
  }

  // ── Reading the line ──────────────────────────────────────────────────────────────────────────

  function ruleLine(message: Message): RuledLine {
    if (message.kind !== "user" || admission?.draining || !on()) return OPEN;
    let session: Session;
    try {
      session = store.getSession(message.session_id);
    } catch {
      return OPEN;
    }
    const reading = readControlLine(lineInput(message, session));
    switch (reading.kind) {
      // No control word the rules know, a plain status question, or a control word in a longer
      // line: what the line means is the reading's to say (`readLine`).
      case "none":
      case "possible_control":
        return OPEN;
      case "status":
        if (isStatusQuestion(message)) return OPEN;
        answerStatus(message, reading.scopes, { offerStop: reading.offerStop });
        return DONE;
      case "reaffirm":
        answerStatus(message, reading.scopes, { offerStop: false });
        return DONE;
      case "stop":
        stopByLine(message, reading.scopes, reading.offerCancel);
        return DONE;
      case "continue":
        return { done: continueByLine(message, session, reading.scopes), decided: true };
      case "abandon":
        // 「算了」 alone: nothing is stopped or dropped by text; the buttons ask which you meant.
        mark(message, ["stop", "cancel"], reading.scopes);
        return { done: false, decided: true };
    }
  }

  function readLine(message: Message, line: UserLineReading): boolean {
    if (message.kind !== "user" || admission?.draining || !on()) return false;
    let session: Session;
    try {
      session = store.getSession(message.session_id);
    } catch {
      return false;
    }
    const input = lineInput(message, session);
    // Read by the word lists: the rules' own reading stands, as it always did.
    if (line.control === null) {
      const rules = readControlLine(input);
      if (rules.kind === "status") return statusLine(message, rules.scopes, line);
      if (rules.kind === "possible_control") offerButtons(message, session, rules.offer, rules.scopes);
      return false;
    }
    const scopes = controlScopes(input);
    if (line.statusOnly && line.control === "none") return statusLine(message, scopes, line);
    switch (line.control) {
      case "none":
        return false;
      case "stop":
        if (line.controlOnly) {
          stopByLine(message, scopes, false);
          return true;
        }
        offerButtons(message, session, ["stop"], scopes);
        return false;
      case "go_on":
        if (line.controlOnly) return continueByLine(message, session, scopes);
        offerButtons(message, session, ["continue"], scopes);
        return false;
      case "both":
        offerButtons(message, session, ["stop", "continue"], scopes);
        return false;
    }
  }

  /**
   * A line that only asks where the work stands, which the plan's status answer did not take (no
   * plan to report on): it takes the path any line takes, unless a stop covers what it asks about.
   */
  function statusLine(message: Message, scopes: ControlScope[], line: UserLineReading): boolean {
    if (!line.statusOnly || !scopes.some((scope) => scopeHolds(scope, message).length > 0)) return false;
    answerStatus(message, scopes, { offerStop: false });
    return true;
  }

  /**
   * The buttons on a line that may have meant a stop or a go on. 继续 on the hint lifts your stops,
   * so it is offered only while there is one it would lift. With none, pressing it could only answer
   * 「没有被叫停」 and read 「已继续」 under a request that went on as any line (「继续做第二集，……」
   * with nothing stopped).
   */
  function offerButtons(message: Message, session: Session, verbs: ControlOffer[], scopes: ControlScope[]): void {
    const offer = verbs.filter((action) => action !== "continue" || goOnLifts(message, session, scopes));
    if (offer.length > 0) mark(message, offer, scopes);
  }

  /** Whether a go on said with `message` would lift anything now, or meet a stop that holds what it names. */
  function goOnLifts(message: Message, session: Session, scopes: ControlScope[]): boolean {
    if (holdsToLift(session, scopes).length > 0 || stopsAbout(message).length > 0 || stopsOnBots(message, scopes).length > 0) return true;
    if (scopes.some((scope) => scope.scope === "global") && store.listHolds({ inForce: true }).some((hold) => stopBefore(hold, message))) return true;
    return scopes.some((scope) => scopeHolds(scope, message).length > 0);
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
    carryOut(() => scopes.map((scope) => holdOn(scope, { source: "user_text", sourceMessageId: message.id })), {
      in: message.session_id,
      scopes,
      offerCancel,
    });
  }

  /** A hold of yours on a scope a line or a button names, with the work it handed on. */
  function holdOn(
    scope: { scope: HoldScope; id: string | null },
    opts: { source: "user_text" | "user_button"; sourceMessageId?: string | null; action?: "pause" | "cancel" },
  ): Hold {
    return store.createHold({
      scope: scope.scope,
      scopeId: scope.id,
      action: opts.action,
      source: opts.source,
      sourceMessageId: opts.sourceMessageId ?? null,
      targets: handedOn(scope.scope, scope.id),
    });
  }

  /**
   * A stop in one write: the holds `create` makes, every live turn they cover ended, what beside it
   * goes on recorded, and — when `receipt.in` names a conversation you are in — the receipt there.
   * The aborts and the publishing follow once it is written.
   */
  function carryOut(
    create: () => Hold[],
    receipt: { in: string | null; scopes: ControlScope[]; offerCancel?: boolean },
  ): { made: Hold[]; receipt: Message | null } {
    const result = store.transaction(() => {
      const created = create();
      const ended = endCovered(created);
      const made = settle(created, ended, receipt.in);
      const line = receipt.in && store.isPresent(receipt.in, USER_MEMBER) ? stopReceiptLine(made, receipt.in, receipt) : null;
      return { ended, made, line };
    });
    for (const { turn } of result.ended) publishTurn(turn, null);
    if (result.line) publishMessage(result.line);
    return { made: result.made, receipt: result.line };
  }

  /** The receipt for a stop you said, chose from a menu or confirmed on a button, with its buttons. */
  function stopReceiptLine(holds: Hold[], sessionId: string, opts: { scopes: ControlScope[]; offerCancel?: boolean }): Message {
    const offer: ControlOffer[] = ["undo", ...(holds.some((hold) => hold.scope === "global") ? [] : ["stop_all" as const]), ...(opts.offerCancel ? ["cancel" as const] : [])];
    const plans = planOffers(holds);
    return store.insertMessage({
      sessionId,
      kind: "system",
      author: authorIn(sessionId, opts.scopes),
      body: stopReceipt(holds, sessionId),
      hiddenFromBots: true,
      control: { kind: "receipt", verb: "stop", hold_ids: holds.map((hold) => hold.id), offer, scopes: opts.scopes, ...(plans.length > 0 ? { plans } : {}) },
    });
  }

  /**
   * The plans a stop's receipt offers to widen it to — one other Bots were still working in — and
   * to narrow a stop on a whole Bot to: each plan its stopped work was in.
   */
  function planOffers(holds: Hold[]): ControlPlanOffer[] {
    const widen = new Set<string>();
    const narrow = new Set<string>();
    for (const hold of holds) {
      for (const row of hold.effect.working_beside ?? []) if (row.task_id) widen.add(row.task_id);
      if (hold.scope !== "bot") continue;
      for (const record of hold.effect.stopped_turns ?? []) if (record.task_id) narrow.add(record.task_id);
    }
    const offers = (offer: ControlPlanOffer["offer"], ids: Set<string>) =>
      [...ids].slice(0, PLAN_OFFERS_MAX).flatMap((id) => {
        const title = planTitle(id);
        return title === null ? [] : [{ offer, task_id: id, title }];
      });
    return [...offers("stop_plan", widen), ...offers("only_plan", narrow)];
  }

  function stopByButton(turnId: string): Turn | null {
    if (!on()) return null;
    const turn = store.getTurn(turnId);
    const bot = turn.bot_id;
    const task = turn.task_id ?? null;
    const scope: HoldScope = task ? "bot_plan" : "turn";
    const scopeId = task ? botPlanScopeId(bot, task) : turn.id;
    // A turn already over is refused, as a Stop before holds was. A group's turn is not any more:
    // one Bot's work in a group is stopped the same way as in a direct (ADR 0040 P2).
    if (!["running", "waiting_approval", "waiting_ask"].includes(turn.status)) throw new HttpError(422, "invalid_args", "turn is not in progress");
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
    const scope = input.scope as HoldScope;
    const scopeId = (input.scopeId ?? null) as string | null;
    const cascade = input.cascade ?? true;
    if (input.sessionId !== undefined && input.sessionId !== null && typeof input.sessionId !== "string") {
      throw new HttpError(422, "invalid_args", "session_id must be a string");
    }
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : null;
    if (sessionId) store.getSession(sessionId);
    const { made } = carryOut(
      () => [
        store.createHold({
          scope: input.scope,
          scopeId: input.scopeId,
          action: input.action,
          cascade: input.cascade,
          liftOnNextUserMessage: input.liftOnNextUserMessage,
          source: "user_button",
          targets: cascade === true && typeof scopeId === "string" ? handedOn(scope, scopeId) : [],
        }),
      ],
      { in: sessionId, scopes: lineScopes(scope, scopeId) },
    );
    return made[0]!;
  }

  /** A hold's scope as a line's buttons name it; a scope no line can name (one turn, say) has none. */
  function lineScopes(scope: HoldScope, scopeId: string | null): ControlScope[] {
    if (scope === "global") return [{ scope: "global", id: null }];
    if ((scope === "bot" || scope === "session" || scope === "plan") && scopeId) return [{ scope, id: scopeId }];
    return [];
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
    if (store.capabilities().engine_level >= ENGINE_LEVELS.delegation) return store.delegationCascadeTargets({ scope, id: scopeId });
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

  function continueByLine(message: Message, session: Session, scopes: ControlScope[], by: "user_text" | "user_button" = "user_text"): boolean {
    const named = holdsToLift(session, scopes);
    const everything = scopes.some((scope) => scope.scope === "global");
    // The Stops the line is about, those on a Bot the words leave out aside: 「@X 继续」 in a group
    // says nothing to the other Bots on the plan it lands on, and their Stops stay. A group stop
    // menu's hold on the group or a job is about whatever you say there next, a go on to one Bot
    // included; only the Bots the words name open again on it (`othersOnWide`).
    const about = stopsAbout(message).filter(
      (hold) => everything || isWide(hold) || scopes.some((scope) => scope.scope !== "bot" || stopOnBot(hold, scope.id)),
    );
    const namedBots = everything ? [] : scopes.flatMap((scope) => (scope.scope === "bot" ? [scope.id] : []));
    const othersOnWide = (record: HeldTurn, hold: Hold) =>
      namedBots.length > 0 && hold.lift_on_next_user_message && isWide(hold) && !namedBots.includes(record.bot_id);
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
      const lifted = toLift.map((hold) => store.liftHold(hold.id, { by, messageId: message.id }));
      for (const hold of lifted) {
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: message.session_id, payload: { hold: hold.id, by } });
      }
      const resumed = resumeLifted(lifted, said, { stops: true, leave: othersOnWide });
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
          ...(stillHeld.some((hold) => !hold.lift_on_next_user_message)
            ? { offer: ["continue_only", "continue_all"] as ControlOffer[], held_ids: stillHeld.map((hold) => hold.id) }
            : { offer: [] }),
          scopes,
        },
      });
      return { receipt, resumed };
    });
    publishMessage(receipt);
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

  /** Whether `sessionId` is your direct with a Bot, where any line of yours opens that Bot's turn. */
  function directWithYou(sessionId: string): boolean {
    try {
      return store.getSession(sessionId).kind !== "group" && store.isPresent(sessionId, USER_MEMBER);
    } catch {
      return false;
    }
  }

  /**
   * Opens again the turns the lifted holds ended, each on a note with your words and where it was;
   * one another hold still covers is handed to that hold, to go on when it is lifted — to one that
   * opens its work again then, when there is one. A Stop's hold opens nothing again unless `stops`
   * says so (a go on that lifted it along with the rest): Stop means "not this", and your next line
   * is what the Bot goes on from. A turn `leave` names, nothing else holding it, is left for a line
   * of yours that is about to reach it anyway.
   */
  function resumeLifted(
    lifted: Hold[],
    said: SaidLine,
    opts: { stops: boolean; leave?: (record: HeldTurn, hold: Hold) => boolean },
  ): Array<{ record: HeldTurn; turn: Turn }> {
    const resumed: Array<{ record: HeldTurn; turn: Turn }> = [];
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
        if (opts.leave?.(record, hold)) continue;
        const turn = resume(record, said);
        if (!turn) continue;
        store.addHoldEffect(hold.id, { resumed_turns: [turn.id] });
        resumed.push({ record, turn });
      }
    }
    return resumed;
  }

  /**
   * One stopped turn's work, opened again on a note in the conversation it ran in. The note is the
   * app telling that Bot, not a line of the conversation: like a check-back's own line, only the turn
   * it wakes or is heard in reads it (`botOnly`), and the flow board still draws the wake from the
   * stopped turn. Nothing publishes it; you see the go on's receipt instead.
   */
  function resume(record: HeldTurn, said: SaidLine): Turn | null {
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
      botOnly: true,
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
    return turn;
  }

  function lift(id: string): Hold {
    return store.transaction(() => {
      // Lifting one already lifted changes nothing, and opens nothing again.
      if (store.getHold(id).lifted_at) return store.getHold(id);
      const lifted = store.liftHold(id, { by: "user_button" });
      resumeLifted([lifted], null, { stops: false });
      store.recordWorkEvent({ kind: "control.lift", actor: "user", payload: { hold: id, by: "user_button" } });
      return store.getHold(id);
    });
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

  function unanswered(turn: Turn): void {
    if (!on() || turn.mode !== "readonly") return;
    let line: Message;
    try {
      line = store.getMessage(turn.trigger_message_id);
    } catch {
      return;
    }
    if (line.kind !== "user") return;
    const scopes: ControlScope[] = [{ scope: "bot", id: turn.bot_id }];
    // Lifted meanwhile: nothing stands in the way of saying it again.
    if (heldAbout(scopes, line.session_id, line).length === 0) return;
    answerStatus(line, scopes, { offerStop: false, offerContinue: true, unanswered: line.id });
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
        default:
          return false;
      }
    });
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

  // ── Answering ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The answer to 「停了吗」 and 「你没停」: what holds the work asked about and what of it runs,
   * checked afresh — anything found still running under one of those holds is ended first and
   * recorded as a violation (there should never be any). `offerContinue`: a go on the words could
   * not lift, since something wider holds it; the answer offers the buttons.
   */
  function answerStatus(message: Message, scopes: ControlScope[], opts: { offerStop: boolean; offerContinue?: boolean; unanswered?: string }): void {
    const here = message.session_id;
    const { answer, ended } = store.transaction(() => {
      const holds = heldAbout(scopes, here, message);
      const ended = endViolations(holds);
      const live = store.listLiveTurns().filter((turn) => turn.mode !== "readonly");
      const running = live.filter((turn) => scopes.some((scope) => inScope(scope, turn)));
      const elsewhere = scopes.some((scope) => scope.scope === "session") ? workOnHere(message, live.filter((turn) => !running.includes(turn))) : [];
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
          elsewhere: elsewhere.map((turn) => turnLine(heldTurn(turn, lives.get(turn.id)), here, heading)),
          ended: ended.map((row) => turnLine(row.record, here, heading)),
          offerStop,
          unanswered: opts.unanswered !== undefined,
        }),
        hiddenFromBots: true,
        control: { kind: "status", hold_ids: holds.map((hold) => hold.id), offer, scopes, ...(opts.unanswered ? { unanswered: opts.unanswered } : {}) },
      });
      return { answer, ended };
    });
    for (const { turn } of ended) publishTurn(turn, null);
    publishMessage(answer);
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

  // ── Buttons ───────────────────────────────────────────────────────────────────────────────────

  function act(messageId: string, input: { action: unknown; taskId?: unknown }): ControlActionResult {
    if (!on()) throw new HttpError(409, "holds_unavailable", "holds are not on yet: the engine level has not reached them (GET /v1/capabilities)");
    const message = store.getMessage(messageId);
    const control = message.control;
    if (!control) throw new HttpError(422, "invalid_args", "this line has no control buttons");
    // A restart notice's buttons are the engine's restart module's (engine/restart.ts), a line about
    // checks from your words the derived-checks module's (engine/derived-checks.ts). A blocked job's
    // question is answered at its own endpoint, and the supervisor's lines offer nothing (ADR 0045).
    if (control.kind === "restart" || control.kind === "check" || control.kind === "requirement" || control.kind === "plan_opened"
      || control.kind === "work_question" || control.kind === "supervisor" || control.kind === "review_item" || control.kind === "rework" || control.kind === "ceiling" || control.kind === "model_default" || control.kind === "lesson") {
      throw new HttpError(422, "invalid_args", "this line's buttons are not about your stops");
    }
    const action = input.action as ControlOffer;
    const taskId = typeof input.taskId === "string" ? input.taskId : null;
    const offered =
      action === "stop_plan" || action === "only_plan"
        ? control.kind === "receipt" && (control.plans ?? []).some((plan) => plan.offer === action && plan.task_id === taskId)
        : control.offer.includes(action);
    if (!offered) throw new HttpError(422, "invalid_args", "this line does not offer that button");
    // One press per line: the buttons are answers to one question, and a second tap or a retried
    // request must not stop or lift a second time.
    if ((control.acted ?? []).length > 0) return { made: [], lifted: [] };
    const pressed = (): void => {
      store.setMessageControl(message.id, { ...control, acted: [...(control.acted ?? []), action] });
    };
    const here = message.session_id;
    switch (action) {
      case "stop":
      case "cancel": {
        if (action === "cancel" && control.kind === "receipt") {
          // 作废 on a stop's receipt: the stop stands, now recorded as dropping the job.
          const ids = control.hold_ids.filter((id) => !store.getHold(id).lifted_at);
          store.transaction(() => {
            store.cancelHolds(ids);
            pressed();
          });
          return { made: [], lifted: [] };
        }
        // Your line that only might have been a stop, or a status answer's button: the stop it
        // meant, made now, with a receipt like any other. The line's own words are quoted.
        const fromLine = control.kind === "possible_control" ? message.id : null;
        const { made } = carryOut(
          () => {
            pressed();
            return control.scopes.map((scope) => holdOn(scope, { source: "user_button", sourceMessageId: fromLine, action: action === "cancel" ? "cancel" : "pause" }));
          },
          { in: here, scopes: control.scopes },
        );
        return { made, lifted: [] };
      }
      case "continue": {
        // Your line that only might have been a go on: what it would have lifted, lifted now.
        let session: Session;
        try {
          session = store.getSession(here);
        } catch {
          throw new HttpError(422, "invalid_args", "the conversation is gone");
        }
        const before = new Set(store.listHolds({ inForce: true }).map((hold) => hold.id));
        store.transaction(pressed);
        if (!continueByLine(message, session, control.scopes, "user_button")) answerStatus(message, control.scopes, { offerStop: false });
        const lifted = [...before].map((id) => store.getHold(id)).filter((hold) => hold.lifted_at);
        return { made: [], lifted };
      }
      case "undo":
        return undo(message, control.kind === "possible_control" ? [] : control.hold_ids, pressed);
      case "stop_all": {
        const { made } = carryOut(
          () => {
            pressed();
            return [holdOn({ scope: "global", id: null }, { source: "user_button" })];
          },
          { in: here, scopes: [{ scope: "global", id: null }] },
        );
        return { made, lifted: [] };
      }
      case "stop_plan": {
        const { made } = carryOut(
          () => {
            pressed();
            return [holdOn({ scope: "plan", id: taskId }, { source: "user_button" })];
          },
          { in: here, scopes: [{ scope: "plan", id: taskId! }] },
        );
        return { made, lifted: [] };
      }
      case "only_plan":
        return onlyPlan(message, control.kind === "possible_control" ? [] : control.hold_ids, taskId!, pressed);
      case "continue_only":
      case "continue_all": {
        const listed = control.kind === "status" ? control.hold_ids : control.kind === "receipt" ? (control.held_ids ?? []) : [];
        const line = control.kind === "status" ? control.unanswered : undefined;
        return goOnByButton(message, control.scopes, listed, action === "continue_only", pressed, line);
      }
      case "resume":
      case "leave":
      case "confirm_check":
      case "edit_check":
      case "remove_check":
      case "confirm_requirements":
      case "review_requirements":
      case "make_standing":
      case "keep_project":
      case "undo_plan":
      case "merge_plan":
      case "confirm_item":
      case "remove_item":
      case "approve":
      case "reject":
      case "another_way":
      case "another_plan":
      case "relax":
      case "accept":
      case "rework":
      case "dismiss":
      case "confirm":
      case "decline":
        // Only a restart notice or a line about checks, requirements, a hand-over or a ceiling offers these, all turned away above.
        throw new HttpError(422, "invalid_args", "this line does not offer that button");
    }
  }

  /**
   * Undo on a stop's receipt: its holds lifted and the work they ended opened again, a Stop's too —
   * undo means as if it had not been pressed. A line of yours that was read as the stop was never
   * meant as one, so it now goes on as any line would have. Said in your direct with a Bot, that
   * line always opens a turn of the Bot's there, so the work stopped there does not open again
   * beside it as well, or the Bot would be at it twice. In a group the line wakes only whom it
   * names — naming nobody, with nobody at work any more, it gets only the Bots' judgements — so
   * the stopped work there opens again as any lift opens it, and the line then goes on as any line
   * of yours there would.
   */
  function undo(message: Message, holdIds: string[], pressed: () => void): ControlActionResult {
    const toLift = holdIds.map((id) => store.getHold(id)).filter((hold) => !hold.lifted_at);
    const lines = new Set(toLift.flatMap((hold) => (hold.source === "user_text" && hold.source_message_id ? [hold.source_message_id] : [])));
    const heard = new Set([...lines].map(messageSession).filter((id): id is string => id !== null && directWithYou(id)));
    const lifted = store.transaction(() => {
      pressed();
      const lifted = toLift.map((hold) => store.liftHold(hold.id, { by: "user_button" }));
      for (const hold of lifted) {
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: message.session_id, payload: { hold: hold.id, by: "user_button", undo: true } });
      }
      resumeLifted(lifted, null, { stops: true, leave: (record) => heard.has(record.session_id) });
      return lifted.map((hold) => store.getHold(hold.id));
    });
    for (const id of lines) {
      try {
        redeliver(store.getMessage(id));
      } catch {
        // the line was cleared meanwhile; there is nothing to send on
      }
    }
    return { made: [], lifted };
  }

  /**
   * 「只停《P》」 on a stop's receipt: each stop on a whole Bot becomes one on its work in that plan,
   * and the rest of its work opens again, the way a go on would open it. Said in a receipt of its own.
   */
  function onlyPlan(message: Message, holdIds: string[], taskId: string, pressed: () => void): ControlActionResult {
    const wide = holdIds.map((id) => store.getHold(id)).filter((hold) => hold.scope === "bot" && !hold.lifted_at);
    const result = store.transaction(() => {
      pressed();
      const made = wide.map((hold) =>
        holdOn({ scope: "bot_plan", id: botPlanScopeId(hold.scope_id!, taskId) }, { source: "user_button", sourceMessageId: hold.source_message_id }),
      );
      const lifted = wide.map((hold) => store.liftHold(hold.id, { by: "user_button" }));
      for (const hold of lifted) {
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: message.session_id, payload: { hold: hold.id, by: "user_button", narrowed_to: taskId } });
      }
      const resumed = resumeLifted(lifted, null, { stops: false });
      const scopes = wide.map((hold) => ({ scope: "bot" as const, id: hold.scope_id! }));
      const line = continueReceiptLine(message.session_id, scopes, lifted, resumed, made.map((hold) => store.getHold(hold.id)));
      return { made, lifted: lifted.map((hold) => store.getHold(hold.id)), line };
    });
    publishMessage(result.line);
    return { made: result.made.map((hold) => store.getHold(hold.id)), lifted: result.lifted };
  }

  /**
   * The two buttons under a go on that a wider stop held back. 「全部继续」 lifts every stop over what
   * the go on named. 「只让 X 继续」 lifts them too, but each wider one (on everything, a conversation,
   * a plan) first leaves in its place one stop per other Bot on what it held of that Bot's work, so
   * only the Bots the go on named go on. Under the line said in place of a read-only answer that
   * said nothing (`unanswered`), each named Bot also takes up your line there.
   */
  function goOnByButton(message: Message, scopes: ControlScope[], listed: string[], only: boolean, pressed: () => void, unanswered?: string): ControlActionResult {
    const here = message.session_id;
    const keep = new Set(botsNamed(scopes, here));
    const result = store.transaction(() => {
      pressed();
      // The stops the line listed (a plan the go on would have landed on is among them), and any
      // made over the same work since.
      const ids = new Set([...listed, ...heldAbout(scopes, here).map((hold) => hold.id)]);
      const over = store.listHolds({ inForce: true }).reverse().filter((hold) => ids.has(hold.id));
      const made = only ? over.flatMap((hold) => (isWide(hold) ? splitHold(hold, keep) : [])) : [];
      const lifted = over.map((hold) => store.liftHold(hold.id, { by: "user_button" }));
      for (const hold of lifted) {
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: here, payload: { hold: hold.id, by: "user_button" } });
      }
      const resumed = resumeLifted(lifted, null, { stops: true });
      if (unanswered) takeUp(unanswered, keep, resumed);
      const line = continueReceiptLine(here, scopes, lifted, resumed, made.map((hold) => store.getHold(hold.id)));
      return { made, lifted: lifted.map((hold) => store.getHold(hold.id)), line };
    });
    publishMessage(result.line);
    return { made: result.made.map((hold) => store.getHold(hold.id)), lifted: result.lifted };
  }

  /**
   * Your line a read-only answer said nothing to, taken up now by each of `bots` that is not at
   * work there already — a stopped turn opened again in that conversation reads the line in its
   * transcript — the way the line would have opened its turn with nothing stopped. One a stop still
   * covers answers read-only again.
   */
  function takeUp(lineId: string, bots: Set<string>, resumed: Array<{ record: HeldTurn }>): void {
    let line: Message;
    let session: Session;
    try {
      line = store.getMessage(lineId);
      session = store.getSession(line.session_id);
    } catch {
      return;
    }
    const withYou = session.kind !== "group" && store.isPresent(session.id, USER_MEMBER);
    for (const botId of bots) {
      if (resumed.some((row) => row.record.bot_id === botId && row.record.session_id === session.id)) continue;
      if (!store.isPresent(session.id, botId)) continue;
      if (store.listLiveTurns({ sessionId: session.id, botId }).some((turn) => turn.mode !== "readonly")) continue;
      if (withYou) startTurn(session.id, botId, line, "fork", { cause: "user_line" });
      else hearOrStart(session.id, botId, line, { item: { author: "", body: line.body, checkBack: false } }, { cause: "user_line", otherwise: "fork" });
    }
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

  /**
   * Stops that hold, for every Bot but those in `keep`, what `wide` held of its work: on everything,
   * all of each Bot's work, one stop per Bot; on a plan, each Bot's work in it; on a conversation,
   * each Bot's work in the plans it parked or has now, plus a turn stop on each of that Bot's
   * stopped turns off those plans, so none of them opens again when `wide` goes. Each quotes the
   * line that made `wide`.
   */
  function splitHold(wide: Hold, keep: Set<string>): Hold[] {
    const others = store.listBots().filter((bot) => !bot.archived_at && !keep.has(bot.id));
    const opts = { source: "user_button" as const, sourceMessageId: wide.source_message_id, action: wide.action };
    switch (wide.scope) {
      case "global":
        return others.map((bot) => holdOn({ scope: "bot", id: bot.id }, opts));
      case "plan":
        return others.map((bot) => holdOn({ scope: "bot_plan", id: botPlanScopeId(bot.id, wide.scope_id!) }, opts));
      case "session": {
        const plans = new Set((wide.effect.parked_plans ?? []).map((row) => row.task_id));
        const current = store.sessionCurrentTask(wide.scope_id!)?.id;
        if (current) plans.add(current);
        const made = others.flatMap((bot) => [...plans].map((task) => holdOn({ scope: "bot_plan", id: botPlanScopeId(bot.id, task) }, opts)));
        const otherIds = new Set(others.map((bot) => bot.id));
        const turns = new Set([
          ...[...(wide.effect.stopped_turns ?? []), ...(wide.effect.held_over ?? [])]
            .filter((record) => otherIds.has(record.bot_id) && (record.task_id === null || !plans.has(record.task_id)))
            .map((record) => record.turn_id),
          ...wide.targets.filter((target) => target.scope === "turn" && otherIds.has(turnRow(target.id)?.bot_id ?? "")).map((target) => target.id),
        ]);
        for (const turn of turns) if (turnRow(turn)) made.push(holdOn({ scope: "turn", id: turn }, opts));
        return made;
      }
      default:
        return [];
    }
  }

  /** A receipt for holds a button lifted: what it lifted, what opens again, and what stays held. */
  function continueReceiptLine(
    sessionId: string,
    scopes: ControlScope[],
    lifted: Hold[],
    resumed: Array<{ record: HeldTurn }>,
    stillHeld: Hold[],
  ): Message {
    const current = lifted.map((hold) => store.getHold(hold.id));
    return store.insertMessage({
      sessionId,
      kind: "system",
      author: authorIn(sessionId, scopes),
      body: continueReceiptBody(locale(), {
        lifted: current.map((hold) => ({ scope: scopeLabel(hold, sessionId), said: holdSaid(hold) })),
        resumed: resumed.map((row) => turnLine(row.record, sessionId, headingBots(scopes))),
        resumedCheckBacks: current.reduce((sum, hold) => sum + (hold.effect.resumed_check_backs?.length ?? 0), 0),
        restored: current.flatMap((hold) => hold.effect.restored_plans ?? []).map((id) => planTitle(id) ?? id),
        stillHeld: stillHeld.map((hold) => ({ scope: scopeLabel(hold, sessionId), said: holdSaid(hold) })),
      }),
      hiddenFromBots: true,
      control: { kind: "receipt", verb: "continue", hold_ids: current.map((hold) => hold.id), offer: [], scopes },
    });
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
      liftOnNextLine: nextLineAbout(holds.find((hold) => hold.lift_on_next_user_message)),
      global: holds.some((hold) => hold.scope === "global"),
    });
  }

  /** What the line that lifts `hold` has to be about, as its receipt says it; false for none. */
  function nextLineAbout(hold: Hold | undefined): false | "job" | "group" | "bot" {
    if (!hold) return false;
    if (hold.scope === "session") return "group";
    if (hold.scope === "bot") return "bot";
    return "job";
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

  return { on, ruleLine, readLine, liftOnYourLine, unanswered, stopByButton, hold, act, lift, enforce, heldLines: heldLinesFor };
}

