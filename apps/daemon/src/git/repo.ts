/**
 * Resolves how a project session's directory maps to one or more git repositories (ADR 0118).
 * Computes a single canonical `projectBoundary` shared across repo discovery, worktree listing,
 * commit graph markers, and worktree parameter validation:
 * - When `projectDir` is inside a git worktree: `projectBoundary` is that worktree's top-level
 *   (and any immediate standalone nested repos inside it are also discovered).
 * - When `projectDir` is a non-git parent folder: `projectBoundary` is `projectDir` itself, and
 *   immediate child repos are discovered and deduplicated by common git directory.
 */
import type { GitOperationKind, GitRepoChoice } from "@real-bot/protocol";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { HttpError } from "../errors";
import { defaultGitExec, type GitExecutor } from "./exec";

export type DiscoveredRepo = {
  /** Project-boundary-relative identifier (`"."` for the root repo). */
  id: string;
  name: string;
  path: string;
  commonDir: string;
  commonRoot: string;
  gitDir: string;
};

export type ProjectRepoDiscovery = {
  gitAvailable: boolean;
  gitError: string | null;
  projectBoundary: string;
  /** The worktree containing `projectDir` when `projectDir` is inside a repo, else null. */
  defaultWorktree: string | null;
  repos: DiscoveredRepo[];
};

export type ResolvedRepo = {
  isRepo: boolean;
  gitAvailable: boolean;
  gitError: string | null;
  repoId: string | null;
  repoRoot: string | null;
  commonRoot: string | null;
  worktreeRoot: string | null;
  projectBoundary: string;
  defaultWorktree: string | null;
  gitDir: string | null;
  relativePrefix: string;
  repos: GitRepoChoice[];
  /** Directory in which git commands should run (resolved worktree or repo root). */
  targetDir: string;
};

export type ParsedWorktreeEntry = {
  path: string;
  headOid: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  isMain: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
};

export function safeRealpath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** True when `target` is `root` itself or nested inside `root` (after resolving symlinks). */
export function isPathWithin(target: string, root: string): boolean {
  const targetReal = safeRealpath(target);
  const rootReal = safeRealpath(root);
  if (targetReal === rootReal) return true;
  const trimmed = rootReal.replace(/[\\/]+$/, "");
  return targetReal.startsWith(`${trimmed}/`) || targetReal.startsWith(`${trimmed}\\`);
}

/** Formats `target` relative to `boundary` using POSIX separators (`"."` when equal). */
export function toBoundaryRelative(target: string, boundary: string): string {
  const rel = relative(safeRealpath(boundary), safeRealpath(target)).split("\\").join("/");
  return rel || ".";
}

type GitMarker =
  | { kind: "repo"; gitDir: string; commonDir: string }
  | { kind: "worktree"; gitDir: string; commonDir: string }
  | { kind: "submodule"; gitDir: string; commonDir: string };

/**
 * Pure-filesystem `.git` inspection (no subprocesses):
 * - `.git` directory -> standalone repo
 * - `.git` file with `gitdir:` whose target has `commondir` -> linked worktree
 * - `.git` file with `gitdir:` without `commondir` -> submodule
 */
export function inspectGitMarker(dir: string): GitMarker | null {
  const dotGit = join(dir, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    const real = safeRealpath(dotGit);
    return { kind: "repo", gitDir: real, commonDir: real };
  }
  if (!st.isFile()) return null;
  let content = "";
  try {
    content = readFileSync(dotGit, "utf8").slice(0, 4096);
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match?.[1]) return null;
  const gitDir = safeRealpath(resolve(dir, match[1].trim()));
  const commonFile = join(gitDir, "commondir");
  if (existsSync(commonFile)) {
    try {
      const rawCommon = readFileSync(commonFile, "utf8").trim();
      if (rawCommon) {
        return { kind: "worktree", gitDir, commonDir: safeRealpath(resolve(gitDir, rawCommon)) };
      }
    } catch {
      // fall through
    }
  }
  return { kind: "submodule", gitDir, commonDir: gitDir };
}

function commonRootOf(commonDir: string): string {
  return basename(commonDir) === ".git" ? resolve(commonDir, "..") : commonDir;
}

/** Detects an in-progress merge, rebase, cherry-pick, or revert from git metadata files. */
export function detectGitOperation(gitDir: string | null): GitOperationKind | null {
  if (!gitDir) return null;
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  return null;
}

