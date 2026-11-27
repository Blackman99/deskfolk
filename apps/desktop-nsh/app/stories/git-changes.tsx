/**
 * Standalone story for `GitChangesView` and `GitGraphView`: exercises nested file tree grouping,
 * single-child folder compaction, collapse/expand, search auto-expand, drag-resizing splits,
 * responsive side-by-side / top-bottom commit layout switching, and narrow drill-down navigation.
 */
import type {
  GitChangeFile,
  GitChangesResponse,
  GitCommitDetail,
  GitDiffResponse,
  GitLogResponse,
  GitRepoSummary,
} from "@real-bot/protocol";
import { cleanup, effect, host, signal, Text, untracked, View } from "nsh";
import { runtime } from "../src/runtime";
import { GitChangesView } from "../src/ui/git/GitChangesView";
import { GitGraphView } from "../src/ui/git/GitGraphView";

const SAMPLE_FILES: GitChangeFile[] = [
  {
    path: "README.md",
    old_path: null,
    status: "M",
    staged: false,
    unstaged: true,
    additions: 4,
    deletions: 1,
    binary: false,
  },
  {
    path: "apps/desktop-nsh/app/src/ui/git/GitChangesView.tsx",
    old_path: null,
    status: "M",
    staged: false,
    unstaged: true,
    additions: 42,
    deletions: 18,
    binary: false,
  },
  {
    path: "apps/desktop-nsh/app/src/ui/git/GitChangesTree.tsx",
    old_path: null,
    status: "A",
    staged: false,
    unstaged: true,
    additions: 120,
    deletions: 0,
    binary: false,
  },
  {
    path: "apps/desktop-nsh/app/src/m/git/change-tree.ts",
    old_path: null,
    status: "A",
    staged: true,
    unstaged: false,
    additions: 88,
    deletions: 0,
    binary: false,
  },
  {
    path: "packages/protocol/src/git.ts",
    old_path: null,
    status: "M",
    staged: false,
    unstaged: true,
    additions: 2,
    deletions: 2,
    binary: false,
  },
];

const SUMMARY: GitRepoSummary = {
  is_repo: true,
  git_available: true,
  git_error: null,
  repo_id: ".",
  repo_root: "/tmp/deskfolk-story-repo",
  common_root: "/tmp/deskfolk-story-repo/.git",
  worktree_root: "/tmp/deskfolk-story-repo",
  project_boundary: "/tmp/deskfolk-story-repo",
  default_worktree: "/tmp/deskfolk-story-repo",
  relative_prefix: "",
  repos: [{ id: ".", path: "/tmp/deskfolk-story-repo", name: "deskfolk" }],
  branch: "feat/git-diff-tree",
  head_oid: "1234567890abcdef1234567890abcdef12345678",
  detached: false,
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  staged_count: 1,
  unstaged_count: 4,
  untracked_count: 0,
  conflicted_count: 0,
  dirty_count: 5,
  operation: null,
  other_dirty_worktrees: 0,
  signature: "story-sig-1",
  checked_at: "2026-11-27T12:00:00.000Z",
};

const SAMPLE_LOG: GitLogResponse = {
  repo_root: SUMMARY.repo_root!,
  scope: "branch",
  commits: [
    {
      oid: "1234567890abcdef1234567890abcdef12345678",
      short_oid: "1234567",
      parents: ["abcdef1234567890abcdef1234567890abcdef12"],
      subject: "feat(git): show changed files as a resizable tree",
      author_name: "Alice",
      authored_at: "2026-11-27T11:30:00.000Z",
      refs: [{ kind: "head", name: "feat/git-diff-tree" }],
    },
    {
      oid: "abcdef1234567890abcdef1234567890abcdef12",
      short_oid: "abcdef1",
      parents: [],
      subject: "chore: initial commit",
      author_name: "Bob",
      authored_at: "2026-11-26T09:00:00.000Z",
      refs: [{ kind: "local", name: "main" }],
    },
  ],
  has_more: false,
  checked_at: SUMMARY.checked_at,
};

