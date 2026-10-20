import type { AgentRun, ClaudeCodeSessionListing, SessionSummary } from "@real-bot/protocol";
import { tildePath } from "./import-claude-session.ts";

/** One directory of the 「项目」 section and the project sessions that ran in it, newest first. */
export type ProjectDirGroup = {
  dir: string;
  /** The last segment of the path: what the row says. */
  label: string;
  sessions: SessionSummary[];
};

/** The last segment of a directory path, either separator; the whole path when it has none. */
export function projectDirLabel(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const last = trimmed.split(/[\\/]/).pop();
  return last || trimmed || dir;
}

function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

/**
 * Project sessions grouped by directory. The directories run newest first by their newest session,
 * so the project you just worked in is on top; a session with no directory is left out.
 */
export function groupProjectSessions(sessions: readonly SessionSummary[]): ProjectDirGroup[] {
  const byDir = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (!session.project_dir) continue;
    const list = byDir.get(session.project_dir);
    if (list) list.push(session);
    else byDir.set(session.project_dir, [session]);
  }
  const groups: ProjectDirGroup[] = [];
  for (const [dir, list] of byDir) {
    groups.push({ dir, label: projectDirLabel(dir), sessions: [...list].sort(newestFirst) });
  }
  return groups.sort((a, b) => newestFirst(a.sessions[0]!, b.sessions[0]!));
}

/** Whether the agent is at work in this run, or waiting on you inside it. */
export function isLiveRun(run: AgentRun | null | undefined): boolean {
  return run?.status === "running" || run?.status === "waiting_approval";
}

/** The project sessions whose newest run is live. */
export function liveRunSessionIds(runs: Readonly<Record<string, AgentRun>>): string[] {
  return Object.values(runs).filter(isLiveRun).map((run) => run.session_id);
}

/**
 * The directories your Claude Code sessions ran in, newest first, each once, for the sheet's
 * quick-pick chips. The listing is already newest first; a session with no directory has none to give.
 */
export function recentProjectDirs(listings: readonly ClaudeCodeSessionListing[], limit = 6): string[] {
  const seen = new Set<string>();
  for (const listing of listings) {
    if (listing.cwd) seen.add(listing.cwd);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Longer than this, a header line shows only a directory's last two names. */
const DIR_DISPLAY_MAX = 40;

/**
 * A directory the way a terminal shows it: home as `~`. A long one keeps its end, `…/app/web`:
 * a header line has room for little, and the start of a path is the part that says least.
 */
export function dirDisplay(dir: string | null | undefined): string {
  if (!dir) return "";
  const shown = tildePath(dir);
  if (shown.length <= DIR_DISPLAY_MAX) return shown;
  const names = shown.split(/[\\/]/).filter(Boolean);
  return `…/${names.slice(-2).join("/")}`;
}

/** Whether a typed directory is an absolute path; the daemon refuses a relative one with 422. */
export function isAbsoluteDir(value: string): boolean {
  const dir = value.trim();
  return dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith("\\\\");
}
