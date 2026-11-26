/**
 * Single-file unified diff reader for `DiffView` (ADR 0118).
 * Handles working tree, staged, unstaged, merge-base, commit diffs, untracked files, binary files,
 * and byte-bounded truncation safely.
 */
import type { GitDiffBase, GitDiffResponse } from "@real-bot/protocol";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { HttpError } from "../errors";
import { defaultGitExec, isSafeRepoRelPath, isValidCommitOid, type GitExecutor } from "./exec";
import { resolveProjectRepo, safeRealpath } from "./repo";
import { resolveDefaultMergeBase } from "./status";

const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;
const MIN_DIFF_BYTES = 16 * 1024;
const HARD_MAX_DIFF_BYTES = 700 * 1024;
const MAX_UNTRACKED_BYTES = 256 * 1024;
/** Safe ceiling for JSON-encoded response bytes (leaves headroom under remote's 1 MiB message cap). */
const MAX_SERIALIZED_RESPONSE_BYTES = 900 * 1024;

export function clampDiffMaxBytes(raw?: number | null): number {
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return DEFAULT_MAX_DIFF_BYTES;
  return Math.max(MIN_DIFF_BYTES, Math.min(HARD_MAX_DIFF_BYTES, Math.floor(raw)));
}

/** Ensures the JSON-encoded response stays safely below the 1 MiB remote message limit even after escaping. */
export function boundDiffResponseBytes(resp: GitDiffResponse, maxWireBytes = MAX_SERIALIZED_RESPONSE_BYTES): GitDiffResponse {
  if (!resp.patch) return resp;
  let wireLen = Buffer.byteLength(JSON.stringify(resp), "utf8");
  if (wireLen <= maxWireBytes) return resp;
  let patch = resp.patch;
  while (wireLen > maxWireBytes && patch.length > 0) {
    const ratio = (maxWireBytes * 0.85) / wireLen;
    const nextLen = Math.max(0, Math.min(patch.length - 1, Math.floor(patch.length * ratio)));
    const cut = patch.lastIndexOf("\n", nextLen);
    patch = cut > 0 ? patch.slice(0, cut + 1) : patch.slice(0, nextLen);
    wireLen = Buffer.byteLength(JSON.stringify({ ...resp, patch, truncated: true }), "utf8");
  }
  return {
    ...resp,
    patch,
    truncated: true,
    reason: resp.reason ?? "diff exceeds preview limit",
  };
}

function isBinaryDiff(patch: string): boolean {
  return /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);
}