/**
 * Parses `git worktree list --porcelain` blocks. Preserves `isMain` from the original entry order
 * before filtering out bare entries so a linked worktree under a bare repo is not mislabeled main.
 */
export function parseWorktreeList(stdout: string): ParsedWorktreeEntry[] {
  const blocks = stdout.replace(/\r\n/g, "\n").split(/\n\n+/);
  const out: ParsedWorktreeEntry[] = [];
  let rawIndex = 0;
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (lines.length === 0) continue;
    const isFirst = rawIndex === 0;
    rawIndex += 1;
    let path: string | null = null;
    let headOid: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    let locked = false;
    let lockedReason: string | null = null;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) headOid = line.slice("HEAD ".length).trim() || null;
      else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "detached") detached = true;
      else if (line === "bare") bare = true;
      else if (line === "locked" || line.startsWith("locked ")) {
        locked = true;
        lockedReason = line.length > 7 ? line.slice(7).trim() || null : null;
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        prunable = true;
      }
    }
    if (path && !bare) {
      out.push({ path, headOid, branch, detached, bare, isMain: isFirst, locked, lockedReason, prunable });
    }
  }
  return out;
}

/** Lists worktrees for a repository via `git worktree list --porcelain`. */
export async function listWorktrees(cwd: string, exec: GitExecutor, coalesceKey?: string): Promise<ParsedWorktreeEntry[]> {
  const res = await exec(cwd, ["worktree", "list", "--porcelain"], {
    coalesceKey: coalesceKey ?? `wt-list:${safeRealpath(cwd)}`,
  });
  if (!res.ok) return [];
  return parseWorktreeList(res.stdout);
}

/** Lists raw worktree paths for a repository. */
export async function listWorktreePaths(cwd: string, exec: GitExecutor): Promise<string[]> {
  const entries = await listWorktrees(cwd, exec);
  return entries.map((e) => e.path);
}

type ProbeResult = {
  ok: boolean;
  unavailable?: boolean;
  error?: string | null;
  toplevel?: string;
  gitDir?: string;
  commonDir?: string;
  prefix?: string;
};

async function probeGitDir(dir: string, exec: GitExecutor): Promise<ProbeResult> {
  const res = await exec(dir, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--show-prefix"], {
    coalesceKey: `rev-parse:${safeRealpath(dir)}`,
  });
  if (res.unavailable) return { ok: false, unavailable: true, error: res.stderr || "git not found" };
  if (!res.ok) return { ok: false, error: res.stderr || null };
  const lines = res.stdout.replace(/\r\n/g, "\n").split("\n");
  const toplevel = lines[0]?.trim();
  const rawGitDir = lines[1]?.trim();
  const rawCommonDir = lines[2]?.trim();
  const prefix = (lines[3] ?? "").trim().replace(/\/+$/, "");
  if (!toplevel || !rawGitDir || !rawCommonDir) return { ok: false };
  const gitDir = safeRealpath(resolve(dir, rawGitDir));
  const commonDir = safeRealpath(resolve(dir, rawCommonDir));
  return { ok: true, toplevel, gitDir, commonDir, prefix };
}

/**
 * Scans immediate child folders (1 level deep, skipping hidden and `node_modules`) for standalone
 * git repositories. Linked worktrees are only included if no standalone repo with the same common
 * git directory exists under `parentDir`. Submodules are skipped in v1.
 */
function scanChildRepos(
  parentDir: string,
  boundary: string,
  seenCommonDirs: Set<string>,
  opts: { allowStandaloneWorktrees: boolean },
): DiscoveredRepo[] {
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const standalone: DiscoveredRepo[] = [];
  const fallbackWorktrees: Array<{ dir: string; name: string; marker: GitMarker }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = join(parentDir, entry.name);
    const marker = inspectGitMarker(child);
    if (!marker || marker.kind === "submodule") continue;
    if (marker.kind === "repo") {
      if (seenCommonDirs.has(marker.commonDir)) continue;
      seenCommonDirs.add(marker.commonDir);
      standalone.push({
        id: toBoundaryRelative(child, boundary),
        name: entry.name,
        path: child,
        commonDir: marker.commonDir,
        commonRoot: commonRootOf(marker.commonDir),
        gitDir: marker.gitDir,
      });
    } else if (opts.allowStandaloneWorktrees) {
      fallbackWorktrees.push({ dir: child, name: entry.name, marker });
    }
  }

  for (const item of fallbackWorktrees) {
    if (seenCommonDirs.has(item.marker.commonDir)) continue;
    seenCommonDirs.add(item.marker.commonDir);
    standalone.push({
      id: toBoundaryRelative(item.dir, boundary),
      name: item.name,
      path: item.dir,
      commonDir: item.marker.commonDir,
      commonRoot: commonRootOf(item.marker.commonDir),
      gitDir: item.marker.gitDir,
    });
  }

  return standalone.sort((a, b) => a.id.localeCompare(b.id));
}

