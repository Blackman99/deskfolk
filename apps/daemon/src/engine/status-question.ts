/**
 * 进度询问: answering a status question ("怎么样了", "how's it going") from what the store already
 * knows, so asking never organizes, judges, wakes or redirects a turn. `turn-engine.ts` checks this
 * ahead of everything else `handleInboundMessage` would otherwise do with a user line.
 *
 * WHY: a real group (4 Bots, 169 turns over 5 days) had the user ask "怎么样了" about 8 times. Each
 * one went through the organizer (once it even opened a new plan titled 「怎么样了」 that ran 79
 * turns on its own), then participation judgement, and a Bot that judged "join" was redirected —
 * its live turn ended and a new one started — so asking for status interrupted the work. In a
 * direct it forks a second turn beside the busy one instead. The fix is to answer the question
 * from the plan's own rows and never touch a live turn at all.
 *
 * Nor does it call a quiet plan back. It used to, when nothing was running and tickets were open,
 * so asking where a job you had stopped stood set it going again (ADR 0040 P1): a question only
 * asks.
 */
import { USER_MEMBER, type Message } from "@real-bot/protocol";
import { sessionLabel } from "../context";
import {
  statusQuestionBody,
  type StatusArtifactLine,
  type StatusCheckBackLine,
  type StatusWaitingLine,
  type StatusTicketLine,
  type StatusWorkingLine,
} from "../prompts";
import type { TurnAdmission } from "../quiesce";
import { isStatusQuestion } from "../status-question";
import type { Store } from "../store";
import { takeCodePoints } from "../text";

export type StatusQuestionDeps = {
  store: Store;
  publishMessage: (message: Message) => void;
  admission?: TurnAdmission;
};

export type StatusQuestionEngine = {
  /** True when `message` was a status question this fully handled — the caller does nothing else with it. */
  handle: (message: Message) => boolean;
};

/** Code points of a live turn's latest command the status line quotes. */
const LAST_STEP_MAX = 60;
const WORKING_LINES_MAX = 8;
const TICKET_LINES_MAX = 12;
const ARTIFACT_LINES_MAX = 3;
const FAILING_CHECK_LINES_MAX = 3;
const WAITING_LINES_MAX = 4;
const CHECK_BACK_LINES_MAX = 3;
/** Code points of an approval summary, a question or a check-back note the status line quotes. */
const WAITING_TEXT_MAX = 80;

