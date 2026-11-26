/**
 * GitHub GraphQL queries via local `gh api graphql` (ADR 0118).
 * Queries PRs, CI status checks, closing issues, referenced issues/PRs, and repository lists
 * with 60-second TTL caching and stale fallback on network errors.
 */
import type {
  GitHubCheckItem,
  GitHubCheckSummary,
  GitHubComment,
  GitHubIssueDetail,
  GitHubIssueListResponse,
  GitHubIssueSummary,
  GitHubLabel,
  GitHubListFilter,
  GitHubPrDetail,
  GitHubPrListResponse,
  GitHubPrSummary,
  GitHubRelatedResponse,
  GitHubRepoStatus,
} from "@real-bot/protocol";
import { defaultGitExec, type GitExecutor } from "../git/exec";
import { resolveProjectRepo } from "../git/repo";
import { parseStatusV2, resolveDefaultMergeBase } from "../git/status";
import { defaultGhExec, StaleTtlCache, type GhExecutor } from "./exec";
import { extractBranchAndCommitRefs, extractChatGitHubRefs, resolveRepoRemotes } from "./remote";

const CACHE_TTL_MS = 60_000;
const relatedCache = new StaleTtlCache<GitHubRelatedResponse>(CACHE_TTL_MS);
const prListCache = new StaleTtlCache<GitHubPrListResponse>(CACHE_TTL_MS);
const issueListCache = new StaleTtlCache<GitHubIssueListResponse>(CACHE_TTL_MS);
const prDetailCache = new StaleTtlCache<GitHubPrDetail>(CACHE_TTL_MS);
const issueDetailCache = new StaleTtlCache<GitHubIssueDetail>(CACHE_TTL_MS);
const authCache = new StaleTtlCache<{ login: string }>(CACHE_TTL_MS * 2);

export function clearGitHubCaches(): void {
  relatedCache.clear();
  prListCache.clear();
  issueListCache.clear();
  prDetailCache.clear();
  issueDetailCache.clear();
  authCache.clear();
}

function isAuthError(stderr: string, code: number): boolean {
  if (code === 4) return true;
  return /not logged into|gh auth login|authentication failed|bad credentials|401|requires authentication|token.*expired/i.test(stderr);
}

function isKnownGitHubHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "github.com" || lower.endsWith(".github.com")) return true;
  if (lower.includes("github")) return true;
  return false;
}

