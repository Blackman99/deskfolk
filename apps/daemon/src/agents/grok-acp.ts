/**
 * Your Grok (`grok agent --no-leader stdio`, ADR 0115) for what the app asks of it besides a run:
 * starting it where a run would, the protocol's `initialize`, a short-lived server for a question
 * nothing goes to a model for (listing or reading your sessions, the `/` commands), and the folders
 * of its own a session may use.
 *
 * Measured on 1.0.89 (2026-11-18): `initialize` names the hooks a client may register
 * (`_meta["x.ai/hooks"].blockingEvents`, `pre_tool_use` among them) and the `/` commands it offers
 * before any session (`_meta.availableCommands`); a session lives under `$GROK_HOME/sessions/<the
 * directory, URL-encoded>/<session>/`, where its plan (`plan.md`) is written.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeCodeCommand } from "@real-bot/protocol";
import daemonPackage from "../../package.json";
import { claudeLaunch } from "../claude-code/spawn";
import { rpcPeer, type RpcPeer } from "../engine/agent/jsonrpc";
import { acpCommandsOf } from "../project-acp";
import type { Store } from "../store";
import { resolveAgent, type ResolvedAgent } from "./runtime";

export const GROK_ASK_TIMEOUT_MS = 30_000;

/** The callback id the app registers its tool hook under. */
export const GROK_HOOK_ID = "deskfolk";
/** How long Grok holds a call for the hook's answer; it runs the call when this passes (fail open). */
export const GROK_HOOK_TIMEOUT_S = 600;

/** What `initialize` answers that the app reads. */
export type GrokCapabilities = {
  list: boolean;
  load: boolean;
  resume: boolean;
  image: boolean;
  /** It runs a client's hook before each tool call (`pre_tool_use`): the app's permission gate. */
  hooks: boolean;
  /** The `/` commands it offers before any session is opened. */
  commands: ClaudeCodeCommand[];
};

/**
 * The protocol's handshake. The client offers no file system and no terminal: Grok uses its own
 * tools, as in its terminal, and the app holds each call before it runs through the hook it
 * registers on every session (`grokHooks`). It offers forms, for an MCP server's questions.
 */
export async function initializeGrok(rpc: RpcPeer, timeoutMs = GROK_ASK_TIMEOUT_MS): Promise<GrokCapabilities> {
  type Answer = {
    agentCapabilities?: {
      loadSession?: boolean;
      sessionCapabilities?: Record<string, unknown>;
      promptCapabilities?: { image?: boolean };
      _meta?: { "x.ai/hooks"?: { blockingEvents?: unknown } };
    };
    _meta?: { availableCommands?: unknown };
  };
  const answer = await rpc.request<Answer>("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
    clientInfo: { name: "deskfolk", title: "Deskfolk", version: typeof daemonPackage.version === "string" ? daemonPackage.version : "dev" },
  }, timeoutMs);
  const caps = answer?.agentCapabilities ?? {};
  const session = caps.sessionCapabilities ?? {};
  const blocking = caps._meta?.["x.ai/hooks"]?.blockingEvents;
  return {
    list: "list" in session,
    load: caps.loadSession === true || "load" in session,
    resume: "resume" in session,
    image: caps.promptCapabilities?.image === true,
    hooks: Array.isArray(blocking) && blocking.includes("pre_tool_use"),
    commands: grokCommandsOf(answer?._meta?.availableCommands),
  };
}

/**
 * The `/` commands as a project session offers them. Left out: `always-approve` (the app's
 * permission mode decides, not Grok's), and those that keep Grok working after its reply on a
 * schedule of their own (`loop`, `goal`, `workflow`): a run's Grok ends with the run, so they
 * would stop without a word (ADR 0115).
 */
export const GROK_HIDDEN_COMMANDS = new Set(["always-approve", "loop", "goal", "workflow"]);

export function grokCommandsOf(listed: unknown): ClaudeCodeCommand[] {
  return acpCommandsOf(listed).filter((command) => !GROK_HIDDEN_COMMANDS.has(command.name));
}

/** The Grok a project session starts on an account (null: the daemon's own `~/.grok`), found as a Bot's is. */
export function projectGrokOf(store: Store): (configDir: string | null) => Promise<ResolvedAgent> {
  return (configDir) => resolveAgent({ runner: "grok", custom: null, setting: store.agentPath("grok"), configDir });
}

/** An account's Grok home: its `GROK_HOME`, or `~/.grok` for the default one. */
export function grokHome(configDir: string | null, home = homedir()): string {
  return configDir ?? join(home, ".grok");
}

