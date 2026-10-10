/**
 * A local agent other than Claude Code, as the app drives it (ADR 0079). A driver speaks one
 * protocol — the Agent Client Protocol, Codex's app-server, `agy`'s print mode — and turns what the
 * agent does into the few things the app keeps for every turn: what it said, which of its own tools
 * it ran and with what effect, what it cost, how it ended. Everything else a turn has — the
 * workspace boundary and your approvals, holds and Stop, the effect ledger, the app's tools, the
 * closing reply and its bounces — is the runner's (`external-runner.ts`), the same for every driver
 * and the same as a Claude Agent turn's.
 */
import type { ChildProcess } from "node:child_process";
import type { BotRunner, CustomAgent } from "@real-bot/protocol";
import type { AgentInputPart } from "../../context";
import type { FailKind } from "../../prompts";
import type { AgentTool } from "../agent-runner";
import type { AppAction } from "./policy";

/** How one prompt of the agent's ended. */
export type AgentResult =
  /** It answered: its last words (the reply), possibly empty. */
  | { kind: "reply"; text: string }
  /** It stopped because the app asked it to (insert-now, a tool that ended the segment, Stop). */
  | { kind: "cancelled" }
  | { kind: "error"; failKind: FailKind; detail: string | null };

export type AgentEvent =
  /** The model it reports running on. */
  | { type: "model"; model: string }
  /** One step of the model: what it said in it (beside any calls), and the calls it made, by the app's names. */
  | { type: "hop"; id: string; text: string; calls: Array<{ id: string; name: string; arguments: string }> }
  /** The words of the step in progress, for the bubble while it works. */
  | { type: "partial"; text: string }
  /**
   * One of its own tools began. `gated`: the app already decided on it (a permission it asked for,
   * a file or command it had the app run): only calls the app never saw are checked here.
   */
  | { type: "tool_started"; callId: string; action: AppAction; gated: boolean }
  | { type: "tool_finished"; callId: string; action: AppAction; gated: boolean; ok: boolean; output: string; exitCode?: number | null }
  /**
   * What a model call cost. `cumulative`: the totals so far in this session (a delta is taken);
   * otherwise this call's own. Tokens it does not report are 0; `costUsd` null when it says no price.
   */
  | { type: "usage"; model: string; input: number; output: number; cached: number; costUsd: number | null; cumulative: boolean }
  /** Its plan's limit stopped a request, and when it resets (null: it did not say). */
  | { type: "limit"; reset: string | null }
  /** The prompt in progress ended. */
  | { type: "result"; result: AgentResult };

/** What the app decided about a call the agent asked about, or had the app carry out. */
export type GateAnswer = { kind: "allow"; note?: string } | { kind: "deny"; reason: string };

/** A command the app runs for the agent (ACP `terminal/*`): its output so far, and how it ended. */
export type AppTerminal = {
  output(): { output: string; truncated: boolean; exitCode: number | null; signal: string | null; done: boolean };
  waitForExit(): Promise<{ exitCode: number | null; signal: string | null }>;
  kill(): void;
};

/** What a driver is given: the turn's settings, and the app's side of every protocol. */
export type AgentHost = {
  turnId: string;
  runner: BotRunner;
  /** For `runner: "custom"`, which of your agents. */
  custom: CustomAgent | null;
  /** The command found for the runner (an absolute path), and the arguments its launch starts with. */
  executable: string;
  launchArgs: string[];
  /** The daemon's environment for the agent: nested-session markers off, the account's directory and the system proxy on. */
  env: Record<string, string>;
  /** Workspace root and this turn's directory (absolute). */
  workspace: string;
  cwd: string;
  mode: "work" | "desk" | "readonly";
  locale: "zh" | "en";
  model: string | null;
  effort: string | null;
  /** The app's instructions for the Bot, whole: preface, profile, skills, system text, memories. */
  instructions: string;
  /** The app's own tools (end_turn, submit, ask_user, …) and how to call one. */
  tools: AgentTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Mounts the app's tools as an MCP server the agent connects to: over HTTP, or the daemon's stdio shim. */
  mountMcp(transport: "http" | "stdio"): { url: string; headers: Record<string, string> } | { command: string; args: string[]; env: Record<string, string> };
  /** The app's rules for a call the agent asks about (or has the app carry out): a card when it crosses out. */
  gate(callId: string, action: AppAction): Promise<GateAnswer>;
  /** Carry out what was let through: the app reads, writes and runs for agents that ask it to (ACP `fs/*`, `terminal/*`). */
  readFile(path: string, line?: number | null, limit?: number | null): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  runCommand(command: string, args: string[], options: { cwd: string; env: Record<string, string>; outputByteLimit: number | null }): AppTerminal;
  /** Starts the agent's process: in a process group of its own, on the record, killed with its tree. */
  spawn(command: string, args: string[], options: { cwd: string; env: Record<string, string> }): ChildProcess;
  /** Everything the agent reports, in order; awaited, so the app's bookkeeping keeps pace. */
  emit(event: AgentEvent): Promise<void>;
  stderr(chunk: string): void;
  signal: AbortSignal;
};

/** A running session of the agent: one per segment of a turn. */
export type AgentSession = {
  /** The next thing it reads: the first message, a bounce, lines heard. Queued until the prompt in progress ends. */
  prompt(input: AgentInputPart[]): void;
  /** Stop the step in progress (insert-now, a tool ended the segment); a `cancelled` result follows. */
  cancel(): Promise<boolean>;
  /** Add lines to the step in progress without stopping it, where the agent can (Codex `turn/steer`). */
  steer?(input: AgentInputPart[]): Promise<boolean>;
  close(): void;
  /** Settles when the agent's process is gone. */
  done: Promise<void>;
};

export type DriverCaps = {
  /** Lines said meanwhile reach it mid-step (`steer`), or wait for the next prompt (`hold`). */
  midTurn: "steer" | "hold";
  /** Insert-now can cut a step short. */
  sendNow: boolean;
  /** The app's own tools reach it. */
  appTools: boolean;
  /** The app reads, writes and runs for it (ACP `fs/*`, `terminal/*`): those names go back on the turn. */
  appRunsFiles: boolean;
};

export type AgentDriver = {
  caps: DriverCaps;
  /** How the agent reaches the app's tools, said in the preface when it is not by their names (ADR 0079). */
  toolHint?: { zh: string; en: string };
  start(host: AgentHost, first: AgentInputPart[]): Promise<AgentSession>;
};
