/**
 * Git views for project sessions (ADR 0118): repository summary, working/branch diffs, linked
 * worktrees with their active sessions, and commit history graph data. Read-only in v1.
 */

export const GIT_DIFF_BASES = ["working", "staged", "unstaged", "merge-base"] as const;
export type GitDiffBase = (typeof GIT_DIFF_BASES)[number];

export function isGitDiffBase(value: unknown): value is GitDiffBase {
  return typeof value === "string" && (GIT_DIFF_BASES as readonly string[]).includes(value);
}

export const GIT_PANE_VIEWS = ["changes", "graph", "github"] as const;
export type GitPaneView = (typeof GIT_PANE_VIEWS)[number];

export function isGitPaneView(value: unknown): value is GitPaneView {
  return typeof value === "string" && (GIT_PANE_VIEWS as readonly string[]).includes(value);
}

export type GitOperationKind = "merge" | "rebase" | "cherry-pick" | "revert";

/** One repository discovered under a project directory (`id` is relative to project boundary, `"."` for root). */
export type GitRepoChoice = {
  id: string;
  path: string;
  name: string;
};

/** `GET /v1/project-sessions/:id/git`: lightweight repository status for headers and polling. */
export type GitRepoSummary = {
  is_repo: boolean;
  git_available: boolean;
  git_error: string | null;
  /** Project-boundary-relative id of the active repo (`"."` for the root repo). */
  repo_id: string | null;
  repo_root: string | null;
  common_root: string | null;
  worktree_root: string | null;
  /** Canonical project boundary root shared by repo/worktree discovery and validation. */
  project_boundary: string | null;
  /** Default worktree containing the project session's own directory, or null for multi-repo parent folders. */
  default_worktree: string | null;
  /** Non-empty when the project directory is a subdirectory inside `repo_root`. */
  relative_prefix: string;
  /** Repositories discovered under the project directory (root + independent child repos). */
  repos: GitRepoChoice[];
  branch: string | null;
  head_oid: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
  conflicted_count: number;
  dirty_count: number;
  operation: GitOperationKind | null;
  /** Sibling worktrees in the same repository that currently have uncommitted changes. */
  other_dirty_worktrees: number;
  /** Lightweight change token; unchanged means file list and diffs need not be refetched. */
  signature: string;
  checked_at: string;
};

export type GitFileStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?";

export type GitChangeFile = {
  path: string;
  old_path: string | null;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

/** `GET /v1/project-sessions/:id/git/changes`: changed files against working tree or merge-base. */
export type GitChangesResponse = {
  base: GitDiffBase;
  base_ref: string | null;
  worktree: string;
  files: GitChangeFile[];
  truncated: boolean;
  total_files: number;
  checked_at: string;
};

/** `GET /v1/project-sessions/:id/git/diff`: single-file unified diff for `DiffView`. */
export type GitDiffResponse = {
  path: string;
  base: GitDiffBase | "commit";
  commit: string | null;
  patch: string;
  binary: boolean;
  truncated: boolean;
  untracked: boolean;
  bytes: number;
  reason: string | null;
};

/** One linked or main worktree in the repository, paired with project sessions rooted inside it. */
export type GitWorktreeInfo = {
  path: string;
  branch: string | null;
  head_oid: string | null;
  detached: boolean;
  is_main: boolean;
  is_current: boolean;
  locked: boolean;
  locked_reason: string | null;
  prunable: boolean;
  dirty_count: number | null;
  ahead: number | null;
  behind: number | null;
  session_ids: string[];
  live_session_ids: string[];
};

/** `GET /v1/project-sessions/:id/git/worktrees`. */
export type GitWorktreesResponse = {
  repo_root: string;
  common_root: string;
  worktrees: GitWorktreeInfo[];
  checked_at: string;
};

/** One worktree node in the zero-status `GET /v1/project-sessions/:id/git/tree` hierarchy. */
export type GitTreeWorktree = {
  path: string;
  /** Path relative to the project boundary (`"."` when equal to the boundary). */
  rel_path: string;
  branch: string | null;
  head_oid: string | null;
  detached: boolean;
  is_main: boolean;
  /** True when this worktree encloses the project session's own directory. */
  is_project_dir: boolean;
  locked: boolean;
  locked_reason: string | null;
  prunable: boolean;
  session_ids: string[];
};

/** One repository group in `GET /v1/project-sessions/:id/git/tree`. */
export type GitTreeRepo = {
  /** Project-boundary-relative repo id (`"."` for the root repo). */
  id: string;
  name: string;
  repo_root: string;
  common_root: string;
  error: string | null;
  worktrees: GitTreeWorktree[];
};

/** `GET /v1/project-sessions/:id/git/tree`: zero-status repo -> worktree hierarchy for a project. */
export type GitProjectTreeResponse = {
  git_available: boolean;
  git_error: string | null;
  project_boundary: string;
  default_repo_id: string | null;
  default_worktree: string | null;
  repos: GitTreeRepo[];
  checked_at: string;
};

export type GitLogRefKind = "head" | "local" | "remote" | "tag" | "worktree";

export type GitLogRef = {
  name: string;
  kind: GitLogRefKind;
  worktree_path?: string;
};

export type GitLogCommit = {
  oid: string;
  short_oid: string;
  parents: string[];
  author_name: string;
  authored_at: string;
  subject: string;
  refs: GitLogRef[];
};

/** `GET /v1/project-sessions/:id/git/log`. */
export type GitLogResponse = {
  repo_root: string;
  scope: "branch" | "all";
  commits: GitLogCommit[];
  has_more: boolean;
  checked_at: string;
};

/** `GET /v1/project-sessions/:id/git/commits/:oid`. */
export type GitCommitDetail = {
  oid: string;
  short_oid: string;
  parents: string[];
  author_name: string;
  authored_at: string;
  subject: string;
  body: string;
  refs: GitLogRef[];
  files: GitChangeFile[];
  truncated: boolean;
};
