import type { ClaudeUsage, ClaudeUsageWindow } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

/** How often the sidebar asks while the window is in front; the daemon keeps answers as long. */
export const CLAUDE_USAGE_POLL_MS = 5 * 60_000;

/** Whether a Bot runs on Claude Agent: the meter asks nothing until one does. */
export function claudeAgentInUse(bots: ReadonlyArray<{ runner?: string | null }>): boolean {
  return bots.some((bot) => bot.runner === "claude_code");
}

/** A window's name in full, for the card and the opened meter. */
export function usageWindowLabel(window: ClaudeUsageWindow, t: Copy): string {
  if (window.kind === "five_hour") return t.claudeAgent.usage.fiveHour;
  if (window.kind === "seven_day") return t.claudeAgent.usage.sevenDay;
  return t.claudeAgent.usage.model(window.model ?? "?");
}

/** The two windows the closed meter shows, the plan's own. */
export function headlineWindows(usage: ClaudeUsage): ClaudeUsageWindow[] {
  return usage.windows.filter((window) => window.kind !== "model");
}

/** Whole percent, never 0 for a window that has started filling. */
export function usagePercentText(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

/** How full a window is, for its colour: worth a look from three quarters, nearly gone from nine tenths. */
export function usageLevel(percent: number): "normal" | "warn" | "danger" {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warn";
  return "normal";
}

/** When a window starts over: in so long within a day, otherwise the day and time. */
export function usageResetText(resetsAt: string | null, now: number, t: Copy, locale: string): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  const left = at - now;
  if (left <= 60_000) return t.claudeAgent.usage.resetsSoon;
  if (left < 24 * 3_600_000) {
    const minutes = Math.ceil(left / 60_000);
    return t.claudeAgent.usage.resetsIn(t.claudeAgent.usage.hoursMinutes(Math.floor(minutes / 60), minutes % 60));
  }
  // claude.ai says 01:59:59.98 one time and 02:00:00 the next for the same window: to the nearest minute.
  const when = new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(Math.round(at / 60_000) * 60_000);
  return t.claudeAgent.usage.resetsAt(when);
}

/** The clock time an answer is from. */
export function usageCheckedTime(checkedAt: string | null, locale: string): string | null {
  if (!checkedAt) return null;
  const at = Date.parse(checkedAt);
  if (Number.isNaN(at)) return null;
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}
