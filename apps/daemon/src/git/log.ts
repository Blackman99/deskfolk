/**
 * Git commit history log and commit detail reader for the commit graph view (ADR 0118).
 * Omits author emails; attaches branch, tag, HEAD, and sibling worktree markers.
 */
import type { GitCommitDetail, GitLogCommit, GitLogRef, GitLogResponse } from "@real-bot/protocol";
import { basename } from "node:path";
import { HttpError } from "../errors";
import { defaultGitExec, isValidCommitOid, type GitExecutor } from "./exec";
import { isPathWithin, resolveProjectRepo, safeRealpath } from "./repo";
import { parseNameStatusZ, parseNumstatZ, resolveDefaultMergeBase, type NumstatEntry } from "./status";
import { parseWorktreePorcelain } from "./worktrees";

const DEFAULT_LIMIT = 150;
const MAX_LIMIT = 500;
const MAX_COMMIT_FILES = 300;
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

/** Parses `%D` decoration list into structured refs. */
export function parseDecorations(raw: string): GitLogRef[] {
  if (!raw.trim()) return [];
  const refs: GitLogRef[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part === "HEAD") {
      refs.push({ name: "HEAD", kind: "head" });
    } else if (part.startsWith("HEAD -> ")) {
      refs.push({ name: "HEAD", kind: "head" });
      refs.push({ name: part.slice("HEAD -> ".length).trim(), kind: "local" });
    } else if (part.startsWith("tag: ")) {
      refs.push({ name: part.slice("tag: ".length).trim(), kind: "tag" });
    } else if (part.includes("/")) {
      // Distinguish remotes (origin/main) from local slash branches (feat/x) heuristically;
      // remote-tracking refs typically start with a remote name or `remotes/`.
      const clean = part.startsWith("refs/remotes/") ? part.slice("refs/remotes/".length) : part;
      const isRemote = part.startsWith("origin/") || part.startsWith("upstream/") || part.startsWith("refs/remotes/");
      refs.push({ name: clean, kind: isRemote ? "remote" : "local" });
    } else {
      refs.push({ name: part, kind: "local" });
    }
  }
  return refs;
}

export function parseLogOutput(stdout: string): GitLogCommit[] {
  const commits: GitLogCommit[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\r?\n/, "");
    if (!trimmed) continue;
    const fields = trimmed.split(FIELD_SEP);
    const oid = fields[0]?.trim();
    if (!oid) continue;
    const shortOid = fields[1]?.trim() || oid.slice(0, 7);
    const parentsRaw = fields[2]?.trim() ?? "";
    const parents = parentsRaw ? parentsRaw.split(/\s+/).filter(Boolean) : [];
    const authorName = fields[3]?.trim() ?? "";
    const authoredAt = fields[4]?.trim() ?? "";
    const subject = fields[5]?.trim() ?? "";
    const refs = parseDecorations(fields[6] ?? "");
    commits.push({
      oid,
      short_oid: shortOid,
      parents,
      author_name: authorName,
      authored_at: authoredAt,
      subject,
      refs,
    });
  }
  return commits;
}

