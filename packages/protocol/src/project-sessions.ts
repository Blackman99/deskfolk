/**
 * Project sessions (ADR 0095): you and a local agent in a directory, as in the agents' own desktop
 * apps, with no Bot. The app keeps permissions, the model, the thinking level and Stop; each run
 * of the agent is an `AgentRun`.
 */
import type { ClaudeEffort } from "./bots.ts";

/** The agents a project session can run, in the order a new session offers them (ADR 0095, ADR 0099). */
export const PROJECT_AGENTS = ["claude_code", "codex"] as const;
export type ProjectAgent = (typeof PROJECT_AGENTS)[number];

export function isProjectAgent(value: unknown): value is ProjectAgent {
  return typeof value === "string" && (PROJECT_AGENTS as readonly string[]).includes(value);
}

/**
 * What each agent's project sessions have beyond a conversation in a directory with permissions
 * and Stop (ADR 0099): plan mode (ADR 0098), the `/` list of its commands, a choice of your
 * accounts, carrying on a terminal session, and a replay for the task map. What one lacks the
 * windows leave out and the routes refuse (422).
 */
export type ProjectAgentCaps = { plan: boolean; commands: boolean; accounts: boolean; importable: boolean; replay: boolean };

export const PROJECT_AGENT_CAPS: Record<ProjectAgent, ProjectAgentCaps> = {
  claude_code: { plan: true, commands: true, accounts: true, importable: true, replay: true },
  codex: { plan: false, commands: false, accounts: false, importable: false, replay: false },
};

export type AgentRunStatus = "running" | "waiting_approval" | "completed" | "failed" | "stopped" | "interrupted";

/**
 * What a run waits on you for under ask first: the same kinds as a Bot's approval card. In plan
 * mode (ADR 0098) it can also be the plan Claude Code asks you to approve: `kind_key` is
 * `PLAN_APPROVAL_KIND`, `summary` the plan as markdown, `target` the file it is saved in.
 */
export type AgentRunApproval = { kind_key: string; target: string; summary: string };

/** The approval kind of a plan Claude Code presents in plan mode (ADR 0098). */
export const PLAN_APPROVAL_KIND = "plan";

/**
 * The mode a project session's runs start Claude Code in (ADR 0098): `plan` is its plan mode — it
 * looks around, writes a plan and asks you to approve it before it changes anything. Null on the
 * session is as usual.
 */
export type ProjectAgentMode = "plan";

export function isProjectAgentMode(value: unknown): value is ProjectAgentMode {
  return value === "plan";
}