async function runGraphql<T>(
  cwd: string,
  host: string,
  query: string,
  variables: Record<string, string | number>,
  ghExec: GhExecutor,
  coalesceKey?: string,
): Promise<{ ok: true; data: T } | { ok: false; auth: boolean; unavailable: boolean; error: string }> {
  const args = ["api", "--hostname", host, "graphql", "-f", `query=${query}`];
  for (const [key, val] of Object.entries(variables)) {
    if (typeof val === "number") args.push("-F", `${key}=${val}`);
    else args.push("-f", `${key}=${val}`);
  }
  const res = await ghExec(cwd, args, { coalesceKey });
  if (res.unavailable) return { ok: false, auth: false, unavailable: true, error: res.stderr || "gh not installed" };
  if (!res.ok) {
    return {
      ok: false,
      auth: isAuthError(res.stderr, res.code),
      unavailable: false,
      error: res.timedOut ? "GitHub request timed out" : (res.stderr || `gh exited with code ${res.code}`),
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as { data?: T; errors?: Array<{ message?: string }> };
    if (!parsed.data) {
      const msg = parsed.errors?.map((e) => e.message).filter(Boolean).join("; ") || "empty GraphQL response";
      return { ok: false, auth: isAuthError(msg, res.code), unavailable: false, error: msg };
    }
    return { ok: true, data: parsed.data };
  } catch (err) {
    return { ok: false, auth: false, unavailable: false, error: err instanceof Error ? err.message : "invalid JSON from gh" };
  }
}

function parseLabels(raw: unknown): GitHubLabel[] {
  const nodes = (raw as { nodes?: unknown[] } | null | undefined)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((n): n is { name: string; color?: string } => Boolean(n && typeof (n as { name?: unknown }).name === "string"))
    .map((n) => ({ name: n.name, color: typeof n.color === "string" ? n.color : null }));
}

function parseComments(raw: unknown): { comments: GitHubComment[]; truncated: boolean } {
  const conn = raw as { totalCount?: number; nodes?: unknown[] } | null | undefined;
  const nodes = Array.isArray(conn?.nodes) ? conn!.nodes! : [];
  const comments: GitHubComment[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const row = node as { author?: { login?: string } | null; body?: string; createdAt?: string; url?: string };
    comments.push({
      author: row.author?.login ?? "ghost",
      body: typeof row.body === "string" ? row.body : "",
      created_at: typeof row.createdAt === "string" ? row.createdAt : "",
      url: typeof row.url === "string" ? row.url : null,
    });
  }
  const total = typeof conn?.totalCount === "number" ? conn.totalCount : comments.length;
  return { comments, truncated: total > comments.length };
}

function parseChecks(rollup: unknown): GitHubCheckSummary | null {
  const contexts = (rollup as { contexts?: { nodes?: unknown[] } } | null | undefined)?.contexts?.nodes;
  if (!Array.isArray(contexts) || contexts.length === 0) return null;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const items: GitHubCheckItem[] = [];
  for (const node of contexts) {
    if (!node || typeof node !== "object") continue;
    const n = node as {
      __typename?: string;
      name?: string;
      context?: string;
      status?: string;
      state?: string;
      conclusion?: string | null;
      detailsUrl?: string | null;
      targetUrl?: string | null;
    };
    const name = n.name ?? n.context ?? "check";
    const status = (n.status ?? n.state ?? "UNKNOWN").toUpperCase();
    const conclusion = n.conclusion ? n.conclusion.toUpperCase() : null;
    const url = n.detailsUrl ?? n.targetUrl ?? null;
    if (status === "COMPLETED") {
      if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") passed += 1;
      else failed += 1;
    } else if (status === "SUCCESS") {
      passed += 1;
    } else if (status === "FAILURE" || status === "ERROR") {
      failed += 1;
    } else {
      pending += 1;
    }
    items.push({ name, status, conclusion, url });
  }
  return { total: items.length, passed, failed, pending, items: items.slice(0, 30) };
}

function toIssueSummary(raw: unknown, source?: GitHubIssueSummary["source"]): GitHubIssueSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.number !== "number" || typeof n.title !== "string") return null;
  const assigneesRaw = (n.assignees as { nodes?: Array<{ login?: string }> } | null | undefined)?.nodes ?? [];
  return {
    number: n.number,
    title: n.title,
    state: n.state === "CLOSED" ? "CLOSED" : "OPEN",
    url: typeof n.url === "string" ? n.url : "",
    author: (n.author as { login?: string } | null | undefined)?.login ?? "ghost",
    labels: parseLabels(n.labels),
    assignees: assigneesRaw.map((a) => a.login).filter((v): v is string => typeof v === "string"),
    updated_at: typeof n.updatedAt === "string" ? n.updatedAt : "",
    ...(source ? { source } : {}),
  };
}

function toPrSummary(raw: unknown, source?: GitHubPrSummary["source"]): GitHubPrSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.number !== "number" || typeof n.title !== "string") return null;
  const commits = (n.commits as { nodes?: Array<{ commit?: { statusCheckRollup?: unknown } }> } | null | undefined)?.nodes;
  const rollup = commits?.[0]?.commit?.statusCheckRollup ?? null;
  const state = n.state === "MERGED" ? "MERGED" : n.state === "CLOSED" ? "CLOSED" : "OPEN";
  return {
    number: n.number,
    title: n.title,
    state,
    is_draft: Boolean(n.isDraft),
    url: typeof n.url === "string" ? n.url : "",
    author: (n.author as { login?: string } | null | undefined)?.login ?? "ghost",
    head_ref: typeof n.headRefName === "string" ? n.headRefName : "",
    base_ref: typeof n.baseRefName === "string" ? n.baseRefName : "",
    review_decision: typeof n.reviewDecision === "string" ? n.reviewDecision : null,
    updated_at: typeof n.updatedAt === "string" ? n.updatedAt : "",
    additions: typeof n.additions === "number" ? n.additions : 0,
    deletions: typeof n.deletions === "number" ? n.deletions : 0,
    changed_files: typeof n.changedFiles === "number" ? n.changedFiles : 0,
    checks: parseChecks(rollup),
    ...(source ? { source } : {}),
  };
}

