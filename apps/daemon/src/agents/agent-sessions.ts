/**
 * Your terminal sessions of each agent, to carry on as project sessions (ADR 0095; Codex, ADR 0099
 * addendum 2026-11-17): listed and read for every agent through one door, each agent's in its own
 * way — Claude Code's from its session files, every other agent's asked of the agent itself.
 */
import type { AgentSessionList, ProjectAgent } from "@real-bot/protocol";
import { claudeSessionRoots, findClaudeSessionFile, listClaudeSessions, readClaudeSession } from "../claude-code/sessions";
import { HttpError } from "../errors";
import type { Store } from "../store";
import type { AgySessions } from "./agy-sessions";
import type { CodexSessions } from "./codex-sessions";

/** A line of a conversation carried in: what you said or what the agent answered, at its own time. */
export type ImportedLine = { role: "user" | "assistant"; text: string; at: string };

/** A terminal session read for carrying on: its lines at their own times, and how many tool calls are not shown one by one. */
export type ImportedSession = {
  session_id: string;
  title: string;
  cwd: string | null;
  lines: ImportedLine[];
  tool_calls: number;
};

export type AgentSessions = {
  /** Up to `limit` of the agent's sessions you could carry on, newest first. */
  list(agent: ProjectAgent, limit: number): Promise<AgentSessionList>;
  /** One of them, read for carrying on; 404 when the agent no longer has it, 422 for an account not yours. */
  read(agent: ProjectAgent, sessionId: string, configDir: string | null): Promise<ImportedSession>;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createAgentSessions(deps: { store: Store; codex: CodexSessions; agy: AgySessions }): AgentSessions {
  const { store } = deps;
  return {
    async list(agent, limit) {
      switch (agent) {
        case "claude_code": {
          const items = listClaudeSessions(claudeSessionRoots(store.claudeCodeConfigDirs()), { limit }).map((item) => ({ ...item, agent }));
          return { items, error: null };
        }
        case "codex": {
          try {
            return { items: await deps.codex.list(null, limit, store.knownAgentSessions(agent)), error: null };
          } catch (error) {
            return { items: [], error: message(error) };
          }
        }
        case "antigravity": {
          try {
            return { items: await deps.agy.list(limit, store.knownAgentSessions(agent), store.workspacePath()), error: null };
          } catch (error) {
            return { items: [], error: message(error) };
          }
        }
      }
    },
    async read(agent, sessionId, configDir) {
      switch (agent) {
        case "claude_code": {
          const root = claudeSessionRoots(store.claudeCodeConfigDirs()).find((entry) => entry.configDir === configDir);
          if (!root) throw new HttpError(422, "invalid_args", "config_dir is not one of your Claude accounts");
          const file = findClaudeSessionFile(root, sessionId);
          if (!file) throw new HttpError(404, "not_found", "no such Claude Code session");
          return readClaudeSession(file, sessionId);
        }
        case "codex": {
          if (configDir !== null) throw new HttpError(422, "invalid_args", "config_dir is not one of your Codex accounts");
          const read = await deps.codex.read(configDir, sessionId).catch((error) => {
            throw new HttpError(502, "agent_unavailable", `Codex could not be asked: ${message(error)}`);
          });
          if (!read) throw new HttpError(404, "not_found", "no such Codex thread");
          return read;
        }
        case "antigravity": {
          if (configDir !== null) throw new HttpError(422, "invalid_args", "Antigravity sessions are on no account of yours the app lists");
          // Carried on twice, two sessions here would write the one `agy` session.
          if (store.knownAgentSessions(agent).has(sessionId)) throw new HttpError(409, "conflict", "this Antigravity session is carried on here already");
          const read = await deps.agy.read(sessionId).catch((error) => {
            throw new HttpError(502, "agent_unavailable", `agy could not be asked: ${message(error)}`);
          });
          if (!read) throw new HttpError(404, "not_found", "no such Antigravity session");
          return read;
        }
      }
    },
  };
}
