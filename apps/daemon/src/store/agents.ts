/**
 * What is kept about your local agents (ADR 0079), one runner at a time: where its command lives
 * when you tell us, the config directories of your accounts on it, and the ACP agents you named
 * yourself. Claude Code keeps its own keys from ADR 0061 (`claude_code_path`,
 * `claude_code_config_dirs`); the others get `<runner>_path` and `<runner>_config_dirs`. Nothing
 * else about an agent is stored: Deskfolk runs it and asks it about itself, it never keeps its
 * credentials.
 */
import { AGENT_KINDS, BUILTIN_MODEL_ROLES, type BotRunner, type CustomAgent } from "@real-bot/protocol";
import { CLAUDE_CONFIG_DIRS_MAX, normalizeConfigDir, sameConfigDir, tildeDir, tooWideForConfigDir } from "../claude-code/account";
import { HttpError } from "../errors";
import { ulid } from "../ids";
import { claudeCodeConfigDirs, claudeCodePath, setClaudeCodeConfigDirs, setClaudeCodePath } from "./claude-code";
import { setSetting, type StoreContext } from "./shared";

const CUSTOM_KEY = "custom_agents";
/** At most this many ACP agents of your own. */
export const CUSTOM_AGENTS_MAX = 8;
const NAME_MAX = 60;
const ARG_MAX = 1024;
const ARGS_MAX = 32;

function setting(ctx: StoreContext, key: string): string {
  return ctx.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? "";
}

/** The command you pointed a runner at, or null to let the daemon look for one. */
export function agentPath(ctx: StoreContext, runner: BotRunner): string | null {
  if (runner === "claude_code") return claudeCodePath(ctx);
  if (runner === "custom") return null;
  const value = setting(ctx, `${runner}_path`).trim();
  return value || null;
}

/** An absolute path (or one under `~/`) to keep for a runner, or null / "" to forget it. */
export function setAgentPath(ctx: StoreContext, runner: BotRunner, value: unknown): string | null {
  if (runner === "claude_code") return setClaudeCodePath(ctx, value);
  if (runner === "custom") throw new HttpError(422, "invalid_args", "a custom agent's command is set with the agent itself");
  if (value === null || (typeof value === "string" && value.trim() === "")) {
    setSetting(ctx, `${runner}_path`, "");
    return null;
  }
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "path must be a string or null");
  const trimmed = value.trim();
  if (trimmed.length > ARG_MAX) throw new HttpError(422, "invalid_args", "path is too long");
  if (!/^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(trimmed)) {
    throw new HttpError(422, "invalid_args", "path must be absolute");
  }
  setSetting(ctx, `${runner}_path`, trimmed);
  return trimmed;
}

/** The config directories of your accounts on a runner, besides the daemon's own environment. */
export function agentConfigDirs(ctx: StoreContext, runner: BotRunner): string[] {
  if (runner === "claude_code") return claudeCodeConfigDirs(ctx);
  if (!AGENT_KINDS[runner].configDirVar) return [];
  const raw = setting(ctx, `${runner}_config_dirs`);
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((dir): dir is string => typeof dir === "string" && dir.length > 0) : [];
  } catch {
    return [];
  }
}

/** Every listed account directory, of every runner: none of them is a Bot's to read or write. */
export function allAgentConfigDirs(ctx: StoreContext): string[] {
  return (Object.keys(AGENT_KINDS) as BotRunner[]).flatMap((runner) => agentConfigDirs(ctx, runner));
}

/**
 * The whole list for a runner, as the Settings card sends it after an add or a removal (the rules
 * of ADR 0061's accounts addendum, for every agent that has config directories): one a Bot, a
 * built-in call or a ladder rung runs on stays until it is moved, since taking it away would move
 * that spending without you choosing.
 */
