/**
 * Linked worktree discovery, zero-status repo -> worktree tree building, and Deskfolk session
 * pairing (ADR 0118). Sessions are matched across all discovered repositories' worktrees at once
 * by deepest enclosing path so nested independent repos and nested `.wt/*` worktrees never leak
 * onto an outer main checkout.
 */
import type {
  GitProjectTreeResponse,
  GitTreeRepo,
  GitWorktreeInfo,
  GitWorktreesResponse,
} from "@real-bot/protocol";
import { existsSync } from "node:fs";
import { defaultGitExec, type GitExecutor } from "./exec";
import {
  discoverProjectRepos,
  isPathWithin,
  listWorktrees,
  parseWorktreeList,
  resolveProjectRepo,
  safeRealpath,
  toBoundaryRelative,
  type ParsedWorktreeEntry,
} from "./repo";
import { parseStatusV2, stripNestedWorktreeEntries } from "./status";

export type RawWorktree = ParsedWorktreeEntry;

/** Parses `git worktree list --porcelain` blocks (re-exported for callers and tests). */
export function parseWorktreePorcelain(stdout: string): RawWorktree[] {
  return parseWorktreeList(stdout);
}

export type SessionDirRef = {
  id: string;
  dir: string;
  live: boolean;
};

/** Assigns each project session to the deepest worktree path containing its directory. */
export function mapSessionsToWorktrees(
  worktreePaths: readonly string[],
  sessions: readonly SessionDirRef[],
): Map<string, { sessionIds: string[]; liveSessionIds: string[] }> {
  const result = new Map<string, { sessionIds: string[]; liveSessionIds: string[] }>();
  const normalized = worktreePaths.map((wt) => ({ raw: wt, real: safeRealpath(wt) }));
  // Longest path first so nested worktrees and nested repos win over the main checkout.
  normalized.sort((a, b) => b.real.length - a.real.length);
  for (const wt of worktreePaths) result.set(wt, { sessionIds: [], liveSessionIds: [] });

  for (const session of sessions) {
    const dirReal = safeRealpath(session.dir);
    const owner = normalized.find(
      (wt) => dirReal === wt.real || dirReal.startsWith(`${wt.real}/`) || dirReal.startsWith(`${wt.real}\\`),
    );
    if (!owner) continue;
    const bucket = result.get(owner.raw)!;
    bucket.sessionIds.push(session.id);
    if (session.live) bucket.liveSessionIds.push(session.id);
  }
  return result;
}

/**
 * Zero-status `GET /v1/project-sessions/:id/git/tree` reader: runs one `git worktree list --porcelain`
 * per discovered repository, filters worktrees to `projectBoundary`, and pairs Deskfolk sessions
 * globally across all repositories by deepest enclosing path.
 */