/** Where Grok keeps one session: its plan, its notes and its background commands' output. */
export function grokSessionDir(configDir: string | null, cwd: string, sessionId: string, home = homedir()): string {
  return join(grokHome(configDir, home), "sessions", encodeURIComponent(cwd), sessionId);
}

/**
 * Grok's own folders a session may use as any folder outside the project (ADR 0115, as Codex's
 * memories and skills are): the session's own folder (its plan), your skills, agents and plugins,
 * its memory, and the scripts its background-task skill keeps. Its sign-in (`auth.json`), its
 * config and every other session stay shut.
 */
export function grokOpenDirs(configDir: string | null, sessionDirs: string[], home = homedir()): string[] {
  const base = grokHome(configDir, home);
  return [...sessionDirs, ...["skills", "agents", "plugins", "memory-v2", "bundled", "long-running-background-tasks"].map((name) => join(base, name))];
}

/** The hook registration every session of a run carries (`session/new`, `resume`, `load`): every call, before it runs. */
export function grokHooks(): Record<string, unknown> {
  return { "x.ai/hooks": { pre_tool_use: [{ matcher: "*", hookCallbackIds: [GROK_HOOK_ID], timeout: GROK_HOOK_TIMEOUT_S }] } };
}

/** Starts Grok in `dir`, initializes it, runs `ask` on it, and ends it, however `ask` ends. */
export async function withGrokAcp<T>(grok: Extract<ResolvedAgent, { ok: true }>, dir: string, ask: (rpc: RpcPeer, caps: GrokCapabilities) => Promise<T>, timeoutMs = GROK_ASK_TIMEOUT_MS): Promise<T> {
  const launch = claudeLaunch(grok.executable, grok.args, grok.env);
  const child = spawn(launch.command, launch.args, { cwd: dir, env: grok.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.verbatim });
  const rpc = rpcPeer(child.stdout, child.stdin, { jsonrpc: true });
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("grok exited before it answered")));
  });
  // Its exit after the answer, when it is ended below, is nobody's failure.
  exited.catch(() => undefined);
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  try {
    return await Promise.race([(async () => ask(rpc, await initializeGrok(rpc, timeoutMs)))(), exited]);
  } finally {
    clearTimeout(timer);
    rpc.close();
    child.kill("SIGTERM");
  }
}

/** One stored update of a session, as `_x.ai/session/updates` answers it: when it was written, and the update. */
export type GrokRecord = { timestamp?: number; timestamp_us?: number; method?: string; params?: { sessionId?: string; update?: Record<string, unknown> } };

/** A session's stored updates, oldest first, asked without loading it; empty when Grok has none. */
export async function grokUpdates(rpc: RpcPeer, sessionId: string, cwd: string, timeoutMs = GROK_ASK_TIMEOUT_MS): Promise<GrokRecord[]> {
  const answer = await rpc.request<{ updates?: GrokRecord[]; result?: { updates?: GrokRecord[] } }>("_x.ai/session/updates", { sessionId, cwd }, timeoutMs);
  const updates = answer?.updates ?? answer?.result?.updates;
  return Array.isArray(updates) ? updates : [];
}

/** A record's time in ms: its microseconds when written, else its seconds. */
export function recordMs(record: GrokRecord): number | null {
  if (typeof record.timestamp_us === "number") return Math.floor(record.timestamp_us / 1000);
  if (typeof record.timestamp === "number") return record.timestamp * 1000;
  return null;
}

/**
 * What typing `/` offers in a Grok session (ADR 0115): what a run in the directory last heard
 * (`available_commands_update`), else what a short-lived Grok offers there before any session.
 */
export async function grokCommandList(
  resolve: (configDir: string | null) => Promise<ResolvedAgent>,
  memory: { get(dir: string): ClaudeCodeCommand[] | null; set(dir: string, commands: ClaudeCodeCommand[]): void },
  dir: string,
  configDir: string | null,
): Promise<{ commands: ClaudeCodeCommand[]; checked_at: string; error: string | null }> {
  const checked_at = new Date().toISOString();
  const kept = memory.get(dir);
  if (kept) return { commands: kept, checked_at, error: null };
  const grok = await resolve(configDir);
  if (!grok.ok) return { commands: [], checked_at, error: grok.error };
  try {
    const commands = await withGrokAcp(grok, dir, async (_rpc, caps) => caps.commands);
    memory.set(dir, commands);
    return { commands, checked_at, error: null };
  } catch (error) {
    return { commands: [], checked_at, error: error instanceof Error ? error.message : String(error) };
  }
}
