import type { Bot, Memory, SessionSummary } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import { classifySession } from "../sidebar/session-groups.ts";
import { sessionTitle } from "../sidebar/session-title.ts";

export type MemoryDraft = { subject: string; body: string };
export type MemoryFieldErrors = { subject?: string; body?: string };
export type MemoryPlan =
  | { ok: true; body: { subject: string; body: string } }
  | { ok: false; errors: MemoryFieldErrors };

export function draftFromMemory(memory: Memory): MemoryDraft {
  return { subject: memory.subject, body: memory.body };
}

export function memoryDraftDirty(draft: MemoryDraft, baseline: MemoryDraft): boolean {
  return draft.subject !== baseline.subject || draft.body !== baseline.body;
}

/**
 * A Bot can rewrite a memory while its pane is open, so a live update must not clobber what the
 * user is typing. Same rule as the skill editor: a dirty draft stands, a clean one follows.
 */
export function reconcileMemoryDraft(
  draft: MemoryDraft,
  baseline: MemoryDraft,
  incoming: Memory,
): { draft: MemoryDraft; baseline: MemoryDraft } {
  const next = draftFromMemory(incoming);
  if (memoryDraftDirty(draft, baseline)) return { draft, baseline: next };
  return { draft: next, baseline: next };
}

export function planMemory(draft: MemoryDraft, t: Copy): MemoryPlan {
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  const errors: MemoryFieldErrors = {};
  if (!subject) errors.subject = t.sidebar.memorySubjectEmpty;
  if (!body) errors.body = t.sidebar.memoryBodyEmpty;
  if (errors.subject || errors.body) return { ok: false, errors };
  return { ok: true, body: { subject, body } };
}

export function mapMemoryError(status: number, t: Copy): MemoryFieldErrors {
  if (status === 409) return { subject: t.sidebar.memorySubjectConflict };
  return {};
}

/**
 * How old a memory reads. The buckets match the ones the daemon renders into the prompt, so the
 * pane and the Bot agree on whether a conclusion is fresh or stale.
 */
export function memoryAgeLabel(createdAt: string, t: Copy, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(createdAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return t.sidebar.memoryAgeToday;
  if (days < 7) return t.sidebar.memoryAgeThisWeek;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return t.sidebar.memoryAgeWeeks(weeks);
  return t.sidebar.memoryAgeMonths(Math.floor(days / 30));
}

export type MemoryOrigin =
  | { kind: "missing" }
  | { kind: "session"; session: SessionSummary; messageId: string | null; label: string };

/**
 * Where a memory was formed. The session's kind matters as much as its name: a memory picked up
 * in a Bot↔Bot direct is the one worth noticing, because you were not in that conversation.
 */
export function resolveMemoryOrigin(
  memory: Memory,
  sessionsById: ReadonlyMap<string, SessionSummary>,
  bots: ReadonlyMap<string, Bot>,
  t: Copy,
): MemoryOrigin {
  if (!memory.source_session_id) return { kind: "missing" };
  const session = sessionsById.get(memory.source_session_id);
  if (!session) return { kind: "missing" };
  const title = sessionTitle(session, bots, { deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop });
  const label = classifySession(session) === "bot-bot" ? `${t.sidebar.botBot} · ${title}` : title;
  return { kind: "session", session, messageId: memory.source_message_id, label };
}
