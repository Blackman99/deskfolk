/**
 * Project sessions (ADR 0095): you and a local agent in a directory, as in the agents' own desktop
 * apps, with no Bot. The app keeps permissions and Stop; each run of the agent is an `AgentRun`.
 */

export type ProjectAgent = "claude_code";

export type AgentRunStatus = "running" | "waiting_approval" | "completed" | "failed" | "stopped" | "interrupted";

/** What a run waits on you for under ask first: the same kinds as a Bot's approval card. */
export type AgentRunApproval = { kind_key: string; target: string; summary: string };

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
export type CreateProjectSessionRequest = {
  agent?: ProjectAgent;
  dir?: string;
  /** The Claude account directory; omitted or null is the daemon's own environment. */
  config_dir?: string | null;
  import?: { session_id: string; config_dir?: string | null };
};

/**
 * Where a tool call of a project session's agent works (ADR 0095), for the task map: a path
 * relative to the project directory (`""` its root), a path outside it — Claude Code's own files
 * under `~/.claude*` apart — or, for a shell command, a test or type check, or git. `none` for a
 * call that names no place (a subagent, a question, a to-do list).
 */
export type AgentToolPlace =
  | { zone: "project"; path: string }
  | { zone: "outside"; path: string }
  | { zone: "claude_home"; path: string }
  | { zone: "check"; check: "test" | "typecheck" }
  | { zone: "git" }
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
