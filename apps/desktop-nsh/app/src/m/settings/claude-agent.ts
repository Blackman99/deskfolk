import type { ClaudeCodeAccount, ClaudeCodeStatus } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

/** What Claude Code says it is signed in with: the daemon's own environment, or one listed account. */
export type ClaudeSignIn = Pick<ClaudeCodeStatus, "auth_method" | "logged_in" | "subscription_type" | "email">;

/** The account Claude Code says it is signed in with, as the panel and the card name it (ADR 0061). */
export function claudeAccountLabel(status: ClaudeSignIn, t: Copy): string {
  const method = status.auth_method ?? (status.logged_in ? "claude.ai" : "none");
  const plan = status.subscription_type?.replace(/^claude\s+/i, "");
  const base = method === "claude.ai" && plan
    ? t.claudeAgent.subscription(plan.charAt(0).toUpperCase() + plan.slice(1))
    : (t.claudeAgent.methods[method] ?? method);
  return status.email ? `${base} · ${status.email}` : base;
}

/**
 * The account a Bot's `agent_config_dir` names (`''` or null: the daemon's own environment); null
 * when the status has no word of it — from a daemon older than accounts, a listed one is unknown.
 */
export function claudeAccountOf(status: ClaudeCodeStatus | null, dir: string | null | undefined): ClaudeCodeAccount | ClaudeSignIn | null {
  if (!status) return null;
  const wanted = dir || null;
  return status.accounts?.find((account) => account.config_dir === wanted) ?? (wanted === null ? status : null);
}

/** What stands in the way of a Claude Agent turn on `signIn` (the daemon's own when absent), worst first; null when nothing does. */
export function claudeAgentBlocker(status: ClaudeCodeStatus | null, signIn?: ClaudeSignIn | null): "missing" | "signed_out" | null {
  if (!status) return null;
  if (!status.path) return "missing";
  if ((signIn ?? status).logged_in === false) return "signed_out";
  return null;
}

/** Billed per token rather than out of a plan: worth saying before a Bot is switched over. */
export function claudeAgentPaysPerToken(status: ClaudeSignIn | null): boolean {
  return status?.auth_method === "api_key" || status?.auth_method === "api_key_helper";
}

/** Claude Code is installed and at least one of the accounts it knows is signed in: a Claude model can be run. */
export function claudeReady(status: ClaudeCodeStatus | null): boolean {
  if (!status?.path) return false;
  return status.accounts ? status.accounts.some((account) => account.logged_in === true) : status.logged_in === true;
}

/**
 * The accounts a Claude model can run on, as the Bot panel's account picker lists them: this
 * computer's default, then each listed directory; `current` stays a choice even when the list no
 * longer has it (the phone cannot see the list).
 */
export function claudeAccountOptions(status: ClaudeCodeStatus | null, current: string, t: Copy): Array<{ value: string; label: string }> {
  const own = status?.path ? claudeAccountOf(status, null) : null;
  const options = [{ value: "", label: own && own.logged_in !== false ? `${t.sidebar.botAgentAccountDefault} · ${claudeAccountLabel(own, t)}` : t.sidebar.botAgentAccountDefault }];
  for (const account of status?.accounts ?? []) {
    if (account.config_dir) options.push({ value: account.config_dir, label: `${claudeAccountLabel(account, t)} · ${account.config_dir}` });
  }
  if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
  return options;
}
