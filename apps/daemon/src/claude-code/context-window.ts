/**
 * Authoritative context window size for a Claude Code model on an account, asked directly of your
 * own Claude Code via `getContextUsage({ detail: "summary" })` without sending a prompt or making
 * any API call. Cached per account and model so existing or imported sessions backfill their
 * progress ring without ever guessing a window size from a model name.
 */
import { tmpdir } from "node:os";
import { claudeControlContextWindow } from "../agents/agent-context";
import { CLAUDE_MODELS_MAX_AGE_MS, signedInAs } from "./models";
import type { ClaudeCodeProbe } from "./probe";
import { withSystemProxy } from "./proxy";
import { claudeChildEnv } from "./status";
import { spawnClaude } from "./usage";

const ASK_TIMEOUT_MS = 15_000;
/** Failed probes wait this long before trying `claude` again so clicking sessions never spams spawns. */
const FAIL_COOLDOWN_MS = 30_000;

/** Starts `executable` without a prompt, asks it for `model`'s context window, and closes it. */
export type AskContextWindow = (launch: { executable: string; env: Record<string, string>; cwd: string; model: string }) => Promise<number | null>;

export type ClaudeContextWindowProbe = {
  /** Cached authoritative window size if still fresh (`undefined` on cache miss, `null` on recent failure). */
  peek(configDir: string | null, model: string): number | null | undefined;
  /** Queries Claude Code (or returns the cached answer) for `model`'s context window under `configDir`. */
  windowOf(configDir: string | null, model: string): Promise<number | null>;
};

export function createClaudeContextWindowProbe(deps: {
  claudeCode: ClaudeCodeProbe;
  ask?: AskContextWindow;
  env?: Record<string, string | undefined>;
  now?: () => number;
}): ClaudeContextWindowProbe {
  const now = deps.now ?? Date.now;
  const ask = deps.ask ?? askWithSdk;
  const kept = new Map<string, { limit: number | null; at: number; who: string | null }>();
  const inFlight = new Map<string, Promise<number | null>>();

  function cachedOf(configDir: string | null, clean: string): number | null | undefined {
    const old = kept.get(`${configDir ?? ""}\0${clean}`);
    if (!old) return undefined;
    const who = signedInAs(deps.claudeCode.last(), configDir);
    const sameAccount = who === null || old.who === null || who === old.who;
    const ttl = old.limit !== null ? CLAUDE_MODELS_MAX_AGE_MS : FAIL_COOLDOWN_MS;
    if (sameAccount && now() - old.at < ttl) return old.limit;
    return undefined;
  }

  async function fresh(configDir: string | null, clean: string, key: string): Promise<number | null> {
    try {
      const status = await deps.claudeCode.current();
      if (!status.path) {
        kept.set(key, { limit: null, at: now(), who: null });
        return null;
      }
      const env = withSystemProxy(claudeChildEnv(deps.env ?? process.env, configDir), status);
      const limit = await ask({ executable: status.path, env, cwd: tmpdir(), model: clean });
      kept.set(key, { limit, at: now(), who: signedInAs(status, configDir) });
      return limit;
    } catch {
      kept.set(key, { limit: null, at: now(), who: null });
      return null;
    }
  }

  return {
    peek(configDir, model) {
      const clean = model.trim();
      if (!clean) return null;
      return cachedOf(configDir, clean);
    },
    windowOf(configDir, model) {
      const clean = model.trim();
      if (!clean) return Promise.resolve(null);
      const cached = cachedOf(configDir, clean);
      if (cached !== undefined) return Promise.resolve(cached);
      const key = `${configDir ?? ""}\0${clean}`;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const asking = fresh(configDir, clean, key).finally(() => inFlight.delete(key));
      inFlight.set(key, asking);
      return asking;
    },
  };
}

/** Asks Claude Code's local `getContextUsage({ detail: "summary" })` with no prompt and no session persistence. */
async function askWithSdk(launch: { executable: string; env: Record<string, string>; cwd: string; model: string }): Promise<number | null> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  let release = () => {};
  const idle = new Promise<void>((resolve) => (release = resolve));
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
      model: launch.model,
      abortController: abort,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`claude gave no context window within ${ASK_TIMEOUT_MS / 1000} s`)), ASK_TIMEOUT_MS);
      timer.unref?.();
    });
    const res = await Promise.race([session.getContextUsage({ detail: "summary" }), late]);
    return claudeControlContextWindow(res).limit;
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
