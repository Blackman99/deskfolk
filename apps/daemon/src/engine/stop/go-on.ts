/** Going on: holds lifted by a line or a button, and the work they ended opened again on a note. */
import { type Message, type Session, type ControlScope, type HeldTurn, type Hold, type ControlOffer, type Turn, type AnsweredLine, USER_MEMBER } from "@real-bot/protocol";
import type { UserLineReading } from "../../line-reading";
import { saidOf, continueReceiptBody, type SaidLine, resumeNote } from "../../prompts";
import { onOneBot } from "../../store/holds";
import type { StopDeps } from "../stop";
import type { StopReach } from "./reach";
import type { StopWords } from "./words";
import type { StopAnswers } from "./answers";

export function createStopGoOn(deps: StopDeps, reach: StopReach, words: StopWords, answers: StopAnswers) {
  const { store, publishMessage, admission, startTurn, hearOrStart, wakes } = deps;
  const { holdsToLift, stopsAbout, isWide, stopOnBot, stopBefore, stopsOnBots, scopeHolds, heldAbout, on, saidTo, saidToBots, landedPlan, messageSession } = reach;
  const { authorIn, locale, scopeLabel, liftedLabel, holdSaid, turnLine, headingBots, botName, planTitle, planTag } = words;
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
    // The stops the line itself is about count too: a line that may have meant a stop was passed by
    // `liftOnYourLine`, so its 继续 is the word that lets them go (ADR 0071).
    if (named.length === 0 && away.length === 0 && about.length === 0) {
      // Nothing the words lift, and nothing wider holding what they name: 「继续」 is how you tell a
      // Bot to go on with its next step, an ordinary line.
      if (!scopes.some((scope) => scopeHolds(scope, message).some((hold) => !withLine.has(hold.id)))) return false;
      answerStatus(message, scopes, { offerStop: false, offerContinue: true });
      return true;
    }
    // The line goes nowhere else now, so the Stops it is about go with it here, and their work
    // opens again on the same note as the rest: the note is how your words reach it.
    const ids = new Set([...named, ...about, ...away].map((hold) => hold.id));
    // Oldest first, the way they were made.
    const toLift = store.listHolds({ inForce: true }).reverse().filter((hold) => ids.has(hold.id));
    // Words that name everything lift everything; otherwise a stop over more Bots lets go of the Bots
    // the words name, or the line is said to (ADR 0071), and the rest stay stopped.
    const goingOn = namedBots.length > 0 ? namedBots : saidToBots(message);
    const { receipt, resumed } = store.transaction(() => {
      const said = saidOf(message);
      const lifted = toLift.map((hold) =>
        everything || onOneBot(hold) || goingOn.length === 0
          ? store.liftHold(hold.id, { by, messageId: message.id })
          : store.releaseHold(hold.id, goingOn, { by, messageId: message.id }),
      );
      for (const hold of lifted) {
        store.recordWorkEvent({
          kind: hold.lifted_at ? "control.lift" : "control.release",
          actor: "user",
          sessionId: message.session_id,
          payload: { hold: hold.id, by, ...(hold.lifted_at ? {} : { bots: goingOn }) },
        });
      }
      const resumed = resumeLifted(lifted, said, { stops: true, leave: othersOnWide });
      const current = lifted.map((hold) => store.getHold(hold.id));
      const stillHeld = heldAbout(scopes, session.id, message);
      const receipt = store.insertMessage({
        sessionId: message.session_id,
        kind: "system",
        author: authorIn(message.session_id, scopes),
        body: continueReceiptBody(locale(), {
          lifted: current.map((hold) => ({ scope: liftedLabel(hold, message.session_id), said: holdSaid(hold) })),
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
   * by its turn on that job when it has one. Not by a Bot already back at the line's job in another
   * conversation — its stopped work opened again there just now: a Bot works one job in one segment
   * at a time, and a second one beside it could not open; the line stays answered where it was.
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
    const job = landedPlan(line, botId);
    if (job !== null && store.listLiveTurns({ botId }).some((turn) => turn.mode !== "readonly" && turn.task_id === job && turn.session_id !== session.id)) return null;
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
      // Lifting one already lifted changes nothing, and opens nothing again. Lifting is going on
      // (ADR 0071): the work it ended opens again on a note, a Stop's too.
      if (store.getHold(id).lifted_at) return store.getHold(id);
      const lifted = store.liftHold(id, { by: "user_button" });
      resumeLifted([lifted], null, { stops: true });
      store.recordWorkEvent({ kind: "control.lift", actor: "user", payload: { hold: id, by: "user_button" } });
      return store.getHold(id);
    });
  }

  /**
   * Your line is your word to the Bots it is said to (ADR 0071): a stop is only "stop for now". One of
   * yours on one Bot's work the line is about is lifted; one over more Bots — everything, a group, a
   * job, a ticket — lets go of the Bots the line is said to, and is lifted once it has let go of every
   * Bot it covers. Returns the holds it lifted or let go of the Bots from, as they now read. A line
   * read as only asking where the work stands lifts none: asking is not telling it to go on, and the
   * Bot answers it read-only, still stopped.
   */
  function liftOnYourLine(message: Message, reading: UserLineReading | null = null): Hold[] {
    // A line that may have meant a stop lifts none: its buttons say which (a complaint it sent back is no such line).
    if (message.kind !== "user" || message.control?.kind === "possible_control" || !on()) return [];
    if (reading?.statusOnly) return [];
    const about = stopsAbout(message);
    if (about.length === 0) return [];
    const bots = saidToBots(message);
    return store.transaction(() =>
      about.flatMap((hold) => {
        const after = onOneBot(hold)
          ? store.liftHold(hold.id, { by: "user_text", messageId: message.id })
          : store.releaseHold(hold.id, bots, { by: "user_text", messageId: message.id });
        store.recordWorkEvent({
          kind: after.lifted_at ? "control.lift" : "control.release",
          actor: "user",
          sessionId: message.session_id,
          payload: { hold: hold.id, by: "user_text", next_line: true, ...(after.lifted_at ? {} : { bots }) },
        });
        return [after];
      }),
    );
  }

  /**
   * A go on the reader read (ADR 0070), once the line is filed: your stops that keep each Bot it is
   * said to from the job it is filed under go — on the Bot's work, on its work in that job or on its
   * ticket, on one of its turns; on this conversation, or on the job when you stopped it from here,
   * only when the line is said to every Bot here — and the line then wakes the Bot like any line, so
   * the Bot goes on from it and says so itself. A stop on another job stays: on 2026-10-09 「继续」 in
   * 视频导演's direct, about the MV that had stopped there, lifted its stop on 《一拳超人》 instead,
   * opened nothing, and the MV stayed where it was. So does a stop on everything, or on a job or a
   * conversation stopped from elsewhere: their buttons lift them. A go on whose words name
   * everything (`scopes`: 「所有 Bot 继续」) lifts every stop you made. Only stops made before the line.
   */
  function goOnWithLine(message: Message, reading: UserLineReading | null, scopes: ControlScope[]): Hold[] {
    if (message.kind !== "user" || !on() || reading?.source !== "model" || reading.control !== "go_on") return [];
    const ids = new Set<string>();
    const present = store.presentBotIds(message.session_id);
    const bots = present.filter((id) => saidTo(message, id));
    if (scopes.some((scope) => scope.scope === "global")) {
      for (const hold of store.listHolds({ inForce: true })) {
        if (hold.created_at < message.created_at && (hold.source === "user_text" || hold.source === "user_button")) ids.add(hold.id);
      }
    }
    for (const botId of bots) {
      const covering = store.holdsCovering({ botId, sessionId: message.session_id, taskId: landedPlan(message, botId), ticketId: message.ticket_id ?? null });
      for (const hold of covering) {
        if (hold.created_at >= message.created_at || hold.scope === "global") continue;
        // This conversation's own stop, or a job's you stopped from here.
        const here = hold.scope === "session" ? hold.scope_id === message.session_id
          : hold.source_message_id !== null && messageSession(hold.source_message_id) === message.session_id;
        if ((hold.scope === "session" || hold.scope === "plan") && (!here || bots.length < present.length)) continue;
        ids.add(hold.id);
      }
    }
    if (ids.size === 0) return [];
    return store.transaction(() =>
      store.listHolds({ inForce: true }).reverse().filter((hold) => ids.has(hold.id)).map((hold) => {
        const lifted = store.liftHold(hold.id, { by: "user_text", messageId: message.id });
        store.recordWorkEvent({ kind: "control.lift", actor: "user", sessionId: message.session_id, payload: { hold: hold.id, by: "user_text", go_on: true } });
        return lifted;
      }),
    );
  }

  /**
   * A line of yours changed (ADR 0063) after you pressed Stop on what it set going: the change is
   * what you say next to that Bot about it, as a new line is (`liftOnYourLine`), so the Stops
   * holding a copy of the line, or the note of what you changed, go, and the Bot goes on from the
   * change. Whatever is in force when the change lands was pressed before it. A stop over more Bots
   * lets go of that copy's Bot only (ADR 0071); a hold of the app's keeps holding them.
   */
  function liftOnYourChange(line: Message, editId: string): Hold[] {
    if (line.kind !== "user" || !on()) return [];
    return goOnForHeldCopies(line, { by: "user_text", payload: { edit: editId } });
  }

  /**
   * 直接插入 (ADR 0069) on a line of yours a Stop holds — one you sent while the Bot worked, and
   * pressed Stop before it read it: you want it read now, so the Stops holding it go and the Bot
   * opens a turn on it. Before, the button was off under a stop and nothing but another line ever
   * lifted a Stop, so the line sat 「叫停中 · 解除后读到」 with the Bot at nothing.
   */
  function liftOnYourInsert(line: Message): Hold[] {
    if (line.kind !== "user" || !on()) return [];
    return goOnForHeldCopies(line, { by: "user_button", payload: { insert: line.id } });
  }

  /**
   * 退回 on a hand-over's card is your word to the Bot that made it to go back to work: a Stop on
   * its work in that job goes, as at a new line of yours about it. Before, the rework waited under
   * the Stop for a line you had no reason to write.
   */
  function liftOnSendBack(card: Message, producer: string, taskId: string, ticketId: string | null): Hold[] {
    if (!on()) return [];
    return store.goOnForYourWord({ botId: producer, taskId, ticketId }, { by: "user_button", sessionId: card.session_id, payload: { send_back: card.id } });
  }

  /**
   * Your word about a line of yours — its change, 直接插入 — goes on past every stop of yours holding
   * a copy of it, or the note of what you changed, for that copy's Bot (`goOnForYourWord`): one on
   * that Bot alone is lifted, one over more Bots lets go of it.
   */
  function goOnForHeldCopies(line: Message, how: { by: "user_text" | "user_button"; payload: Record<string, unknown> }): Hold[] {
    const held = store.db
      .query<{ bot_id: string; session_id: string | null; task_id: string | null; ticket_id: string | null; turn_id: string | null }, [string]>(
        `SELECT bot_id, session_id, task_id, ticket_id, turn_id FROM inbox_items WHERE message_id = ? AND state = 'held'`,
      )
      .all(line.id);
    return store.transaction(() =>
      held.flatMap((item) =>
        store.goOnForYourWord(
          { botId: item.bot_id, sessionId: item.session_id, taskId: item.task_id, ticketId: item.ticket_id, turnId: item.turn_id },
          { by: how.by, messageId: line.id, sessionId: line.session_id, payload: how.payload },
        ),
      ),
    );
  }

  /**
   * The work a lifted stop had ended that your line to a whole group did not reach, opened again on
   * a note with your words. A Bot your line woke goes on from it there, and one already back at that
   * job is at it; the rest were left with nothing to go on from: on 2026-10-04's walkthrough a
   * group's stop cut 文案 off in its direct with the lead, 「宣传语改成英文的，海报改横版」 woke only
   * the lead, and 文案 sat stopped until the supervisor called it back three minutes later to
   * "answer" the old request. The receipt had said the Bots go on from your line. A line that names
   * Bots is for them alone, as 「@X 继续」 is: the others' work stays stopped. A go on (`goOn`) is
   * about the job wherever its work stopped, so it opens that work again in any conversation.
   */
  function goOnFromYourLine(message: Message, lifted: Hold[], goOn = false): Turn[] {
    if (lifted.length === 0 || !on()) return [];
    let group = false;
    try {
      group = store.getSession(message.session_id).kind === "group";
    } catch {
      return [];
    }
    const woken = new Set(wakes(message));
    if (!goOn && (!group || store.presentBotIds(message.session_id).some((id) => !woken.has(id)))) return [];
    // A go on is about the stopped job itself: its work opens again unless the line's own turn is
    // on that job — a 「继续」 to a Bot at its desk does not leave the job it stopped where it was
    // (ADR 0071). Any other line reached a Bot it woke, whatever that turn is on.
    const reached = (record: HeldTurn) =>
      store.listLiveTurns({ botId: record.bot_id }).some(
        (turn) => turn.mode !== "readonly" && (goOn && record.task_id !== null
          ? turn.task_id === record.task_id
          : turn.trigger_message_id === message.id || (record.task_id !== null && turn.task_id === record.task_id)),
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

  return { continueByLine, resumeLifted, lift, liftOnYourLine, liftOnYourChange, liftOnYourInsert, liftOnSendBack, goOnWithLine, goOnFromYourLine, takeUp, continueReceiptLine };
}

export type StopGoOn = ReturnType<typeof createStopGoOn>;
