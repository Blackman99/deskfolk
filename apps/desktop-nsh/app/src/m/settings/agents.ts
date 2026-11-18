import { AGENT_KINDS, type AgentStatus, type CustomAgent } from "@real-bot/protocol";

/** How a change to an agent's settings failed, for the card's own words and the daemon's detail under them. */
export type AgentFailure = {
  /** 409: a Bot (or a ladder rung, a built-in call) runs on it; 422: the daemon refused the value; else: it could not be asked. */
  kind: "in_use" | "invalid" | "failed";
  /** The daemon's own message for a 409 or 422, in English; it names the Bots that stand in the way. */
  detail: string | null;
};

export function agentFailure(error: unknown): AgentFailure {
  const status = (error as { status?: number } | null)?.status;
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : null;
  if (status === 409) return { kind: "in_use", detail: message };
  if (status === 422) return { kind: "invalid", detail: message };
  return { kind: "failed", detail: null };
}

/** A daemon that does not have the route at all: an older Mac behind a paired phone. */
export function agentUnreachable(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

/** Which agent a status is of: its runner, and for your own ACP agents which one. */
export function agentKey(agent: { runner: string; custom_id: string | null }): string {
  return `${agent.runner}:${agent.custom_id ?? ""}`;
}

/** The command a turn would run, or looked for: the one you set for a custom agent, else the agent's own name for it. */
export function agentCommand(status: Pick<AgentStatus, "runner">, custom: CustomAgent | null | undefined): string {
  return custom?.command ?? AGENT_KINDS[status.runner].command ?? "";
}

/** A directory of a second account to suggest in the field, as the agent names its own (`~/.codex-b`). */
export function agentAccountExample(runner: AgentStatus["runner"]): string {
  return `~/.${AGENT_KINDS[runner].command ?? "agent"}-b`;
}

/** The whole list with one entry's name changed, ids kept: what the daemon takes after a rename. */
export function renamed(agents: CustomAgent[], id: string, name: string): CustomAgent[] {
  return agents.map((agent) => (agent.id === id ? { ...agent, name } : agent));
}

/** One argument per line, each trimmed at its ends; blank lines do not count. Spaces inside a line stay. */
export function parseArgs(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** The most ACP agents of your own the daemon keeps. */
export const CUSTOM_AGENTS_MAX = 8;
