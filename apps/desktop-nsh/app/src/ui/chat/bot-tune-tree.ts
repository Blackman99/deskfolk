/**
 * What a Bot's picker in its direct's composer (`BotTune`) lists and does. It starts at what runs
 * the Bot, the Bot panel's 运行方式: the app on your endpoints, Claude Agent, then your other local
 * agents (`runnerOptions`, so an agent not found or signed out is there but cannot be picked). Under
 * the app: an endpoint, one of its models, a level (`endpointTuneTree`); under an agent: an account
 * when Claude has a second one, a model, a level (`agentTuneTree`).
 *
 * A pick under the runner the Bot is on changes what it always did there. A pick under another one
 * moves the Bot onto it, and that one PATCH names every field of the new runner (`runnerMovePatch`):
 * the daemon starts an agent's model, level and account over only on a move from one agent to
 * another, so from the app's own loop, or from one of your ACP agents to another, the old ones
 * would stay.
 */
import { CLAUDE_EFFORTS, isBotRunner, type AgentsStatusResponse, type Bot, type ClaudeCodeStatus, type PatchBotRequest, type Provider } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api";
import type { Copy } from "../../m/copy";
import { loadClaudeModels } from "../../m/claude-models.svelte";
import { endpointSource, runnerSource, type ModelSource } from "../../m/model-source";
import { agentLabelOf, agentStatusOf, parseRunnerValue, runnerOptions, runnerValueOf } from "../../m/runner-choice";
import { agentBotPatch, agentTuneModels, endpointPin, endpointTuneLabels, endpointTuneTree } from "../../m/chat/bot-tune";
import { accountChoices } from "../../m/chat/project-agent-options.svelte";
import type { TuneFocus, TuneLevel, TuneRow, TuneTree } from "../../m/chat/tune-picker";
import { agentTuneLabels, agentTuneTree, type AgentTuneSource } from "./agent-tune-tree";

type Endpoint = Pick<Provider, "id" | "name" | "models" | "model_catalog" | "base_url" | "api_format">;

/** What the picker reads, each time it asks: pass getters for what changes. */
export type BotTuneSource = {
  readonly t: Copy;
  readonly bot: Bot;
  readonly providers: readonly Endpoint[];
  /** Your local agents as the daemon last saw them; null while asking, or from one that cannot say. */
  readonly agents: AgentsStatusResponse | null;
  /** Your Claude Code and its accounts; null while asking. */
  readonly claude: ClaudeCodeStatus | null;
  readonly client: Pick<MessengerApi, "claudeCodeModels"> | null;
  onpick(change: PatchBotRequest): void;
};

/** The first level's key; the levels under it are the endpoint tree's or the agent tree's. */
export const RUNNER_LEVEL = "runner";

/** What runs a Bot, as the first column's rows name it: '' the app's own loop, a runner, `custom:<id>`. */
export function botRunnerValue(bot: Pick<Bot, "runner" | "agent_custom_id">): string {
  return bot.runner && isBotRunner(bot.runner) ? runnerValueOf(bot.runner, bot.agent_custom_id ?? null) : "";
}

/** The first column: the panel's runner choices, each a short name over what it is (or why it cannot be picked), with its logo. */
export function runnerRows(t: Copy, agents: AgentsStatusResponse | null, current: string): TuneRow[] {
  return runnerOptions(t, agents, current).map((option) => ({
    value: option.value,
    label: option.value === "" ? t.composer.tuneRunnerApp : option.value === "claude_code" ? t.claudeAgent.title : (option.label ?? option.value),
    detail: option.hint ?? (option.value ? t.composer.tuneRunnerAgent : t.composer.tuneRunnerAppHint),
    disabled: option.disabled,
    // The app's own loop has no logo of its own: a plain endpoint tile, so the names line up.
    mark: option.source ?? { kind: "custom", name: t.composer.tuneRunnerApp },
  }));
}

/**
 * The one PATCH a pick under another runner comes to: the runner, and every field it runs on, from
 * the path picked (`level` the leaf). Onto the app's own loop: the endpoint pin, and no agent model,
 * level or account. Onto an agent: its model and level ('' for its own settings), and the account
 * only Claude's level picks; `agent_config_dir` is left out for a daemon that has no accounts for a Bot.
 */
export function runnerMovePatch(
  bot: Pick<Bot, "model" | "provider_id" | "thinking_level" | "agent_config_dir">,
  providers: readonly Endpoint[],
  value: string,
  level: string,
  focus: TuneFocus,
): PatchBotRequest {
  const { runner, customId } = parseRunnerValue(value);
  const account = bot.agent_config_dir !== undefined ? { agent_config_dir: (runner === "claude_code" ? focus.account : "") || null } : {};
  if (!runner) {
    return {
      runner: null,
      agent_model: null,
      agent_effort: null,
      ...account,
      ...endpointPin(bot, providers, { endpoint: focus.endpoint ?? "", model: focus.model ?? "", thinking: level === "thinking" ? (focus.thinking ?? "") : undefined }),
    };
  }
  return {
    runner,
    ...(runner === "custom" ? { agent_custom_id: customId } : {}),
    agent_model: focus.model || null,
    agent_effort: CLAUDE_EFFORTS.find((effort) => effort === focus.effort) ?? null,
    ...account,
  };
}

/** An agent's name in the composer: Claude Code by its own name, the rest as the app names them. */
function agentNameOf(t: Copy, value: string, agents: AgentsStatusResponse | null): string {
  const { runner, customId } = parseRunnerValue(value);
  if (!runner) return "";
  return runner === "claude_code" ? t.project.agentNames.claude_code : agentLabelOf(runner, customId, agents);
}

