import type { ClaudeCodeStatus } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";

/** The account Claude Code says it is signed in with, as the panel and the card name it (ADR 0061). */
export function claudeAccountLabel(status: ClaudeCodeStatus, t: Copy): string {
  const method = status.auth_method ?? (status.logged_in ? "claude.ai" : "none");
  const plan = status.subscription_type?.replace(/^claude\s+/i, "");
  const base = method === "claude.ai" && plan
    ? t.claudeAgent.subscription(plan.charAt(0).toUpperCase() + plan.slice(1))
    : (t.claudeAgent.methods[method] ?? method);
  return status.email ? `${base} · ${status.email}` : base;
}

/** What stands in the way of a Claude Agent turn, worst first; null when nothing does. */
export function claudeAgentBlocker(status: ClaudeCodeStatus | null): "missing" | "signed_out" | null {
  if (!status) return null;
  if (!status.path) return "missing";
  if (status.logged_in === false) return "signed_out";
  return null;
}

/** Billed per token rather than out of a plan: worth saying before a Bot is switched over. */
export function claudeAgentPaysPerToken(status: ClaudeCodeStatus | null): boolean {
  return status?.auth_method === "api_key" || status?.auth_method === "api_key_helper";
}
