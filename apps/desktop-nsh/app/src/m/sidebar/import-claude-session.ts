import type { AgentSessionListing, ClaudeCodeSessionListing, CreateProjectSessionRequest, ProjectAgent } from "@real-bot/protocol";
import { formatListTime } from "./list-time.ts";

/** A terminal session as the import lists hold it: any agent's, a Claude Code one from an older daemon without its agent. */
export type ImportListing = ClaudeCodeSessionListing & { agent?: ProjectAgent };

/** The home directory as `~`, so a path reads the way a terminal shows it. */
export function tildePath(path: string): string {
  return path.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/, "~");
}

/** Whose terminal session a listing is: Claude Code's when an older daemon did not say. */
export function listingAgent(session: ImportListing): ProjectAgent {
  return session.agent ?? "claude_code";
}

/**
 * The muted line under a row in its directory: the account it ran on when the list holds more than
 * one (`account`, null otherwise), its branch, and when it last moved.
 */
export function importSubtitle(session: ClaudeCodeSessionListing, nowMs: number, locale: "zh" | "en", account: string | null = null): string {
  return [
    account ?? "",
    session.git_branch ?? "",
    formatListTime(session.modified_at, nowMs, locale)
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The request that carries one terminal session on as a project session of its agent (ADR 0095). */
export function importRequest(session: ImportListing): CreateProjectSessionRequest {
  return { agent: listingAgent(session), import: { session_id: session.session_id, config_dir: session.config_dir } };
}

/** The request for a new project session of an agent in a typed or picked directory. */
export function newProjectRequest(dir: string, agent: ProjectAgent = "claude_code"): CreateProjectSessionRequest {
  return { agent, dir: dir.trim() };
}

/**
 * An agent's terminal sessions to carry on, newest first. A daemon from before every agent had
 * its list still lists Claude Code's on the old route; any other agent's then fails.
 */
export async function loadAgentSessions(
  client: { agentSessions?: (agent: ProjectAgent, limit?: number) => Promise<{ items: AgentSessionListing[] }>; claudeCodeSessions: (limit?: number) => Promise<ClaudeCodeSessionListing[]> },
  agent: ProjectAgent,
  limit: number,
): Promise<ImportListing[]> {
  try {
    if (!client.agentSessions) throw new Error("no agent sessions route");
    return (await client.agentSessions(agent, limit)).items;
  } catch (error) {
    if (agent !== "claude_code") throw error;
    return (await client.claudeCodeSessions(limit)).map((item) => ({ ...item, agent }));
  }
}