export function createStatusQuestion(deps: StatusQuestionDeps): StatusQuestionEngine {
  const { store, publishMessage, admission } = deps;

  /** The session's current plan, else the plan of its most recent turn; null when it has neither. */
  function planIdFor(sessionId: string): string | null {
    const current = store.sessionCurrentTask(sessionId);
    if (current) return current.id;
    const row = store.db
      .query<{ task_id: string | null }, [string]>(
        `SELECT task_id FROM turns WHERE session_id = ? AND task_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId);
    return row?.task_id ?? null;
  }

  /** The Bot whose turn most recently touched this plan — the least surprising author for a system line about it. */
  function mostRecentPlanBot(taskId: string): string | null {
    const row = store.db
      .query<{ bot_id: string }, [string]>(
        `SELECT bot_id FROM turns WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId);
    return row?.bot_id ?? null;
  }

  function botName(id: string): string {
    try {
      return store.getBot(id).name;
    } catch {
      return id;
    }
  }

  function ticketRef(ticketId: string): { seq: number; title: string } | null {
    try {
      const row = store.getTicket(ticketId);
      return { seq: row.seq, title: row.title };
    } catch {
      return null;
    }
  }

  function turnBot(turnId: string): string | null {
    try {
      return store.getTurn(turnId).bot_id;
    } catch {
      return null;
    }
  }

  /** The plan's own last movement: its latest turn activity or ticket update, whichever is newer. */
  function lastMovedAt(taskId: string): string | null {
    const turnAt =
      store.db.query<{ at: string | null }, [string]>(`SELECT MAX(last_activity_at) AS at FROM turns WHERE task_id = ?`).get(taskId)
        ?.at ?? null;
    const ticketAt =
      store.db.query<{ at: string | null }, [string]>(`SELECT MAX(updated_at) AS at FROM tickets WHERE task_id = ?`).get(taskId)?.at ??
      null;
    const candidates = [turnAt, ticketAt].filter((value): value is string => Boolean(value));
    return candidates.length > 0 ? candidates.reduce((a, b) => (a > b ? a : b)) : null;
  }

  function minutesSince(iso: string, now: number): number {
    return Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  }

  function handle(message: Message): boolean {
    if (admission?.draining) return false;
    if (!isStatusQuestion(message)) return false;
    const taskId = planIdFor(message.session_id);
    if (!taskId) return false;
    let task;
    try {
      task = store.getTask(taskId);
    } catch {
      return false;
    }

    const locale = store.settingsCached().locale;
    const now = Date.now();

    const liveOnPlan = store.listLiveTurns().filter((turn) => turn.task_id === taskId);
    const heldOnYou = liveOnPlan.filter((turn) => turn.status === "waiting_approval" || turn.status === "waiting_ask");
    const pendingApprovals = heldOnYou.length > 0 ? store.listApprovals("pending") : [];
    const waiting: StatusWaitingLine[] = heldOnYou.slice(0, WAITING_LINES_MAX).map((turn) => {
      let text = "";
      if (turn.status === "waiting_approval") {
        text = pendingApprovals.find((approval) => approval.turn_id === turn.id)?.summary ?? "";
      } else if (turn.pending_ask_id) {
        try {
          text = store.getMessage(turn.pending_ask_id).body;
        } catch {
          text = "";
        }
      }
      return {
        bot: botName(turn.bot_id),
        kind: turn.status === "waiting_approval" ? "approval" : "ask",
        text: takeCodePoints(text.replace(/\s+/g, " ").trim(), WAITING_TEXT_MAX).text,
        elsewhere: turn.session_id !== message.session_id ? sessionLabel(store, turn.session_id, null, locale) : null,
      };
    });
    const running = liveOnPlan.filter((turn) => turn.status === "running");
    const working: StatusWorkingLine[] = running.slice(0, WORKING_LINES_MAX).map((turn) => {
      const runs = store.turnRuns(turn.id);
      const lastRun = runs.length > 0 ? runs[runs.length - 1]! : null;
      return {
        bot: botName(turn.bot_id),
        ticket: turn.ticket_id ? ticketRef(turn.ticket_id) : null,
        minutes: minutesSince(turn.created_at, now),
        lastStep: lastRun ? takeCodePoints(lastRun.command, LAST_STEP_MAX).text : null,
        elsewhere: turn.session_id !== message.session_id ? sessionLabel(store, turn.session_id, null, locale) : null,
      };
    });

    const allTickets = store.listTickets(taskId);
    const tickets: StatusTicketLine[] = allTickets.slice(0, TICKET_LINES_MAX).map((ticket) => ({
      seq: ticket.seq,
      title: ticket.title,
      status: ticket.status,
      worker: ticket.worker ? botName(ticket.worker) : null,
    }));

    const cited = store.taskArtifacts(taskId, store.citedPathExists, ARTIFACT_LINES_MAX);
    const artifacts: StatusArtifactLine[] = cited.map((row) => {
      const authorId = row.turn_id ? turnBot(row.turn_id) : null;
      return {
        path: row.path,
        author: authorId ? botName(authorId) : locale === "en" ? "someone" : "有人",
        minutesAgo: minutesSince(row.last_cited_at, now),
      };
    });

    const allChecks = store.listChecks(taskId);
    const passed = allChecks.filter((check) => check.last_run?.outcome === "pass").length;
    const failingChecks = allChecks.filter((check) => check.last_run?.outcome === "fail");
    const failing = failingChecks
      .slice(0, FAILING_CHECK_LINES_MAX)
      .map((check) => ({ item: check.item, detail: check.last_run?.detail ?? "" }));

    const checkBacks: StatusCheckBackLine[] = store
      .pendingPlanCheckBacks(taskId)
      .slice(0, CHECK_BACK_LINES_MAX)
      .map((row) => ({
        bot: botName(row.bot_id),
        inMinutes: Math.max(0, Math.round((Date.parse(row.due_at) - now) / 60_000)),
        note: takeCodePoints((row.note ?? "").replace(/\s+/g, " ").trim(), WAITING_TEXT_MAX).text,
      }));

    let idleMinutes: number | null = null;
    if (working.length === 0) {
      const at = lastMovedAt(taskId);
      idleMinutes = at ? minutesSince(at, now) : null;
    }

    const body = statusQuestionBody(locale, {
      plan: { title: task.title, status: task.status },
      working,
      tickets,
      artifacts,
      checks: { passed, total: allChecks.length, failing },
      idleMinutes,
      waiting,
      checkBacks,
    });

    const author = mostRecentPlanBot(taskId) ?? USER_MEMBER;
    const note = store.transaction(() => {
      const inserted = store.insertMessage({
        sessionId: message.session_id,
        kind: "system",
        author,
        body,
        hiddenFromBots: true,
      });
      store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [taskId, inserted.id]);
      return inserted;
    });
    publishMessage(note);
    return true;
  }

  return { handle };
}
