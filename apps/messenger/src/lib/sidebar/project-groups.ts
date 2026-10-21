import type { AgentRun, ClaudeCodeSessionListing, ProjectAgent, SessionSummary } from "@real-bot/protocol";
import { tildePath } from "./import-claude-session.ts";

/** The agents a project session can run, in the order the sheet offers them (ADR 0095: Claude Code first). */
export const PROJECT_AGENTS: readonly ProjectAgent[] = ["claude_code"];

/** One directory of one agent in the 「项目」 section and the project sessions that ran there, newest first. */
export type ProjectDirGroup = {
  /** The agent and the directory, each group's own. */
  key: string;
  agent: ProjectAgent;
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

function agentOf(session: SessionSummary): ProjectAgent {
  return session.project_agent ?? "claude_code";
}

/**
 * Project sessions grouped by agent and directory: one directory worked in by two agents is two
 * groups. The groups run newest first by their newest session, so the project you just worked in
 * is on top; a session with no directory is left out.
 */
export function groupProjectSessions(sessions: readonly SessionSummary[]): ProjectDirGroup[] {
  const byKey = new Map<string, ProjectDirGroup>();
  for (const session of sessions) {
    const dir = session.project_dir;
    if (!dir) continue;
    const agent = agentOf(session);
    const key = `${agent}\u0000${dir}`;
    const group = byKey.get(key);
    if (group) group.sessions.push(session);
    else byKey.set(key, { key, agent, dir, label: projectDirLabel(dir), sessions: [session] });
  }
  const groups = [...byKey.values()];
  for (const group of groups) group.sessions.sort(newestFirst);
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

/** One directory the sheet offers: start a session in it, or carry on one of the terminal's from it. */
export type PickerDir = {
  dir: string;
  label: string;
  /** The terminal sessions that ran in it, newest first. */
  listings: ClaudeCodeSessionListing[];
  /** When anything last happened in it, a terminal session or one of the app's. */
  latest: string;
};

/**
 * The directories the sheet offers for an agent, newest first: where its terminal sessions ran
 * and where the app's project sessions for it did, each once. A terminal session with no
 * directory has nowhere to be carried on and is left out.
 */
export function pickerDirs(
  listings: readonly ClaudeCodeSessionListing[],
  sessions: readonly SessionSummary[],
  agent: ProjectAgent,
): PickerDir[] {
  const byDir = new Map<string, PickerDir>();
  const at = (dir: string, when: string): PickerDir => {
    let entry = byDir.get(dir);
    if (!entry) {
      entry = { dir, label: projectDirLabel(dir), listings: [], latest: when };
      byDir.set(dir, entry);
    } else if (when > entry.latest) entry.latest = when;
    return entry;
  };
  // Only Claude Code has a terminal listing to read.
  if (agent === "claude_code") {
    for (const listing of listings) if (listing.cwd) at(listing.cwd, listing.modified_at).listings.push(listing);
  }
  for (const session of sessions) {
    if (session.kind === "project" && session.project_dir && agentOf(session) === agent) at(session.project_dir, session.updated_at);
  }
  const dirs = [...byDir.values()];
  for (const entry of dirs) entry.listings.sort((a, b) => (a.modified_at < b.modified_at ? 1 : a.modified_at > b.modified_at ? -1 : 0));
  return dirs.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
}

/** Whether the listing comes from more than one Claude account, so each row says which. */
export function listingSpansAccounts(listings: readonly ClaudeCodeSessionListing[]): boolean {
  return new Set(listings.map((listing) => listing.config_dir ?? "")).size > 1;
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
