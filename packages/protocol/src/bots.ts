import type { USER_MEMBER } from "./constants.ts";
import type { ThinkingLevel } from "./models.ts";
import type { SessionDetail } from "./sessions.ts";

/**
 * Who runs a Bot's turns (ADR 0061, ADR 0079). Absent or null: the app's own hop loop on an
 * OpenAI-compatible endpoint. Any other value is a local agent: an agent CLI you installed and
 * signed in to yourself, run unmodified on this computer — `claude_code` is your Claude Code through
 * the Agent SDK ("Claude Agent"), `codex` your Codex through its app-server, `grok`, `opencode`
 * and `zcode` theirs over the Agent Client Protocol, `antigravity` your `agy` in print mode,
 * and `custom` an ACP command you named (`agent_custom_id`). Each runs on `agent_model` and
 * `agent_effort` (null: the agent's own defaults) and, where the agent has config directories, the
 * account in `agent_config_dir` (null: whichever one it finds in the daemon's environment). The
 * endpoint pin stays what the app's own calls about the Bot run on.
 */
export const BOT_RUNNERS = ["claude_code", "codex", "grok", "opencode", "antigravity", "zcode", "custom"] as const;
export type BotRunner = (typeof BOT_RUNNERS)[number];

/**
 * How the app talks to a local agent: the Agent SDK (Claude Code), Codex's app-server, the Agent
 * Client Protocol, or `agy`'s print mode with its NDJSON events.
 */
export type AgentProtocol = "claude_sdk" | "codex_app_server" | "acp" | "agy_print";

/** What every client knows of a local agent before asking it anything (ADR 0079). */
export type AgentKindInfo = {
  runner: BotRunner;
  /** Its name in the app; plain text, no vendor mark beside it except Claude's (ADR 0061). */
  label: string;
  protocol: AgentProtocol;
  /** The command looked for on this computer; null for a custom agent, whose command you name. */
  command: string | null;
  /** The effort levels it takes, lowest first; empty when it takes none (the model decides). */
  efforts: readonly string[];
  /** Model names offered before the agent was asked for its own list. */
  modelAliases: readonly string[];
  /**
   * The environment variable that points it at another config directory — another of your accounts
   * (as `CLAUDE_CONFIG_DIR` does for Claude Code); null when it has none the app knows of.
   */
  configDirVar: string | null;
  /** Its plan reports usage windows the app can show (Claude's, Codex's, Grok's, Antigravity's); the others show spend only. */
  planUsage: boolean;
  /** The app's own tools (end_turn, submit, ask_user, …) reach it; not true of `agy`'s print mode. */
  appTools: boolean;
};

export const AGENT_KINDS: Record<BotRunner, AgentKindInfo> = {
  claude_code: { runner: "claude_code", label: "Claude Agent", protocol: "claude_sdk", command: "claude",
    efforts: ["low", "medium", "high", "xhigh", "max"], modelAliases: ["sonnet", "opus", "haiku", "fable"],
    configDirVar: "CLAUDE_CONFIG_DIR", planUsage: true, appTools: true },
  codex: { runner: "codex", label: "Codex", protocol: "codex_app_server", command: "codex",
    efforts: ["low", "medium", "high", "xhigh", "max"], modelAliases: [], configDirVar: "CODEX_HOME", planUsage: true, appTools: true },
  grok: { runner: "grok", label: "Grok", protocol: "acp", command: "grok",
    efforts: ["low", "medium", "high", "xhigh"], modelAliases: [], configDirVar: null, planUsage: true, appTools: true },
  opencode: { runner: "opencode", label: "OpenCode", protocol: "acp", command: "opencode",
    efforts: [], modelAliases: [], configDirVar: null, planUsage: false, appTools: true },
  antigravity: { runner: "antigravity", label: "Antigravity", protocol: "agy_print", command: "agy",
    efforts: ["low", "medium", "high", "xhigh", "max"], modelAliases: [], configDirVar: null, planUsage: true, appTools: false },
  zcode: { runner: "zcode", label: "ZCode", protocol: "acp", command: "zcode-acp",
    efforts: [], modelAliases: [], configDirVar: null, planUsage: false, appTools: true },
  custom: { runner: "custom", label: "ACP Agent", protocol: "acp", command: null,
    efforts: [], modelAliases: [], configDirVar: null, planUsage: false, appTools: true },
};

/**
 * An ACP agent you named yourself (`runner: "custom"`, ADR 0079): any command that serves the Agent
 * Client Protocol on its stdin and stdout, run with these arguments. `id` is what a Bot's
 * `agent_custom_id` points at.
 */
export type CustomAgent = { id: string; name: string; command: string; args: string[] };

