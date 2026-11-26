/**
 * Read-only local API routes for project session Git views (ADR 0118).
 * Every route derives the working directory from `store.projectOf(id).dir` and validates
 * `worktree`, `repo`, `base`, `path`, and `oid` strictly.
 */
import { isGitDiffBase, type GitDiffBase } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { readGitDiff } from "../../git/diff";
import { readGitCommitDetail, readGitLog } from "../../git/log";
import { readGitChanges, readGitSummary } from "../../git/status";
import { readGitProjectTree, readGitWorktrees, type SessionDirRef } from "../../git/worktrees";
import { jsonResponse, matchPath } from "../../http";
import type { RouteCtx } from "../route-ctx";

function projectSessionsForWorktrees(ctx: RouteCtx): SessionDirRef[] {
  const liveRunSet = new Set(ctx.store.listLiveAgentRuns().map((r) => r.session_id));
  const rows = ctx.store.db
    .query<{ id: string; project_dir: string }, []>(
      `SELECT id, project_dir FROM sessions WHERE kind = 'project' AND project_dir IS NOT NULL AND project_dir != '' AND project_parent_id IS NULL AND archived_at IS NULL`,
    )
    .all();
  return rows.map((row) => ({ id: row.id, dir: row.project_dir, live: liveRunSet.has(row.id) }));
}

export function projectGitRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { store, method, path, url } = ctx;
  if (method !== "GET") return null;

  let params = matchPath(path, "/v1/project-sessions/:id/git");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const repo = url.searchParams.get("repo");
    const worktree = url.searchParams.get("worktree");
    const includeOther = url.searchParams.get("other") === "1";
    return readGitSummary(project.dir, { repo, worktree, includeOtherWorktrees: includeOther })
      .then((summary) => jsonResponse(summary, 200, null));
  }

  params = matchPath(path, "/v1/project-sessions/:id/git/tree");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const refresh = url.searchParams.get("refresh") === "1";
    const sessions = projectSessionsForWorktrees(ctx);
    return readGitProjectTree(project.dir, { sessions, refresh })
      .then((tree) => jsonResponse(tree, 200, null));
  }

  params = matchPath(path, "/v1/project-sessions/:id/git/changes");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const rawBase = url.searchParams.get("base") ?? "working";
    if (!isGitDiffBase(rawBase)) throw new HttpError(422, "invalid_args", "base must be working, staged, unstaged, or merge-base");
    const repo = url.searchParams.get("repo");
    const worktree = url.searchParams.get("worktree");
    const scope = url.searchParams.get("scope") === "dir" ? "dir" : "repo";
    return readGitChanges(project.dir, { base: rawBase as GitDiffBase, repo, worktree, scope })
      .then((changes) => jsonResponse(changes, 200, null));
  }

  params = matchPath(path, "/v1/project-sessions/:id/git/diff");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const filePath = url.searchParams.get("path") ?? "";
    const rawBase = url.searchParams.get("base") ?? "working";
    const commit = url.searchParams.get("commit");
    if (!commit && !isGitDiffBase(rawBase)) {
      throw new HttpError(422, "invalid_args", "base must be working, staged, unstaged, or merge-base");
    }
    const repo = url.searchParams.get("repo");
    const worktree = url.searchParams.get("worktree");
    return readGitDiff(project.dir, {
      path: filePath,
      base: isGitDiffBase(rawBase) ? rawBase : "working",
      commit,
      repo,
      worktree,
    }).then((diff) => jsonResponse(diff, 200, null));
  }

  params = matchPath(path, "/v1/project-sessions/:id/git/worktrees");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const repo = url.searchParams.get("repo");
    const sessions = projectSessionsForWorktrees(ctx);
    return readGitWorktrees(project.dir, { repo, sessions }).then((res) => {
      if (!res) throw new HttpError(404, "not_found", "project directory is not a git repository");
      return jsonResponse(res, 200, null);
    });
  }

  params = matchPath(path, "/v1/project-sessions/:id/git/log");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const scope = url.searchParams.get("scope") === "all" ? "all" : "branch";
    const limitRaw = url.searchParams.get("limit");
    const skipRaw = url.searchParams.get("skip");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const skip = skipRaw ? Number(skipRaw) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new HttpError(422, "invalid_args", "invalid limit");
    if (skip !== undefined && (!Number.isFinite(skip) || skip < 0)) throw new HttpError(422, "invalid_args", "invalid skip");
    const repo = url.searchParams.get("repo");
    const worktree = url.searchParams.get("worktree");
    return readGitLog(project.dir, { scope, limit, skip, repo, worktree }).then((res) => {
      if (!res) throw new HttpError(404, "not_found", "project directory is not a git repository");
      return jsonResponse(res, 200, null);
    });
  }

  params = matchPath(path, "/v1/project-sessions/:id/git/commits/:oid");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const repo = url.searchParams.get("repo");
    const worktree = url.searchParams.get("worktree");
    return readGitCommitDetail(project.dir, params.oid!, { repo, worktree })
      .then((detail) => jsonResponse(detail, 200, null));
  }

  return null;
}