function toPrDetail(raw: unknown, source?: GitHubPrSummary["source"]): GitHubPrDetail | null {
  const summary = toPrSummary(raw, source);
  if (!summary) return null;
  const n = raw as Record<string, unknown>;
  const closingRaw = (n.closingIssuesReferences as { nodes?: unknown[] } | null | undefined)?.nodes ?? [];
  const closingIssues = closingRaw.map((item) => toIssueSummary(item, "closing")).filter((v): v is GitHubIssueSummary => v !== null);
  const { comments, truncated } = parseComments(n.comments);
  return {
    ...summary,
    body: typeof n.body === "string" ? n.body : "",
    labels: parseLabels(n.labels),
    closing_issues: closingIssues,
    comments,
    comments_truncated: truncated,
  };
}

function toIssueDetail(raw: unknown, source?: GitHubIssueSummary["source"]): GitHubIssueDetail | null {
  const summary = toIssueSummary(raw, source);
  if (!summary) return null;
  const n = raw as Record<string, unknown>;
  const { comments, truncated } = parseComments(n.comments);
  return {
    ...summary,
    body: typeof n.body === "string" ? n.body : "",
    comments,
    comments_truncated: truncated,
  };
}

export type GitHubDeps = {
  gitExec?: GitExecutor;
  ghExec?: GhExecutor;
};

/** Probes repository GitHub remote and local `gh` authentication status. */
export async function probeGitHubStatus(
  projectDir: string,
  opts: { repo?: string | null; worktree?: string | null; refresh?: boolean } & GitHubDeps = {},
): Promise<GitHubRepoStatus> {
  const gitExec = opts.gitExec ?? defaultGitExec;
  const ghExec = opts.ghExec ?? defaultGhExec;
  const now = new Date().toISOString();

  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec: gitExec });
  if (!resolved.isRepo) {
    return {
      state: "not_repo", host: null, owner: null, repo: null, upstream_owner: null, upstream_repo: null,
      current_branch: null, remote_url: null, login: null, error: null, checked_at: now,
    };
  }

  const stRes = await gitExec(resolved.targetDir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"], {
    coalesceKey: `gh-branch:${resolved.targetDir}`,
  });
  const branch = stRes.ok ? parseStatusV2(stRes.stdout).branch : null;
  const remotes = await resolveRepoRemotes(resolved.targetDir, branch, gitExec);
  if (!remotes.primary) {
    return {
      state: "not_github", host: null, owner: null, repo: null, upstream_owner: null, upstream_repo: null,
      current_branch: branch, remote_url: remotes.rawUrl, login: null, error: null, checked_at: now,
    };
  }

  const { host, owner, repo, url } = remotes.primary;
  const baseFields = {
    host,
    owner,
    repo,
    upstream_owner: remotes.upstream?.owner ?? null,
    upstream_repo: remotes.upstream?.repo ?? null,
    current_branch: branch,
    remote_url: url,
  };

  // Verify `gh` works against this host (also serves as authoritative auth check + GHE detection).
  const authKey = `auth:${host}`;
  if (!opts.refresh) {
    const cached = authCache.getFresh(authKey);
    if (cached) {
      return { state: "ok", ...baseFields, login: cached.value.login, error: null, checked_at: cached.fetchedAt };
    }
  }

  const probe = await runGraphql<{ viewer?: { login?: string } }>(
    resolved.targetDir,
    host,
    "query { viewer { login } }",
    {},
    ghExec,
    `gh-viewer:${host}`,
  );
  if (!probe.ok) {
    if (probe.unavailable) {
      return { state: isKnownGitHubHost(host) ? "no_gh" : "not_github", ...baseFields, login: null, error: probe.error, checked_at: now };
    }
    if (!isKnownGitHubHost(host)) {
      return { state: "not_github", ...baseFields, login: null, error: null, checked_at: now };
    }
    return { state: probe.auth ? "not_authed" : "error", ...baseFields, login: null, error: probe.error, checked_at: now };
  }

  const login = probe.data.viewer?.login ?? null;
  if (login) authCache.set(authKey, { login }, now);
  return { state: "ok", ...baseFields, login, error: null, checked_at: now };
}

