/** A line heard by a Bot whose turn is already running: in this conversation, as an answer to its question, or from another one. */
import { type Turn, type Message, USER_MEMBER } from "@real-bot/protocol";
import { sessionLabel } from "../../context";
import { planTagger } from "../../context/transcript";
import { ENGINE_LEVELS } from "../../store/schema-gate";
import { recordHeard } from "../inbox-record";
import { mayWake } from "../control";
import type { Live, InboxEntry } from "../types";
import type { LifecycleDeps } from "../lifecycle";

export function createHearing(deps: LifecycleDeps) {
  const { store, lives, answerAsk } = deps;

  /**
   * Puts a line into a live turn's inbox: tagged with the plan it is about, and with where it was
   * said when that is another conversation.
   */
  function hearIn(
    turn: Turn,
    live: Live | undefined,
    trigger: Message,
    entry: Omit<InboxEntry, "message">,
    about: { taskId: string | null; ticketId: string | null },
  ): void {
    if (live && answersAsk(turn, live, trigger)) return;
    const locale = store.settingsCached().locale;
    const tag = planTagger(store, { taskId: turn.task_id ?? null, ticketId: turn.ticket_id ?? null }, locale)(about);
    const where = trigger.session_id === turn.session_id ? entry.item.where : sessionLabel(store, trigger.session_id, turn.bot_id, locale) ?? undefined;
    let author = entry.item.author || trigger.author;
    if (!entry.item.author) {
      try {
        author = trigger.author === USER_MEMBER ? "user" : store.getBot(trigger.author).name;
      } catch {
        author = trigger.author;
      }
    }
    const heard = recordHeard(store, turn, {
      ...entry,
      item: { ...entry.item, author, tag: tag || undefined, where },
      message: trigger,
      ...(trigger.session_id === turn.session_id ? {} : { elsewhere: true }),
    });
    if (live && !live.abort.signal.aborted) live.inbox.push(heard);
  }

  /**
   * Your line reaching a segment that waits on your answer to its question, said where it asked:
   * from the work items' level that line is the answer (ADR 0040 §3.3) — text of your own rather
   * than one of its choices — and the segment goes on with it, instead of the line waiting in an
   * inbox the waiting segment never reads. A line with files, a Bot's line, or one said elsewhere
   * still goes to the inbox. True when it answered.
   */
  function answersAsk(turn: Turn, live: Live, trigger: Message): boolean {
    if (store.capabilities().engine_level < ENGINE_LEVELS.work_items || !live.ask || live.abort.signal.aborted) return false;
    if (trigger.kind !== "user" || trigger.author !== USER_MEMBER || trigger.attachments.length > 0 || !trigger.body.trim()) return false;
    try {
      const current = store.getTurn(turn.id);
      if (current.status !== "waiting_ask" || current.session_id !== trigger.session_id) return false;
      answerAsk(live.ask.id, trigger.session_id, trigger.body);
      // Your answer now, written on the question: a question is answered once, so the line stays as it was (ADR 0063).
      store.markLineTaken(trigger.id, "answer");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Your line, once filed under a plan, reaches every turn working in that plan in another session:
   * you tell a Bot in your direct what to change about the job it is doing in a group, and the
   * group's turns on that job — its own and its teammates' — read it on their next hop without being
   * interrupted. Turns in the line's own session already have it in their transcript, and a turn a
   * hold covers does not get it. Returns the turns that got it.
   */
  function hearAcross(message: Message, opts?: { turnIds?: readonly string[] }): Turn[] {
    if (!message.task_id) return [];
    const locale = store.settingsCached().locale;
    let author = "user";
    if (message.author !== USER_MEMBER) {
      try {
        author = store.getBot(message.author).name;
      } catch {
        author = message.author;
      }
    }
    // The hearing turn cannot see that session's transcript, so the files come along by path.
    const body = [message.body, ...message.attachments.map((att) => `附件：${att.workspace_relpath}`)].join("\n");
    const got: Turn[] = [];
    for (const current of store.listLiveTurns()) {
      if (current.task_id !== message.task_id || current.session_id === message.session_id) continue;
      if (opts?.turnIds && !opts.turnIds.includes(current.id)) continue;
      const live = lives.get(current.id);
      if (!live || live.abort.signal.aborted) continue;
      const wake = {
        cause: "heard_across" as const,
        botId: current.bot_id,
        sessionId: current.session_id,
        taskId: current.task_id ?? null,
        ticketId: current.ticket_id ?? null,
        turnId: current.id,
      };
      if (!mayWake(store, wake)) continue;
      const tag = planTagger(store, { taskId: current.task_id ?? null, ticketId: current.ticket_id ?? null }, locale)({
        taskId: message.task_id,
        ticketId: message.ticket_id ?? null,
      });
      const where = sessionLabel(store, message.session_id, current.bot_id, locale) ?? undefined;
      live.inbox.push(recordHeard(store, current, {
        item: { author, body, checkBack: false, tag: tag || undefined, where },
        message,
        elsewhere: true,
      }));
      got.push(current);
    }
    return got;
  }

  return { hearIn, answersAsk, hearAcross };
}

export type Hearing = ReturnType<typeof createHearing>;