const BLANK = { account: "", model: "", effort: "" };

/**
 * What the agent levels under one runner read: the Bot's own model, level and account on the agent
 * it runs on, nothing picked on any other (a move starts at the agent's own settings). Claude's
 * accounts only with a second one, and never from a daemon that has no accounts for a Bot.
 */
export function agentTuneSourceFor(source: BotTuneSource, value: string): AgentTuneSource {
  const { runner, customId } = parseRunnerValue(value);
  const on = () => value === botRunnerValue(source.bot);
  const tune = () => (on() ? { account: source.bot.agent_config_dir ?? "", model: source.bot.agent_model ?? "", effort: source.bot.agent_effort ?? "" } : BLANK);
  return {
    get t() {
      return source.t;
    },
    get agentName() {
      return agentNameOf(source.t, value, source.agents);
    },
    get tune() {
      return tune();
    },
    get models() {
      return runner && runner !== "claude_code"
        ? agentTuneModels(agentStatusOf(source.agents, runner, customId), runner, tune().model, source.t.project.modelDefault)
        : undefined;
    },
    get accounts() {
      if (runner !== "claude_code" || source.bot.agent_config_dir === undefined) return null;
      const choices = accountChoices(source.claude, tune().account, source.t.project.defaultAccount);
      return choices.length > 1 ? choices : null;
    },
    accountLocked: false,
    get client() {
      return source.client;
    },
    onPick: (change) => source.onpick(agentBotPatch(change)),
  };
}

export function botTuneTree(source: BotTuneSource): TuneTree {
  const current = () => botRunnerValue(source.bot);
  const runnerLevel = (): TuneLevel => ({ key: RUNNER_LEVEL, heading: source.t.sidebar.botRunner, width: 200, details: true });
  const endpoints = endpointTuneTree({
    get t() {
      return source.t;
    },
    get bot() {
      return source.bot;
    },
    get providers() {
      return source.providers;
    },
    onpick: (change) => source.onpick(change),
  });
  const agents = new Map<string, TuneTree>();
  /** The levels under a runner: the endpoints' under the app's own loop, an agent's under each agent. */
  function under(value: string): TuneTree {
    if (!value) return endpoints;
    let tree = agents.get(value);
    if (!tree) {
      tree = agentTuneTree(agentTuneSourceFor(source, value));
      agents.set(value, tree);
    }
    return tree;
  }
  const runnerOf = (focus: TuneFocus) => focus[RUNNER_LEVEL] ?? "";

  return {
    start: () => ({ ...under(current()).start(), [RUNNER_LEVEL]: current() }),
    levels: (focus) => [runnerLevel(), ...under(runnerOf(focus)).levels(focus)],
    // The widest path any runner can open, so the columns keep their width as the pointer goes from one runner to another.
    room: (focus) => {
      const width = (levels: TuneLevel[]) => levels.reduce((sum, level) => sum + level.width, 0);
      const paths = runnerRows(source.t, source.agents, current())
        .filter((row) => !row.disabled)
        .map((row) => (row.value === runnerOf(focus) ? under(row.value).room(focus) : under(row.value).room(under(row.value).start())));
      const widest = paths.reduce((most, path) => (width(path) > width(most) ? path : most), under(runnerOf(focus)).room(focus));
      return [runnerLevel(), ...widest];
    },
    rows: (level, focus) => (level === RUNNER_LEVEL ? runnerRows(source.t, source.agents, current()) : under(runnerOf(focus)).rows(level, focus)),
    checked: (level, focus) => (level === RUNNER_LEVEL ? current() : under(runnerOf(focus)).checked(level, focus)),
    // Every runner has a level under it: the endpoints, or the agent's models.
    opensMore: (level, value, focus) => (level === RUNNER_LEVEL ? true : under(runnerOf(focus)).opensMore(level, value, focus)),
    focusAt: (level, value, focus) => {
      if (level === RUNNER_LEVEL) {
        if (value === runnerOf(focus)) return focus;
        // Another runner starts over at its own levels: the model keys of the two trees are the same.
        const start = under(value).start();
        if (parseRunnerValue(value).runner === "claude_code") loadClaudeModels(source.client, start.account || null);
        return { ...start, [RUNNER_LEVEL]: value };
      }
      const next = under(runnerOf(focus)).focusAt(level, value, focus);
      return next === focus ? focus : { ...next, [RUNNER_LEVEL]: runnerOf(focus) };
    },
    commit: (level, focus) => {
      const value = runnerOf(focus);
      if (level === RUNNER_LEVEL) return;
      if (value === current()) return under(value).commit(level, focus);
      source.onpick(runnerMovePatch(source.bot, source.providers, value, level, focus));
    },
  };
}

/** What the closed picker says: what runs the Bot by its logo, then its model and level, and quieter after them the endpoint or the account. */
export function botTuneLabels(source: BotTuneSource): { mark: ModelSource | null; value: string; level: string | null; aside: string | null; title: string } {
  const value = botRunnerValue(source.bot);
  const { runner } = parseRunnerValue(value);
  if (runner) {
    const agent = agentTuneSourceFor(source, value);
    return { mark: runnerSource(runner, agent.agentName, source.t), ...agentTuneLabels(agent) };
  }
  const shown = endpointTuneLabels(source.t, source.bot, source.providers);
  return { mark: shown.endpoint ? endpointSource(shown.endpoint, source.t) : null, value: shown.value, level: shown.level, aside: shown.aside, title: shown.title };
}
