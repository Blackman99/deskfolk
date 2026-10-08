/** How a turn ends other than by its closing reply: failed, retried, crashed or interrupted, and what it was running on. */
import { type Turn, USER_MEMBER } from "@real-bot/protocol";
import { isRetriedFailure, retryNote } from "../../hop-limits";
import { type FailKind, completionFailBody } from "../../prompts";
import { isoNow } from "../../ids";
import { MODEL_FAIL_SHAPES } from "../../store/quality";
import type { TurnExecution } from "../../store/routing";
import type { Live } from "../types";
import type { LifecycleDeps } from "../lifecycle";

/** Claude Agent failures only the user can clear (ADR 0061): the supervisor does not retry them. */
const USER_FIX_FAILS: ReadonlySet<FailKind> = new Set<FailKind>(["agent_missing", "agent_signed_out", "agent_limit"]);

export function createTurnEndings(deps: LifecycleDeps) {
  const { store, publishMessage, publishTurn, lives } = deps;

  /**
   * The hop loop runs detached, so a throw used to vanish and leave the row `running` for good:
   * the sidebar said Thinking until the next boot and the Bot waiting on the other side of a
   * handoff never heard back. Close the turn instead, and say so in the transcript.
   */
  async function crashTurn(turnId: string, error: unknown): Promise<void> {
    console.error(`[turn ${turnId}] crashed`, error);
    try {
      failTurn(turnId, "crashed");
    } catch {
      // the turn or the store is already gone; the sweep and the next boot still catch the row
    }
  }

  /**
   * The counts a live turn has accumulated. Null when this process was not running the turn, so
   * the route row stays unknown instead of claiming a clean zero.
   */
  function executionOf(live: Live | undefined): TurnExecution | null {
    if (!live) return null;
    return {
      hops: live.hops,
      toolCalls: live.toolCalls,
      toolErrors: live.toolErrors,
      repeatedFailures: live.repeatedFailures,
      filesWritten: live.writtenPaths.length,
      failures: live.failures,
    };
  }

  function interruptTurn(current: Turn): void {
    const result = store.interruptTurnRecord(current.id, executionOf(lives.get(current.id)));
    if (result) {
      publishMessage(result.note);
      publishTurn(result.turn);
    }
  }

  /**
   * A hop that loops, is a canned refusal, arrives in half or runs past its time limit failed; it
   * is not a reply (ADR 0040 P1). None of it is posted or kept in the loop, so it wakes nobody. The
   * same model gets one more go with a note, and failing again in a row ends the turn with a failure
   * line in the session. The endpoint failing outright ends the turn at once: the client has already
   * asked again. True when the hop goes again.
   */
  function retryOrFail(turnId: string, live: Live, kind: FailKind): boolean {
    if (isRetriedFailure(kind) && !live.retried) {
      live.retried = true;
      live.loop.push({ role: "user", content: retryNote(live.locale, kind) });
      return true;
    }
    failTurn(turnId, kind);
    return false;
  }

  function failTurn(turnId: string, kind: FailKind, detail?: string | null): void {
    const live = lives.get(turnId);
    const current = store.getTurn(turnId);
    if (live?.abort.signal.aborted || !["running", "waiting_ask", "waiting_approval"].includes(current.status)) return;
    const locale = store.settingsCached().locale;
    const now = isoNow();
    const { message, completed } = store.transaction(() => {
      const message = store.insertMessage({
        sessionId: current.session_id,
        turnId,
        parentId: live?.parentId ?? null,
        kind: "system",
        author: current.bot_id,
        body: completionFailBody(locale, kind, detail),
      });
      store.voidPendingTurnActions(turnId, "turn_failed", now);
      store.finishTurnRoute(turnId, "failed", kind, executionOf(live));
      // A reply that failed again after its retry steps its job up for the next turn (ADR 0054).
      if (MODEL_FAIL_SHAPES.has(kind)) store.stepUpForTrouble(turnId, "failure_shape", now);
      // From level 8 how the turn failed is filed by its shape: a loop or a refusal is the model's (ADR 0050).
      if (store.learningOn()) {
        store.recordWorkEvent({ kind: "turn.failed", actor: "app", botId: current.bot_id, taskId: current.task_id, ticketId: current.ticket_id,
          turnId, sessionId: current.session_id, payload: { fail_kind: kind } });
      }
      // From the supervisor's level the job needs attention; its 「继续」 line is this failure line.
      // What only you can fix — Claude Code missing, signed out, out of usage — is not retried for
      // you: it would fail the same way until you do (ADR 0061).
      if (!USER_FIX_FAILS.has(kind)) store.markSegmentCutOff(turnId, kind);
      // Work the supervisor takes up is retried without you; it tells you when it stops retrying.
      if (store.isPresent(current.session_id, USER_MEMBER) && !store.supervisorTakesUp(turnId)) {
        store.createNotification({
          semantic_key: `failure:${turnId}`,
          kind: "failure",
          session_id: current.session_id,
          turn_id: turnId,
          message_id: message.id,
          created_at: now,
          action_state: "open",
          fail_kind: kind,
        });
      }
      return { message, completed: store.setTurnStatus(turnId, "completed") };
    });
    publishMessage(message);
    publishTurn(completed, null);
  }

  return { crashTurn, executionOf, interruptTurn, retryOrFail, failTurn };
}

export type TurnEndings = ReturnType<typeof createTurnEndings>;
