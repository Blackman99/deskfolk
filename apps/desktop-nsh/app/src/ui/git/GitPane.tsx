/**
 * Unified project-scoped Git & GitHub workbench pane / mobile session page (ADR 0118).
 * Works cleanly across three orthogonal axes:
 * - `host: "pane" | "page"`: desktop workbench tab vs full-screen phone/tablet page (`?s=<id>&o=git`).
 * - `narrow` (measured width < 540): single-column history-backed drill-down vs two-column desktop/tablet.
 * - `isRemote` (`client.kind === "remote"`): disables 15s polling and lazy row fan-out, enforces
 *   `AbortSignal` cancellation, caps initial diff bytes, and surfaces host-upgrade hint on 404.
 */
import type {
  Attachment,
  GitDiffBase,
  GitPaneView,
  GitProjectTreeResponse,
  GitRepoSummary,
} from "@real-bot/protocol";
import { cleanup, computed, effect, signal, Text, untracked, View, type ViewRef } from "nsh";
import { ApiError } from "../../m/api.ts";
import { projectGitStore } from "../../m/git/git-store.svelte.ts";
import { newProjectIn } from "../../m/sidebar/project-actions.ts";
import { isLiveRun, projectAgentOf, projectDirLabel } from "../../m/sidebar/project-groups.ts";
import { showToast } from "../../m/toast.svelte.ts";
import { lifecycle } from "../../platform/lifecycle";
import { copy, runtime } from "../../runtime";
import { EmptyState } from "../EmptyState";
import { settled } from "../workbench/drag-settle";
import { GitChangesView } from "./GitChangesView";
import { GitContextPopover } from "./GitContextPopover";
import { GitGraphView } from "./GitGraphView";
import { GitHeader } from "./GitHeader";
import { GitHubView } from "./GitHubView";
import type { GitHost } from "./git-levels";