const PR_DETAIL_FRAGMENT = `
  number title state isDraft url body updatedAt additions deletions changedFiles headRefName baseRefName reviewDecision
  author { login }
  labels(first: 10) { nodes { name color } }
  closingIssuesReferences(first: 10) {
    nodes {
      number title state url updatedAt
      author { login }
      labels(first: 8) { nodes { name color } }
      assignees(first: 5) { nodes { login } }
    }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 30) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
  comments(last: 15) {
    totalCount
    nodes { author { login } body createdAt url }
  }
`;

const ISSUE_SUMMARY_FRAGMENT = `
  number title state url updatedAt
  author { login }
  labels(first: 8) { nodes { name color } }
  assignees(first: 5) { nodes { login } }
`;

const PR_SUMMARY_FRAGMENT = `
  number title state isDraft url updatedAt additions deletions changedFiles headRefName baseRefName reviewDecision
  author { login }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 20) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
`;

/** Fetches PRs and issues associated with the current branch, unpushed commits, and chat history. */
export async function fetchGitHubRelated(
  projectDir: string,
  opts: {
    repo?: string | null;
    worktree?: string | null;
    chatMessages?: readonly string[];
    refresh?: boolean;
  } & GitHubDeps = {},
): Promise<GitHubRelatedResponse> {
  const gitExec = opts.gitExec ?? defaultGitExec;
  const ghExec = opts.ghExec ?? defaultGhExec;
  const now = new Date().toISOString();
  const status = await probeGitHubStatus(projectDir, { repo: opts.repo, worktree: opts.worktree, refresh: opts.refresh, gitExec, ghExec });
  if (status.state !== "ok" || !status.host || !status.owner || !status.repo) {
    return { status, branch_pr: null, closing_issues: [], referenced_issues: [], referenced_prs: [], stale: false, fetched_at: now, error: status.error };
  }

  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec: gitExec });
  const targetDir = resolved.targetDir;
  const branch = status.current_branch;

  // Gather local signals: branch commits since merge-base + chat URLs.
  let commitSubjects: string[] = [];
  if (branch) {
    const mb = await resolveDefaultMergeBase(targetDir, gitExec);
    const range = mb ? `${mb.mergeBaseOid}..HEAD` : "-n10";
    const logArgs = mb ? ["log", "--max-count=20", "--format=%s%n%b", range] : ["log", "--max-count=10", "--format=%s%n%b", "HEAD"];
    const logRes = await gitExec(targetDir, logArgs, { coalesceKey: `gh-commits:${targetDir}:${range}` });
    if (logRes.ok && logRes.stdout.trim()) commitSubjects = [logRes.stdout];
  }

  const repoTargets = [
    { host: status.host, owner: status.owner, repo: status.repo },
    ...(status.upstream_owner && status.upstream_repo ? [{ host: status.host, owner: status.upstream_owner, repo: status.upstream_repo }] : []),
  ];
  const chatRefs = extractChatGitHubRefs(opts.chatMessages ?? [], repoTargets);
  const localNums = extractBranchAndCommitRefs(branch, commitSubjects);
  const refNumbers = [...new Set([...chatRefs.issues, ...chatRefs.prs, ...localNums])].slice(0, 12);

  const cacheKey = `related:${status.host}:${status.owner}/${status.repo}:${branch ?? ""}:${refNumbers.join(",")}`;
  if (!opts.refresh) {
    const cached = relatedCache.getFresh(cacheKey);
    if (cached) return { ...cached.value, status, stale: false };
  }

  const refOwner = status.upstream_owner ?? status.owner;
  const refRepo = status.upstream_repo ?? status.repo;
  const refAliases = refNumbers
    .map(
      (num, idx) => `
      r${idx}: issueOrPullRequest(number: ${num}) {
        __typename
        ... on Issue { ${ISSUE_SUMMARY_FRAGMENT} }
        ... on PullRequest { ${PR_SUMMARY_FRAGMENT} }
      }`,
    )
    .join("\n");

  const query = `
    query($owner: String!, $repo: String!, $refOwner: String!, $refRepo: String!${branch ? ", $branch: String!" : ""}) {
      primary: repository(owner: $owner, name: $repo) {
        ${branch ? `pullRequests(headRefName: $branch, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_DETAIL_FRAGMENT} } }` : ""}
      }
      ${refNumbers.length > 0 ? `refs: repository(owner: $refOwner, name: $refRepo) { ${refAliases} }` : ""}
    }
  `;

  const vars: Record<string, string | number> = {
    owner: status.owner,
    repo: status.repo,
    refOwner,
    refRepo,
    ...(branch ? { branch } : {}),
  };

  const res = await runGraphql<{
    primary?: { pullRequests?: { nodes?: unknown[] } };
    refs?: Record<string, Record<string, unknown> | null>;
  }>(targetDir, status.host, query, vars, ghExec, `gh-related:${cacheKey}`);

  if (!res.ok) {
    const stale = relatedCache.getStale(cacheKey);
    if (stale) return { ...stale.value, status, stale: true, error: res.error };
    return { status, branch_pr: null, closing_issues: [], referenced_issues: [], referenced_prs: [], stale: false, fetched_at: now, error: res.error };
  }

  const prNodes = res.data.primary?.pullRequests?.nodes ?? [];
  const openPr = prNodes.find((p) => (p as { state?: string })?.state === "OPEN") ?? prNodes[0] ?? null;
  const branchPr = openPr ? toPrDetail(openPr, "branch") : null;
  const closingIssues = branchPr?.closing_issues ?? [];
  const closingSet = new Set(closingIssues.map((i) => i.number));

  const referencedIssues: GitHubIssueSummary[] = [];
  const referencedPrs: GitHubPrSummary[] = [];
  const chatIssueSet = new Set(chatRefs.issues);
  const chatPrSet = new Set(chatRefs.prs);

  if (res.data.refs) {
    for (const node of Object.values(res.data.refs)) {
      if (!node || typeof node !== "object") continue;
      if (node.__typename === "Issue") {
        const issue = toIssueSummary(node, chatIssueSet.has(Number(node.number)) ? "chat" : "commit");
        if (issue && !closingSet.has(issue.number)) referencedIssues.push(issue);
      } else if (node.__typename === "PullRequest") {
        const pr = toPrSummary(node, chatPrSet.has(Number(node.number)) ? "chat" : "commit");
        if (pr && pr.number !== branchPr?.number) referencedPrs.push(pr);
      }
    }
  }

  const out: GitHubRelatedResponse = {
    status,
    branch_pr: branchPr,
    closing_issues: closingIssues,
    referenced_issues: referencedIssues,
    referenced_prs: referencedPrs,
    stale: false,
    fetched_at: now,
    error: null,
  };
  relatedCache.set(cacheKey, out, now);
  return out;
}

