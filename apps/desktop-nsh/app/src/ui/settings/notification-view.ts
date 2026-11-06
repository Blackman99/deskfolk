/** Pure helpers of `NotificationSettings` (`settings/NotificationSettings.svelte`): what each card says. */
import type { Copy } from "../../m/copy.ts";
import type { NotificationPolicyCategories } from "../../m/notifications/types.ts";
import { closeCopyKey } from "../../m/notifications/tab-owner.ts";
import type { IconName } from "../Icon";

export type CategoryKey = keyof NotificationPolicyCategories;

export const CATEGORY_KEYS: readonly CategoryKey[] = ["approval", "ask", "failure", "interrupted", "reply", "routine_result"];

/** The icon, and the box colours, of a category (`.category-icon-*`). */
export const CATEGORY_LOOK: Record<CategoryKey, { icon: IconName; box: string; tint: string }> = {
  approval: { icon: "shield-check", box: "bg-accent-tint", tint: "tint-brand" },
  ask: { icon: "help-circle", box: "bg-purple-bg", tint: "tint-purple" },
  failure: { icon: "alert-circle", box: "bg-danger-bg", tint: "tint-danger" },
  interrupted: { icon: "pause-circle", box: "bg-warn-bg", tint: "tint-warn" },
  reply: { icon: "message", box: "bg-accent-tint", tint: "tint-brand" },
  routine_result: { icon: "calendar-check", box: "bg-ok-bg", tint: "tint-ok" },
};

export type CategoryRow = { key: CategoryKey; label: string; desc: string; checked: boolean };

/** The six categories with their words (the descriptions are the Svelte's own literals) and state. */
export function categoryList(categories: NotificationPolicyCategories | undefined, t: Copy, locale: "en" | "zh"): CategoryRow[] {
  const en = locale === "en";
  const n = t.notifications;
  return [
    { key: "approval", label: n.catApproval, desc: en ? "Bot requests tool or action permission approval" : "Bot 请求工具或操作权限审批时" },
    { key: "ask", label: n.catAsk, desc: en ? "Bot asks a question waiting for your answer" : "Bot 遇到疑问等待你的答复时" },
    { key: "failure", label: n.catFailure, desc: en ? "A background task or tool call fails" : "后台任务或工具调用执行失败时" },
    { key: "interrupted", label: n.catInterrupted, desc: en ? "An active conversation turn is interrupted" : "会话轮次被人工或系统中断时" },
    { key: "reply", label: n.catReply, desc: en ? "A message is directly addressed to you" : "收到专门面向你的新消息或回复时" },
    { key: "routine_result", label: n.catRoutineResult, desc: en ? "A scheduled routine completes and outputs" : "定时例程完成执行并产出结果时" },
  ].map((row) => ({ ...row, key: row.key as CategoryKey, checked: categories?.[row.key as CategoryKey] ?? true }));
}

/** What a refused test notification says, by the API's error code. */
export function testErrorText(code: string | null, t: Copy): string {
  if (code === null) return t.notifications.testFailed;
  const n = t.notifications;
  const messages: Record<string, string> = {
    push_pending: n.testPushPending,
    rate_limited: n.testRateLimited,
    push_contact_required: n.testContactRequired,
    push_disabled: n.needsRepair,
    no_subscription: n.needsRepair,
    gateway_unavailable: n.remoteGated,
    delivery_gated: n.testDeliveryGated,
    capability_unavailable: n.upgradeRequired,
    request_unknown: t.disconnected.host,
    disconnected: t.disconnected.host,
  };
  return messages[code] ?? `${n.testFailed} (${code})`;
}

/** What closing push on this device says when it did not close cleanly everywhere. */
export function closeFeedback(outcome: Parameters<typeof closeCopyKey>[0], t: Copy): string | null {
  const key = closeCopyKey(outcome);
  if (key === "local_only") return t.notifications.localOnlyClose;
  if (key === "host_only") return t.notifications.hostOnlyClose;
  if (key === "unconfirmed") return t.notifications.unconfirmedClose;
  return null;
}