export async function readGitProjectTree(
  projectDir: string,
  opts: { sessions?: readonly SessionDirRef[]; refresh?: boolean; exec?: GitExecutor } = {},
): Promise<GitProjectTreeResponse> {
  const exec = opts.exec ?? defaultGitExec;
  const now = new Date().toISOString();
  const discovery = await discoverProjectRepos(projectDir, { exec, forceRefresh: opts.refresh });

  if (!discovery.gitAvailable || discovery.repos.length === 0) {
    return {
      git_available: discovery.gitAvailable,
      git_error: discovery.gitError,
      project_boundary: discovery.projectBoundary,
      default_repo_id: null,
      default_worktree: discovery.defaultWorktree,
      repos: [],
      checked_at: now,
    };
  }

  const perRepo = await Promise.all(
    discovery.repos.map(async (repo) => {
      const res = await exec(repo.path, ["worktree", "list", "--porcelain"], {
        coalesceKey: `wt-list:${repo.commonDir}`,
      });
      if (!res.ok) {
        return { repo, error: res.stderr || "git worktree list failed", entries: [] as ParsedWorktreeEntry[] };
      }
      const entries = parseWorktreeList(res.stdout).filter((wt) => isPathWithin(wt.path, discovery.projectBoundary));
      return { repo, error: null, entries };
    }),
  );

  // Pair sessions across ALL repos' worktrees at once so nested standalone repos don't leak into parent checkouts.
  const allWorktreePaths = perRepo.flatMap((r) => r.entries.map((e) => e.path));
  const sessionMap = mapSessionsToWorktrees(allWorktreePaths, opts.sessions ?? []);
  const defaultWtReal = discovery.defaultWorktree ? safeRealpath(discovery.defaultWorktree) : null;

  const repos: GitTreeRepo[] = perRepo.map(({ repo, error, entries }) => ({
    id: repo.id,
    name: repo.name,
    repo_root: repo.path,
    common_root: repo.commonRoot,
    error,
    worktrees: entries.map((wt) => {
      const wtReal = safeRealpath(wt.path);
      return {
        path: wt.path,
        rel_path: toBoundaryRelative(wt.path, discovery.projectBoundary),
        branch: wt.branch,
        head_oid: wt.headOid,
        detached: wt.detached,
        is_main: wt.isMain,
        is_project_dir: defaultWtReal !== null && wtReal === defaultWtReal,
        locked: wt.locked,
        locked_reason: wt.lockedReason,
        prunable: wt.prunable,
        session_ids: sessionMap.get(wt.path)?.sessionIds ?? [],
      };
    }),
  }));

  return {
    git_available: true,
    git_error: null,
    project_boundary: discovery.projectBoundary,
    default_repo_id: discovery.repos[0]?.id ?? null,
    default_worktree: discovery.defaultWorktree,
    repos,
    checked_at: now,
  };
}

export async function readGitWorktrees(
  projectDir: string,
  opts: { repo?: string | null; sessions?: readonly SessionDirRef[]; exec?: GitExecutor } = {},
): Promise<GitWorktreesResponse | null> {
  const exec = opts.exec ?? defaultGitExec;
  const now = new Date().toISOString();
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, exec });
  if (!resolved.isRepo || !resolved.repoRoot || !resolved.commonRoot) return null;

  const raw = (await listWorktrees(resolved.targetDir, exec, `wt-list:${resolved.commonRoot}`)).filter((wt) =>
    isPathWithin(wt.path, resolved.projectBoundary),
  );
  const allPaths = raw.map((r) => r.path);
  const currentReal = safeRealpath(resolved.targetDir);
  const sessionMap = mapSessionsToWorktrees(allPaths, opts.sessions ?? []);

  const enriched: GitWorktreeInfo[] = await Promise.all(
    raw.map(async (wt) => {
      const wtReal = safeRealpath(wt.path);
      const isCurrent = wtReal === currentReal;
      const sessions = sessionMap.get(wt.path) ?? { sessionIds: [], liveSessionIds: [] };
      let dirtyCount: number | null = null;
      let ahead: number | null = null;
      let behind: number | null = null;
      if (!wt.prunable && existsSync(wt.path)) {
        const stRes = await exec(wt.path, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
          timeoutMs: 4_000,
          coalesceKey: `status:${safeRealpath(wt.path)}`,
        });
        if (stRes.ok) {
          const parsed = stripNestedWorktreeEntries(parseStatusV2(stRes.stdout), wt.path, allPaths);
          dirtyCount = parsed.entries.length;
          ahead = parsed.upstream ? parsed.ahead : null;
          behind = parsed.upstream ? parsed.behind : null;
        }
      }
      return {
        path: wt.path,
        branch: wt.branch,
        head_oid: wt.headOid,
        detached: wt.detached,
        is_main: wt.isMain,
        is_current: isCurrent,
        locked: wt.locked,
        locked_reason: wt.lockedReason,
        prunable: wt.prunable,
        dirty_count: dirtyCount,
        ahead,
        behind,
        session_ids: sessions.sessionIds,
        live_session_ids: sessions.liveSessionIds,
      };
    }),
  );

  return {
    repo_root: resolved.repoRoot,
    common_root: resolved.commonRoot,
    worktrees: enriched,
    checked_at: now,
  };
}