function buildSearchQuery(owner: string, repo: string, kind: "pr" | "issue", filter: GitHubListFilter, q: string): string {
  const parts = [`repo:${owner}/${repo}`, `is:${kind}`];
  if (filter === "open") parts.push("is:open");
  else if (filter === "closed") parts.push("is:closed");
  else if (filter === "mine") parts.push("is:open", "involves:@me");
  else if (filter === "review_requested") parts.push("is:open", kind === "pr" ? "review-requested:@me" : "assignee:@me");
  const cleanQ = q.replace(/["\r\n]/g, " ").trim().slice(0, 120);
  if (cleanQ) parts.push(cleanQ);
  return parts.join(" ");
}

export async function fetchGitHubPulls(
  projectDir: string,
  opts: { filter?: GitHubListFilter; q?: string; repo?: string | null; worktree?: string | null; refresh?: boolean } & GitHubDeps = {},
): Promise<GitHubPrListResponse> {
  const gitExec = opts.gitExec ?? defaultGitExec;
  const ghExec = opts.ghExec ?? defaultGhExec;
  const filter: GitHubListFilter = opts.filter ?? "open";
  const q = opts.q?.trim() ?? "";
  const now = new Date().toISOString();
  const status = await probeGitHubStatus(projectDir, { repo: opts.repo, worktree: opts.worktree, refresh: opts.refresh, gitExec, ghExec });
  if (status.state !== "ok" || !status.host || !status.owner || !status.repo) {
    return { items: [], filter, stale: false, fetched_at: now, error: status.error };
  }
  const cacheKey = `pulls:${status.host}:${status.owner}/${status.repo}:${filter}:${q}`;
  if (!opts.refresh) {
    const cached = prListCache.getFresh(cacheKey);
    if (cached) return { ...cached.value, stale: false };
  }
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec: gitExec });
  const searchStr = buildSearchQuery(status.owner, status.repo, "pr", filter, q);
  const query = `
    query($q: String!) {
      search(query: $q, type: ISSUE, first: 30) {
        nodes { ... on PullRequest { ${PR_SUMMARY_FRAGMENT} } }
      }
    }
  `;
  const res = await runGraphql<{ search?: { nodes?: unknown[] } }>(
    resolved.targetDir,
    status.host,
    query,
    { q: searchStr },
    ghExec,
    `gh-pulls:${cacheKey}`,
  );
  if (!res.ok) {
    const stale = prListCache.getStale(cacheKey);
    if (stale) return { ...stale.value, stale: true, error: res.error };
    return { items: [], filter, stale: false, fetched_at: now, error: res.error };
  }
  const items = (res.data.search?.nodes ?? [])
    .map((n) => toPrSummary(n, "list"))
    .filter((v): v is GitHubPrSummary => v !== null);
  const out: GitHubPrListResponse = { items, filter, stale: false, fetched_at: now, error: null };
  prListCache.set(cacheKey, out, now);
  return out;
}

