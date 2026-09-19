import { type Bot, type SessionSummary } from "@real-bot/protocol";
import { presentBotIds } from "../sidebar/session-groups.ts";

export type GroupNamePlan = { ok: true; name: string } | { ok: false; error: "empty" };

export function planGroupName(name: string): GroupNamePlan {
  const next = name.trim();
  if (next.length === 0) return { ok: false, error: "empty" };
  return { ok: true, name: next };
}

export function pullInCandidates(bots: readonly Bot[], session: SessionSummary): Bot[] {
  const present = new Set(presentBotIds(session));
  return bots.filter((bot) => !bot.archived_at && !present.has(bot.id));
}

export function canRemoveGroupBot(session: SessionSummary): boolean {
  return presentBotIds(session).length > 2;
}

export function mapGroupEditError(message: string): { name: "empty" } | { top: true } {
  if (message === "name is required") return { name: "empty" };
  return { top: true };
}
