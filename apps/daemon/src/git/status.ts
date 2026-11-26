/**
 * Git status, repository summary, and changed-file list parsing (ADR 0118).
 */
import type { GitChangeFile, GitChangesResponse, GitDiffBase, GitFileStatus, GitRepoSummary } from "@real-bot/protocol";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { defaultGitExec, type GitExecutor } from "./exec";
import { detectGitOperation, isPathWithin, listWorktreePaths, resolveProjectRepo, safeRealpath } from "./repo";

const MAX_FILES = 500;

export type ParsedStatusV2 = {
  headOid: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitChangeFile[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
};

function mapStatusChar(ch: string): GitFileStatus {
  if (ch === "A" || ch === "M" || ch === "D" || ch === "R" || ch === "C" || ch === "U") return ch;
  return "M";
}

/** Parses `git status --porcelain=v2 --branch -z --untracked-files=all`. */
export function parseStatusV2(stdout: string): ParsedStatusV2 {
  let headOid: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitChangeFile[] = [];
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;

  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token.startsWith("# branch.oid ")) {
      const val = token.slice("# branch.oid ".length).trim();
      headOid = val === "(initial)" ? null : val;
    } else if (token.startsWith("# branch.head ")) {
      const val = token.slice("# branch.head ".length).trim();
      if (val === "(detached)") {
        detached = true;
        branch = null;
      } else {
        detached = false;
        branch = val;
      }
    } else if (token.startsWith("# branch.upstream ")) {
      upstream = token.slice("# branch.upstream ".length).trim() || null;
    } else if (token.startsWith("# branch.ab ")) {
      const match = token.slice("# branch.ab ".length).match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number(match[1]) || 0;
        behind = Number(match[2]) || 0;
      }
    } else if (token.startsWith("1 ")) {
      // 1 XY sub mH mI mW hH hI path
      const xy = token.slice(2, 4);
      const parts = token.split(" ");
      const path = parts.slice(8).join(" ");
      if (!path) continue;
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      const staged = x !== ".";
      const unstaged = y !== ".";
      if (staged) stagedCount += 1;
      if (unstaged) unstagedCount += 1;
      entries.push({
        path,
        old_path: null,
        status: mapStatusChar(unstaged ? y : x),
        staged,
        unstaged,
        additions: null,
        deletions: null,
        binary: false,
      });
    } else if (token.startsWith("2 ")) {
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath
      const xy = token.slice(2, 4);
      const parts = token.split(" ");
      const path = parts.slice(9).join(" ");
      const oldPath = tokens[i + 1] ?? null;
      i += 1;
      if (!path) continue;
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      const staged = x !== ".";
      const unstaged = y !== ".";
      if (staged) stagedCount += 1;
      if (unstaged) unstagedCount += 1;
      entries.push({
        path,
        old_path: oldPath,
        status: mapStatusChar(x !== "." ? x : y),
        staged,
        unstaged,
        additions: null,
        deletions: null,
        binary: false,
      });
    } else if (token.startsWith("u ")) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = token.split(" ");
      const path = parts.slice(10).join(" ");
      if (!path) continue;
      conflictedCount += 1;
      entries.push({
        path,
        old_path: null,
        status: "U",
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null,
        binary: false,
      });
    } else if (token.startsWith("? ")) {
      const path = token.slice(2);
      if (!path) continue;
      untrackedCount += 1;
      entries.push({
        path,
        old_path: null,
        status: "?",
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null,
        binary: false,
      });
    }
  }

  return { headOid, branch, detached, upstream, ahead, behind, entries, stagedCount, unstagedCount, untrackedCount, conflictedCount };
}

export type NumstatEntry = { additions: number | null; deletions: number | null; binary: boolean };

/** Parses `git diff --numstat -z` output into per-path line counts. */
export function parseNumstatZ(stdout: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>();
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const match = token.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!match) continue;
    const addRaw = match[1]!;
    const delRaw = match[2]!;
    let path = match[3]!;
    // For renames in `-z` numstat, the 3rd column is empty and followed by origPath\0newPath.
    if (path === "") {
      const newPath = tokens[i + 2] ?? "";
      i += 2;
      path = newPath;
    }
    if (!path) continue;
    const binary = addRaw === "-" || delRaw === "-";
    map.set(path, {
      additions: binary ? null : Number(addRaw),
      deletions: binary ? null : Number(delRaw),
      binary,
    });
  }
  return map;
}

