import type { ClaudeAccountUsage, ClaudeUsage, ClaudeUsageWindow } from "@real-bot/protocol";
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

/**
 * Each account some Bot on Claude Agent runs on, with its own usage; a daemon older than accounts
 * answers for one, which stands in as the daemon's own environment.
 */
export function usageAccounts(usage: ClaudeUsage): ClaudeAccountUsage[] {
  if (usage.accounts && usage.accounts.length > 0) return usage.accounts;
  const { accounts: _accounts, ...only } = usage;
  return [{ ...only, config_dir: null, email: null }];
}

/**
 * The accounts' names where room is short, in order: their plans (`Pro`, `Team`) when those tell
 * them apart, otherwise each email before the @, else the directory's last part.
 */
export function usageAccountShortLabels(accounts: ClaudeAccountUsage[], t: Copy): string[] {
  const plans = accounts.map((account) => account.plan?.replace(/^claude\s+/i, "").trim() ?? "");
  if (plans.every(Boolean) && new Set(plans.map((plan) => plan.toLowerCase())).size === plans.length) {
    return plans.map((plan) => plan.charAt(0).toUpperCase() + plan.slice(1));
  }
  return accounts.map((account) => {
    if (account.email) return account.email.split("@")[0] || account.email;
    if (account.config_dir) return account.config_dir.split(/[\\/]/).filter(Boolean).pop() ?? account.config_dir;
    return t.claudeAgent.usage.own;
  });
}

/** An account's name in full, for the opened meter and the card. */
export function usageAccountLabel(account: ClaudeAccountUsage, t: Copy): string {
  return account.email ?? account.config_dir ?? t.claudeAgent.usage.own;
}

/** Why an account shows no windows, in the card's and the meter's words; null when it has some. */
export function usageAccountNote(account: ClaudeAccountUsage, t: Copy): string | null {
  if (account.available) return null;
  if (account.reason === "signed_out") return t.claudeAgent.usage.signedOut;
  if (account.reason === "no_plan") return t.claudeAgent.usage.noPlan;
  if (account.reason === "failed") return t.claudeAgent.usage.failed;
  return null;
}

/** The two windows the closed meter shows, the plan's own. */
export function headlineWindows(usage: Pick<ClaudeUsage, "windows">): ClaudeUsageWindow[] {
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
