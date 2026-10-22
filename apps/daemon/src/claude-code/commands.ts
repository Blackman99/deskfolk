/**
 * The slash commands Claude Code offers in a project session (ADR 0098), as its own `/` lists them:
 * a session started without a prompt in the session's directory, reading your settings as a run
 * does, answers the Agent SDK's `supportedCommands` and is closed again — nothing goes to a model.
 * The list is the account's (its skills and plugins) and the directory's (the project's own
 * commands and skills), so each pair is asked on its own and the answer kept for a while, as the
 * models are (`models.ts`).
 */
import type { ClaudeCodeCommand, ClaudeCodeCommandList } from "@real-bot/protocol";
import type { ClaudeCodeProbe } from "./probe";
import { withSystemProxy } from "./proxy";
import { claudeChildEnv } from "./status";
import { spawnClaude } from "./usage";

/** How long a pair's list is kept before the next ask starts `claude` again. */
export const CLAUDE_COMMANDS_MAX_AGE_MS = 10 * 60_000;
const ASK_TIMEOUT_MS = 30_000;

/**
 * Left out of the list. The terminal's own (Claude Code marks them for its phone and remote
 * clients); the ones the app has its own control for — the model and thinking level in the
 * composer's picker, the name in the sidebar — which would change Claude Code behind the picker's
 * back; and its internal ones, named with `__`. Typed, each still goes to Claude Code.
 */
const LEFT_OUT = new Set(["doctor", "color", "focus", "reload-plugins", "model", "effort", "rename"]);

/** The part of the SDK's `SlashCommand` read here. */
export type CommandAnswer = Array<{ name?: unknown; description?: unknown; argumentHint?: unknown; aliases?: unknown }>;

/** Starts `executable` without a prompt in `cwd`, asks it for its commands, and closes it. */
export type AskCommands = (launch: { executable: string; env: Record<string, string>; cwd: string }) => Promise<CommandAnswer>;

export type ClaudeCommandList = {
  /** The commands of an account (null: the daemon's own environment) in a directory, kept while younger than `CLAUDE_COMMANDS_MAX_AGE_MS`. */
  list(configDir: string | null, dir: string): Promise<ClaudeCodeCommandList>;
};

/** Each name once, as Claude Code runs it: the first row with a name wins, as its own `/name` does. */
export function readCommands(answer: CommandAnswer): ClaudeCodeCommand[] {
  const commands = new Map<string, ClaudeCodeCommand>();
  for (const row of Array.isArray(answer) ? answer : []) {
    const name = typeof row?.name === "string" ? row.name.trim().replace(/^\//, "") : "";
    if (!name || name.startsWith("__") || LEFT_OUT.has(name) || commands.has(name)) continue;
    commands.set(name, {
      name,
      description: typeof row.description === "string" ? row.description.trim() : "",
      argument_hint: typeof row.argumentHint === "string" ? row.argumentHint.trim() : "",
      aliases: Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0) : [],
    });
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createClaudeCommandList(deps: {
  claudeCode: ClaudeCodeProbe;
  ask?: AskCommands;
  env?: Record<string, string | undefined>;
  now?: () => number;
}): ClaudeCommandList {
  const now = deps.now ?? Date.now;
  const ask = deps.ask ?? askWithSdk;
  const kept = new Map<string, { list: ClaudeCodeCommandList; at: number }>();
  const inFlight = new Map<string, Promise<ClaudeCodeCommandList>>();

  async function fresh(configDir: string | null, dir: string, key: string): Promise<ClaudeCodeCommandList> {
    const checkedAt = () => new Date(now()).toISOString();
    try {
      const status = await deps.claudeCode.current();
      if (!status.path) return { commands: [], checked_at: checkedAt(), error: "claude_not_found" };
      const env = withSystemProxy(claudeChildEnv(deps.env ?? process.env, configDir), status);
      const commands = readCommands(await ask({ executable: status.path, env, cwd: dir }));
      const list = { commands, checked_at: checkedAt(), error: commands.length ? null : "no_commands" };
      if (commands.length) kept.set(key, { list, at: now() });
      return list;
    } catch (error) {
      // A list asked for before still serves, with what went wrong this time.
      const message = error instanceof Error ? error.message : String(error);
      const old = kept.get(key);
      return old ? { ...old.list, error: message } : { commands: [], checked_at: checkedAt(), error: message };
    }
  }

  return {
    list(configDir, dir) {
      const key = `${configDir ?? ""}\n${dir}`;
      const old = kept.get(key);
      if (old && now() - old.at < CLAUDE_COMMANDS_MAX_AGE_MS) return Promise.resolve(old.list);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const asking = fresh(configDir, dir, key).finally(() => inFlight.delete(key));
      inFlight.set(key, asking);
      return asking;
    },
  };
}

/** The real ask: the Agent SDK's session, loaded only when one is asked for, as a run loads it. */
async function askWithSdk(launch: { executable: string; env: Record<string, string>; cwd: string }): Promise<CommandAnswer> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  let release = () => {};
  const idle = new Promise<void>((resolve) => (release = resolve));
  // The prompt never comes: the session only answers control requests until it is closed.
  async function* noPrompt(): AsyncGenerator<never> {
    await idle;
  }
  const abort = new AbortController();
  const session = sdk.query({
    prompt: noPrompt(),
    options: {
      pathToClaudeCodeExecutable: launch.executable,
      spawnClaudeCodeProcess: spawnClaude,
      cwd: launch.cwd,
      env: { ...launch.env, CLAUDE_AGENT_SDK_CLIENT_APP: "deskfolk" },
      // Your settings, as a run reads them: they bring the skills, plugins and the project's commands.
      settingSources: ["user", "project", "local"],
      strictMcpConfig: true,
      persistSession: false,
      tools: [],
      abortController: abort,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`claude gave no commands within ${ASK_TIMEOUT_MS / 1000} s`)), ASK_TIMEOUT_MS);
    });
    return (await Promise.race([session.supportedCommands(), late])) as CommandAnswer;
  } finally {
    clearTimeout(timer);
    release();
    try {
      session.close();
    } catch {
      // already over
    }
    abort.abort();
  }
}