/** Synthesizes a unified diff for an untracked file so `DiffView` renders it uniformly. */
function readUntrackedPatch(repoRoot: string, relPath: string, maxBytes: number): GitDiffResponse {
  const full = resolve(repoRoot, relPath);
  const rootReal = safeRealpath(repoRoot);
  const fullReal = safeRealpath(full);
  if (fullReal !== rootReal && !fullReal.startsWith(`${rootReal}/`) && !fullReal.startsWith(`${rootReal}\\`)) {
    throw new HttpError(422, "invalid_args", "path escapes repository root");
  }
  let size = 0;
  try {
    const st = statSync(full);
    if (!st.isFile()) {
      return { path: relPath, base: "working", commit: null, patch: "", binary: false, truncated: false, untracked: true, bytes: 0, reason: "not a regular file" };
    }
    size = st.size;
  } catch {
    return { path: relPath, base: "working", commit: null, patch: "", binary: false, truncated: false, untracked: true, bytes: 0, reason: "file not found" };
  }

  const limit = Math.min(MAX_UNTRACKED_BYTES, maxBytes);
  const toRead = Math.min(size, limit);
  const buf = Buffer.alloc(toRead);
  const fd = openSync(full, "r");
  try {
    readSync(fd, buf, 0, toRead, 0);
  } finally {
    closeSync(fd);
  }

  // Detect NUL bytes in the initial window as binary.
  const probeLen = Math.min(toRead, 8192);
  for (let i = 0; i < probeLen; i += 1) {
    if (buf[i] === 0) {
      return { path: relPath, base: "working", commit: null, patch: "", binary: true, truncated: false, untracked: true, bytes: size, reason: "binary file" };
    }
  }

  const truncated = size > limit;
  const text = buf.toString("utf8").replace(/\r\n/g, "\n");
  const lines = text.length === 0 ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relPath}`,
    lines.length > 0 ? `@@ -0,0 +1,${lines.length} @@` : "",
  ].filter(Boolean);
  const body = lines.map((line) => `+${line}`);
  const patch = [...header, ...body].join("\n") + (lines.length > 0 ? "\n" : "");
  return boundDiffResponseBytes({
    path: relPath,
    base: "working",
    commit: null,
    patch,
    binary: false,
    truncated,
    untracked: true,
    bytes: size,
    reason: truncated ? `file exceeds ${Math.round(limit / 1024)} KiB preview limit` : null,
  });
}

export async function readGitDiff(
  projectDir: string,
  opts: {
    path: string;
    base?: GitDiffBase;
    commit?: string | null;
    worktree?: string | null;
    repo?: string | null;
    maxBytes?: number | null;
    exec?: GitExecutor;
  },
): Promise<GitDiffResponse> {
  if (!isSafeRepoRelPath(opts.path)) {
    throw new HttpError(422, "invalid_args", "invalid repository-relative path");
  }
  if (opts.commit && !isValidCommitOid(opts.commit)) {
    throw new HttpError(422, "invalid_args", "invalid commit hash");
  }
  const exec = opts.exec ?? defaultGitExec;
  const base: GitDiffBase = opts.base ?? "working";
  const maxBytes = clampDiffMaxBytes(opts.maxBytes);
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec });
  if (!resolved.isRepo) {
    throw new HttpError(404, "not_found", "project directory is not a git repository");
  }

  const targetDir = resolved.targetDir;
  if (opts.commit) {
    const res = await exec(
      targetDir,
      ["show", "--format=", "--patch", "--no-color", "--no-ext-diff", "--no-textconv", "-M", opts.commit, "--", opts.path],
      { timeoutMs: 10_000, maxBytes, coalesceKey: `diff-commit:${targetDir}:${opts.commit}:${opts.path}:${maxBytes}` },
    );
    const patch = res.stdout;
    const binary = isBinaryDiff(patch);
    return boundDiffResponseBytes({
      path: opts.path,
      base: "commit",
      commit: opts.commit,
      patch: binary ? "" : patch,
      binary,
      truncated: res.truncated,
      untracked: false,
      bytes: Buffer.byteLength(patch, "utf8"),
      reason: res.timedOut ? "git diff timed out" : binary ? "binary file" : res.truncated ? "diff exceeds preview limit" : null,
    });
  }

  // Check untracked files when viewing working tree or unstaged changes.
  if (base === "working" || base === "unstaged") {
    const tracked = await exec(targetDir, ["ls-files", "--error-unmatch", "--", opts.path], {
      timeoutMs: 4_000,
      coalesceKey: `ls-files:${targetDir}:${opts.path}`,
    });
    if (!tracked.ok && !tracked.unavailable) {
      const fullPath = join(targetDir, opts.path);
      try {
        if (statSync(fullPath).isFile()) {
          return readUntrackedPatch(targetDir, opts.path, maxBytes);
        }
      } catch {
        // File might be deleted/missing; fall through to git diff.
      }
    }
  }

  let args: string[];
  if (base === "staged") {
    args = ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--", opts.path];
  } else if (base === "unstaged") {
    args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--", opts.path];
  } else if (base === "merge-base") {
    const mb = await resolveDefaultMergeBase(targetDir, exec);
    if (!mb) {
      return { path: opts.path, base, commit: null, patch: "", binary: false, truncated: false, untracked: false, bytes: 0, reason: "no default branch found" };
    }
    args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", mb.mergeBaseOid, "--", opts.path];
  } else {
    // `working`: compare working tree against HEAD, or cached if repository has no commits yet.
    const headOk = await exec(targetDir, ["rev-parse", "--verify", "--quiet", "HEAD"], { coalesceKey: `has-head:${targetDir}` });
    args = headOk.ok
      ? ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "HEAD", "--", opts.path]
      : ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--", opts.path];
  }

  const res = await exec(targetDir, args, {
    timeoutMs: 10_000,
    maxBytes,
    coalesceKey: `diff:${targetDir}:${base}:${opts.path}:${maxBytes}`,
  });
  const patch = res.stdout;
  const binary = isBinaryDiff(patch);
  return boundDiffResponseBytes({
    path: opts.path,
    base,
    commit: null,
    patch: binary ? "" : patch,
    binary,
    truncated: res.truncated,
    untracked: false,
    bytes: Buffer.byteLength(patch, "utf8"),
    reason: res.timedOut ? "git diff timed out" : binary ? "binary file" : res.truncated ? "diff exceeds preview limit" : null,
  });
}
