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

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_UNTRACKED_BYTES = 256 * 1024;

function isBinaryDiff(patch: string): boolean {
  return /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);
}

/** Synthesizes a unified diff for an untracked file so `DiffView` renders it uniformly. */
function readUntrackedPatch(repoRoot: string, relPath: string): GitDiffResponse {
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

  const toRead = Math.min(size, MAX_UNTRACKED_BYTES);
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

  const truncated = size > MAX_UNTRACKED_BYTES;
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
  return {
    path: relPath,
    base: "working",
    commit: null,
    patch,
    binary: false,
    truncated,
    untracked: true,
    bytes: size,
    reason: truncated ? `file exceeds ${Math.round(MAX_UNTRACKED_BYTES / 1024)} KiB preview limit` : null,
  };
}

export async function readGitDiff(
  projectDir: string,
  opts: {
    path: string;
    base?: GitDiffBase;
    commit?: string | null;
    worktree?: string | null;
    repo?: string | null;
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
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec });
  if (!resolved.isRepo) {
    throw new HttpError(404, "not_found", "project directory is not a git repository");
  }

  const targetDir = resolved.targetDir;
  if (opts.commit) {
    const res = await exec(
      targetDir,
      ["show", "--format=", "--patch", "--no-color", "--no-ext-diff", "--no-textconv", "-M", opts.commit, "--", opts.path],
      { timeoutMs: 10_000, maxBytes: MAX_DIFF_BYTES, coalesceKey: `diff-commit:${targetDir}:${opts.commit}:${opts.path}` },
    );
    const patch = res.stdout;
    const binary = isBinaryDiff(patch);
    return {
      path: opts.path,
      base: "commit",
      commit: opts.commit,
      patch: binary ? "" : patch,
      binary,
      truncated: res.truncated,
      untracked: false,
      bytes: Buffer.byteLength(patch, "utf8"),
      reason: res.timedOut ? "git diff timed out" : binary ? "binary file" : res.truncated ? "diff exceeds preview limit" : null,
    };
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
          return readUntrackedPatch(targetDir, opts.path);
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
    maxBytes: MAX_DIFF_BYTES,
    coalesceKey: `diff:${targetDir}:${base}:${opts.path}`,
  });
  const patch = res.stdout;
  const binary = isBinaryDiff(patch);
  return {
    path: opts.path,
    base,
    commit: null,
    patch: binary ? "" : patch,
    binary,
    truncated: res.truncated,
    untracked: false,
    bytes: Buffer.byteLength(patch, "utf8"),
    reason: res.timedOut ? "git diff timed out" : binary ? "binary file" : res.truncated ? "diff exceeds preview limit" : null,
  };
}
