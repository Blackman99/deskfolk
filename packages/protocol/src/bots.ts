import type { USER_MEMBER } from "./constants.ts";
import type { ThinkingLevel } from "./models.ts";
import type { SessionDetail } from "./sessions.ts";

/**
 * Who runs a Bot's turns (ADR 0061). Absent or null: the app's own hop loop on an OpenAI-compatible
 * endpoint. `claude_code`: the user's own installed and signed-in Claude Code, through the Agent
 * SDK — shown as "Claude Agent", on `agent_model` and `agent_effort` (null: Claude Code's own
 * defaults) and the account in `agent_config_dir` (null: whichever one Claude Code finds in the
 * daemon's environment). The endpoint pin stays what the app's own calls about the Bot run on.
 */
export const BOT_RUNNERS = ["claude_code"] as const;
export type BotRunner = (typeof BOT_RUNNERS)[number];

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
  /** Who runs its turns (ADR 0061); absent from a daemon older than that. */
  runner?: BotRunner | null;
  /** The Claude model (alias or full id) a Claude Agent turn asks for; null: Claude Code's default. */
  agent_model?: string | null;
  /** The effort a Claude Agent turn asks for; null: Claude Code's default. */
  agent_effort?: ClaudeEffort | null;
  /**
   * The Claude Code config directory a Claude Agent turn runs with — which of your Claude accounts
   * it spends; one of the accounts listed in Settings (`ClaudeCodeStatus.accounts`). Null: the
   * account Claude Code finds in the daemon's own environment.
   */
  agent_config_dir?: string | null;
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
  agent_effort?: ClaudeEffort | null;
  agent_config_dir?: string | null;
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
  agent_effort?: ClaudeEffort | null;
  agent_config_dir?: string | null;
};

export type CreateBotResponse = {
  bot: Bot;
  direct_session: SessionDetail;
};