export function setAgentConfigDirs(ctx: StoreContext, runner: BotRunner, value: unknown): string[] {
  if (runner === "claude_code") return setClaudeCodeConfigDirs(ctx, value);
  const variable = AGENT_KINDS[runner].configDirVar;
  if (!variable) throw new HttpError(422, "invalid_args", `${AGENT_KINDS[runner].label} has no accounts to list`);
  if (!Array.isArray(value)) throw new HttpError(422, "invalid_args", "config_dirs must be a list of paths");
  if (value.length > CLAUDE_CONFIG_DIRS_MAX) throw new HttpError(422, "invalid_args", `at most ${CLAUDE_CONFIG_DIRS_MAX} accounts can be listed`);
  const dirs: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new HttpError(422, "invalid_args", "config_dirs must be a list of paths");
    const dir = normalizeConfigDir(entry);
    if (!dir) throw new HttpError(422, "invalid_args", `${entry.trim().slice(0, 200)} is not an absolute path`);
    if (tooWideForConfigDir(dir)) throw new HttpError(422, "invalid_args", `${tildeDir(dir)} is your home folder or holds it: name the account's own directory`);
    if (!dirs.some((kept) => sameConfigDir(kept, dir))) dirs.push(dir);
  }
  const label = AGENT_KINDS[runner].label;
  const removed = agentConfigDirs(ctx, runner).filter((dir) => !dirs.some((kept) => sameConfigDir(kept, dir)));
  for (const dir of removed) {
    const users = ctx.db
      .query<{ name: string }, [string, string]>("SELECT name FROM bots WHERE deleted_at IS NULL AND runner = ? AND agent_config_dir = ? ORDER BY name COLLATE NOCASE")
      .all(runner, dir)
      .map((row) => row.name);
    if (users.length > 0) {
      throw new HttpError(409, "conflict", `${tildeDir(dir)} is the ${label} account of ${users.join(", ")}: move ${users.length === 1 ? "that Bot" : "those Bots"} to another account first`);
    }
    for (const role of BUILTIN_MODEL_ROLES) {
      const used = ctx.db.query<{ key: string; value: string }, [string, string]>("SELECT key, value FROM settings WHERE key IN (?, ?)")
        .all(`${role}_runner`, `${role}_config_dir`);
      const configDir = used.find((row) => row.key === `${role}_config_dir`)?.value ?? "";
      if (used.find((row) => row.key === `${role}_runner`)?.value !== runner || !configDir || !sameConfigDir(configDir, dir)) continue;
      throw new HttpError(409, "conflict", role === "reader"
        ? `${tildeDir(dir)} is the ${label} account lines are read on: choose another reader model or account first`
        : `${tildeDir(dir)} is the ${label} account the built-in call ${role} runs on: choose another model or account for it first`);
    }
    if (ladderAgentConfigDirs(ctx, runner).some((used) => sameConfigDir(used, dir))) {
      throw new HttpError(409, "conflict", `${tildeDir(dir)} is the ${label} account of a rung on the model ladder: take that rung off or move it to another account first`);
    }
  }
  setSetting(ctx, `${runner}_config_dirs`, dirs.length > 0 ? JSON.stringify(dirs) : "");
  return dirs;
}

/** The accounts the model ladder's rungs on a runner spend (ADR 0076). */
export function ladderAgentConfigDirs(ctx: StoreContext, runner: BotRunner): string[] {
  try {
    const rungs = JSON.parse(setting(ctx, "model_ladder") || "[]") as unknown;
    return Array.isArray(rungs)
      ? rungs.flatMap((rung) => (rung && rung.runner === runner && typeof rung.config_dir === "string" ? [rung.config_dir as string] : []))
      : [];
  } catch {
    return [];
  }
}

/**
 * A config directory a request names for an account on a runner: null or "" for the daemon's own
 * environment, otherwise one of that runner's listed directories, kept as the list keeps it.
 */
export function listedAgentConfigDir(ctx: StoreContext, runner: BotRunner, value: unknown, field: string): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", `${field} must be a string or null`);
  const dir = normalizeConfigDir(value);
  const listed = dir ? agentConfigDirs(ctx, runner).find((kept) => sameConfigDir(kept, dir)) : undefined;
  if (!listed) throw new HttpError(422, "invalid_args", `${field} must be one of the ${AGENT_KINDS[runner].label} accounts listed in Settings`);
  return listed;
}

