/**
 * Unified project-scoped Git & GitHub workbench pane (ADR 0118).
 * Separates hierarchical location (`projectDir -> Repo -> Worktree`, via a persistent breadcrumb
 * and single grouped popover) from content view (`Changes`, `History`, `GitHub`).
 * Tab params are the single source of truth; switching repo/worktree stays on the current view and
 * remounts the active content body cleanly without double-fetching or leaking stale selections.
 */
import {
  GIT_PANE_VIEWS,
  type Attachment,
  type GitDiffBase,
  type GitPaneView,
  type GitProjectTreeResponse,
  type GitRepoSummary,
} from "@real-bot/protocol";
import { cleanup, computed, effect, Overlay, signal, Text, untracked, View, type ViewRef } from "nsh";
import { ApiError } from "../../m/api.ts";
import { projectGitStore } from "../../m/git/git-store.svelte.ts";
import { newProjectIn } from "../../m/sidebar/project-actions.ts";
import { isLiveRun, projectAgentOf, projectDirLabel } from "../../m/sidebar/project-groups.ts";
import { showToast } from "../../m/toast.svelte.ts";
import { lifecycle } from "../../platform/lifecycle";
import { copy, runtime } from "../../runtime";
import { EmptyState } from "../EmptyState";
import { Icon, type IconName } from "../Icon";
import { IconButton } from "../IconButton";
import { MENU_ITEM, MENU_SURFACE, shadow } from "../styles";
import { tip } from "../tip";
import { settled } from "../workbench/drag-settle";
import { GitChangesView } from "./GitChangesView";
import { GitContextPopover } from "./GitContextPopover";
import { GitGraphView } from "./GitGraphView";
import { GitHubView } from "./GitHubView";

const VIEW_ICONS: Record<GitPaneView, IconName> = {
  changes: "git-branch",
  graph: "history",
  github: "globe",
};

