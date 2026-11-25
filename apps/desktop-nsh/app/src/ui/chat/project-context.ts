/**
 * How a project session's context window usage reads: how full, at what level, and the words for
 * it. The composer's ring and the phone header's ring with its sheet read it the same way.
 */
import type { ProjectContextUsage } from "@real-bot/protocol";
import { formatTokens } from "../../m/spend-format.ts";
import { usageLevel, usageUsedText } from "../../m/usage/usage.ts";
import { copy } from "../../runtime";

export function contextReading(context: () => ProjectContextUsage | null | undefined) {
  const t = () => copy();
  const ctx = () => {
    const c = context();
    return c && c.used > 0 ? c : null;
  };
  const percent = () => {
    const c = ctx();
    return c && c.limit && c.limit > 0 ? (c.used / c.limit) * 100 : null;
  };
  const level = () => {
    const p = percent();
    return p !== null ? usageLevel(p) : "normal";
  };
  const label = () => {
    const c = ctx();
    if (!c) return "";
    const p = percent();
    if (p !== null && c.limit) return t().project.contextHint(formatTokens(c.used), formatTokens(c.limit), usageUsedText(p));
    return t().project.contextUsedOnlyHint(formatTokens(c.used));
  };
  const shortText = () => {
    const c = ctx();
    if (!c) return "";
    const p = percent();
    return p !== null ? usageUsedText(p) : formatTokens(c.used);
  };
  return { ctx, percent, level, label, shortText };
}
