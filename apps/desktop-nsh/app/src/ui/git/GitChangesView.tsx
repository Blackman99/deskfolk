/**
 * Working tree & branch-vs-mainline changes view (ADR 0118).
 * Left: virtualised file list with baseline & path filter; right: `GitDiffViewer`.
 * Collapses to single-column drill-down when the pane is narrower than 540 pt.
 */
import type { GitChangeFile, GitChangesResponse, GitDiffBase, GitDiffResponse, GitRepoSummary } from "@real-bot/protocol";
import { computed, effect, List, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import { copy, runtime } from "../../runtime";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { FileIcon } from "../overlays/FileIcon";
import { GitDiffViewer } from "./GitDiffViewer";
import { splitRepoPath, statusBadgeClass } from "./git-ui-helpers";

const BASES: readonly GitDiffBase[] = ["working", "staged", "unstaged", "merge-base"];

export function GitChangesView(props: {
  sessionId: string;
  summary: GitRepoSummary;
  repo: string | null;
  worktree: string | null;
  narrow: boolean;
  reloadToken: number;
  base?: GitDiffBase;
  onBaseChange?: (base: GitDiffBase) => void;
  scope?: "repo" | "dir";
  onScopeChange?: (scope: "repo" | "dir") => void;
  onOpenPreview: (absPath: string) => void;
}) {
  const t = () => copy();
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
    untracked(() => {
      loading.set(data() === null);
      error.set(null);
      void api
        .gitChanges(sid, { base: b, repo, worktree: wt, scope: sc })
        .then((res) => {
          if (seq !== changesSeq) return;
          data.set(res);
          const cur = selectedPath();
          if (!cur || !res.files.some((f) => f.path === cur)) {
            selectedPath.set(res.files[0]?.path ?? null);
          }
        })
        .catch((err) => {
          if (seq !== changesSeq) return;
          error.set(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seq === changesSeq) loading.set(false);
        });
    });
  });

  effect(() => {
    const sid = props.sessionId;
    const p = selectedPath();
    const b = base();
    const repo = props.repo;
    const wt = props.worktree;
    void props.reloadToken;
    const api = runtime.client;
    if (!api || !p) {
      untracked(() => {
        diff.set(null);
        diffError.set(null);
        diffLoading.set(false);
      });
      return;
    }
    const seq = ++diffSeq;
    untracked(() => {
      diffLoading.set(true);
      diffError.set(null);
      void api
        .gitDiff(sid, { path: p, base: b, repo, worktree: wt })
        .then((res) => {
          if (seq !== diffSeq) return;
          diff.set(res);
        })
        .catch((err) => {
          if (seq !== diffSeq) return;
          diffError.set(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seq === diffSeq) diffLoading.set(false);
        });
    });
  });

  const filtered = computed<GitChangeFile[]>(() => {
    const files = data()?.files ?? [];
    const q = query().trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q) || (f.old_path?.toLowerCase().includes(q) ?? false));
  });

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

  const listPane = () => (
    <View
      testID="git-changes-list-pane"
      class={`${props.narrow ? "flex-1" : "w-[250px] shrink-0 border-r border-line"} min-h-0 bg-sidebar-bg`}
    >
      <View class="px-[8px] pt-[8px] pb-[6px] gap-[6px] border-b border-line-subtle shrink-0">
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
        <If when={Boolean(props.summary.relative_prefix)}>
          <View class="flex-row items-center gap-[4px]">
            <View
              role="button"
              testID="git-scope-repo"
              onPress={() => setScope("repo")}
              class={`cursor-pointer select-none px-[6px] h-[20px] rounded-(--radius-xs) items-center justify-center ${
                scope() === "repo" ? "bg-accent-tint" : "hover:bg-row-hover"
              }`}
            >
              <Text class={`text-[11px] ${scope() === "repo" ? "text-brand font-medium" : "text-ink-muted"}`}>{t().git.changes.scopeRepo}</Text>
            </View>
            <View
              role="button"
              testID="git-scope-dir"
              onPress={() => setScope("dir")}
              class={`cursor-pointer select-none px-[6px] h-[20px] rounded-(--radius-xs) items-center justify-center ${
                scope() === "dir" ? "bg-accent-tint" : "hover:bg-row-hover"
              }`}
            >
              <Text class={`text-[11px] ${scope() === "dir" ? "text-brand font-medium" : "text-ink-muted"}`}>{t().git.changes.scopeDir}</Text>
            </View>
          </View>
        </If>
        <Input
          testID="git-changes-filter"
          value={query()}
          placeholder={t().git.changes.filterPlaceholder}
          accessibilityLabel={t().git.changes.filterPlaceholder}
          onChange={(e) => query.set(e.value)}
          class="h-[26px] px-[8px] rounded-(--radius-sm) border border-line bg-input-bg text-[12px] text-ink"
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
        <List
          testID="git-changes-list"
          each={filtered()}
          keyExtractor={(item) => item.path}
          estimatedItemSize={42}
          class="flex-1 min-h-0"
          contentStyle={{ paddingTop: 4, paddingBottom: 8, paddingLeft: 4, paddingRight: 4, gap: 2 }}
        >
          {(item) => {
            const active = () => selectedPath() === item().path;
            const split = () => splitRepoPath(item().path);
            const badge = () => statusBadgeClass(item().status);
            return (
              <View
                role="button"
                testID={`git-file-${item().path}`}
                accessibilityState={{ selected: active() }}
                onPress={() => {
                  selectedPath.set(item().path);
                  if (props.narrow) narrowDetail.set(true);
                }}
                class={`cursor-pointer select-none flex-row items-center gap-[6px] px-[8px] py-[6px] rounded-(--radius-sm) ${
                  active() ? "bg-accent-tint" : "hover:bg-row-hover"
                }`}
              >
                <FileIcon icon={fileIconFor(item().path)} size={16} />
                <View class="flex-1 min-w-0">
                  <Text class={`text-[12px] line-clamp-1 ${active() ? "font-semibold text-brand" : "text-ink"}`}>{split().name}</Text>
                  <If when={split().dir}>
                    <Text class="text-[10px] text-ink-muted line-clamp-1">{split().dir}</Text>
                  </If>
                </View>
                <View class="flex-row items-center gap-[4px] shrink-0">
                  <If when={item().additions !== null && item().additions! > 0}>
                    <Text class="font-mono text-[10px] text-ok-text">{`+${item().additions}`}</Text>
                  </If>
                  <If when={item().deletions !== null && item().deletions! > 0}>
                    <Text class="font-mono text-[10px] text-danger-text">{`-${item().deletions}`}</Text>
                  </If>
                  <View class={`w-[18px] h-[18px] rounded-(--radius-xs) items-center justify-center ${badge().bg}`}>
                    <Text class={`font-mono text-[10px] font-bold ${badge().text}`}>{item().status}</Text>
                  </View>
                </View>
              </View>
            );
          }}
        </List>
      </If>

      <View class="px-[8px] py-[5px] border-t border-line-subtle shrink-0">
        <Text class="text-[10px] text-ink-muted line-clamp-2">{t().git.changes.readOnlyHint}</Text>
      </View>
    </View>
  );

  return (
    <View testID="git-changes-view" class="flex-1 min-h-0 flex-row">
      <If when={!props.narrow || !narrowDetail()}>{listPane()}</If>
      <If when={!props.narrow || narrowDetail()}>
        <GitDiffViewer
          diff={diff()}
          loading={diffLoading()}
          error={diffError()}
          onOpenPreview={openAbsPreview}
          onBack={props.narrow ? () => narrowDetail.set(false) : undefined}
        />
      </If>
    </View>
  );
}
