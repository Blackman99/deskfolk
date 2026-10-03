import type { Bot, Hold, SessionSummary, Turn } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { isLiveStatus } from "./transcript.ts";

/**
 * What a choice in the stop menu stops: everything, one Bot, a conversation or a plan (`POST /v1/holds`).
 * `liftOnNext`: the stop goes with your next line about it, as a Stop's does — a group's menu stops
 * that way; the board's and the tools menu's stay until you lift them.
 */
export type StopChoice = { scope: "global" | "bot" | "session" | "plan"; id: string | null; liftOnNext?: boolean };

export type StopMenuItem = { key: string; label: string; choice: StopChoice };

/** Whether a stop in force already covers what a choice would: then the menu leaves it out. */
function held(holds: readonly Hold[], choice: StopChoice): boolean {
  return holds.some((hold) => hold.scope === "global" || (hold.scope === choice.scope && hold.scope_id === choice.id));
}

function newestFirst(a: Turn, b: Turn): number {
  return a.last_activity_at < b.last_activity_at ? 1 : a.last_activity_at > b.last_activity_at ? -1 : 0;
}

/**
 * The stop menu of a group (ADR 0040 P2): the group itself first, then each Bot at work there,
 * this job and every Bot — each only while nothing already stops it. Empty when nobody is at work
 * there. The group, a Bot and the job are stopped like a Stop: your next line there (to that Bot,
 * about that job) lifts it and is what they go on from, so a new instruction after stopping is not
 * met by a stop still on (2026-10-03). Every Bot stays stopped until you lift it, as the board's
 * and the tools menu's stops do. A direct has no menu: it has one Stop, the button, which stops
 * what its Bot is doing now. A Bot↔Bot direct is yours to read, not to stop from here.
 */
export function conversationStopItems(input: {
  session: SessionSummary;
  turns: readonly Turn[];
  bots: ReadonlyMap<string, Bot>;
  holds: readonly Hold[];
  t: Copy["control"];
  deleted: string;
}): StopMenuItem[] {
  const { session, bots, holds, t } = input;
  const live = input.turns.filter((turn) => isLiveStatus(turn.status)).sort(newestFirst);
  const items: StopMenuItem[] = [];
  const add = (key: string, label: string, choice: StopChoice) => {
    if (!held(holds, choice)) items.push({ key, label, choice });
  };
  if (session.kind !== "group") return [];
  const working = live.filter((turn) => turn.session_id === session.id);
  if (working.length === 0) return [];
  add(`session:${session.id}`, t.thisGroup, { scope: "session", id: session.id, liftOnNext: true });
  for (const botId of new Set(working.map((turn) => turn.bot_id))) {
    add(`bot:${botId}`, t.thisBot(bots.get(botId)?.name ?? input.deleted), { scope: "bot", id: botId, liftOnNext: true });
  }
  const plan = working.find((turn) => turn.task_id)?.task_id;
  if (plan) add(`plan:${plan}`, t.thisJob, { scope: "plan", id: plan, liftOnNext: true });
  add("global", t.allBots, { scope: "global", id: null });
  return items;
}

/** The flow board's stop menu: the job on it, and every Bot. */
export function planStopItems(input: { taskId: string; title: string | null; holds: readonly Hold[]; t: Copy["control"] }): StopMenuItem[] {
  const { taskId, title, holds, t } = input;
  const items: StopMenuItem[] = [];
  const job: StopChoice = { scope: "plan", id: taskId };
  if (!held(holds, job)) items.push({ key: `plan:${taskId}`, label: title ? t.thisJobNamed(title) : t.thisJob, choice: job });
  const all: StopChoice = { scope: "global", id: null };
  if (!held(holds, all)) items.push({ key: "global", label: t.allBots, choice: all });
  return items;
}
