/** The daily spend cap on reading images during review. */
import { holdsCovering } from "./holds";
import { localeOf } from "./settings";
import type { StoreContext } from "./shared";
import { supervised } from "./submission-rows";

/** What a day of judging pictures may cost before the app stops asking (§6.5 3), in US dollars. */
export const VISION_DAILY_CAP_USD = 5;
const TICKS_IN_USD = 10_000_000_000;

/**
 * Why a judgement of pictures for this plan is not made now, from level 5 (§6.5 3): a stop of yours
 * covers the plan, or today's judging of pictures has already cost {@link VISION_DAILY_CAP_USD}.
 * Null when it may go ahead (and below level 5, where it always does).
 */
export function visionRefusal(ctx: StoreContext, taskId: string, now: Date = new Date()): string | null {
  if (!supervised(ctx)) return null;
  const en = localeOf(ctx) === "en";
  const plan = ctx.db.query<{ session_id: string | null }, [string]>("SELECT session_id FROM tasks WHERE id = ?").get(taskId);
  if (holdsCovering(ctx, { sessionId: plan?.session_id ?? null, taskId }).length > 0) {
    return en ? "not judged while a stop of yours covers this plan" : "这件事被叫停着，没有看图判定";
  }
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const ticks = ctx.db.query<{ ticks: number | null }, [string]>(`SELECT SUM(COALESCE(cost_usd_ticks, estimated_cost_usd_ticks, 0)) AS ticks
    FROM spend WHERE purpose = 'vision' AND created_at >= ?`).get(dayStart)?.ticks ?? 0;
  if (ticks >= VISION_DAILY_CAP_USD * TICKS_IN_USD) {
    return en ? `today's judging of pictures has reached its $${VISION_DAILY_CAP_USD} cap; not judged this time`
      : `今天看图判定的花费已到 $${VISION_DAILY_CAP_USD} 的上限，这次没判`;
  }
  return null;
}
