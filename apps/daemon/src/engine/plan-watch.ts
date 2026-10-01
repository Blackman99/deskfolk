/**
 * Watching a plan for work nobody is moving. A plan that went quiet — no live turn, no appointment
 * pending in it — has stopped short while tickets are still to do or in progress, or, in a group
 * plan of several tickets, once everything is handed over while its progress still lists work not
 * done or held up; or while a check the app ran itself is still failing. Nothing else would wake
 * anyone: every Bot closed its turn thinking its part was done. This calls one Bot back once per
 * stretch of ticket movement, and says so, once, when a call-back changed nothing. `observeTicket` is the other half: moving a ticket forward on what a turn was
 * seen doing, so there is something here to watch in the first place.
 */
import { USER_MEMBER, type AcceptanceCheck, type Locale, type Ticket, type Turn } from "@real-bot/protocol";
import { NO_ABLATION, type Ablation } from "../ablation";
import { describeCheck } from "../acceptance-eval";
import { planLeftNote, planNudgeNote, stalledPlanBody, type FailingCheckLine, type OpenTicketLine } from "../prompts";
import type { TurnAdmission } from "../quiesce";
import { derivedNotGate, parsePlanSpec, type CheckBack, type Store, type Task } from "../store";
import { mayWake } from "./control";

export type PlanWatchDeps = {
  store: Store;
  admission: TurnAdmission | undefined;
  /** Rewrites a plan's `map.md` and its tickets' `ticket.md` from what the store holds. */
  renderMirrors: (taskId: string) => void;
  fireCheckBack: (id: string, now?: Date) => Turn | null;
  /** Benchmark switches (see `ablation.ts`): `plan-nudge` never calls a Bot back or says the plan stopped. */
  ablation?: Ablation;
  /**
   * How long a group plan whose tickets are all handed over, and the session it is in, stay quiet
   * before the plan's own record calls anyone back. Tests shorten it.
   */
  planLeftQuietMs?: number;
};

export type PlanWatch = {
  reconcilePlan: (taskId: string) => void;
  observeTicket: (turnId: string, botId: string, seen: "working" | "delivered") => void;
  /**
   * A turn of the plan was stopped, or the plan was set aside with its conversation's history: the
   * plan is not looked at again once its quiet runs out.
   */
  forgetPlan: (taskId: string) => void;
  clearTimers: () => void;
};

/**
 * The most call-backs a plan gets while you say nothing in it, whatever its budget of one per
 * ticket and check: each one after the first needs a ticket handed over or a check passed since,
 * but a model that keeps opening tickets, or reopening them and handing them over again, would
 * otherwise raise the budget and earn another every time.
 */
export const PLAN_NUDGES_UNANSWERED_MAX = 5;

