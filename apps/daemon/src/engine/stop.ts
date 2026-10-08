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
 * gets the same receipt as one you said. A Stop pressed on one turn gets none (2026-10-04, ADR 0058):
 * you pressed it on the very turn it stopped, your next word to that Bot about its job lifts it, so
 * the receipt and its Undo only repeated what you had just done.
 *
 * Work items and their inbox, external jobs and upstream waits (ADR 0040 P4) do not exist yet, so
 * "the work a hold covers" is live turns, check-backs and plans, and a delegation is the lineage of
 * turns and the lines that opened them.
 */
import type {
  ControlActionResult,
  ControlOffer,
  ControlScope,
  Hold,
  Message,
  Session,
  Turn,
} from "@real-bot/protocol";
import { controlScopes, readControlLine, type ControlLineInput } from "../control-line";
import type { UserLineReading } from "../line-reading";
import type { TurnAdmission } from "../quiesce";
import { isStatusQuestion } from "../status-question";
import type { Store } from "../store";
import type { TurnExecution } from "../store/routing";
import type { Lifecycle } from "./lifecycle";
import type { Live } from "./types";
import { isoPlus } from "../ids";
import { createStopReach } from "./stop/reach";
import { createStopWords } from "./stop/words";
import { createStopCarryOut } from "./stop/carry-out";
import { createStopAnswers } from "./stop/answers";
import { createStopGoOn } from "./stop/go-on";
import { createStopButtons } from "./stop/buttons";

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
  liftOnYourLine: (message: Message) => Hold[];
  /**
   * Once your line to a whole group has woken whom it wakes: the work the stops it lifted had ended
   * that it did not reach goes on from it too — a Bot's stopped in a conversation of its own while
   * the group's stop held, the lead taking the line in the group. Returns the turns that opened again.
   */
  goOnFromYourLine: (message: Message, lifted: Hold[]) => Turn[];
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
/** A Bot's lines this far back tell who 「你」 is in a group (control-line.ts reads the window). */
const RECENT_WINDOW_MS = 10 * 60_000;

export function createStop(deps: StopDeps): Stop {
  const { store, admission } = deps;
  const reach = createStopReach(deps);
  const words = createStopWords(deps, reach);
  const carry = createStopCarryOut(deps, reach, words);
  const answers = createStopAnswers(deps, reach, words, carry);
  const goOn = createStopGoOn(deps, reach, words, answers);
  const buttons = createStopButtons(deps, reach, carry, answers, goOn);
  const { on, holdsToLift, stopsAbout, stopsOnBots, stopBefore, scopeHolds } = reach;
  const { stopByLine, stopByButton, hold, enforce } = carry;
  const { answerStatus, statusLine, unanswered, heldLinesFor } = answers;
  const { continueByLine, liftOnYourLine, goOnFromYourLine, lift } = goOn;
  const { act } = buttons;

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
    const since = isoPlus(message.created_at, -RECENT_WINDOW_MS);
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

  /** A line that may have meant a stop or a go on: the Bots get it as usual, and it carries the buttons. */
  function mark(message: Message, offer: ControlOffer[], scopes: ControlScope[]): void {
    store.transaction(() => store.setMessageControl(message.id, { kind: "possible_control", offer, scopes }));
  }

  return { on, ruleLine, readLine, liftOnYourLine, goOnFromYourLine, unanswered, stopByButton, hold, act, lift, enforce, heldLines: heldLinesFor };
}

