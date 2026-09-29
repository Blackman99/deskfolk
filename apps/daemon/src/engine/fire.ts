/**
 * The two ways a turn opens without anyone typing: a Bot's own check-back coming due, and a
 * routine's schedule firing. Both land a system line under the Bot that is waking, so the
 * transcript reads as the Bot remembering something rather than the user asking for it, and both
 * open (or join) a turn the same way a mention would.
 */
import { USER_MEMBER, type ClientEvent, type Message, type Turn } from "@real-bot/protocol";
import { checkBackNoteBody, routineFireBody } from "../prompts";
import type { TurnAdmission } from "../quiesce";
import { sessionUpsertFields } from "../session-events";
import { localDate, type Store } from "../store";
import type { InboxEntry } from "./types";

export type FireDeps = {
  store: Store;
  publish: (event: ClientEvent) => void;
  occurred: () => string;
  publishMessage: (message: Message) => void;
  admission: TurnAdmission | undefined;
  /** Late-bound: lifecycle.ts is built after this module. */
  startTurn: (
    sessionId: string,
    botId: string,
    trigger: Message,
    mode: "redirect" | "fork",
    opts?: { routineId?: string | null; routineDueAt?: string | null; taskId?: string | null; ticketId?: string | null },
  ) => Turn;
  /** Late-bound: lifecycle.ts is built after this module. */
  hearOrStart: (
    sessionId: string,
    botId: string,
    trigger: Message,
    entry: Omit<InboxEntry, "message">,
    opts?: { taskId?: string | null; ticketId?: string | null; otherwise?: "redirect" | "fork" },
  ) => Turn;
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
   * nobody to wake.
   */
  fireCheckBack: (id: string, now?: Date) => Turn | null;
  fireRoutine: (routineId: string, now?: Date) => Turn | null;
};

export function createFire(deps: FireDeps): Fire {
  const { store, publish, occurred, publishMessage, admission, startTurn, hearOrStart, attachLive } = deps;

  function fireCheckBack(id: string, now: Date = new Date()): Turn | null {
    if (admission?.draining) return null;
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
      // turn inherits the job the way a handoff does even before `taskId` says so.
      const trigger = store.insertMessage({
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
    const turn = fork
      ? startTurn(result.session.id, result.claimed.bot_id, result.trigger, "fork", lands)
      : hearOrStart(
          result.session.id,
          result.claimed.bot_id,
          result.trigger,
          { item: { author: "", body: result.claimed.note, checkBack: true }, checkBack: lands },
          { ...lands, otherwise: withYou ? "fork" : "redirect" },
        );
    store.markCheckBackFired(id, turn.id);
    return turn;
  }

  function fireRoutine(routineId: string, now: Date = new Date()): Turn | null {
    admission?.assertNew();
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
      // sit side by side, its precedents accumulate, and the rules you set on its board stay. No
      // model call decides this.
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
