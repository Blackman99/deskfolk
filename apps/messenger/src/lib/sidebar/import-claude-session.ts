import type { ClaudeCodeSessionListing, CreateProjectSessionRequest } from "@real-bot/protocol";
import { formatListTime } from "./list-time.ts";

/** The home directory as `~`, so a path reads the way a terminal shows it. */
export function tildePath(path: string): string {
  return path.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/, "~");
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

/** The request that carries one terminal session on as a project session (ADR 0095). */
export function importRequest(session: ClaudeCodeSessionListing): CreateProjectSessionRequest {
  return { agent: "claude_code", import: { session_id: session.session_id, config_dir: session.config_dir } };
}

/** The request for a new project session in a typed or picked directory. */
export function newProjectRequest(dir: string): CreateProjectSessionRequest {
  return { agent: "claude_code", dir: dir.trim() };
}