/** Parses `git diff --name-status -z` into change entries. */
export function parseNameStatusZ(stdout: string): GitChangeFile[] {
  const out: GitChangeFile[] = [];
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (!code) continue;
    const ch = code[0] ?? "M";
    if (ch === "R" || ch === "C") {
      const oldPath = tokens[i + 1] ?? null;
      const newPath = tokens[i + 2] ?? "";
      i += 2;
      if (!newPath) continue;
      out.push({
        path: newPath,
        old_path: oldPath,
        status: mapStatusChar(ch),
        staged: false,
        unstaged: false,
        additions: null,
        deletions: null,
        binary: false,
      });
    } else {
      const path = tokens[i + 1] ?? "";
      i += 1;
      if (!path) continue;
      out.push({
        path,
        old_path: null,
        status: mapStatusChar(ch),
        staged: false,
        unstaged: false,
        additions: null,
        deletions: null,
        binary: false,
      });
    }
  }
  return out;
}

/** Resolves the merge-base against the default mainline ref (origin/HEAD, origin/main, main, master). */
export async function resolveDefaultMergeBase(
  cwd: string,
  exec: GitExecutor = defaultGitExec,
): Promise<{ baseRef: string; mergeBaseOid: string } | null> {
  const candidates: string[] = [];
  const sym = await exec(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    coalesceKey: `origin-head:${cwd}`,
  });
  if (sym.ok && sym.stdout.trim()) candidates.push(sym.stdout.trim());
  for (const fallback of ["origin/main", "origin/master", "main", "master"]) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }
  for (const ref of candidates) {
    const mb = await exec(cwd, ["merge-base", ref, "HEAD"], { coalesceKey: `mb:${cwd}:${ref}` });
    if (mb.ok && mb.stdout.trim()) {
      return { baseRef: ref, mergeBaseOid: mb.stdout.trim() };
    }
  }
  return null;
}

function statusSortRank(status: GitFileStatus): number {
  if (status === "U") return 0;
  if (status === "M" || status === "R" || status === "C") return 1;
  if (status === "A" || status === "D") return 2;
  return 3;
}

function sortFiles(files: GitChangeFile[]): GitChangeFile[] {
  return [...files].sort((a, b) => {
    const rank = statusSortRank(a.status) - statusSortRank(b.status);
    if (rank !== 0) return rank;
    return a.path.localeCompare(b.path);
  });
}

/**
 * Excludes untracked directory/file entries that actually belong to nested worktrees inside
 * `targetDir` (e.g. `? .wt/ci-linux-fix/`), keeping dirty counts accurate.
 */
