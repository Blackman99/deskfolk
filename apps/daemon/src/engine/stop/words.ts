/** How the app's lines about your stops name things: the locale, Bots, plans, tickets, places and the scope of a hold. */
import { type Locale, type Hold, type HeldTurn, type ControlScope, type Session, USER_MEMBER, type Turn } from "@real-bot/protocol";
import { type ControlTurnLine, type SaidLine, saidOf } from "../../prompts";
import type { StopDeps } from "../stop";
import type { StopReach } from "./reach";

export function createStopWords(deps: StopDeps, reach: StopReach) {
  const { store } = deps;
  const { turnRow } = reach;

  function locale(): Locale {
    return store.settingsCached().locale;
  }

  /** What the line that lifts `hold` has to be about, as its receipt says it; false for none. */
  function nextLineAbout(hold: Hold | undefined): false | "job" | "group" | "bot" | "everyone" {
    if (!hold) return false;
    if (hold.scope === "global") return "everyone";
    if (hold.scope === "session") return "group";
    if (hold.scope === "bot") return "bot";
    return "job";
  }

  function turnLine(record: HeldTurn, here: string, heading: Set<string>): ControlTurnLine {
    return {
      bot: heading.has(record.bot_id) ? null : botName(record.bot_id),
      plan: record.task_id ? planTitle(record.task_id) : null,
      where: record.session_id === here ? null : placeOf(record.session_id),
      lastStep: record.recent.at(-1) ?? null,
    };
  }

  function headingBots(scopes: ControlScope[]): Set<string> {
    return new Set(scopes.flatMap((scope) => (scope.scope === "bot" ? [scope.id] : [])));
  }

  /** A hold's scope in words, for you. */
  function scopeLabel(hold: Hold, here: string): string {
    const en = locale() === "en";
    const id = hold.scope_id ?? "";
    switch (hold.scope) {
      case "global":
        return en ? "every Bot's work" : "所有 Bot 的工作";
      case "bot":
        return en ? `all of ${botName(id)}'s work` : `${botName(id)}的全部工作`;
      case "session":
        return id === here ? (en ? "the work here" : "这里的工作") : en ? `the work in ${placeOf(id)}` : `${placeOf(id)}里的工作`;
      case "plan":
        return en ? `the job "${planTitle(id) ?? id}"` : `「${planTitle(id) ?? id}」这件事`;
      case "ticket":
        return ticketLabel(id);
      case "bot_plan": {
        const [botId, taskId] = id.split(":");
        return en ? `${botName(botId!)}'s work on "${planTitle(taskId!) ?? taskId}"` : `${botName(botId!)}在「${planTitle(taskId!) ?? taskId}」上的工作`;
      }
      case "turn": {
        const turn = turnRow(id);
        return en ? `${turn ? botName(turn.bot_id) : "a Bot"}'s turn` : `${turn ? botName(turn.bot_id) : "一个 Bot"}的这一段`;
      }
    }
  }

  /** What you asked about, in words. */
  function aboutLabel(scope: ControlScope, here: string): string {
    const en = locale() === "en";
    switch (scope.scope) {
      case "global":
        return en ? "every Bot" : "所有 Bot";
      case "bot":
        return botName(scope.id);
      case "session":
        return scope.id === here ? (en ? "this conversation" : "这里") : (placeOf(scope.id) ?? scope.id);
      case "plan":
        return en ? `"${planTitle(scope.id) ?? scope.id}"` : `「${planTitle(scope.id) ?? scope.id}」`;
    }
  }

  /** A conversation, as you would name it. */
  function placeOf(sessionId: string): string {
    const en = locale() === "en";
    let session: Session;
    try {
      session = store.getSession(sessionId);
    } catch {
      return en ? "a conversation since deleted" : "一个已删除的会话";
    }
    if (session.kind === "group") return session.name ? (en ? `group "${session.name}"` : `群「${session.name}」`) : en ? "a group" : "一个群";
    const bots = store.presentBotIds(sessionId).map(botName);
    if (store.isPresent(sessionId, USER_MEMBER)) return en ? `your direct with ${bots[0] ?? "?"}` : `你和${bots[0] ?? "?"}的私聊`;
    return en ? `the direct between ${bots.join(" and ")}` : `${bots.join("和")}的私聊`;
  }

  /** The line that made a hold, as a receipt quotes it; null for a button or a line since cleared. */
  function holdSaid(hold: Hold): SaidLine {
    if (!hold.source_message_id) return null;
    try {
      return saidOf(store.getMessage(hold.source_message_id));
    } catch {
      return null;
    }
  }

  function planTag(taskId: string | null, ticketId: string | null): string | null {
    if (!taskId) return null;
    const en = locale() === "en";
    const title = planTitle(taskId) ?? taskId;
    const plan = en ? `the plan "${title}"` : `规划「${title}」`;
    return ticketId ? (en ? `${plan}, ${ticketLabel(ticketId)}` : `${plan}的${ticketLabel(ticketId)}`) : plan;
  }

  function ticketLabel(ticketId: string): string {
    const en = locale() === "en";
    try {
      const ticket = store.getTicket(ticketId);
      const seq = String(ticket.seq).padStart(2, "0");
      return en ? `ticket ${seq} "${ticket.title}"` : `任务 ${seq}《${ticket.title}》`;
    } catch {
      return en ? "a ticket" : "一个任务";
    }
  }

  function botName(id: string): string {
    try {
      return store.getBot(id).name;
    } catch {
      return id;
    }
  }

  function planTitle(id: string): string | null {
    try {
      return store.getTask(id).title;
    } catch {
      return null;
    }
  }

  function safeTurn(id: string): Turn | null {
    try {
      return store.getTurn(id);
    } catch {
      return null;
    }
  }

  /**
   * Who the app's line stands under: in a direct, its Bot, as a status answer does; elsewhere the
   * Bot the line names, else nobody in particular.
   */
  function authorIn(sessionId: string, scopes: ControlScope[]): string {
    try {
      if (store.getSession(sessionId).kind === "direct") {
        const bot = store.presentBotIds(sessionId)[0];
        if (bot) return bot;
      }
    } catch {
      // the conversation is gone; the line below has nowhere to go either
    }
    const named = scopes.find((scope) => scope.scope === "bot");
    return named?.scope === "bot" ? named.id : USER_MEMBER;
  }

  return { locale, nextLineAbout, turnLine, headingBots, scopeLabel, aboutLabel, holdSaid, planTag, ticketLabel, botName, planTitle, safeTurn, authorIn };
}

export type StopWords = ReturnType<typeof createStopWords>;
