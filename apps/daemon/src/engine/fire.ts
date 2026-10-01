/**
 * The two ways a turn opens without anyone typing: a Bot's own check-back coming due, and a
 * routine's schedule firing. Both land a system line under the Bot that is waking, so the
 * transcript reads as the Bot remembering something rather than the user asking for it, and both
 * open (or join) a turn the same way a mention would.
 */
import { USER_MEMBER, type ClientEvent, type Message, type Turn } from "@real-bot/protocol";
import { isoNow } from "../ids";
import { checkBackNoteBody, routineFireBody } from "../prompts";
import type { TurnAdmission } from "../quiesce";
import { sessionUpsertFields } from "../session-events";
import { localDate, type CheckBack, type Store } from "../store";
import { PLAN_NUDGE } from "../store/check-backs";
import { heldWake, mayWake, type WakeCause } from "./control";
import type { InboxEntry } from "./types";

export type FireDeps = {
  store: Store;
  publish: (event: ClientEvent) => void;
  occurred: () => string;
  publishMessage: (message: Message) => void;
  admission: TurnAdmission | undefined;
  /** Late-bound: lifecycle.ts is built after this module. Null when a hold turns the wake away. */
  startTurn: (
    sessionId: string,
    botId: string,
    trigger: Message,
    mode: "redirect" | "fork",
    opts: { cause: WakeCause; routineId?: string | null; routineDueAt?: string | null; taskId?: string | null; ticketId?: string | null },
  ) => Turn | null;
  /** Late-bound: lifecycle.ts is built after this module. Null when a hold turns the wake away. */
  hearOrStart: (
    sessionId: string,
    botId: string,
    trigger: Message,
    entry: Omit<InboxEntry, "message">,
    opts: { cause: WakeCause; taskId?: string | null; ticketId?: string | null; otherwise?: "redirect" | "fork" },
  ) => Turn | null;
  /** Late-bound: lifecycle.ts is built after this module. */
  attachLive: (turn: Turn, carry?: string | null) => void;
};

export type Fire = {
  /**
   * Wakes a Bot at an appointment it made with itself. The note it left becomes a system line in
   * the same session, seen only by the turn it wakes and the flow board, and opens a turn in the
   * job the appointment was made in: in a group the Bot's live turn there is retuned like a mention
   * would, in a direct a new turn forks like a message from the user. Nothing fires while draining;
   * a Bot since archived or gone from the session just has its appointment consumed, since there is
   * nobody to wake. One a hold covers is set aside until the hold is lifted, and posts nothing.
   */
  fireCheckBack: (id: string, now?: Date) => Turn | null;
  /**
   * Fires a routine that is due. One a hold covers stays unclaimed, so once the hold is lifted it
   * fires once, for its latest due time; the wake it would have been is recorded once per due time.
   */
  fireRoutine: (routineId: string, now?: Date) => Turn | null;
};