export async function readGitLog(
  projectDir: string,
  opts: { scope?: "branch" | "all"; limit?: number; skip?: number; worktree?: string | null; repo?: string | null; exec?: GitExecutor } = {},
): Promise<GitLogResponse | null> {
  const exec = opts.exec ?? defaultGitExec;
  const now = new Date().toISOString();
  const scope = opts.scope === "all" ? "all" : "branch";
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  const skip = Math.max(0, Math.floor(opts.skip ?? 0));
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec });
  if (!resolved.isRepo || !resolved.repoRoot) return null;

  const targetDir = resolved.targetDir;
  const wtRes = await exec(targetDir, ["worktree", "list", "--porcelain"], {
    coalesceKey: `wt-list:${resolved.commonRoot ?? targetDir}`,
  });
  const worktrees = (wtRes.ok ? parseWorktreePorcelain(wtRes.stdout) : []).filter((wt) =>
    isPathWithin(wt.path, resolved.projectBoundary),
  );
  const currentReal = safeRealpath(targetDir);

  const revs: string[] = [];
  if (scope === "all") {
    revs.push("--all");
  } else {
    revs.push("HEAD");
    // Include upstream, default mainline, and sibling worktree tips so the graph shows context.
    const up = await exec(targetDir, ["rev-parse", "--verify", "--quiet", "@{upstream}"], { coalesceKey: `up:${targetDir}` });
    if (up.ok && up.stdout.trim()) revs.push(up.stdout.trim());
    const mb = await resolveDefaultMergeBase(targetDir, exec);
    if (mb?.baseRef) revs.push(mb.baseRef);
    for (const wt of worktrees) {
      if (wt.headOid && !revs.includes(wt.headOid)) revs.push(wt.headOid);
    }
  }

  const format = `${RECORD_SEP}%H${FIELD_SEP}%h${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}%D`;
  const args = [
    "log",
    "--topo-order",
    `--max-count=${limit + 1}`,
    ...(skip > 0 ? [`--skip=${skip}`] : []),
    `--format=${format}`,
    ...revs,
  ];
  const res = await exec(targetDir, args, {
    timeoutMs: 10_000,
    coalesceKey: `log:${targetDir}:${scope}:${limit}:${skip}`,
  });
  if (!res.ok) {
    return { repo_root: resolved.repoRoot, scope, commits: [], has_more: false, checked_at: now };
  }

  const parsed = parseLogOutput(res.stdout);
  const hasMore = parsed.length > limit;
  const commits = parsed.slice(0, limit);

  // Attach sibling worktree badges to commits matching their HEAD.
  const wtByOid = new Map<string, GitLogRef[]>();
  for (const wt of worktrees) {
    if (!wt.headOid) continue;
    if (safeRealpath(wt.path) === currentReal) continue;
    const list = wtByOid.get(wt.headOid) ?? [];
    list.push({ name: wt.branch ? `wt:${wt.branch}` : `wt:${basename(wt.path)}`, kind: "worktree", worktree_path: wt.path });
    wtByOid.set(wt.headOid, list);
  }
  for (const commit of commits) {
    const extra = wtByOid.get(commit.oid);
    if (extra) commit.refs.push(...extra);
  }

  return { repo_root: resolved.repoRoot, scope, commits, has_more: hasMore, checked_at: now };
}

export async function readGitCommitDetail(
  projectDir: string,
  oid: string,
  opts: { worktree?: string | null; repo?: string | null; exec?: GitExecutor } = {},
): Promise<GitCommitDetail> {
  if (!isValidCommitOid(oid)) {
    throw new HttpError(422, "invalid_args", "invalid commit hash");
  }
  const exec = opts.exec ?? defaultGitExec;
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec });
  if (!resolved.isRepo) {
    throw new HttpError(404, "not_found", "project directory is not a git repository");
  }
  const targetDir = resolved.targetDir;
  const metaFormat = `%H${FIELD_SEP}%h${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}%D${FIELD_SEP}%b`;
  const [metaRes, nsRes, numRes] = await Promise.all([
    exec(targetDir, ["show", "--no-patch", `--format=${metaFormat}`, oid], { coalesceKey: `commit-meta:${targetDir}:${oid}` }),
    exec(targetDir, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "-M", "--root", oid], { coalesceKey: `commit-ns:${targetDir}:${oid}` }),
    exec(targetDir, ["diff-tree", "--no-commit-id", "--numstat", "-r", "-z", "-M", "--root", oid], { coalesceKey: `commit-num:${targetDir}:${oid}` }),
  ]);
  if (!metaRes.ok || !metaRes.stdout.trim()) {
    throw new HttpError(404, "not_found", "commit not found");
  }
  const parts = metaRes.stdout.split(FIELD_SEP);
  const fullOid = parts[0]?.trim() || oid;
  const shortOid = parts[1]?.trim() || fullOid.slice(0, 7);
  const parents = (parts[2]?.trim() ?? "").split(/\s+/).filter(Boolean);
  const authorName = parts[3]?.trim() ?? "";
  const authoredAt = parts[4]?.trim() ?? "";
  const subject = parts[5]?.trim() ?? "";
  const refs = parseDecorations(parts[6] ?? "");
  const body = parts.slice(7).join(FIELD_SEP).trim();

  const stats = numRes.ok ? parseNumstatZ(numRes.stdout) : new Map<string, NumstatEntry>();
  const rawFiles = nsRes.ok ? parseNameStatusZ(nsRes.stdout) : [];
  const files = rawFiles.map((f) => {
    const s = stats.get(f.path);
    return s ? { ...f, additions: s.additions, deletions: s.deletions, binary: s.binary } : f;
  });

  return {
    oid: fullOid,
    short_oid: shortOid,
    parents,
    author_name: authorName,
    authored_at: authoredAt,
    subject,
    body,
    refs,
    files: files.slice(0, MAX_COMMIT_FILES),
    truncated: files.length > MAX_COMMIT_FILES,
  };
}
