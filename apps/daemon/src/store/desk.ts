/** Bind an admitted desk segment to one of its captured jobs, not a newly recomputed list. */
import type { Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { getMessage, insertMessage } from "./messages";
import { recordWorkEvent } from "./work-events";
import type { StoreContext } from "./shared";

export function deskCandidateIds(ctx: StoreContext, turnId: string): string[] {
  const row = ctx.db.query<{ filing_candidates: string | null }, [string]>("SELECT filing_candidates FROM turns WHERE id = ?").get(turnId);
  if (!row) throw new HttpError(404, "not_found", "turn not found");
  if (!row.filing_candidates) return [];
  const ids: unknown = JSON.parse(row.filing_candidates);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export function assertDeskCandidate(ctx: StoreContext, turnId: string, taskId: string): void {
  if (!deskCandidateIds(ctx, turnId).includes(taskId)) {
    throw new HttpError(422, "invalid_candidate", "choose a job in this turn's candidate list, or quote the user's line to open a new one");
  }
}

/** Continue inherits user authority only through the note explicitly claimed by that segment. */
export function originalUserRequest(ctx: StoreContext, turnId: string): Message | null {
  const visited = new Set<string>();
  let current = turnId;
  for (let depth = 0; depth < 10; depth += 1) {
    if (visited.has(current)) return null;
    visited.add(current);
    const row = ctx.db.query<{ trigger_message_id: string }, [string]>("SELECT trigger_message_id FROM turns WHERE id = ?").get(current);
    if (!row) return null;
    const message = getMessage(ctx, row.trigger_message_id);
    if (message.kind === "user" && message.author === "user") return message;
    if (message.source_turn_id !== current || !message.turn_id) return null;
    current = message.turn_id;
  }
  return null;
}

export function filingBudget(ctx: StoreContext, turnId: string): number {
  const row = ctx.db.query<{ filing_bounces: number }, [string]>("SELECT filing_bounces FROM turns WHERE id = ?").get(turnId);
  if (!row) throw new HttpError(404, "not_found", "turn not found");
  return row.filing_bounces;
}

/** The outcome, its work log and the visible explanation commit together. */
export function markNeedsAttention(ctx: StoreContext, turnId: string, locale: "en" | "zh"): Message {
  return ctx.tx.run(() => {
    const turn = ctx.db.query<{ bot_id: string; session_id: string; work_item_id: string | null }, [string]>(
      "SELECT bot_id, session_id, work_item_id FROM turns WHERE id = ?").get(turnId);
    if (!turn) throw new HttpError(404, "not_found", "turn not found");
    ctx.db.run("UPDATE turns SET end_reason = 'needs_attention', updated_at = ? WHERE id = ?", [isoNow(), turnId]);
    if (turn.work_item_id) ctx.db.run("UPDATE work_items SET state = 'needs_attention', updated_at = ? WHERE id = ?", [isoNow(), turn.work_item_id]);
    recordWorkEvent(ctx, { kind: "work.needs_attention", actor: "app", botId: turn.bot_id, turnId,
      payload: { reason: "filing_budget", candidates: deskCandidateIds(ctx, turnId) } });
    return insertMessage(ctx, { sessionId: turn.session_id, turnId, kind: "system", author: turn.bot_id,
      body: locale === "en" ? "This line needs a job selected before work can proceed." : "这句话需要先选归属，尚未执行有副作用的工具。",
      hiddenFromBots: true });
  });
}

/** Persist the directory-use boundary before a call can produce an external effect. */
export function markWorkDirectoryUsed(ctx: StoreContext, turnId: string): void {
  ctx.db.run("UPDATE turns SET work_dir_changes = MAX(work_dir_changes, 1) WHERE id = ? AND task_id IS NOT NULL", [turnId]);
}

/**
 * A rejected filing never changes a job, and the desk stops asking after two corrections. Only a desk
 * segment counts: once bound, a refused call is an ordinary failed call the Bot reads and retries (the
 * trouble count and hop limits bound it), not a filing — cutting off a working segment would say it
 * still needs a job chosen and has run nothing, after it ran everything.
 */
export function noteFilingBounce(ctx: StoreContext, turnId: string): number {
  ctx.db.run("UPDATE turns SET filing_bounces = filing_bounces + 1, updated_at = ? WHERE id = ? AND mode = 'desk'", [isoNow(), turnId]);
  return ctx.db.query<{ filing_bounces: number }, [string]>("SELECT filing_bounces FROM turns WHERE id = ?").get(turnId)?.filing_bounces ?? 0;
}