export function GitPane(props: {
  sessionId: string;
  projectDir: string;
  view?: GitPaneView;
  worktree?: string | null;
  repo?: string | null;
  pickerNonce?: number | null;
  onChangeParams?: (patch: {
    view?: GitPaneView;
    worktree?: string | null;
    repo?: string | null;
    pickerNonce?: number | null;
  }) => void;
  onOpenArtifact: (
    relpath: string,
    att?: Attachment,
    messageId?: string | null,
    forceTree?: boolean,
    taskId?: string | null,
    siblings?: Attachment[] | null,
    sessionId?: string | null,
  ) => void;
}) {
  const t = () => copy();
  const paneWidth = signal(720);
  const narrow = settled(() => paneWidth() > 0 && paneWidth() < 540);
  const showInlineActions = settled(() => paneWidth() >= 820);

  // Single source of truth: derived directly from tab params (never mirrored into stale local signals).
  const activeView = (): GitPaneView => props.view ?? "changes";
  const activeRepo = (): string | null => props.repo ?? null;
  const activeWorktree = (): string | null => props.worktree ?? null;

  // User view preferences preserved across repo/worktree context switches.
  const diffBase = signal<GitDiffBase>("working");
  const diffScope = signal<"repo" | "dir">("repo");

  const summary = signal<GitRepoSummary | null>(null);
  const tree = signal<GitProjectTreeResponse | null>(null);
  const loading = signal(true);
  const errorMsg = signal<string | null>(null);
  const reloadToken = signal(0);
  const ghForceToken = signal(0);

  const pickerOpen = signal(false);
  const pickerAnchor = signal<ViewRef | null>(null);
  const actionsOpen = signal(false);
  const actionsAnchor = signal<ViewRef | null>(null);

  // Consume one-shot picker open requests (e.g. sidebar "切换仓库 / 工作树…") and clear the nonce.
  let lastConsumedNonce = 0;
  effect(() => {
    const nonce = props.pickerNonce ?? null;
    if (!nonce || nonce === lastConsumedNonce) return;
    lastConsumedNonce = nonce;
    untracked(() => {
      pickerOpen.set(true);
      props.onChangeParams?.({ pickerNonce: null });
    });
  });

  // Fetch zero-status repo -> worktree tree; gracefully degrade on 404 (pre-restart daemon).
  let treeSeq = 0;
  const fetchTree = (refresh = false) => {
    const api = runtime.client;
    if (!api) return;
    const req = ++treeSeq;
    const sid = props.sessionId;
    const pdir = props.projectDir;
    void api
      .gitTree(sid, { refresh })
      .then((res) => {
        if (req === treeSeq) tree.set(res);
      })
      .catch(async (err) => {
        if (req !== treeSeq) return;
        if (err instanceof ApiError && err.status === 404) {
          // Graceful degradation when UI hot-reloads ahead of daemon restart.
          try {
            const wtRes = await api.gitWorktrees(sid, { repo: activeRepo() });
            if (req !== treeSeq) return;
            tree.set({
              git_available: true,
              git_error: null,
              project_boundary: wtRes.repo_root,
              default_repo_id: ".",
              default_worktree: wtRes.repo_root,
              repos: [
                {
                  id: ".",
                  name: projectDirLabel(wtRes.repo_root),
                  repo_root: wtRes.repo_root,
                  common_root: wtRes.common_root,
                  error: null,
                  worktrees: wtRes.worktrees.map((w) => ({
                    path: w.path,
                    rel_path: w.path === wtRes.repo_root ? "." : projectDirLabel(w.path),
                    branch: w.branch,
                    head_oid: w.head_oid,
                    detached: w.detached,
                    is_main: w.is_main,
                    is_project_dir: w.path === pdir || w.is_current,
                    locked: w.locked,
                    locked_reason: w.locked_reason,
                    prunable: w.prunable,
                    session_ids: w.session_ids,
                  })),
                },
              ],
              checked_at: wtRes.checked_at,
            });
          } catch {
            // Leave tree null; summary still renders.
          }
        }
      });
  };

  let sumSeq = 0;
  let lastSig = "";
  let fallbackAttemptedKey = "";
  const fetchSummary = (opts: { bumpChildren: boolean; resetSig?: boolean }) => {
    const api = runtime.client;
    if (!api) return;
    const req = ++sumSeq;
    const repo = activeRepo();
    const wt = activeWorktree();
    const ctxKey = `${repo ?? ""}\0${wt ?? ""}`;
    if (opts.resetSig) lastSig = "";
    void api
      .gitSummary(props.sessionId, { repo, worktree: wt, quick: true })
      .then((res) => {
        if (req !== sumSeq) return;
        summary.set(res);
        errorMsg.set(null);
        loading.set(false);
        // Keep shared chat header cache in sync ONLY for the project's default checkout.
        if (!repo && !wt) {
          void projectGitStore.ensure(api, props.sessionId, props.projectDir, { force: true, quick: true });
        }
        if (opts.bumpChildren || (lastSig && res.signature !== lastSig)) {
          reloadToken.set(reloadToken() + 1);
        }
        lastSig = res.signature;
      })
      .catch((err) => {
        if (req !== sumSeq) return;
        // Fall back to project default ONLY on 422 (deleted/invalid saved worktree or repo), at most once.
        if (err instanceof ApiError && err.status === 422 && (repo || wt) && fallbackAttemptedKey !== ctxKey) {
          fallbackAttemptedKey = ctxKey;
          showToast(t().git.staleWorktreeFallback, { tone: "info" });
          props.onChangeParams?.({ repo: null, worktree: null });
          return;
        }
        errorMsg.set(err instanceof Error ? err.message : String(err));
        loading.set(false);
      });
  };

  // Initial load & reload when repo/worktree changes. Children remount via `contextKey`, so do NOT bump reloadToken.
  effect(() => {
    void props.sessionId;
    void activeRepo();
    void activeWorktree();
    if (runtime.connection !== "connected") return;
    untracked(() => {
      fetchSummary({ bumpChildren: false, resetSig: true });
      fetchTree(false);
    });
  });

  // Debounced refresh when any session in the same project emits a write/git ToolFrame.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      fetchSummary({ bumpChildren: false });
      fetchTree(false);
    }, 500);
  };
  cleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  let lastToolRev = runtime.agentCalls.revision;
  effect(() => {
    const rev = runtime.agentCalls.revision;
    if (rev === lastToolRev) return;
    lastToolRev = rev;
    untracked(() => {
      const sameProjectIds = new Set(
        runtime.snapshot.sessions
          .filter((s) => s.kind === "project" && s.project_dir === props.projectDir)
          .map((s) => s.id),
      );
      const calls = runtime.agentCalls.all();
      const latest = calls[calls.length - 1];
      if (!latest || !sameProjectIds.has(latest.sessionId)) return;
      const action = latest.info.action;
      if (action === "write" || action === "git" || latest.info.place.zone === "git") {
        scheduleRefresh();
      }
    });
  });

  // Refresh when a live run in this project finishes.
  let wasAnyLive = false;
  effect(() => {
    const runs = runtime.snapshot.agentRuns;
    const anyLive = runtime.snapshot.sessions.some(
      (s) => s.kind === "project" && s.project_dir === props.projectDir && isLiveRun(runs[s.id]),
    );
    if (wasAnyLive && !anyLive) untracked(() => scheduleRefresh());
    wasAnyLive = anyLive;
  });

  // Refresh when window regains foreground focus.
  let wasVisible = lifecycle() !== "background";
  effect(() => {
    const nowVisible = lifecycle() !== "background";
    if (!wasVisible && nowVisible) {
      untracked(() => {
        fetchSummary({ bumpChildren: false });
        fetchTree(false);
      });
    }
    wasVisible = nowVisible;
  });

  // Idle lightweight summary polling (15s, zero sibling status fan-out).
  const poll = setInterval(() => {
    if (lifecycle() !== "background" && runtime.connection === "connected" && activeView() !== "github") {
      fetchSummary({ bumpChildren: false });
    }
  }, 15_000);
  cleanup(() => clearInterval(poll));

  const switchView = (v: GitPaneView) => {
    props.onChangeParams?.({ view: v });
  };

  const selectContext = (repoId: string, worktreePath: string) => {
    const defWt = tree()?.default_worktree ?? summary()?.default_worktree ?? null;
    const defRepo = tree()?.default_repo_id ?? null;
    if (defWt && worktreePath === defWt && (!defRepo || repoId === defRepo)) {
      props.onChangeParams?.({ repo: null, worktree: null });
    } else {
      props.onChangeParams?.({ repo: repoId, worktree: worktreePath });
    }
  };

  const backToProjectDefault = () => {
    props.onChangeParams?.({ repo: null, worktree: null });
  };

  const currentWorktreePath = computed(
    () => activeWorktree() ?? summary()?.worktree_root ?? summary()?.repo_root ?? props.projectDir,
  );
  const currentRepoId = computed(() => activeRepo() ?? summary()?.repo_id ?? tree()?.default_repo_id ?? ".");
  const currentRepoName = computed(() => {
    const repos = tree()?.repos ?? summary()?.repos ?? [];
    const hit = repos.find((r) => r.id === currentRepoId());
    if (hit) return hit.name;
    return projectDirLabel(summary()?.repo_root ?? props.projectDir);
  });
  const totalRepos = computed(() => tree()?.repos.length ?? summary()?.repos.length ?? 0);
  const totalWorktrees = computed(() => {
    const tRepos = tree()?.repos;
    if (!tRepos) return summary()?.is_repo ? 1 : 0;
    return tRepos.reduce((sum, r) => sum + r.worktrees.length, 0);
  });
  const canSwitchContext = computed(() => totalRepos() > 1 || totalWorktrees() > 1);

  // Only highlight "non-default worktree" when the project directory itself lives in a worktree.
  const isViewingOtherWorktree = computed(() => {
    const defWt = tree()?.default_worktree ?? summary()?.default_worktree ?? null;
    const curWt = summary()?.worktree_root ?? activeWorktree();
    if (!defWt || !curWt) return false;
    return curWt !== defWt;
  });

  // Remount child views when (repo, worktree) changes; exclude sessionId so sibling sessions keep selection.
  const contextKey = computed(() => `${activeRepo() ?? ""}\0${activeWorktree() ?? ""}`);

  const openFolderInPreview = (dirPath: string) => {
    const row: Attachment = {
      id: `virtual-project-${dirPath}`,
      message_id: "",
      workspace_relpath: dirPath,
      original_filename: projectDirLabel(dirPath),
      created_at: "",
      is_dir: true,
    };
    props.onOpenArtifact(dirPath, undefined, null, false, null, [row], props.sessionId);
  };

  const openFileInPreview = (absPath: string) => {
    props.onOpenArtifact(absPath, undefined, null, false, null, null, props.sessionId);
  };

  const startSessionInCurrent = () => {
    const cur = runtime.snapshot.sessions.find((s) => s.id === props.sessionId);
    const agent = cur ? projectAgentOf(cur) : "claude_code";
    void newProjectIn(runtime, currentWorktreePath(), agent);
  };

  const handleManualRefresh = () => {
    if (activeView() === "github") {
      ghForceToken.set(ghForceToken() + 1);
    }
    fetchTree(true);
    fetchSummary({ bumpChildren: true });
  };

  const tabLabel = (v: GitPaneView) => t().git.tabs[v];
  const branchText = () => {
    const s = summary();
    if (!s) return "";
    return s.branch ?? (s.head_oid ? s.head_oid.slice(0, 7) : t().git.detachedHead);
  };

  return (
    <View
      testID="git-pane"
      class="flex-1 min-h-0 min-w-0 bg-pane"
      onLayout={(e) => paneWidth.set(e.bounds.size.width)}
    >
      {/* Pane top bar: [Repo › Branch·Dirty ▾] [Back]  ...  [Actions] [Changes|History|GitHub] [Refresh] */}
      <View class="flex-row items-center gap-[6px] px-[10px] min-h-[42px] py-[6px] border-b border-line bg-pane shrink-0 flex-wrap">
        <If when={summary()?.is_repo ? summary() : null}>
          {(s) => (
            <View class="flex-row items-center gap-[5px] min-w-0 shrink">
              <View
                role="button"
                ref={(node) => pickerAnchor.set(node)}
                testID="git-context-breadcrumb"
                accessibilityLabel={t().git.worktreePicker}
                accessibilityState={{ expanded: pickerOpen() }}
                tooltip={tip(
                  isViewingOtherWorktree()
                    ? `${t().git.viewingOtherWorktree} · ${currentWorktreePath()}`
                    : currentWorktreePath(),
                )}
                disabled={!canSwitchContext()}
                onPress={() => {
                  if (!canSwitchContext()) return;
                  pickerOpen.set(!pickerOpen());
                }}
                class={`select-none flex-row items-center gap-[5px] px-[8px] h-[28px] rounded-(--radius-control-sm) border min-w-0 shrink ${
                  canSwitchContext() ? "cursor-pointer hover:border-line-hover" : "cursor-default"
                } ${
                  isViewingOtherWorktree()
                    ? "bg-accent-tint/40 border-accent-border"
                    : "bg-sidebar-bg border-line-subtle"
                }`}
              >
                <If when={totalRepos() > 1}>
                  <View class="flex-row items-center gap-[4px] shrink-0 max-w-[120px]">
                    <Icon name="folder" size={12} class="tint-ink-muted shrink-0" />
                    <Text testID="git-pane-repo" class="text-[11.5px] font-medium text-ink-secondary line-clamp-1 shrink min-w-0">
                      {currentRepoName()}
                    </Text>
                    <Icon name="chevron-right" size={12} class="tint-ink-muted shrink-0" />
                  </View>
                </If>
                <Icon
                  name="git-branch"
                  size={12}
                  class={`shrink-0 ${isViewingOtherWorktree() ? "tint-brand" : "tint-ink-muted"}`}
                />
                <Text
                  testID="git-pane-branch"
                  class={`font-mono text-[11.5px] font-semibold line-clamp-1 shrink min-w-0 ${
                    isViewingOtherWorktree() ? "text-brand" : "text-ink"
                  }`}
                >
                  {branchText()}
                </Text>
                <If when={s().dirty_count > 0}>
                  <Text class="font-mono text-[11px] font-semibold text-brand shrink-0">{`· ${s().dirty_count}`}</Text>
                </If>
                <If when={s().ahead > 0}>
                  <Text class="font-mono text-[11px] text-ok-text shrink-0">{`↑${s().ahead}`}</Text>
                </If>
                <If when={s().behind > 0}>
                  <Text class="font-mono text-[11px] text-warn-text shrink-0">{`↓${s().behind}`}</Text>
                </If>
                <If when={canSwitchContext()}>
                  <Icon name="chevron-down" size={12} class="tint-ink-muted shrink-0" />
                </If>
              </View>

              <If when={isViewingOtherWorktree()}>
                <IconButton
                  icon="rotate-ccw"
                  size="sm"
                  label={t().git.backToProjectDir}
                  testID="git-back-project-dir"
                  onPress={backToProjectDefault}
                />
              </If>

              <If when={s().operation}>
                {(op) => (
                  <View class="px-[6px] h-[20px] rounded-(--radius-xs) bg-warn-bg items-center justify-center shrink-0">
                    <Text class="text-[11px] font-semibold text-warn-text">{t().git.operation[op()]}</Text>
                  </View>
                )}
              </If>
            </View>
          )}
        </If>

        <View class="flex-row items-center gap-[6px] ml-auto shrink-0">
          {/* Current worktree quick actions (inline on wide panes, tucked into `⋯` on narrower panes) */}
          <If when={summary()?.is_repo}>
            <If
              when={showInlineActions()}
              else={
                <View ref={(node) => actionsAnchor.set(node)}>
                  <IconButton
                    icon="more"
                    size="sm"
                    label={t().git.moreActions}
                    testID="git-worktree-more-actions"
                    onPress={() => actionsOpen.set(!actionsOpen())}
                  />
                </View>
              }
            >
              <View class="flex-row items-center gap-[2px]">
                <IconButton
                  icon="plus"
                  size="sm"
                  label={t().git.worktrees.newSession}
                  testID="git-action-new-session"
                  onPress={startSessionInCurrent}
                />
                <IconButton
                  icon="terminal"
                  size="sm"
                  label={t().git.worktrees.openTerminal}
                  testID="git-action-terminal"
                  onPress={() => void runtime.openTerminalAt(currentWorktreePath())}
                />
                <IconButton
                  icon="folder"
                  size="sm"
                  label={t().git.worktrees.openDir}
                  testID="git-action-folder"
                  onPress={() => openFolderInPreview(currentWorktreePath())}
                />
              </View>
            </If>
          </If>

          {/* 3-View Segmented Control: Changes | History | GitHub */}
          <View class="flex-row items-center gap-[2px] p-[2px] rounded-(--radius-control) bg-sidebar-bg border border-line-subtle">
            <Each of={[...GIT_PANE_VIEWS]} key={(v) => v}>
              {(v) => {
                const on = () => activeView() === v();
                return (
                  <View
                    role="tab"
                    testID={`git-tab-${v()}`}
                    accessibilityLabel={tabLabel(v())}
                    accessibilityState={{ selected: on() }}
                    onPress={() => switchView(v())}
                    class={`cursor-pointer select-none flex-row items-center gap-[5px] px-[9px] h-[24px] rounded-(--radius-control-sm) ${
                      on() ? "bg-pane" : "hover:bg-row-hover"
                    }`}
                  >
                    <Icon name={VIEW_ICONS[v()]} size={16} class={on() ? "tint-brand" : "tint-ink-muted"} />
                    <Text class={`text-[12px] ${on() ? "font-semibold text-brand" : "text-ink-muted"}`}>{tabLabel(v())}</Text>
                  </View>
                );
              }}
            </Each>
          </View>

          <IconButton icon="refresh" size="sm" label={t().git.refresh} testID="git-pane-refresh" onPress={handleManualRefresh} />
        </View>
      </View>

      {/* Overflow menu for current worktree quick actions on narrower panes */}
      <If when={actionsOpen()}>
        <Overlay
          anchor={actionsAnchor()}
          placement="bottom"
          align="end"
          offset={4}
          margin={8}
          onPressOutside={() => actionsOpen.set(false)}
          onCancel={() => actionsOpen.set(false)}
        >
          <View
            role="menu"
            testID="git-worktree-actions-menu"
            class={`min-w-[168px] gap-[2px] ${MENU_SURFACE}`}
            style={{ boxShadow: shadow("menu") }}
          >
            <View
              role="menuitem"
              onPress={() => {
                actionsOpen.set(false);
                startSessionInCurrent();
              }}
              class={`cursor-pointer select-none ${MENU_ITEM}`}
            >
              <Icon name="plus" size={16} class="tint-ink-muted" />
              <Text class="text-[13px] font-medium text-ink">{t().git.worktrees.newSession}</Text>
            </View>
            <View
              role="menuitem"
              onPress={() => {
                actionsOpen.set(false);
                void runtime.openTerminalAt(currentWorktreePath());
              }}
              class={`cursor-pointer select-none ${MENU_ITEM}`}
            >
              <Icon name="terminal" size={16} class="tint-ink-muted" />
              <Text class="text-[13px] font-medium text-ink">{t().git.worktrees.openTerminal}</Text>
            </View>
            <View
              role="menuitem"
              onPress={() => {
                actionsOpen.set(false);
                openFolderInPreview(currentWorktreePath());
              }}
              class={`cursor-pointer select-none ${MENU_ITEM}`}
            >
              <Icon name="folder" size={16} class="tint-ink-muted" />
              <Text class="text-[13px] font-medium text-ink">{t().git.worktrees.openDir}</Text>
            </View>
          </View>
        </Overlay>
      </If>

      {/* Grouped Repo -> Worktree switcher popover */}
      <GitContextPopover
        open={pickerOpen()}
        anchor={pickerAnchor()}
        sessionId={props.sessionId}
        tree={tree()}
        selectedRepoId={currentRepoId()}
        selectedWorktreePath={currentWorktreePath()}
        onClose={() => pickerOpen.set(false)}
        onSelect={selectContext}
        onOpenFolder={openFolderInPreview}
      />

      {/* Body */}
      <If when={loading() && !summary()}>
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-[13px] text-ink-muted">{t().git.loading}</Text>
        </View>
      </If>

      <If when={!loading() && !summary() && errorMsg()}>
        <EmptyState testID="git-load-error" title={t().git.notRepoTitle} hint={errorMsg()!} />
      </If>

      <If when={!loading() && summary() && !summary()!.git_available}>
        <EmptyState testID="git-unavailable" title={t().git.gitUnavailableTitle} hint={t().git.gitUnavailableHint} />
      </If>

      <If when={!loading() && summary() && summary()!.git_available && !summary()!.is_repo}>
        <EmptyState testID="git-not-repo" title={t().git.notRepoTitle} hint={t().git.notRepoHint} />
      </If>

      <If when={summary()?.is_repo ? summary() : null}>
        {(s) => (
          <View class="flex-1 min-h-0">
            <Each of={[contextKey()]} key={(k) => k}>
              {() => (
                <View class="flex-1 min-h-0">
                  <If when={activeView() === "changes"}>
                    <GitChangesView
                      sessionId={props.sessionId}
                      summary={s()}
                      repo={activeRepo()}
                      worktree={activeWorktree()}
                      narrow={narrow()}
                      reloadToken={reloadToken()}
                      base={diffBase()}
                      onBaseChange={(b) => diffBase.set(b)}
                      scope={diffScope()}
                      onScopeChange={(sc) => diffScope.set(sc)}
                      onOpenPreview={openFileInPreview}
                    />
                  </If>
                  <If when={activeView() === "graph"}>
                    <GitGraphView
                      sessionId={props.sessionId}
                      repo={activeRepo()}
                      worktree={activeWorktree()}
                      narrow={narrow()}
                      reloadToken={reloadToken()}
                    />
                  </If>
                  <If when={activeView() === "github"}>
                    <GitHubView
                      sessionId={props.sessionId}
                      projectDir={props.projectDir}
                      repo={activeRepo()}
                      worktree={activeWorktree()}
                      isOtherWorktree={isViewingOtherWorktree()}
                      narrow={narrow()}
                      reloadToken={reloadToken()}
                      forceRefreshToken={ghForceToken()}
                    />
                  </If>
                </View>
              )}
            </Each>
          </View>
        )}
      </If>
    </View>
  );
}