export async function fetchGitHubIssues(
  projectDir: string,
  opts: { filter?: GitHubListFilter; q?: string; repo?: string | null; worktree?: string | null; refresh?: boolean } & GitHubDeps = {},
): Promise<GitHubIssueListResponse> {
  const gitExec = opts.gitExec ?? defaultGitExec;
  const ghExec = opts.ghExec ?? defaultGhExec;
  const filter: GitHubListFilter = opts.filter ?? "open";
  const q = opts.q?.trim() ?? "";
  const now = new Date().toISOString();
  const status = await probeGitHubStatus(projectDir, { repo: opts.repo, worktree: opts.worktree, refresh: opts.refresh, gitExec, ghExec });
  if (status.state !== "ok" || !status.host || !status.owner || !status.repo) {
    return { items: [], filter, stale: false, fetched_at: now, error: status.error };
  }
  const issueOwner = status.upstream_owner ?? status.owner;
  const issueRepo = status.upstream_repo ?? status.repo;
  const cacheKey = `issues:${status.host}:${issueOwner}/${issueRepo}:${filter}:${q}`;
  if (!opts.refresh) {
    const cached = issueListCache.getFresh(cacheKey);
    if (cached) return { ...cached.value, stale: false };
  }
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec: gitExec });
  const searchStr = buildSearchQuery(issueOwner, issueRepo, "issue", filter, q);
  const query = `
    query($q: String!) {
      search(query: $q, type: ISSUE, first: 30) {
        nodes { ... on Issue { ${ISSUE_SUMMARY_FRAGMENT} } }
      }
    }
  `;
  const res = await runGraphql<{ search?: { nodes?: unknown[] } }>(
    resolved.targetDir,
    status.host,
    query,
    { q: searchStr },
    ghExec,
    `gh-issues:${cacheKey}`,
  );
  if (!res.ok) {
    const stale = issueListCache.getStale(cacheKey);
    if (stale) return { ...stale.value, stale: true, error: res.error };
    return { items: [], filter, stale: false, fetched_at: now, error: res.error };
  }
  const items = (res.data.search?.nodes ?? [])
    .map((n) => toIssueSummary(n, "list"))
    .filter((v): v is GitHubIssueSummary => v !== null);
  const out: GitHubIssueListResponse = { items, filter, stale: false, fetched_at: now, error: null };
  issueListCache.set(cacheKey, out, now);
  return out;
}

