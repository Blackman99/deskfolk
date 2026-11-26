/**
 * Read-only local API routes for project session GitHub views (ADR 0118).
 */
import { isGitHubListFilter, type GitHubListFilter } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import {
  fetchGitHubIssueDetail,
  fetchGitHubIssues,
  fetchGitHubPrDetail,
  fetchGitHubPulls,
  fetchGitHubRelated,
  probeGitHubStatus,
} from "../../github/graphql";
import { jsonResponse, matchPath } from "../../http";
import type { RouteCtx } from "../route-ctx";

function recentSessionBodies(ctx: RouteCtx, sessionId: string): string[] {
  return ctx.store.db
    .query<{ body: string }, [string]>(
      `SELECT body FROM messages WHERE session_id = ? AND kind IN ('user', 'bot') ORDER BY created_at DESC, rowid DESC LIMIT 200`,
    )
    .all(sessionId)
    .map((r) => r.body);
}

function parsePositiveInt(raw: string): number {
  if (!/^[1-9][0-9]{0,7}$/.test(raw)) throw new HttpError(422, "invalid_args", "number must be a positive integer");
  return Number(raw);
}

export function projectGithubRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { store, method, path, url } = ctx;
  if (method !== "GET") return null;

  const repo = url.searchParams.get("repo");
  const worktree = url.searchParams.get("worktree");
  const refresh = url.searchParams.get("refresh") === "1";

  let params = matchPath(path, "/v1/project-sessions/:id/github");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    return probeGitHubStatus(project.dir, { repo, worktree, refresh }).then((status) => jsonResponse(status, 200, null));
  }

  params = matchPath(path, "/v1/project-sessions/:id/github/related");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const chatMessages = recentSessionBodies(ctx, params.id!);
    return fetchGitHubRelated(project.dir, { repo, worktree, chatMessages, refresh }).then((related) => jsonResponse(related, 200, null));
  }

  params = matchPath(path, "/v1/project-sessions/:id/github/pulls");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const rawFilter = url.searchParams.get("filter") ?? "open";
    if (!isGitHubListFilter(rawFilter)) throw new HttpError(422, "invalid_args", "invalid filter");
    const q = url.searchParams.get("q") ?? "";
    return fetchGitHubPulls(project.dir, { filter: rawFilter as GitHubListFilter, q, repo, worktree, refresh }).then((list) =>
      jsonResponse(list, 200, null),
    );
  }

  params = matchPath(path, "/v1/project-sessions/:id/github/issues");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const rawFilter = url.searchParams.get("filter") ?? "open";
    if (!isGitHubListFilter(rawFilter)) throw new HttpError(422, "invalid_args", "invalid filter");
    const q = url.searchParams.get("q") ?? "";
    return fetchGitHubIssues(project.dir, { filter: rawFilter as GitHubListFilter, q, repo, worktree, refresh }).then((list) =>
      jsonResponse(list, 200, null),
    );
  }

  params = matchPath(path, "/v1/project-sessions/:id/github/pulls/:number");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const num = parsePositiveInt(params.number!);
    return fetchGitHubPrDetail(project.dir, num, { repo, worktree, refresh }).then((detail) => {
      if (!detail) throw new HttpError(404, "not_found", "pull request not found");
      return jsonResponse(detail, 200, null);
    });
  }

  params = matchPath(path, "/v1/project-sessions/:id/github/issues/:number");
  if (params) {
    const project = store.projectOf(params.id!);
    if (!project) throw new HttpError(404, "not_found", "not a project session");
    const num = parsePositiveInt(params.number!);
    return fetchGitHubIssueDetail(project.dir, num, { repo, worktree, refresh }).then((detail) => {
      if (!detail) throw new HttpError(404, "not_found", "issue not found");
      return jsonResponse(detail, 200, null);
    });
  }

  return null;
}
