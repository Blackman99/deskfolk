/**
 * Watching a plan for tickets nobody is moving. A plan that went quiet — no live turn, no
 * appointment pending in it — while tickets are still to do or in progress has stopped short, and
 * nothing else would wake anyone: every Bot closed its turn thinking its part was done. This calls
 * one Bot back once per stretch of ticket movement, and says so, once, when a call-back changed
 * nothing. `observeTicket` is the other half: moving a ticket forward on what a turn was seen
 * doing, so there is something here to watch in the first place.
 */
import { USER_MEMBER, type AcceptanceCheck, type Locale, type Message, type Ticket, type Turn } from "@real-bot/protocol";
import { NO_ABLATION, type Ablation } from "../ablation";
import { describeCheck } from "../acceptance-eval";
import { planNudgeNote, stalledPlanBody, type FailingCheckLine, type OpenTicketLine } from "../prompts";
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

  /** The plan stopped — tickets open, checks failing, or both — after a call-back: a line in the session and one notification, once per call-back. */
  function tellStalled(
    sessionId: string,
    taskId: string,
    nudge: CheckBack,
    open: readonly OpenTicketLine[],
    failing: readonly FailingCheckLine[],
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
        body: stalledPlanBody(locale, { open, called, failing }),
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

  function failingCheckLine(check: AcceptanceCheck, locale: Locale): FailingCheckLine {
    return { item: check.item, what: describeCheck(check, locale), detail: check.last_run?.detail ?? "", output: check.last_run?.output ?? null };
  }

  /** A ticket whose worker is present and awake, or null. */
  function workerOf(ticket: Ticket | null | undefined, present: ReadonlySet<string>): string | null {
    return ticket?.worker && present.has(ticket.worker) && isAwake(ticket.worker) ? ticket.worker : null;
  }

  /**
   * A plan that went quiet — no live turn, no appointment pending in it — while tickets are still
   * to do or in progress, or a check the app ran itself is still failing, has stopped short and
   * nothing else would wake anyone: every Bot closed its turn thinking its part was done. The app
   * calls one Bot back — the one on the first open ticket; failing that, the worker of a failing
   * check's own ticket, or of the ticket whose folder the check's path or command runs in; failing
   * that, the worker of the most recently handed-over ticket; failing that, whoever spoke last —
   * with the open tickets and up to three failing checks. If a call-back came and neither a ticket
   * closed nor a check that predates it passed for the first time since, it does not call again: it
   * tells you, once, in the session and as a notification. A hard budget — nudges since the user's
   * own last line here, against tickets plus checks — stops it even short of that, so two Bots (or
   * a Bot and a check that will not pass) cannot bounce a plan forever. Only plans in a session you
   * are in: you are who the last word goes to.
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
      const checks = store.listChecks(taskId);
      const failing = checks.filter((check) => check.last_run?.outcome === "fail");
      if (open.length === 0 && failing.length === 0) return;
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
      const failingLines = failing.slice(0, 3).map((check) => failingCheckLine(check, locale));
      const last = store.lastPlanNudge(taskId);
      if (last) {
        const since = last.created_at;
        const moved = tickets.some((ticket) => ticket.updated_at > since && (ticket.status === "review" || ticket.status === "done"));
        const firstPassed = checks.some((check) => check.first_passed_at && check.defined_at < since && check.first_passed_at > since);
        if (!moved && !firstPassed) {
          tellStalled(sessionId, taskId, last, lines, failingLines, nameOf(last.bot_id) ?? "", locale);
          return;
        }
      }
      const since = store.lastUserLineAt(taskId) ?? task.created_at;
      if (store.planNudgesSince(taskId, since) >= tickets.length + checks.length) {
        if (last) tellStalled(sessionId, taskId, last, lines, failingLines, nameOf(last.bot_id) ?? "", locale);
        return;
      }

      // Target: the first open ticket's worker; else a failing check's own ticket, or the ticket
      // whose folder its path or cwd sits under; else the most recently handed-over ticket; else
      // whoever spoke last.
      let target: Ticket | null = open.find((ticket) => workerOf(ticket, present)) ?? null;
      if (!target) {
        for (const check of failing) {
          const own = check.ticket_id ? (tickets.find((ticket) => ticket.id === check.ticket_id) ?? null) : null;
          if (workerOf(own, present)) {
            target = own;
            break;
          }
          const place = check.kind === "command" ? check.cwd : check.path;
          const under = place ? (tickets.find((ticket) => place === ticket.dir || place.startsWith(`${ticket.dir}/`)) ?? null) : null;
          if (workerOf(under, present)) {
            target = under;
            break;
          }
        }
      }
      if (!target) {
        const handedOver = tickets
          .filter((ticket) => ticket.status === "review" || ticket.status === "done")
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
        target = handedOver.find((ticket) => workerOf(ticket, present)) ?? null;
      }
      const botId = workerOf(target, present) ?? lastSpeaker(taskId, present);
      if (!botId) return;
      const mine = target ? (lines.find((line) => line.seq === target!.seq) ?? null) : null;
      booked = store.bookPlanNudge({
        botId,
        sessionId,
        taskId,
        ticketId: target?.id ?? null,
        note: planNudgeNote(locale, { open: lines, mine, failing: failingLines }),
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
