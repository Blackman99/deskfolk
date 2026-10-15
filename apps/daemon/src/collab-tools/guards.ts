/** Checks a tool call makes before it changes anything. */
import type { ToolCtx } from "../collab-tools";
import { HttpError } from "../errors";
import { ulid } from "../ids";
import { READ_ONLY_REFUSAL, verdictFor } from "../permission-gate";
import { requestDigest } from "../request-digest";
import type { KeyOperation } from "../store/receipts";

export function assertActive(ctx: ToolCtx): void {
  if (ctx.signal?.aborted) throw new HttpError(409, "interrupted", "turn was interrupted");
}

/**
 * What the Bot's permission mode says about a change to the app's setup (ADR 0092): `ask` puts up
 * its card, `allow` goes ahead without one; a read-only Bot is refused here. A call you already
 * allowed on its card goes ahead.
 */
export function setupVerdict(ctx: ToolCtx): "allow" | "ask" {
  if (ctx.approved) return "allow";
  const verdict = verdictFor(ctx.store.permissionModeFor(ctx.botId), "setup");
  if (verdict === "refuse") throw new HttpError(403, "refused", READ_ONLY_REFUSAL);
  return verdict;
}

/**
 * Hydration precedes the guarded transaction; started key writes retain their durable repair record.
 * A read-only Bot changes nothing here, removals and notes included (ADR 0092).
 */
export async function mutateConfiguration<T>(ctx: ToolCtx, work: () => T): Promise<T> {
  setupVerdict(ctx);
  const requestId = ulid();
  const path = `/turn-tools/${ctx.turnId}`;
  const keyOps: KeyOperation[] = [];
  const response = await ctx.store.receipts.execute(
    { deviceId: "turn-tools", requestId, guard: () => assertActive(ctx) },
    requestDigest({ method: "POST", path, body: { request_id: requestId } }),
    "POST", path, {}, async () => {
      await ctx.store.listProviders();
      assertActive(ctx);
      await ctx.store.listMcpServersHydrated();
      assertActive(ctx);
      return () => {
        assertActive(ctx);
        const plan: Array<{ name: string; value: string }> = [];
        const result = ctx.store.planKeys(plan, work);
        for (const op of plan) keyOps.push({ ...op, field: op.value ? "value" : "" });
        return { status: 200, body: JSON.stringify(result ?? null) };
      };
    }, keyOps,
  );
  assertActive(ctx);
  if (response.status >= 400) {
    const body = JSON.parse(response.body ?? "{}");
    throw new HttpError(response.status, body.error?.code ?? "failed", body.error?.message ?? "configuration failed");
  }
  return JSON.parse(response.body ?? "null") as T;
}