export function stripNestedWorktreeEntries(
  parsed: ParsedStatusV2,
  targetDir: string,
  worktreePaths: readonly string[],
): ParsedStatusV2 {
  const targetReal = safeRealpath(targetDir);
  const nestedRelPrefixes: string[] = [];
  for (const wtPath of worktreePaths) {
    const wtReal = safeRealpath(wtPath);
    if (wtReal === targetReal) continue;
    if (!isPathWithin(wtReal, targetReal)) continue;
    const rel = relative(targetReal, wtReal).split("\\").join("/").replace(/\/+$/, "");
    if (rel && !rel.startsWith("..")) nestedRelPrefixes.push(rel);
  }
  if (nestedRelPrefixes.length === 0) return parsed;

  let removedUntracked = 0;
  const entries = parsed.entries.filter((entry) => {
    if (entry.status !== "?") return true;
    const clean = entry.path.replace(/\/+$/, "");
    const hit = nestedRelPrefixes.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`));
    if (hit) removedUntracked += 1;
    return !hit;
  });
  if (removedUntracked === 0) return parsed;
  return {
    ...parsed,
    entries,
    untrackedCount: Math.max(0, parsed.untrackedCount - removedUntracked),
  };
}

async function countOtherDirtyWorktrees(
  currentTarget: string,
  projectBoundary: string,
  worktreePaths: readonly string[],
  exec: GitExecutor,
): Promise<number> {
  const currentReal = safeRealpath(currentTarget);
  const others = worktreePaths
    .filter((p) => isPathWithin(p, projectBoundary) && safeRealpath(p) !== currentReal)
    .slice(0, 12);
  if (others.length === 0) return 0;
  const checks = await Promise.all(
    others.map(async (wtPath) => {
      const res = await exec(wtPath, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
        timeoutMs: 4_000,
        maxBytes: 256 * 1024,
        coalesceKey: `status:${safeRealpath(wtPath)}`,
      });
      if (!res.ok) return 0;
      const parsed = stripNestedWorktreeEntries(parseStatusV2(res.stdout), wtPath, worktreePaths);
      return parsed.entries.length > 0 ? 1 : 0;
    }),
  );
  return checks.reduce<number>((sum, n) => sum + n, 0);
}

/** Reads the lightweight repository summary for headers, empty states, and polling. */
export async function readGitSummary(
  projectDir: string,
  opts: { repo?: string | null; worktree?: string | null; includeOtherWorktrees?: boolean; exec?: GitExecutor } = {},
): Promise<GitRepoSummary> {
  const exec = opts.exec ?? defaultGitExec;
  const now = new Date().toISOString();
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec });
  if (!resolved.isRepo) {
    return {
      is_repo: false,
      git_available: resolved.gitAvailable,
      git_error: resolved.gitError,
      repo_id: null,
      repo_root: null,
      common_root: null,
      worktree_root: null,
      project_boundary: resolved.projectBoundary,
      default_worktree: resolved.defaultWorktree,
      relative_prefix: "",
      repos: resolved.repos,
      branch: null,
      head_oid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged_count: 0,
      unstaged_count: 0,
      untracked_count: 0,
      conflicted_count: 0,
      dirty_count: 0,
      operation: null,
      other_dirty_worktrees: 0,
      signature: "not-repo",
      checked_at: now,
    };
  }

  const [statusRes, wtPaths] = await Promise.all([
    exec(resolved.targetDir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
      coalesceKey: `status:${safeRealpath(resolved.targetDir)}`,
    }),
    listWorktreePaths(resolved.targetDir, exec),
  ]);
  const parsed = statusRes.ok
    ? stripNestedWorktreeEntries(parseStatusV2(statusRes.stdout), resolved.targetDir, wtPaths)
    : {
        headOid: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0,
        entries: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0,
      };
  const operation = detectGitOperation(resolved.gitDir);
  const otherDirty = opts.includeOtherWorktrees === true
    ? await countOtherDirtyWorktrees(resolved.targetDir, resolved.projectBoundary, wtPaths, exec)
    : 0;
  const digest = createHash("sha1")
    .update(statusRes.stdout)
    .update(`|${operation ?? ""}|${otherDirty}|${parsed.entries.length}`)
    .digest("hex")
    .slice(0, 12);

  return {
    is_repo: true,
    git_available: true,
    git_error: statusRes.ok ? null : statusRes.stderr || "git status failed",
    repo_id: resolved.repoId,
    repo_root: resolved.repoRoot,
    common_root: resolved.commonRoot,
    worktree_root: resolved.worktreeRoot,
    project_boundary: resolved.projectBoundary,
    default_worktree: resolved.defaultWorktree,
    relative_prefix: resolved.relativePrefix,
    repos: resolved.repos,
    branch: parsed.branch,
    head_oid: parsed.headOid,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    staged_count: parsed.stagedCount,
    unstaged_count: parsed.unstagedCount,
    untracked_count: parsed.untrackedCount,
    conflicted_count: parsed.conflictedCount,
    dirty_count: parsed.entries.length,
    operation,
    other_dirty_worktrees: otherDirty,
    signature: digest,
    checked_at: now,
  };
}

/** Reads the changed file list with per-file additions/deletions for the chosen diff baseline. */
export async function readGitChanges(
  projectDir: string,
  opts: { base?: GitDiffBase; worktree?: string | null; repo?: string | null; scope?: "repo" | "dir"; exec?: GitExecutor } = {},
): Promise<GitChangesResponse> {
  const exec = opts.exec ?? defaultGitExec;
  const base: GitDiffBase = opts.base ?? "working";
  const now = new Date().toISOString();
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec });
  if (!resolved.isRepo) {
    return { base, base_ref: null, worktree: projectDir, files: [], truncated: false, total_files: 0, checked_at: now };
  }

  const prefixFilter = opts.scope === "dir" && resolved.relativePrefix ? `${resolved.relativePrefix}/` : null;
  const matchesScope = (file: GitChangeFile) => !prefixFilter || file.path.startsWith(prefixFilter) || file.path === resolved.relativePrefix;

  if (base === "merge-base") {
    const mb = await resolveDefaultMergeBase(resolved.targetDir, exec);
    if (!mb) {
      return { base, base_ref: null, worktree: resolved.targetDir, files: [], truncated: false, total_files: 0, checked_at: now };
    }
    const [nsRes, numRes] = await Promise.all([
      exec(resolved.targetDir, ["diff", "--name-status", "-z", "-M", mb.mergeBaseOid], { coalesceKey: `mb-ns:${resolved.targetDir}:${mb.mergeBaseOid}` }),
      exec(resolved.targetDir, ["diff", "--numstat", "-z", "-M", mb.mergeBaseOid], { coalesceKey: `mb-num:${resolved.targetDir}:${mb.mergeBaseOid}` }),
    ]);
    const stats = numRes.ok ? parseNumstatZ(numRes.stdout) : new Map<string, NumstatEntry>();
    const raw = nsRes.ok ? parseNameStatusZ(nsRes.stdout) : [];
    const merged = sortFiles(
      raw.filter(matchesScope).map((entry) => {
        const s = stats.get(entry.path);
        return s ? { ...entry, additions: s.additions, deletions: s.deletions, binary: s.binary } : entry;
      }),
    );
    return {
      base,
      base_ref: mb.baseRef,
      worktree: resolved.targetDir,
      files: merged.slice(0, MAX_FILES),
      truncated: merged.length > MAX_FILES,
      total_files: merged.length,
      checked_at: now,
    };
  }

  const [statusRes, wtPaths] = await Promise.all([
    exec(resolved.targetDir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
      coalesceKey: `status:${safeRealpath(resolved.targetDir)}`,
    }),
    listWorktreePaths(resolved.targetDir, exec),
  ]);
  const parsed = statusRes.ok
    ? stripNestedWorktreeEntries(parseStatusV2(statusRes.stdout), resolved.targetDir, wtPaths)
    : null;
  if (!parsed) {
    return { base, base_ref: null, worktree: resolved.targetDir, files: [], truncated: false, total_files: 0, checked_at: now };
  }

  let files = parsed.entries.filter(matchesScope);
  if (base === "staged") files = files.filter((f) => f.staged);
  else if (base === "unstaged") files = files.filter((f) => f.unstaged || f.status === "?" || f.status === "U");

  const numArgs = base === "staged"
    ? ["diff", "--cached", "--numstat", "-z", "-M"]
    : base === "unstaged"
      ? ["diff", "--numstat", "-z", "-M"]
      : parsed.headOid
        ? ["diff", "--numstat", "-z", "-M", "HEAD"]
        : ["diff", "--cached", "--numstat", "-z", "-M"];
  const numRes = await exec(resolved.targetDir, numArgs, { coalesceKey: `numstat:${resolved.targetDir}:${base}` });
  const stats = numRes.ok ? parseNumstatZ(numRes.stdout) : new Map<string, NumstatEntry>();

  const enriched = sortFiles(
    files.map((entry) => {
      const s = stats.get(entry.path);
      return s ? { ...entry, additions: s.additions, deletions: s.deletions, binary: s.binary } : entry;
    }),
  );

  return {
    base,
    base_ref: base === "working" ? "HEAD" : base,
    worktree: resolved.targetDir,
    files: enriched.slice(0, MAX_FILES),
    truncated: enriched.length > MAX_FILES,
    total_files: enriched.length,
    checked_at: now,
  };
}