export type AgentRun = {
  id: string;
  session_id: string;
  status: AgentRunStatus;
  /** What it is doing now, as one line ("Bash npm test"); null between steps. */
  activity: string | null;
  /** What it has said so far in this run, before its reply. */
  partial: string | null;
  approval: AgentRunApproval | null;
  /** Why it failed, in the agent's own words where it gave any. */
  error: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * `POST /v1/project-sessions`: a new session in `dir`, or, with `import`, one carrying on a
 * terminal session (its directory is the session's own; `dir` is then ignored).
 */
/**
 * What a project session's runs ask the agent for (ADR 0095), each from its next step on; a key
 * left out stays as it is, null goes back to the agent's own default (your settings).
 */
export type PatchProjectSessionRequest = {
  /** An alias or a full id, as the agent names it. */
  model?: string | null;
  /** One of the levels the session's agent takes (`AGENT_KINDS[agent].efforts`). */
  effort?: ClaudeEffort | null;
  /** Plan mode on (`plan`) or off (null), from the run's next step on (ADR 0098). Claude Code only. */
  mode?: ProjectAgentMode | null;
  /**
   * The Claude account its next run spends: one listed in Settings, null for the daemon's own. The
   * session is carried to that account first; refused (409) while a run is going on. Claude Code only.
   */
  config_dir?: string | null;
};

export type CreateProjectSessionRequest = {
  /** Claude Code when left out. */
  agent?: ProjectAgent;
  dir?: string;
  /** The Claude account directory; omitted or null is the daemon's own environment. Claude Code only. */
  config_dir?: string | null;
  /** A terminal session to carry on: Claude Code only (`PROJECT_AGENT_CAPS`). */
  import?: { session_id: string; config_dir?: string | null };
};

/** One slash command Claude Code offers in a project session's directory (ADR 0098), as its own `/` lists it. */
export type ClaudeCodeCommand = {
  /** Without the slash: `compact`, `review`, a skill's `pdf`, a plugin's `plugin:command`. */
  name: string;
  description: string;
  /** What it takes after its name (`<file>`); empty when it takes nothing. */
  argument_hint: string;
  /** Other names that run it. */
  aliases: string[];
};

/**
 * `GET /v1/project-sessions/:id/commands`: what typing `/` offers in the session (ADR 0098), the
 * account's and the directory's own commands and skills; empty with `error` set when Claude Code
 * could not be asked.
 */
export type ClaudeCodeCommandList = {
  commands: ClaudeCodeCommand[];
  checked_at: string;
  error: string | null;
};

/**
 * `GET /v1/project-sessions/:id/locate?path=`: where a path the agent cites is on this computer
 * (ADR 0095). `path` is absolute, or null when nothing matches or the closest matches are several;
 * `matches` are what a lookup by name found, relative to the project directory (empty when the
 * path was there as written).
 */
export type ProjectPathLookup = {
  path: string | null;
  kind: "file" | "dir" | null;
  matches: string[];
};

/**
 * Where a tool call of a project session's agent works (ADR 0095), for the task map: a path
 * relative to the project directory (`""` its root), a path outside it — Claude Code's own files
 * under `~/.claude*` apart — or, for a shell command, a test or type check, or git; an MCP tool
 * works at its server, by the server's name. `none` for a call that names no place (a subagent, a
 * question, a to-do list).
 */
export type AgentToolPlace =
  | { zone: "project"; path: string }
  | { zone: "outside"; path: string }
  | { zone: "claude_home"; path: string }
  | { zone: "check"; check: "test" | "typecheck" }
  | { zone: "git" }
  | { zone: "service"; server: string }
  | { zone: "none" };

/** What a shell command did, read from its words; the command itself is never carried. */
export type AgentShellAction = "check" | "git" | "write" | "search" | "read" | "script" | "run";

/**
 * Rides a `ToolFrame` for a project session's run (ADR 0095): the frame's `turn_id` is then the
 * run's id. A frame of its own would drop the link of a window or phone older than this, which
 * reads any frame it does not know as a broken event stream; this one they read as a tool frame of
 * a turn they do not show.
 */
export type AgentRunToolInfo = {
  session_id: string;
  /** The subagent that made the call; null for the agent itself. */
  agent_id: string | null;
  place: AgentToolPlace;
  action?: AgentShellAction;
  /** The model that made the call (`claude-opus-5-5`); null when it is not known yet. */
  model: string | null;
  at: string;
  /** On `exited`: whether the call succeeded. */
  ok?: boolean;
};

export type AgentReplayDecision = { decision: string; source: string | null; reason_type: string | null };

/** One tool call, read back from the agent's own session files (`GET /v1/project-sessions/:id/replay`). */
export type AgentReplayCall = {
  /** The tool call's id (`toolu_…`). */
  id: string;
  at: string;
  agent_id: string | null;
  tool: string;
  place: AgentToolPlace;
  action?: AgentShellAction;
  /** The model that made the call, as its message names it; null when none does. */
  model: string | null;
  /** The file it names, its last name only; null when it names none. */
  file: string | null;
  ok: boolean;
  /** From the call to the record carrying its result; 0 when no result was written. */
  duration_ms: number;
  /** What Claude Code wrote down about letting the call run, as it wrote it. */
  decision: AgentReplayDecision | null;
};

export type AgentReplaySubagent = {
  id: string;
  description: string;
  agent_type: string | null;
  model: string | null;
  /** The tool call that started it, when its record says. */
  spawned_by: string | null;
  first_at: string | null;
  last_at: string | null;
  calls: number;
};

/** What you said, and your answers to its questions. */
export type AgentReplayLine =
  | { kind: "say"; at: string; text: string }
  | { kind: "answer"; at: string; asked_at: string; questions: string[]; answers: string[] };

export type AgentReplay = {
  session_id: string;
  /** The agent's own session read, and the terminal session it was carried on from when read too. */
  agent_session: string | null;
  source_session: string | null;
  calls: AgentReplayCall[];
  subagents: AgentReplaySubagent[];
  said: AgentReplayLine[];
};
