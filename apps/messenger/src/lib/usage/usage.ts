import type { AgentUsageResponse, ClaudeUsage, UsageAccount, UsageAgent, UsageResponse, UsageWindow } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

/** How often the widget and the page ask while the window is in front; the daemon keeps answers as long. */
export const USAGE_POLL_MS = 5 * 60_000;

/** A window's length as a name: 300 minutes is 5 hours, 10080 is 7 days; `short` for the pill and a summary. */
export function usageSpan(minutes: number | null, t: Copy, short = false): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return t.usage.window;
  if (minutes % 1440 === 0) return short ? t.usage.daysShort(minutes / 1440) : t.usage.days(minutes / 1440);
  if (minutes % 60 === 0) return short ? t.usage.hoursShort(minutes / 60) : t.usage.hours(minutes / 60);
  return short ? t.usage.minutesShort(Math.round(minutes)) : t.usage.minutes(Math.round(minutes));
}

/** A window's name in full: its length, after its model for a model's own window. */
export function usageWindowLabel(window: UsageWindow, t: Copy): string {
  const span = usageSpan(window.minutes, t);
  return window.model ? t.usage.model(window.model, span) : span;
}

/** Windows as listed: the whole plan's shortest first, then each model's (or model group's) together, shortest first. */
export function usageWindowsSorted(windows: UsageWindow[]): UsageWindow[] {
  const groups = [...new Set(windows.map((window) => window.model))];
  const rank = (window: UsageWindow) => (window.model === null ? -1 : groups.indexOf(window.model));
  return [...windows].sort((a, b) => rank(a) - rank(b) || (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
}

/** The window with the least left, which the pill's ring and the menu bar's show. */
export function usageTightest(windows: UsageWindow[]): UsageWindow | null {
  let tightest: UsageWindow | null = null;
  for (const window of windows) if (!tightest || window.percent > tightest.percent) tightest = window;
  return tightest;
}

/** How much of a window is left, from how much is used. */
export function usageLeft(percentUsed: number): number {
  return Math.min(100, Math.max(0, 100 - percentUsed));
}

/** What is left, said: whole percent rounded down, so a window in use never reads 100%; `<1%` for a sliver. */
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
  if (left <= 60_000) return t.usage.resetsSoon;
  if (left < 24 * 3_600_000) {
    const minutes = Math.ceil(left / 60_000);
    return t.usage.resetsIn(t.usage.hoursMinutes(Math.floor(minutes / 60), minutes % 60));
  }
  // claude.ai says 01:59:59.98 one time and 02:00:00 the next for the same window: to the nearest minute.
  const when = new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(Math.round(at / 60_000) * 60_000);
  return t.usage.resetsAt(when);
}

/** The clock time an answer is from. */
export function usageCheckedTime(checkedAt: string | null, locale: string): string | null {
  if (!checkedAt) return null;
  const at = Date.parse(checkedAt);
  if (Number.isNaN(at)) return null;
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}

/** When the newest of the answers came; null when none ever did. */
export function usageLatestCheck(agents: ReadonlyArray<UsageAgent>): string | null {
  let latest: string | null = null;
  for (const agent of agents) {
    for (const { checked_at: at } of agent.accounts) {
      if (at && !Number.isNaN(Date.parse(at)) && (!latest || Date.parse(at) > Date.parse(latest))) latest = at;
    }
  }
  return latest;
}

/** Tokens as a line says them: 950, 12.3k, 1.2M. */
export function usageTokenText(tokens: number): string {
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  // 999,950 and up would round to 1000k.
  if (tokens < 999_950) return `${trim(tokens / 1000)}k`;
  return `${trim(tokens / 1_000_000)}M`;
}

/** Credits as the agent gave them, trimmed to two decimals when they are a number (Codex says `62453.8865125000`). */
export function usageCreditsText(credits: string, locale?: string): string {
  const value = Number(credits);
  if (credits.trim() === "" || !Number.isFinite(value)) return credits;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** A plan as named: `claude max` and `max` both read `Max`. */
export function usagePlanName(plan: string | null): string | null {
  const name = plan?.replace(/^claude\s+/i, "").trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

/** Which account this is, past the agent's name: its email, else its directory's last part, else the default. */
export function usageAccountWho(account: UsageAccount, t: Copy): string {
  if (account.email) return account.email;
  if (account.config_dir) return account.config_dir.split(/[\\/]/).filter(Boolean).pop() ?? account.config_dir;
  return t.usage.own;
}

/** An account's name in full: the agent, its plan, and which account when that tells it apart. */
export function usageAccountName(agent: UsageAgent, account: UsageAccount, t: Copy): string {
  const plan = usagePlanName(account.plan);
  const head = agent.runner === "claude_code" ? "Claude" : agent.label;
  const named = plan ? `${head} ${plan}` : head;
  const several = agent.accounts.length > 1;
  return account.email || several ? `${named} · ${usageAccountWho(account, t)}` : named;
}

/**
 * An account under its agent's name in the panel, in two parts: its plan, and its email (or its
 * directory when the agent has several). One of them is always there.
 */
export function usageAccountShortName(
  agent: UsageAgent,
  account: UsageAccount,
  t: Copy,
): { plan: string | null; who: string | null } {
  const plan = usagePlanName(account.plan);
  const who = account.email || agent.accounts.length > 1 ? usageAccountWho(account, t) : null;
  return { plan, who: plan || who ? who : t.usage.own };
}

/** Why an account shows no windows; null when it has some. */
export function usageAccountNote(account: UsageAccount, t: Copy): string | null {
  if (account.available && account.windows.length > 0) return null;
  if (account.reason === "signed_out") return t.usage.signedOut;
  if (account.reason === "failed") return t.usage.failed;
  if (account.reason === "missing") return t.usage.missing;
  return t.usage.noPlan;
}

/** One account with plan windows to show, for the pill and the summary lines. */
export type UsageMeterEntry = { agent: UsageAgent; account: UsageAccount; tightest: UsageWindow };

/** Every account with windows, in the order the answer lists them, each with its tightest window. */
export function usageMeterEntries(agents: ReadonlyArray<UsageAgent>): UsageMeterEntry[] {
  const out: UsageMeterEntry[] = [];
  for (const agent of agents) {
    for (const account of agent.accounts) {
      const tightest = account.available ? usageTightest(account.windows) : null;
      if (tightest) out.push({ agent, account, tightest });
    }
  }
  return out;
}

/** An account's windows in one short line, as the menu bar and Settings say them: `5h 62% · 7d 81%`. */
export function usageSummary(account: UsageAccount, t: Copy): string {
  const plan = usageWindowsSorted(account.windows).filter((window) => window.model === null);
  if (plan.length > 0) return plan.map((window) => `${usageSpan(window.minutes, t, true)} ${usageLeftText(window.percent)}`).join(" · ");
  // Only per-model windows (Antigravity's model groups): each group by its tightest window.
  const groups = [...new Set(account.windows.map((window) => window.model))];
  return groups
    .map((model) => {
      const tightest = usageTightest(account.windows.filter((window) => window.model === model))!;
      return `${model} ${usageLeftText(tightest.percent)}`;
    })
    .join(" · ");
}

/** The agents with plan windows to report (their accounts listed), and those with only today's records. */
export function usageSplit(agents: ReadonlyArray<UsageAgent>): { plans: UsageAgent[]; todayOnly: UsageAgent[] } {
  return { plans: agents.filter((agent) => agent.accounts.length > 0), todayOnly: agents.filter((agent) => agent.accounts.length === 0) };
}

/**
 * The one answer put together from the two routes before it, for a daemon from before ADR 0080:
 * Claude's accounts first, then the other agents grouped as the new route groups them.
 */
export function usageFromLegacy(claude: ClaudeUsage | null, others: AgentUsageResponse | null): UsageResponse {
  const agents: UsageAgent[] = [];
  if (claude && claude.reason !== "unused") {
    const accounts = claude.accounts && claude.accounts.length > 0 ? claude.accounts : [{ ...claude, config_dir: null, email: null }];
    agents.push({
      runner: "claude_code", custom_id: null, label: "Claude Agent", today: { turns: 0, tokens: 0, estimated_usd: 0 },
      accounts: accounts.map((account) => ({
        config_dir: account.config_dir, email: account.email, available: account.available,
        reason: account.reason === "unused" ? null : account.reason, plan: account.plan, credits: null, checked_at: account.checked_at, error: account.error,
        windows: account.windows.map((window) => ({ minutes: window.kind === "five_hour" ? 300 : 10_080, model: window.kind === "model" ? window.model : null, percent: window.percent, resets_at: window.resets_at })),
      })),
    });
  }
  for (const item of others?.items ?? []) {
    let agent = agents.find((seen) => seen.runner === item.runner && seen.custom_id === item.custom_id);
    if (!agent) {
      agent = { runner: item.runner, custom_id: item.custom_id, label: item.label, today: item.today, accounts: [] };
      agents.push(agent);
    }
    // A daemon from before ADR 0080 asked only Codex for its plan.
    if (item.runner === "codex") {
      agent.accounts.push({
        config_dir: item.config_dir, email: null, available: item.available, reason: item.reason, plan: item.plan, credits: item.credits,
        checked_at: item.checked_at, error: item.error, windows: item.windows.map((window) => ({ ...window, model: window.model ?? null })),
      });
    }
  }
  return { agents };
}
