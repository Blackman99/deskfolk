/**
 * One reading (读句, ADR 0055) made by the user's own Claude Code instead of an endpoint's model
 * (ADR 0061): a single Agent SDK call with no tools, a system prompt of its own and one turn, on the
 * account the user picked. It answers with text, which the reader parses as it parses an endpoint's.
 * Never throws: what cannot be read says why, and the reader falls back to the word lists. The
 * other built-in calls run on it the same way when you chose a Claude model for them (ADR 0077),
 * pictures included: those go as image blocks of the one user message.
 *
 * Readings have their own two places: they never take a Bot's `AGENT_SLOTS`, and a reading that
 * waits for one is bound by the same time limit as one that runs. The other built-in calls get an
 * instance of their own, so a long settle never holds up a line's reading.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { ClaudeEffort } from "@real-bot/protocol";
import type { Options, Query, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import daemonPackage from "../../package.json";
import type { ClaudeCodeProbe } from "./probe";
import { withSystemProxy } from "./proxy";
import { claudeLaunch, killsTree } from "./spawn";
import { accountOf, claudeChildEnv } from "./status";

/** Claude readings running at once. */
export const CLAUDE_READING_SLOTS = 2;

/** Built-in calls running at once on the instance the readings do not use (ADR 0077). */
export const CLAUDE_BUILTIN_SLOTS = 3;

/**
 * Which model of Claude, on which of your accounts (null: the daemon's own environment), and how
 * hard it thinks (absent or null: Claude Code's own default; it lowers what a model cannot do).
 */
export type ClaudeReaderTarget = { kind: "claude_code"; model: string; configDir: string | null; effort?: ClaudeEffort | null };

/** A part of the one user message: text, or a picture as a data URI's base64. */
export type ClaudePromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } };

/** What a reading cost, as the result reports it. */
export type ClaudeReadingUsage = { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number };

export type ClaudeReadingAnswer = {
  content: string | null;
  usage: ClaudeReadingUsage | null;
  /** `claude_unavailable`: Claude Code is not installed or not signed in; `claude_failed`: it errored or said nothing. */
  fail: "claude_unavailable" | "claude_failed" | null;
};

export type ClaudeJudge = (input: { target: ClaudeReaderTarget; system: string; prompt: string | ClaudePromptBlock[]; signal: AbortSignal }) => Promise<ClaudeReadingAnswer>;

/** The Agent SDK's `query`, or a stand-in a test scripts. */
export type ReadingQuery = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => Pick<Query, "close"> & AsyncIterable<SDKMessage>;

/** Blocks as the one user message of a streamed prompt: the SDK takes pictures only that way. */
async function* asUserMessage(blocks: ClaudePromptBlock[]): AsyncIterable<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null } as SDKUserMessage;
}

export type ClaudeReadingDeps = {
  claudeCode: ClaudeCodeProbe | undefined;
  query?: ReadingQuery;
  spawnProcess?: (options: SpawnOptions) => SpawnedProcess;
  slots?: number;
};

async function loadQuery(): Promise<ReadingQuery> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return (params) => sdk.query(params);
}

/** `claude` in a process group of its own, so a timeout takes whatever it started too. */
function spawnReading(options: SpawnOptions): SpawnedProcess {
  const windows = process.platform === "win32";
  const launch = claudeLaunch(options.command, options.args, options.env as Record<string, string>);
  const child = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: !windows,
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatim,
  });
  killsTree(child);
  options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  return child as unknown as SpawnedProcess;
}

type ModelUsageRow = { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number };

/** A result's usage the way a Claude Agent turn's spend is read: cache reads and writes count as input. */
function usageOf(result: Extract<SDKMessage, { type: "result" }>): ClaudeReadingUsage {
  const rows = Object.values((result as { modelUsage?: Record<string, ModelUsageRow> }).modelUsage ?? {});
  if (rows.length > 0) {
    return rows.reduce<ClaudeReadingUsage>((sum, row) => ({
      inputTokens: sum.inputTokens + (row.inputTokens ?? 0) + (row.cacheReadInputTokens ?? 0) + (row.cacheCreationInputTokens ?? 0),
      outputTokens: sum.outputTokens + (row.outputTokens ?? 0),
      cachedTokens: sum.cachedTokens + (row.cacheReadInputTokens ?? 0),
      costUsd: sum.costUsd + (row.costUSD ?? 0),
    }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 });
  }
  const usage = result.usage;
  return {
    inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.cache_read_input_tokens ?? 0,
    costUsd: result.total_cost_usd ?? 0,
  };
}

export function createClaudeJudge(deps: ClaudeReadingDeps): ClaudeJudge {
  const limit = deps.slots ?? CLAUDE_READING_SLOTS;
  let running = 0;
  const waiting: Array<() => void> = [];

  /** A place to read in; false when the reading was given up while it waited. */
  async function slot(signal: AbortSignal): Promise<boolean> {
    while (running >= limit) {
      if (signal.aborted) return false;
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener("abort", wake);
          const at = waiting.indexOf(wake);
          if (at >= 0) waiting.splice(at, 1);
          resolve();
        };
        waiting.push(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    if (signal.aborted) return false;
    running += 1;
    return true;
  }
  function release(): void {
    running = Math.max(0, running - 1);
    waiting.shift()?.();
  }

  return async ({ target, system, prompt, signal }) => {
    const unavailable: ClaudeReadingAnswer = { content: null, usage: null, fail: "claude_unavailable" };
    const failed: ClaudeReadingAnswer = { content: null, usage: null, fail: "claude_failed" };
    let status;
    try {
      status = deps.claudeCode ? await deps.claudeCode.current() : null;
    } catch {
      return unavailable;
    }
    // As a Bot's turn is judged: the account it names, or the daemon's own when the status has none for it.
    if (!status?.path || (accountOf(status, target.configDir) ?? status).logged_in === false) return unavailable;
    if (!(await slot(signal))) return failed;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) abort.abort();
    let session: ReturnType<ReadingQuery> | null = null;
    try {
      const env = withSystemProxy(claudeChildEnv(process.env, target.configDir), status);
      env.CLAUDE_AGENT_SDK_CLIENT_APP = `deskfolk/${typeof daemonPackage.version === "string" ? daemonPackage.version : "dev"}`;
      const query = deps.query ?? (await loadQuery());
      session = query({
        // Text alone goes as it always has; blocks (pictures) as one streamed user message.
        prompt: typeof prompt === "string" ? prompt : asUserMessage(prompt),
        options: {
          pathToClaudeCodeExecutable: status.path,
          spawnClaudeCodeProcess: deps.spawnProcess ?? spawnReading,
          cwd: tmpdir(),
          env,
          model: target.model,
          ...(target.effort ? { effort: target.effort } : {}),
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          tools: [],
          // Replaces Claude Code's own prompt: the reading is asked as an endpoint's model is.
          systemPrompt: system,
          maxTurns: 1,
          permissionMode: "default",
          abortController: abort,
        },
      });
      let answer: ClaudeReadingAnswer = failed;
      for await (const message of session) {
        if (message.type !== "result") continue;
        const usage = usageOf(message);
        answer = message.subtype === "success" && !message.is_error && typeof message.result === "string" && message.result.trim()
          ? { content: message.result, usage, fail: null }
          : { content: null, usage, fail: "claude_failed" };
      }
      return answer;
    } catch {
      return failed;
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        session?.close();
      } catch {
        // already over
      }
      abort.abort();
      release();
    }
  };
}
