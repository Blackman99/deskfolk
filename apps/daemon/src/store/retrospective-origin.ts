/**
 * Which retrospective (ADR 0062) last wrote a memory or a skill, and on which plan: what the card in
 * the Bot's profile says beside it. Apart from `retrospectives.ts` so the memory and skill stores
 * can read it without importing what writes them.
 */
import type { StoreContext } from "./shared";

export type RetrospectiveOrigin = { id: string; task_id: string; plan_title: string | null };

export function retrospectiveOrigin(ctx: StoreContext, retrospectiveId: string | null | undefined): RetrospectiveOrigin | null {
  if (!retrospectiveId) return null;
  const row = ctx.db.query<{ task_id: string; title: string | null }, [string]>(
    "SELECT r.task_id, t.title FROM retrospectives r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.id = ?").get(retrospectiveId);
  return row ? { id: retrospectiveId, task_id: row.task_id, plan_title: row.title } : null;
}