/** The ACP agents you named yourself, in the order you added them. */
export function customAgents(ctx: StoreContext): CustomAgent[] {
  const raw = setting(ctx, CUSTOM_KEY);
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const { id, name, command, args } = entry as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string" || typeof command !== "string") return [];
      return [{ id, name, command, args: Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [] }];
    });
  } catch {
    return [];
  }
}

export function customAgent(ctx: StoreContext, id: string | null | undefined): CustomAgent | null {
  if (!id) return null;
  return customAgents(ctx).find((agent) => agent.id === id) ?? null;
}

/**
 * The whole list, as Settings sends it: each with a name, an absolute command and its arguments; an
 * entry without an id is new and gets one. One a Bot, a built-in call or a ladder rung runs on
 * cannot be taken away (409), as for an account.
 */
export function setCustomAgents(ctx: StoreContext, value: unknown): CustomAgent[] {
  if (!Array.isArray(value)) throw new HttpError(422, "invalid_args", "agents must be a list");
  if (value.length > CUSTOM_AGENTS_MAX) throw new HttpError(422, "invalid_args", `at most ${CUSTOM_AGENTS_MAX} custom agents can be listed`);
  const known = new Map(customAgents(ctx).map((agent) => [agent.id, agent] as const));
  const agents: CustomAgent[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new HttpError(422, "invalid_args", "each agent must be { name, command, args }");
    const raw = entry as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || name.length > NAME_MAX) throw new HttpError(422, "invalid_args", `an agent's name must be 1–${NAME_MAX} characters`);
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!command || command.length > ARG_MAX || !/^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(command)) {
      throw new HttpError(422, "invalid_args", `${name}: the command must be an absolute path`);
    }
    const args = raw.args === undefined ? [] : raw.args;
    if (!Array.isArray(args) || args.length > ARGS_MAX || args.some((arg) => typeof arg !== "string" || arg.length > ARG_MAX)) {
      throw new HttpError(422, "invalid_args", `${name}: args must be a list of at most ${ARGS_MAX} strings`);
    }
    const id = typeof raw.id === "string" && known.has(raw.id) ? raw.id : ulid();
    if (agents.some((kept) => kept.name.toLowerCase() === name.toLowerCase())) throw new HttpError(422, "invalid_args", `two agents are named ${name}`);
    agents.push({ id, name, command, args: args as string[] });
  }
  for (const gone of [...known.values()].filter((agent) => !agents.some((kept) => kept.id === agent.id))) {
    const users = ctx.db
      .query<{ name: string }, [string]>("SELECT name FROM bots WHERE deleted_at IS NULL AND runner = 'custom' AND agent_custom_id = ? ORDER BY name COLLATE NOCASE")
      .all(gone.id)
      .map((row) => row.name);
    if (users.length > 0) throw new HttpError(409, "conflict", `${gone.name} runs ${users.join(", ")}: move ${users.length === 1 ? "that Bot" : "those Bots"} to another runner first`);
    for (const role of BUILTIN_MODEL_ROLES) {
      if (setting(ctx, `${role}_runner`) === "custom" && setting(ctx, `${role}_custom_id`) === gone.id) {
        throw new HttpError(409, "conflict", `${gone.name} runs the built-in call ${role}: choose another model for it first`);
      }
    }
    try {
      const rungs = JSON.parse(setting(ctx, "model_ladder") || "[]") as unknown;
      if (Array.isArray(rungs) && rungs.some((rung) => rung?.runner === "custom" && rung.custom_id === gone.id)) {
        throw new HttpError(409, "conflict", `${gone.name} is a rung on the model ladder: take that rung off first`);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
    }
  }
  setSetting(ctx, CUSTOM_KEY, agents.length > 0 ? JSON.stringify(agents) : "");
  return agents;
}

/** A custom agent id a request names for `runner: "custom"`: one you listed. */
export function listedCustomAgent(ctx: StoreContext, value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, "invalid_args", `${field} must name one of your custom agents`);
  const agent = customAgent(ctx, value.trim());
  if (!agent) throw new HttpError(422, "invalid_args", `${field} must name one of your custom agents`);
  return agent.id;
}
