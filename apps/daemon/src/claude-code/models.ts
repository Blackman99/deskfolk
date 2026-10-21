/**
 * The models your Claude Code offers, per account, as its own `/model` lists them (ADR 0095): a
 * session started without a prompt answers the Agent SDK's `supportedModels` and is closed again,
 * as the usage probe does (`usage.ts`) — nothing goes to a model. The list is the account's (a plan
 * offers what it offers), so each account is asked on its own and the answer kept for a while: a
 * project session's composer opening asks at most once per `CLAUDE_MODELS_MAX_AGE_MS`.
 */
import { tmpdir } from "node:os";
import { isClaudeEffort, type ClaudeCodeModel, type ClaudeCodeModelList } from "@real-bot/protocol";
import type { ClaudeCodeProbe } from "./probe";
import { withSystemProxy } from "./proxy";
import { claudeChildEnv } from "./status";
import { spawnClaude } from "./usage";

/** How long an account's list is kept before the next ask starts `claude` again. */
export const CLAUDE_MODELS_MAX_AGE_MS = 10 * 60_000;
const ASK_TIMEOUT_MS = 30_000;

/** The part of the SDK's `ModelInfo` read here. */
export type ModelAnswer = Array<{
  value?: unknown;
  displayName?: unknown;
  description?: unknown;
  resolvedModel?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
}>;

/** Starts `executable` without a prompt, asks it for its models, and closes it. */
export type AskModels = (launch: { executable: string; env: Record<string, string>; cwd: string }) => Promise<ModelAnswer>;

export type ClaudeModelList = {
  /** The account's list, kept while younger than `CLAUDE_MODELS_MAX_AGE_MS`; null is the daemon's own environment. */
  list(configDir: string | null): Promise<ClaudeCodeModelList>;
};

export function readModels(answer: ModelAnswer): ClaudeCodeModel[] {
  const models: ClaudeCodeModel[] = [];
  for (const row of Array.isArray(answer) ? answer : []) {
    if (typeof row?.value !== "string" || !row.value.trim()) continue;
    const efforts = row.supportsEffort === false || !Array.isArray(row.supportedEffortLevels) ? [] : row.supportedEffortLevels.filter(isClaudeEffort);
    models.push({
      value: row.value,
      display_name: typeof row.displayName === "string" && row.displayName.trim() ? row.displayName : row.value,
      description: typeof row.description === "string" ? row.description : "",
      resolved_model: typeof row.resolvedModel === "string" && row.resolvedModel ? row.resolvedModel : null,
      efforts,
    });
  }
  return models;
}

export function createClaudeModelList(deps: {
  claudeCode: ClaudeCodeProbe;
  ask?: AskModels;
  env?: Record<string, string | undefined>;
  now?: () => number;
}): ClaudeModelList {
  const now = deps.now ?? Date.now;
  const ask = deps.ask ?? askWithSdk;
  const kept = new Map<string, { list: ClaudeCodeModelList; at: number }>();
  const inFlight = new Map<string, Promise<ClaudeCodeModelList>>();

  async function fresh(configDir: string | null, key: string): Promise<ClaudeCodeModelList> {
    const checkedAt = () => new Date(now()).toISOString();
    try {
      const status = await deps.claudeCode.current();
      if (!status.path) return { config_dir: configDir, models: [], checked_at: checkedAt(), error: "claude_not_found" };
      const env = withSystemProxy(claudeChildEnv(deps.env ?? process.env, configDir), status);
      const models = readModels(await ask({ executable: status.path, env, cwd: tmpdir() }));
      const list = { config_dir: configDir, models, checked_at: checkedAt(), error: models.length ? null : "no_models" };
      if (models.length) kept.set(key, { list, at: now() });
      return list;
    } catch (error) {
      // A list asked for before still serves, with what went wrong this time.
      const message = error instanceof Error ? error.message : String(error);
      const old = kept.get(key);
      return old ? { ...old.list, error: message } : { config_dir: configDir, models: [], checked_at: checkedAt(), error: message };
    }
  }

  return {
    list(configDir) {
      const key = configDir ?? "";
      const old = kept.get(key);
      if (old && now() - old.at < CLAUDE_MODELS_MAX_AGE_MS) return Promise.resolve(old.list);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const asking = fresh(configDir, key).finally(() => inFlight.delete(key));
      inFlight.set(key, asking);
      return asking;
    },
  };
}

/** The real ask: the Agent SDK's session, loaded only when one is asked for, as a turn loads it. */
async function askWithSdk(launch: { executable: string; env: Record<string, string>; cwd: string }): Promise<ModelAnswer> {
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
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      tools: [],
      abortController: abort,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`claude gave no models within ${ASK_TIMEOUT_MS / 1000} s`)), ASK_TIMEOUT_MS);
    });
    return (await Promise.race([session.supportedModels(), late])) as ModelAnswer;
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