export function createFire(deps: FireDeps): Fire {
  const { store, publish, occurred, publishMessage, admission, startTurn, hearOrStart, attachLive } = deps;

  function fireCheckBack(id: string, now: Date = new Date()): Turn | null {
    if (admission?.draining) return null;
    if (setAsideIfHeld(id)) return null;
    const result = store.transaction(() => {
      const claimed = store.claimCheckBack(id, now);
      if (!claimed) return null;
      let session;
      try {
        session = store.getSession(claimed.session_id);
      } catch {
        return null;
      }
      let archived: string | null;
      try {
        archived = store.getBot(claimed.bot_id).archived_at;
      } catch {
        return null;
      }
      if (archived || !store.isPresent(session.id, claimed.bot_id)) return null;
      let bookedBy: string | null = null;
      if (claimed.turn_id) {
        try {
          bookedBy = store.getTurn(claimed.turn_id).id;
        } catch {
          bookedBy = null;
        }
      }
      // Hung on the turn that booked it, so the trace draws the Bot waking itself, and the woken
      // turn inherits the job the way a handoff does even before `taskId` says so. One given back
      // after a turn heard it and ended unread wakes the Bot with the line it was heard with.
      const trigger =
        lineOf(claimed) ??
        store.insertMessage({
          sessionId: session.id,
          turnId: bookedBy,
          kind: "system",
          author: claimed.bot_id,
          body: checkBackNoteBody(store.settingsCached().locale, claimed.note),
        });
      // The Bot's reminder to itself: the turn reads it, the conversation never shows it.
      store.recordCheckBackLine(claimed.id, trigger.id);
      return { claimed, session, trigger };
    });
    if (!result) return null;
    const withYou = result.session.kind !== "group" && store.isPresent(result.session.id, USER_MEMBER);
    const lands = {
      taskId: result.claimed.task_id,
      // Back in the ticket's folder it was booked from, not the plan's: an explicit plan takes
      // only the ticket it is given.
      ticketId: result.claimed.task_id ? result.claimed.ticket_id : null,
    };
    // A Bot already working there hears its reminder in that turn. A direct with you forks a turn
    // per message of yours, so you can ask two things at once; a reminder about another job forks
    // there the same way, but one about the job a turn of this Bot is already doing is heard in it —
    // a second turn beside it would do that job twice and write the same files.
    const onIt =
      lands.taskId !== null &&
      store.listLiveTurns({ sessionId: result.session.id, botId: result.claimed.bot_id }).some((live) => live.task_id === lands.taskId);
    const fork = withYou && !onIt;
    const cause = causeOf(result.claimed);
    const turn = fork
      ? startTurn(result.session.id, result.claimed.bot_id, result.trigger, "fork", { cause, ...lands })
      : hearOrStart(
          result.session.id,
          result.claimed.bot_id,
          result.trigger,
          { item: { author: "", body: result.claimed.note, checkBack: true }, checkBack: lands },
          { cause, ...lands, otherwise: withYou ? "fork" : "redirect" },
        );
    // Turned away here only by a hold the appointment's own row does not name — on the plan its turn
    // would land in when the row names none, say. The appointment is spent, as if it had fired.
    if (!turn) return null;
    store.markCheckBackFired(id, turn.id);
    return turn;
  }

  /**
   * A pending appointment a hold covers is set aside for the lift, the way the hold set aside the
   * ones it found when it was made, instead of firing: nothing is posted and nobody wakes. True when
   * it was.
   */
  function setAsideIfHeld(id: string): boolean {
    let row: CheckBack;
    try {
      row = store.getCheckBack(id);
    } catch {
      return false;
    }
    if (row.fired_at || row.voided_at) return false;
    const wake = {
      cause: causeOf(row),
      botId: row.bot_id,
      sessionId: row.session_id,
      taskId: row.task_id,
      ticketId: row.ticket_id,
      turnId: row.turn_id,
    };
    if (mayWake(store, wake)) return false;
    store.suspendHeldCheckBacks(isoNow(), [id]);
    return true;
  }

  function lineOf(row: CheckBack): Message | null {
    if (!row.message_id) return null;
    try {
      return store.getMessage(row.message_id);
    } catch {
      return null;
    }
  }

  function causeOf(row: CheckBack): WakeCause {
    if (row.kind === PLAN_NUDGE) return "plan_nudge";
    return row.cause === "delegation" ? "report_back" : "check_back";
  }

  function fireRoutine(routineId: string, now: Date = new Date()): Turn | null {
    admission?.assertNew();
    let botId: string;
    try {
      botId = store.getRoutine(routineId).bot_id;
    } catch {
      return null;
    }
    const wake = {
      cause: "routine" as const,
      botId,
      sessionId: store.findDirectSession(USER_MEMBER, botId)?.id ?? null,
      taskId: store.routineTask(routineId)?.id ?? null,
    };
    if (heldWake(store, wake).length > 0) {
      // Only a due time is a wake, asked about on every tick until the lift; it stays unclaimed.
      const due = store.routineDue(routineId, now);
      if (due) mayWake(store, wake, { once: `routine:${routineId}:${due.dueAt}` });
      return null;
    }
    const result = store.transaction(() => {
      const claimed = store.claimRoutineDue(routineId, now);
      if (!claimed) return null;
      const existing = store.findDirectSession(USER_MEMBER, claimed.bot_id);
      const session = existing ?? store.createDirect(USER_MEMBER, claimed.bot_id);
      // A system line under the Bot, the way a check-back wakes it: you did not send this, and a
      // line in your name would also read to the organizer as something you just asked for.
      const trigger = store.insertMessage({
        sessionId: session.id,
        kind: "system",
        author: claimed.bot_id,
        body: routineFireBody(store.settingsCached().locale, claimed.title, claimed.instruction),
      });
      // Every routine has one standing plan, and every fire is a ticket of it, so a daily's days
      // sit side by side and the rules you set on its board stay. No model call decides this.
      const plan =
        store.routineTask(claimed.id) ??
        store.openTask({
          sessionId: session.id,
          title: claimed.title,
          brief: claimed.instruction,
          kind: claimed.title,
          spec: {
            kind: claimed.title,
            goal: claimed.title,
            acceptance: [],
            rules: [],
            process: [],
            progress: { done: [], open: [], blocked: [] },
            status: "active",
          },
          routineId: claimed.id,
          now,
        });
      const ticket = store.createTicket({
        taskId: plan.id,
        title: localDate(now),
        spec: claimed.instruction,
        status: "doing",
        worker: claimed.bot_id,
        now,
      });
      const turn = store.createTurn({
        sessionId: session.id,
        botId: claimed.bot_id,
        triggerMessageId: trigger.id,
        routineId: claimed.id,
        routineDueAt: claimed.last_fired_for_due_at,
        taskId: plan.id,
        ticketId: ticket.id,
      });
      return {
        claimed,
        session,
        isNewSession: !existing,
        trigger,
        turn,
      };
    });

    if (!result) return null;

    if (result.isNewSession) {
      publish({
        event: "session.upsert",
        occurred_at: occurred(),
        ...sessionUpsertFields(result.session),
      });
    }
    publishMessage(result.trigger);
    publish({
      event: "routine.upsert",
      occurred_at: occurred(),
      ...result.claimed,
    });
    attachLive(result.turn);
    return result.turn;
  }

  return { fireCheckBack, fireRoutine };
}