export function createPlanWatch(deps: PlanWatchDeps): PlanWatch {
  const { store, admission, renderMirrors, fireCheckBack } = deps;
  const ablation = deps.ablation ?? NO_ABLATION;

  /**
   * A plan with everything handed over has usually stopped on a Bot asking you something, and its
   * record lists what waits on your answer. Calling a Bot back sooner would only have it ask again
   * while you are still reading.
   */
  const PLAN_LEFT_QUIET_MS = deps.planLeftQuietMs ?? 10 * 60_000;
  /** One per plan waiting out that quiet. It lives in this process: a restart inside the window drops it. */
  const leftTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  /**
   * What the plan's own record still lists as not done or held up, once nothing is to do or in
   * progress, when that means it stopped short: a group plan of two tickets or more that are not
   * parked, one of them handed over or done. Held-up work counts: a Bot's own freeze is filed there,
   * and it is exactly what nobody else will lift. A plan of one handed-over ticket is a one-shot job
   * waiting for you to look at it. In a direct the last word already went to you, and there is
   * nobody else it could have been dropped between.
   */
  function workLeft(task: Task, sessionId: string, tickets: readonly Ticket[]): string[] {
    if (tickets.filter((ticket) => ticket.status !== "parked").length < 2) return [];
    if (!tickets.some((ticket) => ticket.status === "review" || ticket.status === "done")) return [];
    if (store.getSession(sessionId).kind !== "group") return [];
    const progress = parsePlanSpec(task.spec)?.progress;
    return progress ? [...progress.open, ...progress.blocked] : [];
  }

  /**
   * How much longer the plan must stay quiet before its record calls anyone back: counted from the
   * last thing a turn of it did or your newest line in the session, whichever came later. A line
   * of yours filed under another plan counts too: you are in the conversation either way.
   */
  function quietLeftMs(taskId: string, sessionId: string): number {
    const yours =
      store.db
        .query<{ at: string | null }, [string]>(`SELECT MAX(created_at) AS at FROM messages WHERE session_id = ? AND kind = 'user'`)
        .get(sessionId)?.at ?? "";
    const turns = store.taskLastActivityAt(taskId);
    return Date.parse(yours > turns ? yours : turns) + PLAN_LEFT_QUIET_MS - Date.now();
  }

  /** Looks at the plan again once the quiet has run out; anything that happens meanwhile moves the time. */
  function lookAgainIn(taskId: string, ms: number): void {
    const timer = setTimeout(() => {
      leftTimers.delete(taskId);
      reconcilePlan(taskId);
    }, ms);
    timer.unref?.();
    leftTimers.set(taskId, timer);
  }

  /**
   * The plan stopped — tickets open, checks failing, or work its record still lists — after a
   * call-back: one notification, once per call-back, and nothing in the conversation. The review is
   * the app's own bookkeeping; the flow board already shows the tickets, and a line under the Bot
   * reads as the Bot reporting on itself. `capped` is how many call-backs went out since you last
   * said something in the plan, when that budget, not a call-back that moved nothing, is what
   * stopped the next one.
   */
  function tellStalled(
    sessionId: string,
    taskId: string,
    nudge: CheckBack,
    work: {
      open: readonly OpenTicketLine[];
      failing: readonly FailingCheckLine[];
      left: readonly string[];
      capped: number | null;
    },
    called: string,
    locale: Locale,
  ): void {
    const key = `stalled:${nudge.id}`;
    if (store.db.query(`SELECT 1 FROM notifications WHERE semantic_key = ?`).get(key)) return;
    store.transaction(() => {
      // Kept so the notification can quote it. A line only the woken turn would read: the
      // conversation, search and unread leave it out, and nothing publishes it.
      const note = store.insertMessage({
        sessionId,
        kind: "system",
        author: nudge.bot_id,
        body: stalledPlanBody(locale, { ...work, called }),
        botOnly: true,
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
    });
  }

  function failingCheckLine(check: AcceptanceCheck, locale: Locale): FailingCheckLine {
    return { item: check.item, what: describeCheck(check, locale), detail: check.last_run?.detail ?? "", output: check.last_run?.output ?? null };
  }

  /** A ticket whose worker is present and awake, or null. */
  function workerOf(ticket: Ticket | null | undefined, present: ReadonlySet<string>): string | null {
    return ticket?.worker && present.has(ticket.worker) && isAwake(ticket.worker) ? ticket.worker : null;
  }

  /**
   * A plan that went quiet — no live turn, no appointment pending in it — has stopped short, and
   * nothing else would wake anyone: every Bot closed its turn thinking its part was done. Two ways:
   *
   * - Tickets are still to do or in progress, or a check the app ran itself is still failing. The
   *   app calls one Bot back — the one on the first open ticket; failing that, the worker of a
   *   failing check's own ticket, or of the ticket whose folder the check's path or command runs
   *   in; failing that, the worker of the most recently handed-over ticket; failing that, whoever
   *   spoke last — with the open tickets and up to three failing checks.
   * - In a group plan of two tickets or more that are not parked, nothing is to do or in progress,
   *   no check is failing, something was handed over or done, and the plan's progress still lists
   *   work not done or held up. Such a plan has usually stopped on a question to you, so it and its
   *   session must first have been quiet for a while. The app calls back the Bot that spoke last in
   *   the plan, into the plan's folder: it picks nobody for a ticket, and a Bot does not pass its
   *   own work.
   *
   * After a call-back it calls again only once a ticket has gone to review or done since (a version
   * of the plan recorded after it, or the board now, shows the ticket there while the one before did
   * not; rewording a ticket that sits in review is no move) or a check that predates it has passed
   * for the first time. A hard budget stops it even short of that: since you last said something in
   * the plan, one call-back per ticket and check, and never more than
   * {@link PLAN_NUDGES_UNANSWERED_MAX}. Otherwise it tells you once, as a notification and not as a
   * line in the session: two Bots (or a Bot and a check that will not pass) must not bounce a plan
   * nobody can move. Only plans in a session you are in: you are who the last word goes to. A Bot a hold
   * covers is not called back at all, and nobody is called in its place: the call-back is recorded
   * as a wake the hold turned away, and books nothing.
   */
  function reconcilePlan(taskId: string): void {
    clearTimeout(leftTimers.get(taskId));
    leftTimers.delete(taskId);
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
      // A plan set aside with its conversation's history (ADR 0040) is nobody's to call back into.
      if (!task.session_id || task.routine_id || task.status !== "active" || task.dormant_since) return;
      const sessionId = task.session_id;
      if (!store.isPresent(sessionId, USER_MEMBER)) return;
      if (store.taskLiveTurnCount(taskId) > 0) return;
      if (store.pendingPlanCheckBacks(taskId).length > 0) return;
      const tickets = store.listTickets(taskId);
      const open = tickets.filter((ticket) => ticket.status === "todo" || ticket.status === "doing");
      // A check from your words you have not confirmed is measured for information: it calls nobody back.
      const checks = store.listChecks(taskId).filter((check) => !derivedNotGate(check));
      const failing = checks.filter((check) => check.last_run?.outcome === "fail");
      const left = open.length > 0 || failing.length > 0 ? [] : workLeft(task, sessionId, tickets);
      if (open.length === 0 && failing.length === 0) {
        if (left.length === 0) return;
        const wait = quietLeftMs(taskId, sessionId);
        if (wait > 0) {
          lookAgainIn(taskId, wait);
          return;
        }
      }
      const present = new Set(store.presentBotIds(sessionId));
      const nameOf = (id: string | null): string | null => {
        if (!id) return null;
        try {
          return store.getBot(id).name;
        } catch {
          return null;
        }
      };
      const line = (ticket: Ticket): OpenTicketLine => ({
        seq: ticket.seq,
        title: ticket.title,
        status: ticket.status as OpenTicketLine["status"],
        worker: nameOf(ticket.worker),
      });
      const lines = open.map(line);
      const locale = store.settingsCached().locale;
      const failingLines = failing.slice(0, 3).map((check) => failingCheckLine(check, locale));
      const last = store.lastPlanNudge(taskId);
      if (last) {
        const since = last.created_at;
        const moved = store.ticketHandedOverSince(taskId, since);
        const firstPassed = checks.some((check) => check.first_passed_at && check.defined_at < since && check.first_passed_at > since);
        if (!moved && !firstPassed) {
          const work = { open: lines, failing: failingLines, left, capped: null };
          tellStalled(sessionId, taskId, last, work, nameOf(last.bot_id) ?? "", locale);
          return;
        }
      }
      const since = store.lastUserLineAt(taskId) ?? task.created_at;
      const spent = store.planNudgesSince(taskId, since);
      if (spent >= Math.min(tickets.length + checks.length, PLAN_NUDGES_UNANSWERED_MAX)) {
        const work = { open: lines, failing: failingLines, left, capped: spent };
        if (last) tellStalled(sessionId, taskId, last, work, nameOf(last.bot_id) ?? "", locale);
        return;
      }

      if (open.length > 0 || failing.length > 0) {
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
        if (!mayWake(store, { cause: "plan_nudge", botId, sessionId, taskId, ticketId: target?.id ?? null })) return;
        const mine = target ? (lines.find((line) => line.seq === target!.seq) ?? null) : null;
        booked = store.bookPlanNudge({
          botId,
          sessionId,
          taskId,
          ticketId: target?.id ?? null,
          note: planNudgeNote(locale, { open: lines, mine, failing: failingLines }),
        });
      } else {
        // Nobody accepts their own ticket, and the plan names nobody else: the Bot it stopped on
        // has the latest picture and hands the rest on by name itself.
        const botId = lastSpeaker(taskId, present);
        if (!botId) return;
        if (!mayWake(store, { cause: "plan_nudge", botId, sessionId, taskId })) return;
        // Booking would void the appointment it already has here, which is for another plan (one in
        // this plan stops the watch above). That one's turn settles its own plan, not this one: look
        // again once it has come due and the quiet after it has run out.
        const pending = store.pendingCheckBack(botId, sessionId);
        if (pending) {
          lookAgainIn(taskId, Math.max(0, Date.parse(pending.due_at) - Date.now()) + PLAN_LEFT_QUIET_MS);
          return;
        }
        const review = tickets.filter((ticket) => ticket.status === "review").map(line);
        booked = store.bookPlanNudge({ botId, sessionId, taskId, ticketId: null, note: planLeftNote(locale, { review }) });
      }
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

  function forgetPlan(taskId: string): void {
    clearTimeout(leftTimers.get(taskId));
    leftTimers.delete(taskId);
  }

  function clearTimers(): void {
    for (const timer of leftTimers.values()) clearTimeout(timer);
    leftTimers.clear();
  }

  return { reconcilePlan, observeTicket, forgetPlan, clearTimers };
}
