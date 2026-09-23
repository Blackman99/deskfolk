import { type Bot, type SessionSummary } from "@real-bot/protocol";
import { presentBotIds } from "../sidebar/session-groups.ts";

/** Kept by the shell: the reset runs on every session change, drawer open or not. */
export type GroupDetailDraft = {
  sessionId: string | null;
  name: string;
  nameError: "empty" | undefined;
  failed: boolean;
  pullPick: string;
};

export type GroupNamePlan = { ok: true; name: string } | { ok: false; error: "empty" };

export function planGroupName(name: string): GroupNamePlan {
  const next = name.trim();
  if (next.length === 0) return { ok: false, error: "empty" };
  return { ok: true, name: next };
}

/** What leaving the title field does: an unchanged or still-blank name sends nothing. */
export function groupNameCommit(
  draft: string,
  saved: string,
): { action: "save"; name: string } | { action: "noop" } | { action: "invalid" } {
  const plan = planGroupName(draft);
  if (!plan.ok) return { action: "invalid" };
  if (plan.name === saved.trim()) return { action: "noop" };
  return { action: "save", name: plan.name };
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
