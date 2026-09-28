/**
 * Watching a plan for tickets nobody is moving. A plan that went quiet — no live turn, no
 * appointment pending in it — while tickets are still to do or in progress has stopped short, and
 * nothing else would wake anyone: every Bot closed its turn thinking its part was done. This calls
 * one Bot back once per stretch of ticket movement, and says so, once, when a call-back changed
 * nothing. `observeTicket` is the other half: moving a ticket forward on what a turn was seen
 * doing, so there is something here to watch in the first place.
 */
import { USER_MEMBER, type Locale, type Message, type Turn } from "@real-bot/protocol";
import { NO_ABLATION, type Ablation } from "../ablation";
import { planNudgeNote, stalledPlanBody, type OpenTicketLine } from "../prompts";
import type { TurnAdmission } from "../quiesce";
import type { CheckBack, Store } from "../store";

export type PlanWatchDeps = {
  store: Store;
  admission: TurnAdmission | undefined;
  publishMessage: (message: Message) => void;
  /** Rewrites a plan's `map.md` and its tickets' `ticket.md` from what the store holds. */
  renderMirrors: (taskId: string) => void;
  fireCheckBack: (id: string, now?: Date) => Turn | null;
  /** Benchmark switches (see `ablation.ts`): `plan-nudge` never calls a Bot back or says the plan stopped. */
  ablation?: Ablation;
};

export type PlanWatch = {
  reconcilePlan: (taskId: string) => void;
  observeTicket: (turnId: string, botId: string, seen: "working" | "delivered") => void;
};

export function createPlanWatch(deps: PlanWatchDeps): PlanWatch {
  const { store, admission, publishMessage, renderMirrors, fireCheckBack } = deps;
  const ablation = deps.ablation ?? NO_ABLATION;

  function isAwake(botId: string): boolean {
    try {
      return !store.getBot(botId).archived_at;
    } catch {
      return false;
    }
  }

  /** The Bot that last spoke in the plan and is still in its session. */
  function lastSpeaker(taskId: string, present: ReadonlySet<string>): string | null {
    const rows = store.db
      .query<{ author: string }, [string]>(
        `SELECT author FROM messages WHERE task_id = ? AND kind = 'bot' ORDER BY created_at DESC, rowid DESC LIMIT 20`,
      )
      .all(taskId);
    return rows.find((row) => present.has(row.author) && isAwake(row.author))?.author ?? null;
  }

  /** The plan stopped with tickets open after a call-back: a line in the session and one notification, once per call-back. */
  function tellStalled(
    sessionId: string,
    taskId: string,
    nudge: CheckBack,
    open: readonly OpenTicketLine[],
    called: string,
    locale: Locale,
  ): void {
    const key = `stalled:${nudge.id}`;
    if (store.db.query(`SELECT 1 FROM notifications WHERE semantic_key = ?`).get(key)) return;
    const note = store.transaction(() => {
      const note = store.insertMessage({
        sessionId,
        kind: "system",
        author: nudge.bot_id,
        body: stalledPlanBody(locale, { open, called }),
      });
      store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [taskId, note.id]);
      if (store.isPresent(sessionId, USER_MEMBER)) {
        store.createNotification({
          semantic_key: key,
          kind: "failure",
          session_id: sessionId,
          message_id: note.id,
          action_state: "open",
          fail_kind: "stalled_plan",
        });
      }
      return note;
    });
    publishMessage(note);
  }

  /**
   * A plan that went quiet — no live turn, no appointment pending in it — while tickets are still
   * to do or in progress has stopped short, and nothing else would wake anyone: every Bot closed
   * its turn thinking its part was done. The app calls one Bot back, the one on the first open
   * ticket (else whoever spoke last in the plan), with the open tickets. If a call-back came and no
   * ticket has moved to review or done since, it does not call again: it tells you, once, in the
   * session and as a notification. Each further call-back needs a ticket to have closed, so they
   * run out with the tickets; two Bots must not bounce on a plan nobody can move. Only plans in a
   * session you are in: you are who the last word goes to.
   */
  function reconcilePlan(taskId: string): void {
    if (admission?.draining || ablation.has("plan-nudge")) return;
    let task: ReturnType<Store["getTask"]>;
    try {
      task = store.getTask(taskId);
    } catch {
      // the plan, or the store, went away while it was quiet
      return;
    }
    let booked: CheckBack | null = null;
    try {
      if (!task.session_id || task.routine_id || task.status !== "active") return;
      const sessionId = task.session_id;
      if (!store.isPresent(sessionId, USER_MEMBER)) return;
      if (store.taskLiveTurnCount(taskId) > 0) return;
      if (store.pendingPlanCheckBacks(taskId).length > 0) return;
      const tickets = store.listTickets(taskId);
      const open = tickets.filter((ticket) => ticket.status === "todo" || ticket.status === "doing");
      if (open.length === 0) return;
      const present = new Set(store.presentBotIds(sessionId));
      const nameOf = (id: string | null): string | null => {
        if (!id) return null;
        try {
          return store.getBot(id).name;
        } catch {
          return null;
        }
      };
      const lines: OpenTicketLine[] = open.map((ticket) => ({
        seq: ticket.seq,
        title: ticket.title,
        status: ticket.status as OpenTicketLine["status"],
        worker: nameOf(ticket.worker),
      }));
      const locale = store.settingsCached().locale;
      const last = store.lastPlanNudge(taskId);
      if (last) {
        const since = last.created_at;
        const moved = tickets.some((ticket) => ticket.updated_at > since && (ticket.status === "review" || ticket.status === "done"));
        if (!moved) {
          tellStalled(sessionId, taskId, last, lines, nameOf(last.bot_id) ?? "", locale);
          return;
        }
      }
      const target = open.find((ticket) => ticket.worker && present.has(ticket.worker) && isAwake(ticket.worker));
      const botId = target?.worker ?? lastSpeaker(taskId, present);
      if (!botId) return;
      const mine = target ? lines[open.indexOf(target)]! : null;
      booked = store.bookPlanNudge({
        botId,
        sessionId,
        taskId,
        ticketId: target?.id ?? null,
        note: planNudgeNote(locale, { open: lines, mine }),
      });
    } catch (error) {
      console.error(`[plan ${taskId}] reconcile failed`, error);
      return;
    }
    try {
      fireCheckBack(booked.id);
    } catch {
      // left pending: the scheduler's next tick fires it
    }
  }

  /**
   * Moves the turn's ticket forward on what the turn was seen doing (see `observeTicketWork`), and
   * rewrites the plan's mirror files when it did. Best-effort: the board is a record of the work.
   */
  function observeTicket(turnId: string, botId: string, seen: "working" | "delivered"): void {
    try {
      const ticketId = store.ticketOfTurn(turnId);
      if (!ticketId) return;
      const moved = store.observeTicketWork({ ticketId, botId, seen });
      if (moved) renderMirrors(moved.task_id);
    } catch {
      // a ticket or turn gone meanwhile has nothing left to move
    }
  }

  return { reconcilePlan, observeTicket };
}