const DISCOVERY_TTL_MS = 5_000;
const discoveryCache = new Map<string, { value: ProjectRepoDiscovery; at: number }>();
const discoveryInflight = new Map<string, Promise<ProjectRepoDiscovery>>();

export function resetRepoDiscoveryCache(): void {
  discoveryCache.clear();
  discoveryInflight.clear();
}

async function computeProjectDiscovery(projectDir: string, exec: GitExecutor): Promise<ProjectRepoDiscovery> {
  if (!existsSync(projectDir)) {
    return {
      gitAvailable: true,
      gitError: "project directory does not exist",
      projectBoundary: projectDir,
      defaultWorktree: null,
      repos: [],
    };
  }

  const probed = await probeGitDir(projectDir, exec);
  if (probed.unavailable) {
    return {
      gitAvailable: false,
      gitError: probed.error ?? "git not available",
      projectBoundary: safeRealpath(projectDir),
      defaultWorktree: null,
      repos: [],
    };
  }

  const seenCommonDirs = new Set<string>();
  if (probed.ok && probed.toplevel && probed.commonDir && probed.gitDir) {
    const boundary = probed.toplevel;
    seenCommonDirs.add(probed.commonDir);
    const rootRepo: DiscoveredRepo = {
      id: ".",
      name: basename(boundary),
      path: boundary,
      commonDir: probed.commonDir,
      commonRoot: commonRootOf(probed.commonDir),
      gitDir: probed.gitDir,
    };
    const nestedRepos = scanChildRepos(boundary, boundary, seenCommonDirs, { allowStandaloneWorktrees: false });
    return {
      gitAvailable: true,
      gitError: null,
      projectBoundary: boundary,
      defaultWorktree: boundary,
      repos: [rootRepo, ...nestedRepos],
    };
  }

  const boundary = safeRealpath(projectDir);
  const children = scanChildRepos(projectDir, boundary, seenCommonDirs, { allowStandaloneWorktrees: true });
  return {
    gitAvailable: true,
    gitError: null,
    projectBoundary: boundary,
    defaultWorktree: null,
    repos: children,
  };
}

/** Discovers repositories under `projectDir` with short-TTL caching and in-flight coalescing. */
export async function discoverProjectRepos(
  projectDir: string,
  opts: { exec?: GitExecutor; forceRefresh?: boolean } = {},
): Promise<ProjectRepoDiscovery> {
  const exec = opts.exec ?? defaultGitExec;
  const useCache = exec === defaultGitExec;
  const key = safeRealpath(projectDir);
  if (useCache && !opts.forceRefresh) {
    const cached = discoveryCache.get(key);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value;
    const running = discoveryInflight.get(key);
    if (running) return running;
  }
  const promise = computeProjectDiscovery(projectDir, exec)
    .then((value) => {
      if (useCache) discoveryCache.set(key, { value, at: Date.now() });
      return value;
    })
    .finally(() => {
      if (useCache && discoveryInflight.get(key) === promise) discoveryInflight.delete(key);
    });
  if (useCache) discoveryInflight.set(key, promise);
  return promise;
}

function toRepoChoices(repos: readonly DiscoveredRepo[]): GitRepoChoice[] {
  return repos.map((r) => ({ id: r.id, path: r.path, name: r.name }));
}

function findDiscoveredRepo(repos: readonly DiscoveredRepo[], requested: string): DiscoveredRepo | undefined {
  const trimmed = requested.trim();
  if (!trimmed) return undefined;
  const wantReal = safeRealpath(trimmed);
  return repos.find(
    (r) => r.id === trimmed || r.name === trimmed || r.path === trimmed || safeRealpath(r.path) === wantReal,
  );
}