/** The effort levels a runner takes; empty when it takes none. */
export function agentEfforts(runner: BotRunner): readonly string[] {
  return AGENT_KINDS[runner].efforts;
}

/** An effort a runner takes. */
export function isAgentEffort(runner: BotRunner, value: unknown): value is string {
  return typeof value === "string" && AGENT_KINDS[runner].efforts.includes(value);
}

/**
 * A model as a Bot may pin it on a local agent: up to 200 printable characters, no spaces. Agents
 * name models their own way (`openai/gpt-5.5`, `nvidia/z-ai/glm-5.3`).
 */
export function isAgentModelName(value: string): boolean {
  return /^[^\s\u0000-\u001f\u007f]{1,200}$/.test(value);
}

/** The effort levels Claude Code takes (`--effort`), lowest first; which ones a model offers varies. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** Model aliases Claude Code resolves itself; a full model id is accepted too. */
export const CLAUDE_MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;

/** A Claude Code model name or alias as a Bot may pin it: letters, digits, `.`, `-`, `_`, `[`, `]`. */
export function isClaudeModelName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/.test(value);
}

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === "string" && (CLAUDE_EFFORTS as readonly string[]).includes(value);
}

export function isBotRunner(value: unknown): value is BotRunner {
  return typeof value === "string" && (BOT_RUNNERS as readonly string[]).includes(value);
}

