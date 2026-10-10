/**
 * Every agent's usage in one answer (ADR 0080, `GET /v1/usage`): Claude's accounts as your Claude
 * Code reads them, Codex's as its app-server reads them, and for every agent this app's own records
 * of it today. Nothing new is asked here: the two probes keep their own answers and their own pace.
 */
import { AGENT_KINDS, type AgentUsage, type BotRunner, type ClaudeAccountUsage, type ClaudeUsage, type ClaudeUsageWindow, type UsageAccount, type UsageAgent, type UsageResponse, type UsageWindow } from "@real-bot/protocol";
import type { ClaudeUsageProbe } from "../claude-code/usage";
import type { Store } from "../store";
import { agentToday, type AgentUsageProbe } from "./usage";

export type UsageOverview = { current(maxAgeMs?: number): Promise<UsageResponse> };

/** The order agents are listed in: Claude first, then as `AGENT_KINDS` lists them, your own ACP agents last. */
const ORDER = Object.keys(AGENT_KINDS) as BotRunner[];

export function createUsageOverview(deps: { store: Store; claudeUsage: ClaudeUsageProbe; agentUsage: AgentUsageProbe }): UsageOverview {
  const { store } = deps;
  return {
    async current(maxAgeMs) {
      // Claude's probe answers `unused` at once when no account is in use or connected.
      const [claude, others] = await Promise.all([deps.claudeUsage.current(maxAgeMs), deps.agentUsage.current(maxAgeMs)]);
      const agents: UsageAgent[] = [];
      if (claude.reason !== "unused") {
        const label = AGENT_KINDS.claude_code.label;
        agents.push({ runner: "claude_code", custom_id: null, label, today: agentToday(store, label), accounts: claudeAccounts(claude).map(fromClaude) });
      }
      for (const item of others.items) {
        let agent = agents.find((seen) => seen.runner === item.runner && seen.custom_id === item.custom_id);
        if (!agent) {
          agent = { runner: item.runner, custom_id: item.custom_id, label: item.label, today: item.today, accounts: [] };
          agents.push(agent);
        }
        // An agent that reports no plan has no accounts to show: only its day here.
        if (AGENT_KINDS[item.runner].planUsage) agent.accounts.push(fromAgent(item));
      }
      const rank = (agent: UsageAgent) => ORDER.indexOf(agent.runner);
      agents.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
      return { agents };
    },
  };
}

/** Each account Claude answered for; a probe from before accounts answers for one, the daemon's own. */
function claudeAccounts(usage: ClaudeUsage): ClaudeAccountUsage[] {
  if (usage.accounts && usage.accounts.length > 0) return usage.accounts;
  const { accounts: _accounts, ...only } = usage;
  return [{ ...only, config_dir: null, email: null }];
}

export function claudeWindow(window: ClaudeUsageWindow): UsageWindow {
  return { minutes: window.kind === "five_hour" ? 300 : 10_080, model: window.kind === "model" ? window.model : null, percent: window.percent, resets_at: window.resets_at };
}

function fromClaude(account: ClaudeAccountUsage): UsageAccount {
  return {
    config_dir: account.config_dir, email: account.email, available: account.available,
    reason: account.reason === "unused" ? null : account.reason, plan: account.plan,
    windows: account.windows.map(claudeWindow), credits: null, checked_at: account.checked_at, error: account.error,
  };
}

function fromAgent(item: AgentUsage): UsageAccount {
  return {
    config_dir: item.config_dir, email: null, available: item.available, reason: item.reason, plan: item.plan,
    windows: item.windows.map((window) => ({ minutes: window.minutes, model: window.model ?? null, percent: window.percent, resets_at: window.resets_at })),
    credits: item.credits, checked_at: item.checked_at, error: item.error,
  };
}
