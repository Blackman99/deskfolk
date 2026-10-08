/**
 * Your Claude plan's usage, asked of your own Claude Code (ADR 0061, 2026-10-08 addendum). A session
 * started without a prompt answers the Agent SDK's `get_usage` — the data behind Claude Code's
 * `/usage`, which Claude Code fetches from claude.ai itself — and is closed again: nothing goes to a
 * model and Deskfolk reads no credential. Asked only while some Bot runs on Claude Agent, and the
 * answer is kept for a while, so the sidebar and the menu bar asking every minute or so start at
 * most one `claude` per `CLAUDE_USAGE_MAX_AGE_MS`.
 *
 * The SDK marks the method experimental. Only the fields it types are read; a `claude` that does
 * not know the request, or answers in another shape, makes the meter say it could not ask.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeCodeStatus, ClaudeUsage, ClaudeUsageWindow } from "@real-bot/protocol";
import type { ClaudeCodeProbe } from "./probe";
import { withSystemProxy } from "./proxy";
import { claudeLaunch, killsTree } from "./spawn";
import { claudeChildEnv } from "./status";

/** How long an answer is kept before the next ask starts `claude` again. */
export const CLAUDE_USAGE_MAX_AGE_MS = 5 * 60_000;
/** A refresh you ask for still reuses an answer this young: a held-down button starts no swarm. */
export const CLAUDE_USAGE_REFRESH_MIN_MS = 30_000;
const ASK_TIMEOUT_MS = 30_000;

type Window = { utilization?: number | null; resets_at?: string | null } | null | undefined;

/** The part of `get_usage`'s answer read here. */
export type UsageAnswer = {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: Window;
    seven_day?: Window;
    seven_day_opus?: Window;
    seven_day_sonnet?: Window;
    model_scoped?: Array<{ display_name?: string; utilization?: number | null; resets_at?: string | null }>;
  } | null;
};

/** Starts `executable` without a prompt, asks it for its usage, and closes it. */
export type AskUsage = (launch: { executable: string; env: Record<string, string>; cwd: string }) => Promise<UsageAnswer>;

export type ClaudeUsageProbe = {
  /** The answer kept when younger than `maxAgeMs`, otherwise a fresh one. */
  current(maxAgeMs?: number): Promise<ClaudeUsage>;
};

export function createClaudeUsageProbe(deps: {
  claudeCode: ClaudeCodeProbe;
  /** Whether some Bot runs on Claude Agent; nothing is asked otherwise. */
  inUse: () => boolean;
  ask?: AskUsage;
  env?: Record<string, string | undefined>;
  now?: () => number;
}): ClaudeUsageProbe {
  const now = deps.now ?? Date.now;
  const ask = deps.ask ?? askWithSdk;
  let kept: { usage: ClaudeUsage; at: number } | null = null;
  /** The last answer with windows in it: a failed ask shows these, with its error. */
  let lastGood: ClaudeUsage | null = null;
  let inFlight: Promise<ClaudeUsage> | null = null;

  async function fresh(): Promise<ClaudeUsage> {
    const status = await deps.claudeCode.current();
    const blocked = blockedBy(status);
    if (blocked) return unavailable(blocked);
    try {
      const env = withSystemProxy(claudeChildEnv(deps.env ?? process.env), status);
      const answer = await ask({ executable: status.path!, env, cwd: tmpdir() });
      const usage = readUsage(answer, new Date(now()).toISOString());
      if (usage.available) lastGood = usage;
      return usage;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return lastGood ? { ...lastGood, error: message } : { ...unavailable("failed"), error: message };
    }
  }

  return {
    current(maxAgeMs = CLAUDE_USAGE_MAX_AGE_MS) {
      // Turning Claude Agent off for the last Bot stops the asking at once; nothing is kept for it.
      if (!deps.inUse()) return Promise.resolve(unavailable("unused"));
      if (kept && now() - kept.at < maxAgeMs) return Promise.resolve(kept.usage);
      inFlight ??= fresh()
        .then((usage) => {
          kept = { usage, at: now() };
          return usage;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/** What stops the asking before `claude` is started. */
function blockedBy(status: ClaudeCodeStatus): ClaudeUsage["reason"] {
  if (!status.path) return "missing";
  if (status.logged_in === false) return "signed_out";
  // Billed per token or by another platform: there is no plan with windows to read.
  if (status.auth_method && ["api_key", "api_key_helper", "third_party"].includes(status.auth_method)) return "no_plan";
  return null;
}

function unavailable(reason: NonNullable<ClaudeUsage["reason"]>): ClaudeUsage {
  return { available: false, reason, plan: null, windows: [], checked_at: null, error: null };
}

/** `get_usage`'s answer as the meter shows it: the plan's two windows, then each model's own. */
export function readUsage(answer: UsageAnswer, checkedAt: string): ClaudeUsage {
  const plan = typeof answer.subscription_type === "string" && answer.subscription_type.trim() ? answer.subscription_type.trim() : null;
  const limits = answer.rate_limits;
  if (answer.rate_limits_available !== true || !limits || typeof limits !== "object") {
    return { available: false, reason: "no_plan", plan, windows: [], checked_at: checkedAt, error: null };
  }
  const windows: ClaudeUsageWindow[] = [];
  const add = (kind: ClaudeUsageWindow["kind"], model: string | null, window: Window) => {
    const percent = window?.utilization;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return;
    if (model && windows.some((seen) => seen.model?.toLowerCase() === model.toLowerCase())) return;
    const resets = typeof window?.resets_at === "string" && !Number.isNaN(Date.parse(window.resets_at)) ? window.resets_at : null;
    windows.push({ kind, model, percent: Math.min(100, Math.max(0, percent)), resets_at: resets });
  };
  add("five_hour", null, limits.five_hour);
  add("seven_day", null, limits.seven_day);
  add("model", "Opus", limits.seven_day_opus);
  add("model", "Sonnet", limits.seven_day_sonnet);
  for (const row of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const name = typeof row?.display_name === "string" ? row.display_name.trim() : "";
    if (name) add("model", name, row);
  }
  if (windows.length === 0) return { available: false, reason: "no_plan", plan, windows, checked_at: checkedAt, error: null };
  return { available: true, reason: null, plan, windows, checked_at: checkedAt, error: null };
}

/** The real ask: the Agent SDK's session, loaded only when one is asked for, as a turn loads it. */
async function askWithSdk(launch: { executable: string; env: Record<string, string>; cwd: string }): Promise<UsageAnswer> {
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
    const answer = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`claude gave no usage within ${ASK_TIMEOUT_MS / 1000} s`)), ASK_TIMEOUT_MS);
    });
    return (await Promise.race([answer, late])) as UsageAnswer;
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

/** `claude`, through cmd.exe when it is npm's batch file; a stop takes what it started too. */
function spawnClaude(options: SpawnOptions): SpawnedProcess {
  const launch = claudeLaunch(options.command, options.args, options.env as Record<string, string>);
  const child = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatim,
  });
  killsTree(child);
  options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  return child as unknown as SpawnedProcess;
}
