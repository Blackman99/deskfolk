/** Going on: holds lifted by a line or a button, and the work they ended opened again on a note. */
import { type Message, type Session, type ControlScope, type HeldTurn, type Hold, type ControlOffer, type Turn, type AnsweredLine, USER_MEMBER } from "@real-bot/protocol";
import { saidOf, continueReceiptBody, type SaidLine, resumeNote } from "../../prompts";
import type { StopDeps } from "../stop";
import type { StopReach } from "./reach";
import type { StopWords } from "./words";
import type { StopAnswers } from "./answers";

export function createStopGoOn(deps: StopDeps, reach: StopReach, words: StopWords, answers: StopAnswers) {
  const { store, publishMessage, admission, startTurn, hearOrStart, wakes } = deps;
  const { holdsToLift, stopsAbout, isWide, stopOnBot, stopBefore, stopsOnBots, scopeHolds, heldAbout, on } = reach;
  const { authorIn, locale, scopeLabel, holdSaid, turnLine, headingBots, botName, planTitle, planTag } = words;
  const { answerStatus } = answers;

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
          resumed: resumed.filter((row) => !row.line).map((row) => turnLine(row.record, message.session_id, headingBots(scopes))),
          takenUp: resumed.flatMap((row) => (row.line ? [{ bot: botName(row.record.bot_id), said: saidOf(row.line) }] : [])),
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
   * Opens again the turns the lifted holds ended, each on a note with your words and where it was;
   * one another hold still covers is handed to that hold, to go on when it is lifted — to one that
   * opens its work again then, when there is one. A Stop's hold opens nothing again unless `stops`
   * says so (a go on that lifted it along with the rest): Stop means "not this", and your next line
   * is what the Bot goes on from. A turn `leave` names, nothing else holding it, is left for a line
   * of yours that is about to reach it anyway.
   *
   * Then the lines of yours they turned into read-only answers go back to their Bots (`line` on the
   * row): under the stop a Bot could only answer, and said it would act once you went on. Before,
   * nothing did: 「片尾的 logo 再大一点」 said under 「先停一下」 got 「等你说继续我再放大并重出成片」,
   * and 继续 opened nothing — the job had been approved, no turn had been stopped to open again —
   * so the logo stayed as it was (2026-10-04). Per Bot, conversation and job the last such line
   * opens the turn, as it would have with nothing stopped, and the turn reads the others above it;
   * a Bot whose stopped work opened again in that conversation reads them there. One another hold
   * still covers keeps them on that hold, for when it is lifted.
   */
  function resumeLifted(
    lifted: Hold[],
    said: SaidLine,
    opts: { stops: boolean; leave?: (record: HeldTurn, hold: Hold) => boolean },
  ): Array<{ record: HeldTurn; turn: Turn; line?: Message }> {
    const resumed: Array<{ record: HeldTurn; turn: Turn; line?: Message }> = [];
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
    const answered = new Map<string, { row: AnsweredLine; hold: Hold; line: Message }>();
    for (const hold of lifted) {
      if (hold.lift_on_next_user_message && !opts.stops) continue;
      for (const row of hold.effect.answered_lines ?? []) {
        let line: Message;
        try {
          line = store.getMessage(row.message_id);
        } catch {
          continue;
        }
        const key = `${row.bot_id}|${line.session_id}|${line.task_id ?? ""}`;
        const before = answered.get(key);
        if (!before || before.line.created_at <= line.created_at) answered.set(key, { row, hold, line });
      }
    }
    for (const { row, hold, line } of answered.values()) {
      const record: HeldTurn = {
        turn_id: row.turn_id,
        bot_id: row.bot_id,
        session_id: line.session_id,
        task_id: line.task_id ?? null,
        ticket_id: line.ticket_id ?? null,
        written: [],
        recent: [],
      };
      if (resumed.some((other) => other.record.bot_id === row.bot_id && other.record.session_id === line.session_id)) continue;
      const still = store.holdsCovering({ botId: row.bot_id, sessionId: line.session_id, taskId: record.task_id, ticketId: record.ticket_id });
      if (still.length > 0) {
        const heir = [...still].reverse().find((other) => !other.lift_on_next_user_message) ?? still.at(-1)!;
        store.addHoldEffect(heir.id, { answered_lines: [row] });
        continue;
      }
      if (opts.leave?.(record, hold)) continue;
      const turn = takeUpLine(line, row.bot_id);
      if (!turn) continue;
      store.addHoldEffect(hold.id, { taken_up_turns: [turn.id] });
      resumed.push({ record, turn, line });
    }
    return resumed;
  }

  /**
   * Your line taken up by `botId` once nothing holds it, as the line would have opened its turn with
   * nothing stopped: in your direct beside whatever the Bot took up there meanwhile, elsewhere heard
   * by its turn on that job when it has one.
   */
  function takeUpLine(line: Message, botId: string): Turn | null {
    if (admission?.draining) return null;
    let session: Session;
    try {
      session = store.getSession(line.session_id);
      if (store.getBot(botId).archived_at) return null;
    } catch {
      return null;
    }
    if (!store.isPresent(session.id, botId)) return null;
    const withYou = session.kind !== "group" && store.isPresent(session.id, USER_MEMBER);
    return withYou
      ? startTurn(session.id, botId, line, "fork", { cause: "user_line" })
      : hearOrStart(session.id, botId, line, { item: { author: "", body: line.body, checkBack: false } }, { cause: "user_line", otherwise: "fork" });
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

  function liftOnYourLine(message: Message): Hold[] {
    if (message.kind !== "user" || message.control || !on()) return [];
    const about = stopsAbout(message);
    if (about.length === 0) return [];
    return store.transaction(() =>
      about.map((hold) => {
        const lifted = store.liftHold(hold.id, { by: "user_text", messageId: message.id });
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: message.session_id, payload: { hold: hold.id, by: "user_text", next_line: true } });
        return lifted;
      }),
    );
  }

  /**
   * The work a lifted stop had ended that your line to a whole group did not reach, opened again on
   * a note with your words. A Bot your line woke goes on from it there, and one already back at that
   * job is at it; the rest were left with nothing to go on from: on 2026-10-04's walkthrough a
   * group's stop cut 文案 off in its direct with the lead, 「宣传语改成英文的，海报改横版」 woke only
   * the lead, and 文案 sat stopped until the supervisor called it back three minutes later to
   * "answer" the old request. The receipt had said the Bots go on from your line. A line that names
   * Bots is for them alone, as 「@X 继续」 is: the others' work stays stopped.
   */
  function goOnFromYourLine(message: Message, lifted: Hold[]): Turn[] {
    if (lifted.length === 0 || !on()) return [];
    let group = false;
    try {
      group = store.getSession(message.session_id).kind === "group";
    } catch {
      return [];
    }
    const woken = new Set(wakes(message));
    if (!group || store.presentBotIds(message.session_id).some((id) => !woken.has(id))) return [];
    const reached = (record: HeldTurn) =>
      store.listLiveTurns({ botId: record.bot_id }).some(
        (turn) => turn.mode !== "readonly" && (turn.trigger_message_id === message.id || (record.task_id !== null && turn.task_id === record.task_id)),
      );
    const resumed = store.transaction(() =>
      resumeLifted(
        lifted.map((hold) => store.getHold(hold.id)),
        saidOf(message),
        { stops: true, leave: reached },
      ),
    );
    return resumed.map((row) => row.turn);
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

  /** A receipt for holds a button lifted: what it lifted, what opens again, and what stays held. */
  function continueReceiptLine(
    sessionId: string,
    scopes: ControlScope[],
    lifted: Hold[],
    resumed: Array<{ record: HeldTurn; line?: Message }>,
    stillHeld: Hold[],
  ): Message {
    const current = lifted.map((hold) => store.getHold(hold.id));
    return store.insertMessage({
      sessionId,
      kind: "system",
      author: authorIn(sessionId, scopes),
      body: continueReceiptBody(locale(), {
        lifted: current.map((hold) => ({ scope: scopeLabel(hold, sessionId), said: holdSaid(hold) })),
        resumed: resumed.filter((row) => !row.line).map((row) => turnLine(row.record, sessionId, headingBots(scopes))),
        takenUp: resumed.flatMap((row) => (row.line ? [{ bot: botName(row.record.bot_id), said: saidOf(row.line) }] : [])),
        resumedCheckBacks: current.reduce((sum, hold) => sum + (hold.effect.resumed_check_backs?.length ?? 0), 0),
        restored: current.flatMap((hold) => hold.effect.restored_plans ?? []).map((id) => planTitle(id) ?? id),
        stillHeld: stillHeld.map((hold) => ({ scope: scopeLabel(hold, sessionId), said: holdSaid(hold) })),
      }),
      hiddenFromBots: true,
      control: { kind: "receipt", verb: "continue", hold_ids: current.map((hold) => hold.id), offer: [], scopes },
    });
  }

  return { continueByLine, resumeLifted, lift, liftOnYourLine, goOnFromYourLine, takeUp, continueReceiptLine };
}

export type StopGoOn = ReturnType<typeof createStopGoOn>;
