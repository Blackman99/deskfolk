/** A closing reply taken through everything that has to pass before it goes out, and a turn that ended having said nothing. */
import { type Turn, attachmentLinePaths, type Message } from "@real-bot/protocol";
import { extractWorkspacePathsFromBody, resolveBodyPathsToWorkDir, mergeCitedPaths } from "../../artifact-paths";
import { pathExists } from "../../collab-tools/args";
import { readsAsNoWork, readBotLineByWords } from "../../line-reading";
import { ENGINE_LEVELS } from "../../store/schema-gate";
import { replyOutNote } from "../../turn-pace";
import { inTicketDir } from "../../store";
import type { Live } from "../types";
import type { LifecycleDeps } from "../lifecycle";
import type { TurnEndings } from "./endings";

export function createClosingReply(deps: LifecycleDeps, endings: TurnEndings) {
  const { store, publishMessage, publishTurn, lives, active, track, closingCheck, readBotLine = readBotLineByWords, publishCitedBotMessage, observeTicket, handleParticipation, implicitSubmission } = deps;
  const { executionOf } = endings;

  /**
   * The segment's last word to the user (the closing reply about to go out, else its newest
   * message) and the sentence in which it says the work is still going, as it reads (ADR 0055):
   * what the end contract weighs an ending against. Undefined when it said nothing.
   */
  async function readLastWord(turnId: string, turn: Turn, closing: string): Promise<{ said: string; later: string | null } | undefined> {
    const said = store.segmentLastWord(turnId, closing);
    if (!said?.trim()) return undefined;
    return { said, later: (await readBotLine(said, turn.session_id, { answering: store.segmentAnswering(turnId) })).later };
  }

  /** Whether a closing reply hands over a file of the segment's ticket: one it wrote, or one its words cite. */
  function handsOver(turn: Turn, live: Live, body: string): boolean {
    if (!turn.ticket_id) return false;
    let dir: string;
    try {
      dir = store.getTicket(turn.ticket_id).dir;
    } catch {
      return false;
    }
    return [...live.writtenPaths, ...attachmentLinePaths(body), ...extractWorkspacePathsFromBody(body)].some((path) => inTicketDir(dir, path));
  }

  /**
   * A closing reply — words with no tool call — taken through everything that has to pass before
   * it goes out: the no-work reading, the closing check, the level-5 hand-over of the files it cites,
   * the end contract, then the post, the completed status and whoever it wakes. Shared by the app's
   * own hop loop and a Claude Agent turn (ADR 0061). `bounce` is a line the Bot answers in one more
   * step; `ended` means the reply went out and the turn is completed; `inactive` means the turn
   * stopped meanwhile, and whatever stopped it wrote its end. Only the closing check holds the words
   * back; what the hand-over or the end contract sends back is about the work, so a reply that passed
   * its own checks is already out by then, and the bounce says so.
   */
  async function settleClosingReply(
    turnId: string,
    live: Live,
    current: Turn,
    content: string,
  ): Promise<{ kind: "bounce"; note: string } | { kind: "ended" } | { kind: "inactive" }> {
    const closer = await readsAsNoWork(content, (text) => readBotLine(text, current.session_id, { answering: store.segmentAnswering(turnId) }));
    if (!active(turnId, live)) return { kind: "inactive" };
    const rawBody = closer ? "" : content;
    // A delivery to the user goes out only after one look at what the job asked for. The note
    // comes back as a user line in the loop, and the next reply is final whatever it says.
    const closingBody = resolveBodyPathsToWorkDir(rawBody, live.workDir, (relpath) => pathExists(store, relpath));
    const bounce = await closingCheck(turnId, live, current, {
      body: closingBody,
      said: rawBody,
      paths: mergeCitedPaths(live.writtenPaths, [
        ...attachmentLinePaths(closingBody),
        ...extractWorkspacePathsFromBody(closingBody),
      ]),
      sessionId: current.session_id,
    });
    if (!active(turnId, live)) return { kind: "inactive" };
    if (bounce) return { kind: "bounce", note: bounce };
    // From level 5 a closing reply that hands files over goes out first, so what it cites is
    // handed over (the implicit submission) before the ending is weighed (§5.2). Words alone
    // are never inferred from a plain-text closing reply — that verbal hand-over once let
    // "母带剪好了" approve a ticket nobody checked (ADR 0046): a ticket whose work
    // is words closes only through an explicit `end_turn(done, answer)` (engine/tools.ts).
    let posted: Message | null | undefined;
    const files = store.capabilities().engine_level >= ENGINE_LEVELS.submissions && handsOver(current, live, closingBody);
    if (files) {
      posted = publishCitedBotMessage(current, live, turnId, rawBody);
      const produced = live.producedPaths ?? [];
      live.writtenPaths = [];
      let settled: Awaited<ReturnType<typeof implicitSubmission>> = null;
      try {
        settled = await implicitSubmission(turnId);
        // Files of a ticket someone else owns: not handed over for this Bot, which hears so once.
        const hint = !settled ? store.handOverHint({ turnId, paths: produced }) : null;
        if (hint) {
          if (posted && !live.parentId && current.mode !== "readonly") void track(handleParticipation(posted, { fromUser: false }));
          return { kind: "bounce", note: posted ? replyOutNote(live.locale, hint) : hint };
        }
      } catch (error) {
        console.error(`[turn ${turnId}] could not hand its files over`, error);
      }
      if (!active(turnId, live)) return { kind: "inactive" };
      // Handed over and sent back by its checks: the Bot hears why, and goes on (handing the same
      // bytes over again hands nothing over, so the next ending is weighed as usual).
      if (settled?.state === "checks_failed") {
        const lines = settled.failures.map((check) => live.locale === "en" ? `"${check.item}": ${check.detail || "fail"}` : `「${check.item}」：${check.detail || "不通过"}`);
        if (posted && !live.parentId && current.mode !== "readonly") void track(handleParticipation(posted, { fromUser: false }));
        const failed = live.locale === "en"
          ? `(app) What you handed over failed its checks, so the ticket did not move: ${lines.join("; ")}. Fix it, or end_turn saying what blocks you.`
          : `（应用）你交出的东西没过检查，任务没往前走：${lines.join("；")}。改好再交，或者用 end_turn 说明卡在哪。`;
        return { kind: "bounce", note: posted ? replyOutNote(live.locale, failed) : failed };
      }
    }
    let endingLine: string | null = null;
    if (store.capabilities().engine_level >= ENGINE_LEVELS.delegation) {
      const lastWord = await readLastWord(turnId, current, rawBody);
      if (!active(turnId, live)) return { kind: "inactive" };
      const finished = store.finishWork({ turnId, reason: "done" }, { pureText: true, closing: rawBody, lastWord, written: live.producedPaths ?? live.writtenPaths });
      if (finished.bounce) {
        // The ending is weighed on the work (files of an approved ticket not handed over, a ticket
        // still open), not on the words, and a Bot takes a reply it wrote for said. Held back, it
        // never went out: on 2026-10-07 视频导演's answers to two of your questions waited on an
        // approved_changed bounce, it handed the files over as told, submit ended the segment, and
        // only the files were left. So the words go out now, before the Bot hears about the work.
        if (posted === undefined && rawBody.trim()) posted = publishCitedBotMessage(current, live, turnId, rawBody);
        if (posted && !live.parentId && current.mode !== "readonly") void track(handleParticipation(posted, { fromUser: false }));
        return { kind: "bounce", note: posted ? replyOutNote(live.locale, finished.bounce) : finished.bounce };
      }
      if (finished.notice || finished.ask) endingLine = finished.ask?.body ?? finished.notice!.body;
    }
    const message = posted !== undefined ? posted : publishCitedBotMessage(current, live, turnId, rawBody);
    // The line about how it ended reads after the reply it is about (「它说了『…』，但这一轮已经结束了」).
    if (endingLine) {
      publishMessage(store.insertMessage({ sessionId: current.session_id, turnId, kind: "system", author: current.bot_id,
        body: endingLine, hiddenFromBots: true }));
    }
    if (message && live.writtenPaths.length > 0) observeTicket(turnId, current.bot_id, "delivered");
    const completed = store.setTurnStatus(turnId, "completed", executionOf(live));
    lives.delete(turnId);
    publishTurn(completed, null);
    // A closing reply goes out the way send_message would: in a group it wakes whoever it
    // names, in a Bot↔Bot direct the other Bot. A you↔Bot direct has no one else to wake. A
    // read-only turn's answer is for you and wakes nobody (ADR 0040 I2's exemption goes no further).
    if (message && !live.parentId && current.mode !== "readonly") {
      void track(handleParticipation(message, { fromUser: false }));
    }
    return { kind: "ended" };
  }

  return { settleClosingReply };
}

export type ClosingReply = ReturnType<typeof createClosingReply>;