function commitDetailFor(oid: string): GitCommitDetail {
  const hit = SAMPLE_LOG.commits.find((c) => c.oid === oid) ?? SAMPLE_LOG.commits[0]!;
  return {
    oid: hit.oid,
    short_oid: hit.short_oid,
    parents: hit.parents,
    subject: hit.subject,
    body: "Commit detail body for story testing.",
    author_name: hit.author_name,
    authored_at: hit.authored_at,
    refs: hit.refs,
    files: oid === SAMPLE_LOG.commits[1]!.oid ? [SAMPLE_FILES[0]!] : SAMPLE_FILES,
    truncated: false,
  };
}

function patchFor(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,3 @@",
    " export const before = true;",
    "-export const oldLine = 1;",
    "+export const newLine = 2;",
    `+export const file = ${JSON.stringify(path)};`,
  ].join("\n");
}

export default function GitChangesStory() {
  const params = host.params as { narrow?: boolean; view?: "changes" | "graph" };
  const ready = signal(false);
  const view = signal<"changes" | "graph">(params.view === "graph" ? "graph" : "changes");
  const narrow = signal(params.narrow === true);
  const paneWidth = signal(0);

  effect(() => {
    void runtime.connection;
    const client = runtime.client;
    if (!client) return;
    const origChanges = client.gitChanges.bind(client);
    const origDiff = client.gitDiff.bind(client);
    const origLog = client.gitLog.bind(client);
    const origCommit = client.gitCommit.bind(client);

    client.gitChanges = async (_sid, opts): Promise<GitChangesResponse> => ({
      base: opts?.base ?? "working",
      base_ref: null,
      worktree: SUMMARY.worktree_root!,
      files: SAMPLE_FILES,
      truncated: false,
      total_files: SAMPLE_FILES.length,
      checked_at: SUMMARY.checked_at,
    });
    client.gitLog = async (): Promise<GitLogResponse> => SAMPLE_LOG;
    client.gitCommit = async (_sid, oid): Promise<GitCommitDetail> => commitDetailFor(oid);
    client.gitDiff = async (_sid, opts): Promise<GitDiffResponse> => ({
      path: opts.path,
      base: opts.commit ? "commit" : (opts.base ?? "working"),
      commit: opts.commit ?? null,
      patch: patchFor(opts.path),
      binary: false,
      truncated: false,
      untracked: false,
      bytes: 180,
      reason: null,
    });
    untracked(() => ready.set(true));
    cleanup(() => {
      client.gitChanges = origChanges;
      client.gitDiff = origDiff;
      client.gitLog = origLog;
      client.gitCommit = origCommit;
    });
  });

  return (
    <View testID="git-changes-story" class="flex-1 min-h-0 bg-pane">
      <View class="flex-row items-center gap-2 px-2 py-1 border-b border-line bg-sidebar-bg shrink-0">
        <View
          role="button"
          testID="story-view-changes"
          onPress={() => view.set("changes")}
          class="cursor-pointer select-none px-2 py-[2px] border border-line rounded-(--radius-sm)"
        >
          <Text class="text-[11px] text-ink">view:changes</Text>
        </View>
        <View
          role="button"
          testID="story-view-graph"
          onPress={() => view.set("graph")}
          class="cursor-pointer select-none px-2 py-[2px] border border-line rounded-(--radius-sm)"
        >
          <Text class="text-[11px] text-ink">view:graph</Text>
        </View>
        <View
          role="button"
          testID="story-toggle-narrow"
          onPress={() => narrow.set(!narrow())}
          class="cursor-pointer select-none px-2 py-[2px] border border-line rounded-(--radius-sm)"
        >
          <Text class="text-[11px] text-ink">{narrow() ? "mode:narrow" : "mode:wide"}</Text>
        </View>
        <Text testID="story-pane-width" class="text-[11px] text-ink-muted">{`view:${Math.round(paneWidth())}`}</Text>
      </View>
      <View
        class="flex-1 min-h-0"
        onLayout={(e) => paneWidth.set(e.bounds.size.width)}
      >
        <If when={ready()}>
          <If when={view() === "changes"}>
            <GitChangesView
              sessionId="story-session"
              summary={SUMMARY}
              repo={null}
              worktree={null}
              narrow={narrow()}
              reloadToken={0}
              onOpenPreview={() => {}}
            />
          </If>
          <If when={view() === "graph"}>
            <GitGraphView
              sessionId="story-session"
              repo={null}
              worktree={null}
              narrow={narrow()}
              reloadToken={0}
            />
          </If>
        </If>
      </View>
    </View>
  );
}
