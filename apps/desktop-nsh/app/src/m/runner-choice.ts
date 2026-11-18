import {
  AGENT_KINDS,
  BOT_RUNNERS,
  isBotRunner,
  isLocalEndpoint,
  isReaderAgentModel,
  type AgentAccount,
  type AgentModel,
  type AgentStatus,
  type AgentsStatusResponse,
  type BotRunner,
  type Provider,
  type ReaderModel,
} from "@real-bot/protocol";
import type { Copy } from "./copy.ts";
import { claudeAgentSource, runnerSource } from "./model-source.ts";
import type { SelectOption } from "./select-options.ts";

/**
 * Who runs a Bot, as the pickers hold it (ADR 0079): `''` the app's own loop, a runner's name for a
 * local agent, and for one of your own ACP agents `custom:<id>` — one string a `Select` can bind to,
 * which `parseRunnerValue` reads back as `runner: "custom"` and `agent_custom_id`.
 */
const CUSTOM_PREFIX = "custom:";

export function runnerValueOf(runner: BotRunner | string | null | undefined, customId?: string | null): string {
  if (runner === "custom" && customId) return `${CUSTOM_PREFIX}${customId}`;
  return runner && isBotRunner(runner) ? runner : "";
}

export function parseRunnerValue(value: string | null | undefined): { runner: BotRunner | null; customId: string | null } {
  const raw = (value ?? "").trim();
  if (raw.startsWith(CUSTOM_PREFIX)) return { runner: "custom", customId: raw.slice(CUSTOM_PREFIX.length) || null };
  return { runner: isBotRunner(raw) ? raw : null, customId: null };
}

/** The status the daemon gave one agent (a custom one by its id); null when it gave none. */
export function agentStatusOf(agents: AgentsStatusResponse | null, runner: BotRunner, customId: string | null = null): AgentStatus | null {
  return agents?.items.find((item) => item.runner === runner && (item.custom_id ?? null) === (runner === "custom" ? customId : null)) ?? null;
}

/** An agent's name in the app: its label, or the name you gave your own ACP agent. */
export function agentLabelOf(runner: BotRunner, customId: string | null, agents: AgentsStatusResponse | null): string {
  if (runner !== "custom") return AGENT_KINDS[runner].label;
  return agents?.custom_agents.find((entry) => entry.id === customId)?.name ?? agentStatusOf(agents, runner, customId)?.label ?? AGENT_KINDS.custom.label;
}

/** What stands in the way of a turn on this agent, worst first; null when nothing does or nothing is known. */
export function agentBlocker(status: AgentStatus | null): "missing" | "signed_out" | null {
  if (!status) return null;
  if (!status.path) return "missing";
  if (status.logged_in === false) return "signed_out";
  return null;
}

/** An agent a model can be run on: found on this computer and not signed out. */
export function agentReady(status: AgentStatus | null): status is AgentStatus {
  return status !== null && agentBlocker(status) === null;
}

/** The effort levels an agent takes, lowest first; empty for one that takes none. */
export function agentEffortsOf(runner: BotRunner | null): readonly string[] {
  return AGENT_KINDS[runner ?? "claude_code"].efforts;
}

/** The models to offer on an agent: what it listed, else its default one when it named one. */
export function agentModelsOf(status: AgentStatus | null): AgentModel[] {
  if (!status) return [];
  if (status.models.length > 0) return status.models;
  return status.default_model ? [{ id: status.default_model, name: status.default_model, efforts: [] }] : [];
}

/** One of your accounts on an agent, as a picker names it. */
export function agentAccountLabel(account: AgentAccount, t: Copy): string {
  const base = account.config_dir ? account.config_dir : t.sidebar.botAgentAccountDefault;
  return account.auth ? `${account.auth} · ${base}` : base;
}

/** The accounts of an agent that has config directories and says which; none otherwise. */
export function agentAccountsOf(status: AgentStatus | null): AgentAccount[] {
  return status && AGENT_KINDS[status.runner].configDirVar ? (status.accounts ?? []) : [];
}

/** The picker of accounts on one agent: this computer's own first, then each listed directory; `current` stays a choice. */
export function agentAccountOptions(status: AgentStatus | null, current: string, t: Copy): Array<{ value: string; label: string }> {
  const accounts = agentAccountsOf(status);
  const own = accounts.find((account) => account.config_dir === null);
  const options = [{ value: "", label: own?.auth && own.logged_in !== false ? `${t.sidebar.botAgentAccountDefault} · ${own.auth}` : t.sidebar.botAgentAccountDefault }];
  for (const account of accounts) {
    if (account.config_dir) options.push({ value: account.config_dir, label: agentAccountLabel(account, t) });
  }
  if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
  return options;
}

/**
 * The runner picker's rows: the app's own loop, Claude Agent, then every other agent by its label and
 * each of your own ACP agents by its name. Every agent wears its logo (`source`); the app's own loop
 * has none. An agent not found on this computer, or signed out, is listed but cannot be picked, with
 * the reason beside it; `current` is never disabled, so a Bot already on it still reads right. Agents
 * are listed once the daemon has said what it finds — an older one, or the phone, does not, and then
 * only the first two are choices.
 */
export function runnerOptions(t: Copy, agents: AgentsStatusResponse | null, current: string): SelectOption[] {
  const options: SelectOption[] = [
    { value: "", label: t.sidebar.botRunnerApp },
    { value: "claude_code", label: t.sidebar.botRunnerClaude, source: claudeAgentSource(t) },
  ];
  const agentRow = (value: string, runner: BotRunner, label: string, status: AgentStatus | null): SelectOption => {
    const blocker = agentBlocker(status);
    return {
      value,
      label,
      source: runnerSource(runner, label, t),
      disabled: blocker !== null && value !== current,
      hint: blocker === "missing" ? t.sidebar.botRunnerAgentMissingShort : blocker === "signed_out" ? t.sidebar.botRunnerAgentSignedOutShort : undefined,
    };
  };
  if (agents) {
    for (const runner of BOT_RUNNERS) {
      if (runner === "claude_code" || runner === "custom") continue;
      options.push(agentRow(runner, runner, AGENT_KINDS[runner].label, agentStatusOf(agents, runner)));
    }
    for (const custom of agents.custom_agents) {
      options.push(agentRow(runnerValueOf("custom", custom.id), "custom", custom.name, agentStatusOf(agents, "custom", custom.id)));
    }
  }
  if (current && !options.some((option) => option.value === current)) {
    const { runner, customId } = parseRunnerValue(current);
    const label = runner ? agentLabelOf(runner, customId, agents) : current;
    options.push({
      value: current,
      label,
      source: runner ? runnerSource(runner, label, t) : undefined,
      hint: runner === "custom" && agents && !agents.custom_agents.some((entry) => entry.id === customId) ? t.sidebar.botRunnerAgentGone : undefined,
    });
  }
  return options;
}

/**
 * Who a new Bot starts on: the app's own loop while an endpoint can run it. With none — the app set up
 * on one local agent alone (ADR 0078, ADR 0079) — that agent, which the line reader's model names;
 * Claude Agent when it names none.
 */
export function setupRunnerOf(providers: readonly Pick<Provider, "base_url" | "key_set">[], reader: ReaderModel | null | undefined): string {
  if (providers.some((provider) => provider.base_url && (provider.key_set || isLocalEndpoint(provider.base_url)))) return "";
  return isReaderAgentModel(reader) ? runnerValueOf(reader.runner, reader.custom_id ?? null) : "claude_code";
}