export function GitPane(props: {
  sessionId: string;
  projectDir: string;
  host?: GitHost;
  view?: GitPaneView;
  worktree?: string | null;
  repo?: string | null;
  pickerNonce?: number | null;
  onClose?: () => void;
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
  const host = (): GitHost => props.host ?? "pane";
  const isRemote = () => runtime.client?.kind === "remote";
  const paneWidth = signal(720);
  const narrow = settled(() => paneWidth() > 0 && paneWidth() < 540);
  const showInlineActions = settled(() => paneWidth() >= 820);

  // Single source of truth: derived directly from tab / page params.
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
  const remoteNeedsUpgrade = signal(false);
  const reloadToken = signal(0);
  const ghForceToken = signal(0);
  const drillDepth = signal(0);

  const pickerOpen = signal(false);
  const pickerAnchor = signal<ViewRef | null>(null);

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

  // Fetch zero-status repo -> worktree tree with AbortSignal & graceful 404 fallback on local daemon.
  let treeSeq = 0;
  let activeTreeAc: AbortController | null = null;
  const fetchTree = (refresh = false) => {
    const api = runtime.client;
    if (!api) return;
    activeTreeAc?.abort();
    const ac = new AbortController();
    activeTreeAc = ac;
    const req = ++treeSeq;
    const sid = props.sessionId;
    const pdir = props.projectDir;
    const remote = isRemote();
    void api
      .gitTree(sid, { refresh }, ac.signal)
      .then((res) => {
        if (req === treeSeq && !ac.signal.aborted) tree.set(res);
      })
      .catch(async (err) => {
        if (req !== treeSeq || ac.signal.aborted) return;
        if (!remote && err instanceof ApiError && err.status === 404) {
          // Graceful degradation on desktop when UI hot-reloads ahead of daemon restart.
          try {
            const wtRes = await api.gitWorktrees(sid, { repo: activeRepo() }, ac.signal);
            if (req !== treeSeq || ac.signal.aborted) return;
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
  cleanup(() => activeTreeAc?.abort());

  let sumSeq = 0;
  let activeSumAc: AbortController | null = null;
  let lastSig = "";
  let fallbackAttemptedKey = "";
  const fetchSummary = (opts: { bumpChildren: boolean; resetSig?: boolean }) => {
    const api = runtime.client;
    if (!api) return;
    activeSumAc?.abort();
    const ac = new AbortController();
    activeSumAc = ac;
    const req = ++sumSeq;
    const repo = activeRepo();
    const wt = activeWorktree();
    const ctxKey = `${repo ?? ""}\0${wt ?? ""}`;
    if (opts.resetSig) lastSig = "";
    void api
      .gitSummary(props.sessionId, { repo, worktree: wt, quick: true }, ac.signal)
      .then((res) => {
        if (req !== sumSeq || ac.signal.aborted) return;
        summary.set(res);
        errorMsg.set(null);
        remoteNeedsUpgrade.set(false);
        loading.set(false);
        // Seed shared header summary cache directly for default checkout (no second HTTP fetch!).
        if (!repo && !wt) {
          projectGitStore.seed(props.projectDir, res);
        }
        if (opts.bumpChildren || (lastSig && res.signature !== lastSig)) {
          reloadToken.set(reloadToken() + 1);
        }
        lastSig = res.signature;
      })
      .catch((err) => {
        if (req !== sumSeq || ac.signal.aborted) return;
        // Remote phone talking to an older daemon without Git routes gets 404.
        if (isRemote() && err instanceof ApiError && err.status === 404) {
          remoteNeedsUpgrade.set(true);
          loading.set(false);
          return;
        }
        // Only fall back on explicit stale worktree/repo error codes (never remote whitelist 422s).
        if (
          err instanceof ApiError &&
          err.status === 422 &&
          (err.code === "git_worktree_not_found" || err.code === "git_repo_not_found") &&
          (repo || wt) &&
          fallbackAttemptedKey !== ctxKey
        ) {
          fallbackAttemptedKey = ctxKey;
          showToast(t().git.staleWorktreeFallback, { tone: "info" });
          props.onChangeParams?.({ repo: null, worktree: null });
          return;
        }
        // Keep last good summary visible on transient offline/weak-network errors.
        if (!summary()) errorMsg.set(err instanceof Error ? err.message : String(err));
        loading.set(false);
      });
  };
  cleanup(() => activeSumAc?.abort());

  // Initial load & reload when repo/worktree switches. Children remount via `contextKey`, so no double fetch.
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

  // Refresh summary AND active child view when connection recovers (e.g. phone returns from background).
  let prevConn = runtime.connection;
  effect(() => {
    const conn = runtime.connection;
    const recovered = prevConn !== "connected" && conn === "connected";
    prevConn = conn;
    if (recovered) {
      untracked(() => {
        fetchSummary({ bumpChildren: true });
        fetchTree(false);
      });
    }
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

  // Refresh when window/page regains foreground focus.
  let wasVisible = lifecycle() !== "background";
  effect(() => {
    const nowVisible = lifecycle() !== "background";
    if (!wasVisible && nowVisible && runtime.connection === "connected") {
      untracked(() => {
        fetchSummary({ bumpChildren: false });
        fetchTree(false);
      });
    }
    wasVisible = nowVisible;
  });

  // Idle summary polling on LOCAL connections only (remote links are single-flight serial).
  const poll = setInterval(() => {
    if (!isRemote() && lifecycle() !== "background" && runtime.connection === "connected" && activeView() !== "github") {
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

  const branchText = () => {
    const s = summary();
    if (!s) return "";
    return s.branch ?? (s.head_oid ? s.head_oid.slice(0, 7) : t().git.detachedHead);
  };

  // On narrow screens, hide the top header while drilled into depth 1/2 so child pages own the screen cleanly.
  const showHeader = () => !(narrow() && drillDepth() > 0);

  return (
    <View
      testID="git-pane"
      class="flex-1 min-h-0 min-w-0 bg-pane"
      onLayout={(e) => paneWidth.set(e.bounds.size.width)}
    >
      <If when={showHeader()}>
        <GitHeader
          host={host()}
          narrow={narrow()}
          showInlineActions={showInlineActions()}
          summary={summary()}
          activeView={activeView()}
          totalRepos={totalRepos()}
          canSwitchContext={canSwitchContext()}
          currentRepoName={currentRepoName()}
          currentWorktreePath={currentWorktreePath()}
          branchText={branchText()}
          isViewingOtherWorktree={isViewingOtherWorktree()}
          pickerOpen={pickerOpen()}
          onPickerAnchor={(node) => pickerAnchor.set(node)}
          onTogglePicker={() => pickerOpen.set(!pickerOpen())}
          onBackProjectDefault={backToProjectDefault}
          onSwitchView={switchView}
          onRefresh={handleManualRefresh}
          onNewSession={startSessionInCurrent}
          onOpenTerminal={() => void runtime.openTerminalAt(currentWorktreePath())}
          onOpenFolder={() => openFolderInPreview(currentWorktreePath())}
          onClose={props.onClose}
        />
      </If>

      {/* Grouped Repo -> Worktree switcher popover / sheet */}
      <GitContextPopover
        open={pickerOpen()}
        anchor={pickerAnchor()}
        host={host()}
        narrow={narrow()}
        isRemote={isRemote()}
        sessionId={props.sessionId}
        tree={tree()}
        currentSummary={summary()}
        selectedRepoId={currentRepoId()}
        selectedWorktreePath={currentWorktreePath()}
        onClose={() => pickerOpen.set(false)}
        onSelect={selectContext}
        onOpenFolder={openFolderInPreview}
      />

      {/* Body */}
      <If when={loading() && !summary() && !remoteNeedsUpgrade()}>
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-[13px] text-ink-muted">{t().git.loading}</Text>
        </View>
      </If>

      <If when={remoteNeedsUpgrade()}>
        <EmptyState testID="git-remote-upgrade" title={t().git.remoteUpgradeTitle} hint={t().git.remoteUpgradeHint} />
      </If>

      <If when={!loading() && !summary() && !remoteNeedsUpgrade() && errorMsg()}>
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
                      host={host()}
                      isRemote={isRemote()}
                      narrow={narrow()}
                      reloadToken={reloadToken()}
                      base={diffBase()}
                      onBaseChange={(b) => diffBase.set(b)}
                      scope={diffScope()}
                      onScopeChange={(sc) => diffScope.set(sc)}
                      onDrillDepthChange={(d) => drillDepth.set(d)}
                      onOpenPreview={openFileInPreview}
                    />
                  </If>
                  <If when={activeView() === "graph"}>
                    <GitGraphView
                      sessionId={props.sessionId}
                      repo={activeRepo()}
                      worktree={activeWorktree()}
                      host={host()}
                      isRemote={isRemote()}
                      narrow={narrow()}
                      reloadToken={reloadToken()}
                      onDrillDepthChange={(d) => drillDepth.set(d)}
                    />
                  </If>
                  <If when={activeView() === "github"}>
                    <GitHubView
                      sessionId={props.sessionId}
                      projectDir={props.projectDir}
                      repo={activeRepo()}
                      worktree={activeWorktree()}
                      isOtherWorktree={isViewingOtherWorktree()}
                      host={host()}
                      isRemote={isRemote()}
                      narrow={narrow()}
                      reloadToken={reloadToken()}
                      forceRefreshToken={ghForceToken()}
                      onDrillDepthChange={(d) => drillDepth.set(d)}
                      onLeaveAfterQuote={props.onClose}
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