async function matchWorktreeInRepos(
  repos: readonly DiscoveredRepo[],
  preferred: DiscoveredRepo | undefined,
  requested: string,
  boundary: string,
  exec: GitExecutor,
): Promise<{ repo: DiscoveredRepo; entry: ParsedWorktreeEntry } | null> {
  const requestedReal = safeRealpath(requested);
  const ordered = preferred ? [preferred, ...repos.filter((r) => r.id !== preferred.id)] : repos;
  for (const repo of ordered) {
    const entries = await listWorktrees(repo.path, exec, `wt-list:${repo.commonDir}`);
    const hit = entries.find(
      (e) =>
        !e.prunable &&
        existsSync(e.path) &&
        isPathWithin(e.path, boundary) &&
        (e.path === requested || safeRealpath(e.path) === requestedReal),
    );
    if (hit) return { repo, entry: hit };
  }
  return null;
}

export async function resolveProjectRepo(
  projectDir: string,
  opts: { repo?: string | null; worktree?: string | null; exec?: GitExecutor } = {},
): Promise<ResolvedRepo> {
  const exec = opts.exec ?? defaultGitExec;
  let discovery = await discoverProjectRepos(projectDir, { exec });

  if (!discovery.gitAvailable || discovery.repos.length === 0) {
    return {
      isRepo: false,
      gitAvailable: discovery.gitAvailable,
      gitError: discovery.gitError,
      repoId: null,
      repoRoot: null,
      commonRoot: null,
      worktreeRoot: null,
      projectBoundary: discovery.projectBoundary,
      defaultWorktree: discovery.defaultWorktree,
      gitDir: null,
      relativePrefix: "",
      repos: [],
      targetDir: projectDir,
    };
  }

  let selectedRepo: DiscoveredRepo | undefined;
  const reqRepo = opts.repo?.trim() || null;
  const reqWt = opts.worktree?.trim() || null;

  if (reqRepo) {
    selectedRepo = findDiscoveredRepo(discovery.repos, reqRepo);
    if (!selectedRepo && !reqWt) {
      discovery = await discoverProjectRepos(projectDir, { exec, forceRefresh: true });
      selectedRepo = findDiscoveredRepo(discovery.repos, reqRepo);
    }
    if (!selectedRepo && !reqWt) {
      throw new HttpError(422, "invalid_args", "repo is not a repository in this project directory");
    }
  }

  let targetDir = (selectedRepo ?? discovery.repos[0]!).path;
  let activeRepo = selectedRepo ?? discovery.repos[0]!;
  let activeGitDir = activeRepo.gitDir;

  if (reqWt) {
    // Worktree wins when both repo and worktree are provided; refresh discovery once on miss.
    let match = await matchWorktreeInRepos(discovery.repos, selectedRepo, reqWt, discovery.projectBoundary, exec);
    if (!match) {
      discovery = await discoverProjectRepos(projectDir, { exec, forceRefresh: true });
      selectedRepo = reqRepo ? findDiscoveredRepo(discovery.repos, reqRepo) : undefined;
      match = await matchWorktreeInRepos(discovery.repos, selectedRepo, reqWt, discovery.projectBoundary, exec);
    }
    if (!match) {
      throw new HttpError(422, "invalid_args", "worktree is not part of this repository");
    }
    activeRepo = match.repo;
    targetDir = match.entry.path;
    const wtProbe = await probeGitDir(targetDir, exec);
    if (wtProbe.ok && wtProbe.gitDir) activeGitDir = wtProbe.gitDir;
  }

  const isDefaultCheckout =
    discovery.defaultWorktree !== null && safeRealpath(targetDir) === safeRealpath(discovery.defaultWorktree);
  const rel =
    isDefaultCheckout && safeRealpath(projectDir) !== safeRealpath(targetDir)
      ? relative(safeRealpath(targetDir), safeRealpath(projectDir)).split("\\").join("/")
      : "";

  return {
    isRepo: true,
    gitAvailable: true,
    gitError: null,
    repoId: activeRepo.id,
    repoRoot: targetDir,
    commonRoot: activeRepo.commonRoot,
    worktreeRoot: targetDir,
    projectBoundary: discovery.projectBoundary,
    defaultWorktree: discovery.defaultWorktree,
    gitDir: activeGitDir,
    relativePrefix: rel && !rel.startsWith("..") ? rel : "",
    repos: toRepoChoices(discovery.repos),
    targetDir,
  };
}
