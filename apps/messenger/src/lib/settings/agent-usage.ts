import type { AgentUsage, AgentUsageWindow } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

/** How often the sidebar asks while the window is in front; the daemon keeps answers as long. */
export const AGENT_USAGE_POLL_MS = 5 * 60_000;

/** A window's name from its length: 300 minutes is 5 hours, 10080 is 7 days, 43200 is 30 days. */
export function agentWindowLabel(minutes: number | null, t: Copy): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return t.agents.usage.window;
  if (minutes % 1440 === 0) return t.agents.usage.days(minutes / 1440);
  if (minutes % 60 === 0) return t.agents.usage.hours(minutes / 60);
  return t.agents.usage.minutes(Math.round(minutes));
}

/** Tokens as a strip says them: 950, 12.3k, 1.2M. */
export function agentTokenText(tokens: number): string {
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  // 999,950 and up would round to 1000k.
  if (tokens < 999_950) return `${trim(tokens / 1000)}k`;
  return `${trim(tokens / 1_000_000)}M`;
}

/** Whether the strip shows plan windows for this item (Codex's) rather than the day's own records. */
export function agentHasWindows(item: Pick<AgentUsage, "available" | "windows">): boolean {
  return item.available && item.windows.length > 0;
}

/** Windows shortest first, so five hours stands before the week. */
export function agentWindowsSorted(windows: AgentUsageWindow[]): AgentUsageWindow[] {
  return [...windows].sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
}

/**
 * Each item's name on the strip: its label, with the account after it when the same agent runs on
 * more than one (the config directory's last part, or the default).
 */
export function agentUsageNames(items: ReadonlyArray<Pick<AgentUsage, "runner" | "custom_id" | "label" | "config_dir">>, t: Copy): string[] {
  return items.map((item) => {
    const same = items.filter((other) => other.runner === item.runner && other.custom_id === item.custom_id).length > 1;
    if (!same) return item.label;
    const dir = item.config_dir?.split(/[\\/]/).filter(Boolean).pop();
    return `${item.label} · ${dir ?? t.agents.usage.own}`;
  });
}
