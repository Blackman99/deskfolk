/**
 * GitHub associated Issues and Pull Requests for project sessions (ADR 0118).
 * Read-only via the user's local `gh` CLI; the app stores no GitHub credentials.
 */

export type GitHubAvailability = "ok" | "not_repo" | "not_github" | "no_gh" | "not_authed" | "error";

export const GITHUB_LIST_FILTERS = ["open", "mine", "review_requested", "closed"] as const;
export type GitHubListFilter = (typeof GITHUB_LIST_FILTERS)[number];

export function isGitHubListFilter(value: unknown): value is GitHubListFilter {
  return typeof value === "string" && (GITHUB_LIST_FILTERS as readonly string[]).includes(value);
}

/** `GET /v1/project-sessions/:id/github`: repository detection and `gh` authentication readiness. */
export type GitHubRepoStatus = {
  state: GitHubAvailability;
  host: string | null;
  owner: string | null;
  repo: string | null;
  upstream_owner: string | null;
  upstream_repo: string | null;
  current_branch: string | null;
  remote_url: string | null;
  login: string | null;
  error: string | null;
  checked_at: string;
};

export type GitHubCheckItem = {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
};

export type GitHubCheckSummary = {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  items: GitHubCheckItem[];
};

export type GitHubLabel = {
  name: string;
  color: string | null;
};

export type GitHubComment = {
  author: string;
  body: string;
  created_at: string;
  url: string | null;
};

export type GitHubPrState = "OPEN" | "CLOSED" | "MERGED";
export type GitHubIssueState = "OPEN" | "CLOSED";

export type GitHubPrSummary = {
  number: number;
  title: string;
  state: GitHubPrState;
  is_draft: boolean;
  url: string;
  author: string;
  head_ref: string;
  base_ref: string;
  review_decision: string | null;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  checks: GitHubCheckSummary | null;
  source?: "branch" | "commit" | "chat" | "list";
};

export type GitHubIssueSummary = {
  number: number;
  title: string;
  state: GitHubIssueState;
  url: string;
  author: string;
  labels: GitHubLabel[];
  assignees: string[];
  updated_at: string;
  source?: "closing" | "branch" | "commit" | "chat" | "list";
};

export type GitHubPrDetail = GitHubPrSummary & {
  body: string;
  labels: GitHubLabel[];
  closing_issues: GitHubIssueSummary[];
  comments: GitHubComment[];
  comments_truncated: boolean;
};

export type GitHubIssueDetail = GitHubIssueSummary & {
  body: string;
  comments: GitHubComment[];
  comments_truncated: boolean;
};

/** `GET /v1/project-sessions/:id/github/related`: PRs and issues linked to this branch and conversation. */
export type GitHubRelatedResponse = {
  status: GitHubRepoStatus;
  branch_pr: GitHubPrDetail | null;
  closing_issues: GitHubIssueSummary[];
  referenced_issues: GitHubIssueSummary[];
  referenced_prs: GitHubPrSummary[];
  stale: boolean;
  fetched_at: string;
  error: string | null;
};

/** `GET /v1/project-sessions/:id/github/pulls`. */
export type GitHubPrListResponse = {
  items: GitHubPrSummary[];
  filter: GitHubListFilter;
  stale: boolean;
  fetched_at: string;
  error: string | null;
};

/** `GET /v1/project-sessions/:id/github/issues`. */
export type GitHubIssueListResponse = {
  items: GitHubIssueSummary[];
  filter: GitHubListFilter;
  stale: boolean;
  fetched_at: string;
  error: string | null;
};
