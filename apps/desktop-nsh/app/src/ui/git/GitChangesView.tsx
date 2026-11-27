/**
 * Working tree & branch-vs-mainline changes view (ADR 0118).
 * Wide panes show a resizable file tree + `GitDiffViewer` side by side; narrow panes drill into
 * `GitDiffPager` wired into `PageRoute`'s level stack (`stepIn` / `holdLevels`) with real
 * `AbortSignal` cancellation and remote 200 KiB preview caps.
 */
import type { GitChangeFile, GitChangesResponse, GitDiffBase, GitDiffResponse, GitRepoSummary } from "@real-bot/protocol";
import { cleanup, computed, effect, safeArea, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { buildGitChangeTree, flattenGitChangeTreeFiles } from "../../m/git/change-tree.ts";
import {
  clampGitChangesTreeWidth,
  loadGitChangesTreeWidth,
  saveGitChangesTreeWidth,
} from "../../m/git/changes-tree-width.ts";
import { copy, runtime } from "../../runtime";
import { EmptyState } from "../EmptyState";
import { GitChangesTree } from "./GitChangesTree";
import { GitDiffPager } from "./GitDiffPager";
import { GitSplitHandle } from "./GitSplitHandle";
import { drillIn, registerGitLevels, type GitHost } from "./git-levels";

const BASES: readonly GitDiffBase[] = ["working", "staged", "unstaged", "merge-base"];
const REMOTE_DIFF_PREVIEW_BYTES = 200 * 1024;
const REMOTE_DIFF_FULL_BYTES = 640 * 1024;

export function GitChangesView(props: {
  sessionId: string;
  summary: GitRepoSummary;
  repo: string | null;
  worktree: string | null;
  host?: GitHost;
  isRemote?: boolean;
  narrow: boolean;
  reloadToken: number;
  base?: GitDiffBase;
  onBaseChange?: (base: GitDiffBase) => void;
  scope?: "repo" | "dir";
  onScopeChange?: (scope: "repo" | "dir") => void;
  onDrillDepthChange?: (depth: number) => void;
  onOpenPreview: (absPath: string) => void;
}) {
  const t = () => copy();
  const isPage = () => props.host === "page";
  const localBase = signal<GitDiffBase>(props.base ?? "working");
  const localScope = signal<"repo" | "dir">(props.scope ?? "repo");
  const base = () => props.base ?? localBase();
  const setBase = (b: GitDiffBase) => {
    localBase.set(b);
    props.onBaseChange?.(b);
  };
  const scope = () => props.scope ?? localScope();
  const setScope = (sc: "repo" | "dir") => {
    localScope.set(sc);
    props.onScopeChange?.(sc);
  };

  const query = signal("");
  const data = signal<GitChangesResponse | null>(null);
  const loading = signal(false);
  const error = signal<string | null>(null);
  const selectedPath = signal<string | null>(null);
  const diff = signal<GitDiffResponse | null>(null);
  const diffLoading = signal(false);
  const diffError = signal<string | null>(null);
  const narrowDetail = signal(false);
  const fullDiffRequestedFor = signal<string | null>(null);

  const viewWidth = signal(Number.POSITIVE_INFINITY);
  const treePreferred = signal(loadGitChangesTreeWidth());
  const treeWidth = computed(() => clampGitChangesTreeWidth(treePreferred(), viewWidth()));
  let dragOriginWidth = 0;

  effect(() => {
    props.onDrillDepthChange?.(props.narrow && narrowDetail() ? 1 : 0);
  });
  cleanup(() => props.onDrillDepthChange?.(0));

  registerGitLevels({
    name: "git-changes-diff",
    active: () => isPage() && props.narrow,
    depth: () => (narrowDetail() ? 1 : 0),
    stepOut: () => narrowDetail.set(false),
  });

  let changesSeq = 0;
  let diffSeq = 0;

  effect(() => {
    const sid = props.sessionId;
    const b = base();
    const sc = scope();
    const repo = props.repo;
    const wt = props.worktree;
    void props.reloadToken;
    const api = runtime.client;
    if (!api) return;
    const seq = ++changesSeq;
    const ac = new AbortController();
    cleanup(() => ac.abort());
    untracked(() => {
      loading.set(data() === null);
      error.set(null);
      void api
        .gitChanges(sid, { base: b, repo, worktree: wt, scope: sc }, ac.signal)
        .then((res) => {
          if (seq !== changesSeq || ac.signal.aborted) return;
          data.set(res);
          const cur = selectedPath();
          if (!cur || !res.files.some((f) => f.path === cur)) {
            const first = flattenGitChangeTreeFiles(buildGitChangeTree(res.files))[0];
            selectedPath.set(first?.path ?? res.files[0]?.path ?? null);
          }
        })
        .catch((err) => {
          if (seq !== changesSeq || ac.signal.aborted) return;
          if (!data()) error.set(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seq === changesSeq && !ac.signal.aborted) loading.set(false);
        });
    });
  });

  effect(() => {
    const sid = props.sessionId;
    const p = selectedPath();
    const b = base();
    const repo = props.repo;
    const wt = props.worktree;
    const remote = props.isRemote === true;
    const fullFor = fullDiffRequestedFor();
    const inDetail = !props.narrow || narrowDetail();
    void props.reloadToken;
    const api = runtime.client;
    if (!api || !p || !inDetail) {
      untracked(() => {
        if (!p) {
          diff.set(null);
          diffError.set(null);
          diffLoading.set(false);
        }
      });
      return;
    }
    const seq = ++diffSeq;
    const ac = new AbortController();
    cleanup(() => ac.abort());
    const maxBytes = remote ? (fullFor === p ? REMOTE_DIFF_FULL_BYTES : REMOTE_DIFF_PREVIEW_BYTES) : undefined;
    untracked(() => {
      diffLoading.set(true);
      diffError.set(null);
      void api
        .gitDiff(sid, { path: p, base: b, repo, worktree: wt, maxBytes }, ac.signal)
        .then((res) => {
          if (seq !== diffSeq || ac.signal.aborted) return;
          diff.set(res);
        })
        .catch((err) => {
          if (seq !== diffSeq || ac.signal.aborted) return;
          diffError.set(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seq === diffSeq && !ac.signal.aborted) diffLoading.set(false);
        });
    });
  });

  const filtered = computed<GitChangeFile[]>(() => {
    const files = data()?.files ?? [];
    const q = query().trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q) || (f.old_path?.toLowerCase().includes(q) ?? false));
  });

  const treeNodes = computed(() => buildGitChangeTree(filtered()));
  const orderedFiles = computed(() => flattenGitChangeTreeFiles(treeNodes()));

  const selectedIndex = computed(() => {
    const p = selectedPath();
    if (!p) return -1;
    return orderedFiles().findIndex((f) => f.path === p);
  });

  const selectFile = (path: string) => {
    fullDiffRequestedFor.set(null);
    selectedPath.set(path);
    if (props.narrow) {
      drillIn(isPage(), () => narrowDetail.set(true));
    }
  };

  const stepFile = (delta: number) => {
    const list = orderedFiles();
    const nextIdx = selectedIndex() + delta;
    const next = list[nextIdx];
    if (next) {
      fullDiffRequestedFor.set(null);
      selectedPath.set(next.path);
    }
  };

  const baseLabel = (b: GitDiffBase): string => {
    const c = t().git.changes;
    if (b === "working") return c.baseWorking;
    if (b === "staged") return c.baseStaged;
    if (b === "unstaged") return c.baseUnstaged;
    return c.baseMergeBase;
  };

  const openAbsPreview = (relpath: string) => {
    const root = data()?.worktree ?? props.summary.worktree_root ?? props.summary.repo_root;
    if (!root) return;
    props.onOpenPreview(`${root.replace(/[\\/]+$/, "")}/${relpath}`);
  };

  const canLoadFull = () =>
    props.isRemote === true &&
    Boolean(diff()?.truncated) &&
    fullDiffRequestedFor() !== selectedPath();

  const listPane = () => (
    <View
      testID="git-changes-list-pane"
      class={`${props.narrow ? "flex-1" : "shrink-0"} min-h-0 bg-sidebar-bg`}
      style={props.narrow ? undefined : { width: treeWidth() }}
    >
      <View class="px-[8px] pt-[8px] pb-[6px] gap-[6px] border-b border-line-subtle shrink-0">
        <If
          when={props.narrow}
          else={
            <View class="flex-row flex-wrap gap-[4px]">
              <Each of={[...BASES]} key={(b) => b}>
                {(b) => (
                  <View
                    role="button"
                    testID={`git-base-${b()}`}
                    accessibilityLabel={baseLabel(b())}
                    accessibilityState={{ selected: base() === b() }}
                    onPress={() => setBase(b())}
                    class={`cursor-pointer select-none px-[7px] h-[22px] rounded-(--radius-control-sm) items-center justify-center ${
                      base() === b() ? "bg-accent-tint" : "hover:bg-row-hover"
                    }`}
                  >
                    <Text class={`text-[11px] font-medium ${base() === b() ? "text-brand" : "text-ink-muted"}`}>{baseLabel(b())}</Text>
                  </View>
                )}
              </Each>
            </View>
          }
        >
          <Scroll horizontal scrollbar={false} contentClass="flex-row items-center gap-[6px]">
            <Each of={[...BASES]} key={(b) => b}>
              {(b) => (
                <View
                  role="button"
                  testID={`git-base-${b()}`}
                  accessibilityLabel={baseLabel(b())}
                  accessibilityState={{ selected: base() === b() }}
                  onPress={() => setBase(b())}
                  class={`cursor-pointer select-none px-[12px] h-[36px] rounded-(--radius-control-sm) items-center justify-center shrink-0 border ${
                    base() === b() ? "bg-accent-tint border-accent-border" : "bg-pane border-line-subtle active:bg-row-hover"
                  }`}
                >
                  <Text class={`text-[12.5px] font-medium ${base() === b() ? "text-brand" : "text-ink-secondary"}`}>{baseLabel(b())}</Text>
                </View>
              )}
            </Each>
          </Scroll>
        </If>

        <If when={Boolean(props.summary.relative_prefix)}>
          <View class="flex-row items-center gap-[4px]">
            <View
              role="button"
              testID="git-scope-repo"
              onPress={() => setScope("repo")}
              class={`cursor-pointer select-none px-[8px] rounded-(--radius-xs) items-center justify-center ${
                props.narrow ? "h-[28px]" : "h-[20px]"
              } ${scope() === "repo" ? "bg-accent-tint" : "hover:bg-row-hover"}`}
            >
              <Text class={`${props.narrow ? "text-[12px]" : "text-[11px]"} ${scope() === "repo" ? "text-brand font-medium" : "text-ink-muted"}`}>
                {t().git.changes.scopeRepo}
              </Text>
            </View>
            <View
              role="button"
              testID="git-scope-dir"
              onPress={() => setScope("dir")}
              class={`cursor-pointer select-none px-[8px] rounded-(--radius-xs) items-center justify-center ${
                props.narrow ? "h-[28px]" : "h-[20px]"
              } ${scope() === "dir" ? "bg-accent-tint" : "hover:bg-row-hover"}`}
            >
              <Text class={`${props.narrow ? "text-[12px]" : "text-[11px]"} ${scope() === "dir" ? "text-brand font-medium" : "text-ink-muted"}`}>
                {t().git.changes.scopeDir}
              </Text>
            </View>
          </View>
        </If>

        <Input
          testID="git-changes-filter"
          value={query()}
          placeholder={t().git.changes.filterPlaceholder}
          accessibilityLabel={t().git.changes.filterPlaceholder}
          onChange={(e) => query.set(e.value)}
          class={`px-[10px] rounded-(--radius-sm) border border-line bg-input-bg text-ink ${
            props.narrow ? "h-[36px] text-[13px]" : "h-[26px] text-[12px]"
          }`}
        />
      </View>

      <If when={data()?.truncated}>
        <View class="px-[8px] py-[4px] bg-chip border-b border-line-subtle shrink-0">
          <Text class="text-[11px] text-ink-muted">
            {t().git.changes.filesTruncated(data()!.files.length, data()!.total_files)}
          </Text>
        </View>
      </If>

      <If when={loading() && !data()}>
        <View class="flex-1 items-center justify-center p-4">
          <Text class="text-[12px] text-ink-muted">{t().git.loading}</Text>
        </View>
      </If>

      <If when={!loading() && error()}>
        <View class="flex-1 items-center justify-center p-4">
          <Text class="text-[12px] text-danger-text text-center">{error()}</Text>
        </View>
      </If>

      <If when={!loading() && !error() && filtered().length === 0}>
        <EmptyState
          testID="git-changes-empty"
          title={base() === "merge-base" ? t().git.changes.emptyMergeBase : t().git.changes.empty}
        />
      </If>

      <If when={filtered().length > 0}>
        <GitChangesTree
          nodes={treeNodes()}
          selectedPath={selectedPath()}
          narrow={props.narrow}
          filterQuery={query()}
          bottomInset={isPage() && props.narrow ? safeArea().bottom : 0}
          onSelectFile={selectFile}
        />
      </If>

      <If when={!props.narrow}>
        <View class="px-[8px] py-[5px] border-t border-line-subtle shrink-0">
          <Text class="text-[10px] text-ink-muted line-clamp-2">{t().git.changes.readOnlyHint}</Text>
        </View>
      </If>
    </View>
  );

  return (
    <View
      testID="git-changes-view"
      class="flex-1 min-h-0 flex-row"
      onLayout={(e) => viewWidth.set(e.bounds.size.width || Number.POSITIVE_INFINITY)}
    >
      <If when={!props.narrow || !narrowDetail()}>{listPane()}</If>
      <If when={!props.narrow}>
        <GitSplitHandle
          axis="vertical"
          testID="git-changes-split"
          label={t().git.changes.resizeTree}
          onDragStart={() => {
            dragOriginWidth = treeWidth();
          }}
          onDragDelta={(dx) => {
            treePreferred.set(clampGitChangesTreeWidth(dragOriginWidth + dx, viewWidth()));
          }}
          onDragEnd={() => saveGitChangesTreeWidth(treePreferred())}
        />
      </If>
      <If when={!props.narrow || narrowDetail()}>
        <GitDiffPager
          diff={diff()}
          loading={diffLoading()}
          error={diffError()}
          host={props.host}
          narrow={props.narrow}
          index={selectedIndex()}
          total={orderedFiles().length}
          onPrev={() => stepFile(-1)}
          onNext={() => stepFile(1)}
          onOpenPreview={openAbsPreview}
          onLoadFull={canLoadFull() ? () => fullDiffRequestedFor.set(selectedPath()) : undefined}
          onBack={props.narrow ? () => narrowDetail.set(false) : undefined}
        />
      </If>
    </View>
  );
}
