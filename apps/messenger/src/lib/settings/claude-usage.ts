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

/** An account's name in full, for the opened meter and the card: its plan, then its email. */
export function usageAccountLabel(account: ClaudeAccountUsage, t: Copy): string {
  const plan = account.plan?.replace(/^claude\s+/i, "").trim();
  const who = account.email ?? account.config_dir ?? t.claudeAgent.usage.own;
  return plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)} · ${who}` : who;
}

/**
 * What an account's group says after its short name: its email (else its directory), with its plan
 * first when the short name is not the plan already.
 */
export function usageAccountDetail(account: ClaudeAccountUsage, shortLabel: string): string | null {
  const plan = account.plan?.replace(/^claude\s+/i, "").trim() ?? "";
  const parts = [plan && plan.toLowerCase() !== shortLabel.toLowerCase() ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : "", account.email ?? account.config_dir ?? ""];
  const detail = parts.filter(Boolean).join(" · ");
  return detail || null;
}

/** When the newest of these answers came; null when none ever did. */
export function usageLatestCheck(accounts: ReadonlyArray<{ checked_at: string | null }>): string | null {
  let latest: string | null = null;
  for (const { checked_at: at } of accounts) {
    if (at && !Number.isNaN(Date.parse(at)) && (!latest || Date.parse(at) > Date.parse(latest))) latest = at;
  }
  return latest;
}

/** Why an account shows no windows, in the card's and the meter's words; null when it has some. */
export function usageAccountNote(account: ClaudeAccountUsage, t: Copy): string | null {
  if (account.available) return null;
  if (account.reason === "signed_out") return t.claudeAgent.usage.signedOut;
  if (account.reason === "no_plan") return t.claudeAgent.usage.noPlan;
  if (account.reason === "failed") return t.claudeAgent.usage.failed;
  return null;
}

/** How much of a window is left, from how much is used: rounded down, so a window in use never reads 100%. */
export function usageLeft(percentUsed: number): number {
  return Math.min(100, Math.max(0, 100 - percentUsed));
}

/** What is left as the strip and the rows say it: whole percent rounded down, `<1%` for a sliver. */
export function usageLeftText(percentUsed: number): string {
  const left = usageLeft(percentUsed);
  if (left > 0 && left < 1) return "<1%";
  return `${Math.floor(left)}%`;
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