export async function fetchGitHubPrDetail(
  projectDir: string,
  number: number,
  opts: { repo?: string | null; worktree?: string | null; refresh?: boolean } & GitHubDeps = {},
): Promise<GitHubPrDetail | null> {
  const gitExec = opts.gitExec ?? defaultGitExec;
  const ghExec = opts.ghExec ?? defaultGhExec;
  const status = await probeGitHubStatus(projectDir, { repo: opts.repo, worktree: opts.worktree, refresh: opts.refresh, gitExec, ghExec });
  if (status.state !== "ok" || !status.host || !status.owner || !status.repo) return null;
  const cacheKey = `pr:${status.host}:${status.owner}/${status.repo}:${number}`;
  if (!opts.refresh) {
    const cached = prDetailCache.getFresh(cacheKey);
    if (cached) return cached.value;
  }
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec: gitExec });
  const query = `
    query($owner: String!, $repo: String!, $num: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $num) { ${PR_DETAIL_FRAGMENT} }
      }
    }
  `;
  const res = await runGraphql<{ repository?: { pullRequest?: unknown } }>(
    resolved.targetDir,
    status.host,
    query,
    { owner: status.owner, repo: status.repo, num: number },
    ghExec,
    `gh-pr:${cacheKey}`,
  );
  if (!res.ok) return prDetailCache.getStale(cacheKey)?.value ?? null;
  const detail = toPrDetail(res.data.repository?.pullRequest);
  if (detail) prDetailCache.set(cacheKey, detail);
  return detail;
}

export async function fetchGitHubIssueDetail(
  projectDir: string,
  number: number,
  opts: { repo?: string | null; worktree?: string | null; refresh?: boolean } & GitHubDeps = {},
): Promise<GitHubIssueDetail | null> {
  const gitExec = opts.gitExec ?? defaultGitExec;
  const ghExec = opts.ghExec ?? defaultGhExec;
  const status = await probeGitHubStatus(projectDir, { repo: opts.repo, worktree: opts.worktree, refresh: opts.refresh, gitExec, ghExec });
  if (status.state !== "ok" || !status.host || !status.owner || !status.repo) return null;
  const issueOwner = status.upstream_owner ?? status.owner;
  const issueRepo = status.upstream_repo ?? status.repo;
  const cacheKey = `issue:${status.host}:${issueOwner}/${issueRepo}:${number}`;
  if (!opts.refresh) {
    const cached = issueDetailCache.getFresh(cacheKey);
    if (cached) return cached.value;
  }
  const resolved = await resolveProjectRepo(projectDir, { repo: opts.repo, worktree: opts.worktree, exec: gitExec });
  const query = `
    query($owner: String!, $repo: String!, $num: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $num) {
          ${ISSUE_SUMMARY_FRAGMENT}
          body
          comments(last: 25) {
            totalCount
            nodes { author { login } body createdAt url }
          }
        }
      }
    }
  `;
  const res = await runGraphql<{ repository?: { issue?: unknown } }>(
    resolved.targetDir,
    status.host,
    query,
    { owner: issueOwner, repo: issueRepo, num: number },
    ghExec,
    `gh-issue:${cacheKey}`,
  );
  if (!res.ok) return issueDetailCache.getStale(cacheKey)?.value ?? null;
  const detail = toIssueDetail(res.data.repository?.issue);
  if (detail) issueDetailCache.set(cacheKey, detail);
  return detail;
}
