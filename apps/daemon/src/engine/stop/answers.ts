/** What the app answers under a stop: where the work stands, a read-only turn that said nothing, and the lines for a plan's status. */
import type { Message, ControlScope, Turn, ControlOffer } from "@real-bot/protocol";
import type { UserLineReading } from "../../line-reading";
import { controlStatusBody, clockOf, heldLines } from "../../prompts";
import type { StopDeps } from "../stop";
import type { StopReach } from "./reach";
import type { StopWords } from "./words";
import type { StopCarryOut } from "./carry-out";

export function createStopAnswers(deps: StopDeps, reach: StopReach, words: StopWords, carry: StopCarryOut) {
  const { store, publishMessage, publishTurn, lives } = deps;
  const { scopeHolds, on, heldAbout, inScope, workOnHere, heldTurn } = reach;
  const { headingBots, authorIn, locale, aboutLabel, scopeLabel, holdSaid, turnLine } = words;
  const { endViolations } = carry;

  /**
   * A line that only asks where the work stands, which the plan's status answer did not take (no
   * plan to report on): it takes the path any line takes, unless a stop covers what it asks about.
   */
  function statusLine(message: Message, scopes: ControlScope[], line: UserLineReading): boolean {
    if (!line.statusOnly || !scopes.some((scope) => scopeHolds(scope, message).length > 0)) return false;
    answerStatus(message, scopes, { offerStop: false });
    return true;
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

  return { statusLine, unanswered, answerStatus, heldLinesFor };
}

export type StopAnswers = ReturnType<typeof createStopAnswers>;
