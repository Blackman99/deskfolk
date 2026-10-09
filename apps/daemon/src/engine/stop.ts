/**
 * Carrying out your stops and go-ons (ADR 0040 P2): a stop line or button becomes holds, the work
 * they cover is ended at once, and the app — not a model turn — tells you what it did, from what
 * the holds recorded (`effect`).
 *
 * What a line of yours means is the reader's to say (ADR 0055), and nothing is carried out on a
 * line the reader could not read (ADR 0070): the word lists are no reading of control any more. A
 * line the reader read as nothing but a stop is carried out here, and nothing else happens with it:
 * no filing, no turn. A go on is said to the Bot, so it goes where any line goes, once it has lifted
 * your stops on the job it is filed under (`goOnWithLine`). A line with more in it goes where any
 * line goes, marked with the buttons it might have meant (`possible_control`).
 *
 * A stop, in one write: a hold per scope the line names, each with the work the covered Bots handed
 * on and have not had back (`handedOn`); the plans and check-backs it covers are parked and set
 * aside by the hold itself (store/holds.ts); every live turn it covers ends as stopped, its
 * check-backs set aside for the lift rather than cancelled, and what it was doing recorded; then
 * the receipt. Once that is written, each ended turn's model call, MCP calls and command process
 * groups are aborted.
 *
 * A go on lifts your stops that keep the Bots it is said to from the job it is filed under, and
 * wakes them like any line: they go on from it and say so themselves. A stop on another job stays.
 * Every stop of yours is only "stop for now" (ADR 0071): your next line to a Bot about what it covers
 * lifts one on that Bot's work, and lets that Bot go from one over more Bots — everything, a group,
 * a job — which holds the rest until you speak to them or lift it. A line or a go on to one Bot
 * leaves the other Bots' stops alone. Your line to a Bot only a hold of the app's covers gets a
 * read-only answer, from the Bot.
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

export type Stop = {
  /** Holds are on: the engine level has reached them (ADR 0040's version gate). */
  on: () => boolean;
  /**
   * A line of yours, once read (ADR 0055): one the reader read as nothing but a stop is carried out,
   * and true says nothing else is to happen with it; one that says a stop beside something else
   * carries the buttons. A go on, a question about the work and anything else go to the Bots
   * (ADR 0070), and so does a line the reader could not read: the word lists carry nothing out.
   */
  readLine: (message: Message, reading: UserLineReading) => boolean;
  /**
   * Your line, once filed, is your word to the Bots it is said to (ADR 0071): before it wakes anyone,
   * a stop of yours on one Bot's work it is about goes, and one over more Bots lets go of those Bots,
   * so they go on from what you said. Only a line said after the stop counts, and a line read as only
   * asking where the work stands lifts nothing. Returns the holds it lifted or let a Bot go from.
   */
  liftOnYourLine: (message: Message, reading?: UserLineReading | null) => Hold[];
  /**
   * Your line, changed: a stop of yours holding a copy of it, or the note of what you changed, goes
   * on past it for that copy's Bot, as at a new line of yours, so the Bot goes on from the change.
   * A hold of the app's keeps holding them.
   */
  liftOnYourChange: (line: Message, editId: string) => Hold[];
  /** 直接插入 on a line of yours a Stop holds: the Stop goes, so the Bot reads it now. */
  liftOnYourInsert: (line: Message) => Hold[];
  /** 退回 on a hand-over's card: a Stop on that Bot's work in the job goes, so it reworks. */
  liftOnSendBack: (card: Message, producer: string, taskId: string, ticketId: string | null) => Hold[];
  /**
   * Your line, once filed, when the reader read it as a go on (ADR 0070): your stops that keep the
   * Bots it is said to from the job it is filed under go before it wakes them — a stop on another
   * job stays. Returns the holds lifted.
   */
  goOnWithLine: (message: Message, reading: UserLineReading | null) => Hold[];
  /**
   * Once your line has woken whom it wakes: the work the stops it lifted had ended that it did not
   * reach goes on from it too — for a line to a whole group, a Bot's stopped in a conversation of
   * its own while the group's stop held; for a go on, the job's work stopped in other conversations.
   * Returns the turns that opened again.
   */
  goOnFromYourLine: (message: Message, lifted: Hold[], goOn?: boolean) => Turn[];
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
  const { heldLinesFor } = answers;
  const { liftOnYourLine, liftOnYourChange, liftOnYourInsert, liftOnSendBack, goOnFromYourLine, lift } = goOn;
  const { act } = buttons;

  // ── Reading the line ──────────────────────────────────────────────────────────────────────────

  function readLine(message: Message, line: UserLineReading): boolean {
    if (message.kind !== "user" || admission?.draining || !on()) return false;
    // Not read by the reader — it failed or timed out, and the word lists read it: nothing is
    // carried out on it, and the Bots read the line as you said it (ADR 0070). A stop that cannot
    // wait has the Stop button.
    if (line.source !== "model" || line.control === null) return false;
    let session: Session;
    try {
      session = store.getSession(message.session_id);
    } catch {
      return false;
    }
    const input = lineInput(message, session);
    const scopes = controlScopes(input);
    switch (line.control) {
      // A go on is said to the Bot: once filed it lifts your stops on that job (`goOnWithLine`) and
      // wakes the Bot like any line, which goes on from it and says so itself.
      case "none":
      case "go_on":
        return false;
      case "stop":
        if (line.controlOnly) {
          // 「算了，停吧」: the receipt also offers to drop the job. Only offered: nothing is dropped by words.
          const words = readControlLine(input);
          stopByLine(message, scopes, words.kind === "stop" && words.offerCancel);
          return true;
        }
        offerButtons(message, session, ["stop"], scopes);
        return false;
      case "both":
        offerButtons(message, session, ["stop", "continue"], scopes);
        return false;
    }
  }

  function goOnWithLine(message: Message, reading: UserLineReading | null): Hold[] {
    if (message.kind !== "user" || !on() || reading?.source !== "model" || reading.control !== "go_on") return [];
    let session: Session;
    try {
      session = store.getSession(message.session_id);
    } catch {
      return [];
    }
    return goOn.goOnWithLine(message, reading, controlScopes(lineInput(message, session)));
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

  return { on, readLine, liftOnYourLine, liftOnYourChange, liftOnYourInsert, liftOnSendBack, goOnWithLine, goOnFromYourLine, stopByButton, hold, act, lift, enforce, heldLines: heldLinesFor };
}