export type Bot = {
  id: string;
  name: string;
  duties: string;
  boundaries: string;
  avatar: string | null;
  model: string | null;
  provider_id: string | null;
  /**
   * Pinned thinking level. `null` lets the app pick per message. A pinned level applies whenever the
   * resolved model supports it; otherwise the app picks as if unpinned.
   */
  thinking_level: ThinkingLevel | null;
  /** Who runs its turns (ADR 0061, ADR 0079); absent from a daemon older than that. */
  runner?: BotRunner | null;
  /** The model a local agent's turn asks for (an alias or full id, as that agent names it); null: its default. */
  agent_model?: string | null;
  /** The effort a local agent's turn asks for, one of `AGENT_KINDS[runner].efforts`; null: its default. */
  agent_effort?: string | null;
  /**
   * The config directory a local agent's turn runs with — which of your accounts it spends; one of
   * the accounts listed in Settings for that agent (`ClaudeCodeStatus.accounts` for Claude). Null:
   * the account the agent finds in the daemon's own environment.
   */
  agent_config_dir?: string | null;
  /** For `runner: "custom"`, which of your custom ACP agents (`CustomAgent.id`); null otherwise. */
  agent_custom_id?: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * What the daemon found of the user's own Claude Code (ADR 0061, `GET /v1/runtime/claude-code`).
 * Deskfolk only runs it and asks it about itself (`claude --version`, `claude auth status`); it never
 * reads its credentials.
 */
export type ClaudeCodeStatus = {
  /** The executable a Claude Agent turn would run; null when none was found. */
  path: string | null;
  /** Where the path came from: your setting, the daemon's PATH, a usual install place, or your login shell. */
  source: "setting" | "path" | "known" | "login_shell" | null;
  version: string | null;
  /** The Claude Code version the bundled Agent SDK was built with; older ones may lack what it uses. */
  sdk_version: string;
  outdated: boolean;
  /** From `claude auth status`; null when it could not be asked. */
  logged_in: boolean | null;
  /** `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party` or `none`, as Claude Code reports it. */
  auth_method: string | null;
  /** e.g. `pro`, `max`; null when the credential is not a subscription. */
  subscription_type: string | null;
  email: string | null;
  /** `ANTHROPIC_BASE_URL` is set for the daemon, so Claude Code sends its requests there. */
  base_url_set: boolean;
  /**
   * The proxy Claude Code reaches Anthropic through, any user and password in it hidden; null when it
   * goes straight. `env`: the daemon's `HTTPS_PROXY` / `ALL_PROXY`, passed on as they are. `system`:
   * none of those is set, so the system's HTTPS proxy is handed to Claude Code as `HTTPS_PROXY`.
   */
  proxy: string | null;
  proxy_source: "env" | "system" | null;
  checked_at: string;
  /** Why something could not be found or asked, in English, for the card's small print. */
  error: string | null;
  /**
   * Your Claude accounts, as Claude Code signs in with each: first the daemon's own environment
   * (`config_dir` null, the same answer as the fields above), then every config directory you
   * listed in Settings. Absent from a daemon older than that.
   */
  accounts?: ClaudeCodeAccount[];
};

/**
 * One Claude account: a Claude Code config directory and what `claude auth status` says of it when
 * run with that directory (ADR 0061). Deskfolk keeps the directory only; signing in is Claude
 * Code's own (`claude auth login`, with `CLAUDE_CONFIG_DIR` set to the directory).
 */
export type ClaudeCodeAccount = {
  /** The directory as listed in Settings, absolute; null for the daemon's own environment. */
  config_dir: string | null;
  /** The directory Claude Code reports it reads (`configDirectory`); null when it did not say. */
  config_directory: string | null;
  logged_in: boolean | null;
  auth_method: string | null;
  subscription_type: string | null;
  email: string | null;
  /** Why it could not be asked, in English. */
  error: string | null;
  /** What to run in a terminal to sign this account in, as this computer's shell takes it. */
  login_command: string;
};

/** One of your Claude plan's usage windows (`GET /v1/claude-usage`). */
export type ClaudeUsageWindow = {
  /** `five_hour` and `seven_day` are the whole plan's; `model` is one model's own weekly window. */
  kind: "five_hour" | "seven_day" | "model";
  /** The model a `model` window is for, as Claude names it (e.g. `Opus`); null otherwise. */
  model: string | null;
  /** How much of the window is used, 0–100. */
  percent: number;
  /** When the window starts over; null when Claude Code did not say. */
  resets_at: string | null;
};

/**
 * Your Claude plan's usage, asked of your own Claude Code: the data behind its `/usage`, which
 * Claude Code fetches from claude.ai itself (ADR 0061). Deskfolk never reads its credentials.
 */
export type ClaudeUsage = {
  /** Whether there are windows to show. */
  available: boolean;
  /**
   * Why not, when not: no Bot runs on Claude Agent (`unused`; nothing is asked then), no `claude`
   * was found, it is signed out, its sign-in has no plan limits (an API key, a third-party platform:
   * `no_plan`), or asking failed before any answer came.
   */
  reason: "unused" | "missing" | "signed_out" | "no_plan" | "failed" | null;
  /** e.g. `pro`, `max`; null when Claude Code did not say. */
  plan: string | null;
  windows: ClaudeUsageWindow[];
  /** When Claude Code gave these windows; null before it ever did. */
  checked_at: string | null;
  /** Why the latest ask failed, in English; the windows are then the last answer that came. */
  error: string | null;
  /**
   * Every account some Bot on Claude Agent runs on, each with its own windows; the fields above are
   * the first one's, for a client older than accounts. Absent from a daemon older than that.
   */
  accounts?: ClaudeAccountUsage[];
};

/** One account's usage (`ClaudeUsage.accounts`): which account, then the same fields as `ClaudeUsage`. */
export type ClaudeAccountUsage = Omit<ClaudeUsage, "accounts"> & {
  /** The Bot's `agent_config_dir`; null for the daemon's own environment. */
  config_dir: string | null;
  /** The account's email, as `claude auth status` gave it; null when it did not. */
  email: string | null;
};

/** One model a local agent offers, as it names it, with the effort levels it takes where it says. */
export type AgentModel = { id: string; name: string; efforts: string[] };

/** One of your accounts on a local agent: a config directory and what the agent says of it (ADR 0079). */
export type AgentAccount = {
  /** The directory as listed in Settings; null for the daemon's own environment. */
  config_dir: string | null;
  logged_in: boolean | null;
  /** What it signs in with, in its own words (`ChatGPT free`, …); null when it did not say. */
  auth: string | null;
  error: string | null;
  login_command: string | null;
};

/**
 * What the daemon found of one of your local agents other than Claude Code (ADR 0079,
 * `GET /v1/runtime/agents`; Claude's own is `ClaudeCodeStatus`). The daemon runs the agent and
 * asks it about itself (its version, its sign-in, its models); it never reads its credentials.
 */
export type AgentStatus = {
  runner: BotRunner;
  /** For a custom ACP agent, which one; null otherwise. */
  custom_id: string | null;
  /** The name shown: the agent's label, or the custom agent's own name. */
  label: string;
  /** The command a turn would run; null when none was found. */
  path: string | null;
  source: "setting" | "path" | "known" | "login_shell" | "custom" | null;
  version: string | null;
  /** Whether it is signed in, as it says itself; null when it cannot tell without a turn. */
  logged_in: boolean | null;
  /** What it signs in with, in its own words (`ChatGPT free`, `grok.com`, the providers OpenCode has keys for); null when it did not say. */
  auth: string | null;
  /** What to run in a terminal to sign it in; null when it has no such command. */
  login_command: string | null;
  /** The models it offers, when it lists them (or offered in its last session); empty before. */
  models: AgentModel[];
  default_model: string | null;
  /** The proxy its requests go through, any user and password hidden; null when they go straight. */
  proxy: string | null;
  proxy_source: "env" | "system" | null;
  checked_at: string;
  /** Why something could not be found or asked, in English, for the card's small print. */
  error: string | null;
  /** Your accounts on it, for an agent with config directories: the daemon's own environment first. */
  accounts?: AgentAccount[];
};

/** `GET /v1/runtime/agents`: every local agent other than Claude Code, and your own ACP agents. */
/**
 * Your local agents as last seen. `refreshing`: some were seen too long ago and are being looked at
 * again (an agent takes seconds to ask); ask again with `wait=1` for the fresh answers.
 */
export type AgentsStatusResponse = { items: AgentStatus[]; custom_agents: CustomAgent[]; refreshing?: boolean };

/** One usage window of an agent's plan (Codex's, ADR 0079): how much is used and when it starts over. */
export type AgentUsageWindow = {
  /** The window's length in minutes (300 = five hours, 10080 = a week); null when it did not say. */
  minutes: number | null;
  /** The models it is for, as the agent names them (Antigravity's `Gemini Models`); null or absent for the whole plan's. */
  model?: string | null;
  /** How much of it is used, 0–100. */
  percent: number;
  resets_at: string | null;
};

/**
 * One local agent's usage (`GET /v1/agent-usage`, ADR 0079): its plan's windows where the agent
 * reports them (Codex), and otherwise what this app's own records hold of it today — never a
 * percentage the agent did not give.
 */
export type AgentUsage = {
  runner: BotRunner;
  custom_id: string | null;
  label: string;
  config_dir: string | null;
  /** Plan windows to show. */
  available: boolean;
  reason: "missing" | "signed_out" | "no_plan" | "failed" | null;
  plan: string | null;
  windows: AgentUsageWindow[];
  /** Credits left on the plan, as the agent says it; null when it does not. */
  credits: string | null;
  /** This app's own spend records for the agent since local midnight. */
  today: { turns: number; tokens: number; estimated_usd: number };
  checked_at: string | null;
  error: string | null;
};

export type AgentUsageResponse = { items: AgentUsage[] };

/** One plan window, as every agent's is shown (ADR 0080). */
export type UsageWindow = {
  /** Its length in minutes: 300 is five hours, 10080 a week; null when the agent did not say. */
  minutes: number | null;
  /** The model a model's own window is for (Claude's `Opus`); null for the whole plan's. */
  model: string | null;
  /** How much of it is used, 0–100. */
  percent: number;
  resets_at: string | null;
};

/** One account of an agent that reports its plan's windows. */
export type UsageAccount = {
  /** The account's config directory as listed in Settings; null for the daemon's own environment. */
  config_dir: string | null;
  email: string | null;
  /** Plan windows to show. */
  available: boolean;
  reason: "missing" | "signed_out" | "no_plan" | "failed" | null;
  plan: string | null;
  windows: UsageWindow[];
  /** Credits left on the plan, as the agent says it. */
  credits: string | null;
  checked_at: string | null;
  /** Why the latest ask failed, in English; the windows are then the last answer that came. */
  error: string | null;
};

/**
 * One agent something runs on, with what this app's own records hold of it today and, where the
 * agent reports them (Claude, Codex), each account's plan windows. `accounts` is empty for an
 * agent that reports none: never a percentage it did not give.
 */
export type UsageAgent = {
  runner: BotRunner;
  custom_id: string | null;
  label: string;
  today: { turns: number; tokens: number; estimated_usd: number };
  accounts: UsageAccount[];
};

/** `GET /v1/usage` (ADR 0080): every agent's usage in one answer, Claude first. */
export type UsageResponse = { agents: UsageAgent[] };

export type ProfileRevision = {
  id: string;
  bot_id: string;
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  actor: typeof USER_MEMBER | string;
  message_id: string | null;
  created_at: string;
};

export type CreateBotRequest = {
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  model?: string | null;
  provider_id?: string | null;
  thinking_level?: ThinkingLevel | null;
  runner?: BotRunner | null;
  agent_model?: string | null;
  agent_effort?: string | null;
  agent_config_dir?: string | null;
  agent_custom_id?: string | null;
};

export type PatchBotRequest = {
  name?: string;
  duties?: string;
  boundaries?: string;
  avatar?: string | null;
  model?: string | null;
  provider_id?: string | null;
  thinking_level?: ThinkingLevel | null;
  runner?: BotRunner | null;
  agent_model?: string | null;
  agent_effort?: string | null;
  agent_config_dir?: string | null;
  agent_custom_id?: string | null;
};

export type CreateBotResponse = {
  bot: Bot;
  direct_session: SessionDetail;
};
