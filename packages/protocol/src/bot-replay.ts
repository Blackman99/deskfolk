/**
 * A Bot conversation on the task map (ADR 0097): where each tool call of its Bots' turns worked, as
 * the app records it. The places are the same as a project session's (ADR 0095), read from the
 * workspace instead of a project directory.
 */
import type { AgentReplayCall, AgentReplayLine, AgentShellAction, AgentToolPlace } from "./project-sessions.ts";

/**
 * Rides a `ToolFrame` for a Bot's turn, as `agent_run` does for a project session's run: which
 * conversation and Bot, where the call works, and the model that made it.
 */
export type BotToolInfo = {
  session_id: string;
  bot_id: string;
  place: AgentToolPlace;
  action?: AgentShellAction;
  /** The model the turn ran the call on; null when it is not known. */
  model: string | null;
  at: string;
  /** On `exited`: whether the call succeeded; absent while it waits on your card or your answer. */
  ok?: boolean;
};

/** One tool call of a Bot's turn, as recorded when it ran. */
export type SessionReplayCall = Omit<AgentReplayCall, "agent_id"> & {
  bot_id: string;
  turn_id: string;
  task_id: string | null;
};

/** What you said there, and your answers to a Bot's questions, with the Bot that asked. */
export type SessionReplayLine = AgentReplayLine & { bot_id?: string };

/**
 * `GET /v1/sessions/:id/replay`: a Bot conversation's tool calls since the app began recording where
 * calls work (calls before that were never recorded), the newest ones only when there are more than
 * a replay carries (`truncated`); what you said there; and the Bots in the order they first worked.
 */
export type SessionReplay = {
  session_id: string;
  calls: SessionReplayCall[];
  bots: string[];
  said: SessionReplayLine[];
  truncated: boolean;
};
