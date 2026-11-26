/**
 * Unified Repo -> Worktree grouped switcher popover (ADR 0118).
 * Desktop renders an anchored `Overlay` below the breadcrumb; narrow windows render a `BottomSheet`.
 * Selecting a worktree updates `(repo, worktree)` in place without changing the active view tab.
 * Dirty/ahead/behind badges are lazily loaded per visible row with bounded concurrency (2) and
 * kept strictly isolated from `projectGitStore` so chat headers stay anchored to the project dir.
 */
import type { GitProjectTreeResponse, GitTreeRepo, GitTreeWorktree, SessionSummary } from "@real-bot/protocol";
import { computed, effect, keymap, Overlay, Scroll, signal, Text, untracked, View, type ViewRef } from "nsh";
import { newProjectIn } from "../../m/sidebar/project-actions.ts";
import { dirDisplay, isLiveRun, projectAgentOf } from "../../m/sidebar/project-groups.ts";
import { copy, runtime } from "../../runtime";
import { BottomSheet } from "../BottomSheet";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";
import { narrowWindow } from "../Modal";
import { AgentLogo } from "../settings/AgentLogo";
import { MENU_SURFACE, shadow } from "../styles";
import { tip } from "../tip";

type LazyStatus = {
  dirty: number;
  ahead: number;
  behind: number;
  at: number;
};

const LAZY_TTL_MS = 15_000;
const LAZY_MAX_ROWS = 16;
const LAZY_CONCURRENCY = 2;

export function GitContextPopover(props: {
  open: boolean;
  anchor: ViewRef | null;
  sessionId: string;
  tree: GitProjectTreeResponse | null;
  selectedRepoId: string | null;
  selectedWorktreePath: string | null;
  onClose: () => void;
  onSelect: (repoId: string, worktreePath: string) => void;
  onOpenFolder: (dirPath: string) => void;
}) {
  const t = () => copy();
  const statuses = signal<Record<string, LazyStatus>>({});
  const sessionsById = computed(() => new Map(runtime.snapshot.sessions.map((s) => [s.id, s] as const)));

  // Escape closes desktop overlay cleanly.
  effect(() => {
    if (!props.open || narrowWindow()) return;
    const off = keymap.bind("escape", () => props.onClose(), { when: "always" });
    return () => off();
  });

  // Lazily fetch dirty/ahead/behind for visible non-prunable rows when the popover opens.
  let fetchGen = 0;
  effect(() => {
    const isOpen = props.open;
    const tree = props.tree;
    const sid = props.sessionId;
    if (!isOpen || !tree) return;
    const api = runtime.client;
    if (!api) return;
    const gen = ++fetchGen;

    untracked(() => {
      const now = Date.now();
      const cache = statuses();
      const queue: Array<{ repoId: string; wtPath: string }> = [];
      for (const repo of tree.repos) {
        for (const wt of repo.worktrees) {
          if (wt.prunable) continue;
          const prev = cache[wt.path];
          if (prev && now - prev.at < LAZY_TTL_MS) continue;
          queue.push({ repoId: repo.id, wtPath: wt.path });
          if (queue.length >= LAZY_MAX_ROWS) break;
        }
        if (queue.length >= LAZY_MAX_ROWS) break;
      }
      if (queue.length === 0) return;

      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length && gen === fetchGen) {
          const item = queue[cursor++]!;
          try {
            const sum = await api.gitSummary(sid, { repo: item.repoId, worktree: item.wtPath, quick: true });
            if (gen !== fetchGen) return;
            statuses.set({
              ...statuses(),
              [item.wtPath]: {
                dirty: sum.dirty_count,
                ahead: sum.ahead,
                behind: sum.behind,
                at: Date.now(),
              },
            });
          } catch {
            // Ignore transient status failures on individual rows.
          }
        }
      };

      for (let i = 0; i < Math.min(LAZY_CONCURRENCY, queue.length); i += 1) {
        void worker();
      }
    });
  });

  const startSessionIn = (wtPath: string) => {
    const cur = sessionsById().get(props.sessionId);
    const agent = cur ? projectAgentOf(cur) : "claude_code";
    props.onClose();
    void newProjectIn(runtime, wtPath, agent);
  };

  const renderWorktreeRow = (repo: GitTreeRepo, wt: GitTreeWorktree) => {
    const selected = () => props.selectedWorktreePath === wt.path;
    const branchLabel = wt.branch ?? (wt.head_oid ? wt.head_oid.slice(0, 7) : t().git.detachedHead);
    const pathLabel = wt.rel_path === "." ? dirDisplay(wt.path) : wt.rel_path;
    const st = () => statuses()[wt.path] ?? null;
    const sessions = (): SessionSummary[] =>
      wt.session_ids
        .map((id) => sessionsById().get(id))
        .filter((s): s is SessionSummary => Boolean(s));

    return (
      <View
        testID={`git-ctx-wt-${wt.branch ?? wt.head_oid ?? wt.path}`}
        class={`px-[8px] py-[7px] rounded-(--radius-sm) gap-[5px] ${
          selected() ? "bg-accent-tint/70 border border-accent-border" : "border border-transparent hover:bg-row-hover"
        }`}
      >
        <View class="flex-row items-center gap-[6px] min-w-0">
          {/* Primary press target: select this (repo, worktree) in place */}
          <View
            role="menuitem"
            disabled={wt.prunable}
            onPress={() => {
              if (wt.prunable) return;
              props.onSelect(repo.id, wt.path);
              props.onClose();
            }}
            class="cursor-pointer select-none disabled:cursor-default flex-1 min-w-0 gap-[2px]"
          >
            <View class="flex-row items-center gap-[5px] min-w-0">
              <Icon
                name={selected() ? "check" : "git-branch"}
                size={12}
                class={`shrink-0 ${selected() ? "tint-brand" : "tint-ink-muted"}`}
              />
              <Text
                class={`font-mono text-[12px] shrink min-w-0 line-clamp-1 ${
                  selected() ? "font-semibold text-brand" : wt.prunable ? "text-ink-muted" : "font-medium text-ink"
                }`}
              >
                {branchLabel}
              </Text>
              <If when={wt.is_main}>
                <View class="px-[5px] h-[15px] rounded-(--radius-xs) bg-chip items-center justify-center shrink-0">
                  <Text class="text-[9.5px] font-medium text-ink-secondary">{t().git.worktrees.mainBadge}</Text>
                </View>
              </If>
              <If when={wt.is_project_dir}>
                <View class="px-[5px] h-[15px] rounded-(--radius-xs) bg-accent-tint items-center justify-center shrink-0">
                  <Text class="text-[9.5px] font-semibold text-brand">{t().git.projectDirBadge}</Text>
                </View>
              </If>
              <If when={wt.locked}>
                <View class="px-[5px] h-[15px] rounded-(--radius-xs) bg-warn-bg items-center justify-center shrink-0">
                  <Text class="text-[9.5px] font-medium text-warn-text">{t().git.worktrees.lockedBadge}</Text>
                </View>
              </If>
              <If when={wt.prunable}>
                <View class="px-[5px] h-[15px] rounded-(--radius-xs) bg-danger-bg items-center justify-center shrink-0">
                  <Text class="text-[9.5px] font-medium text-danger-text">{t().git.worktrees.prunableBadge}</Text>
                </View>
              </If>
            </View>
            <View tooltip={tip(wt.path)} class="min-w-0 pl-[17px]">
              <Text class="font-mono text-[10.5px] text-ink-muted line-clamp-1">{pathLabel}</Text>
            </View>
          </View>

          {/* Fixed-width status column so lazy dirty counts never shift overlay geometry */}
          <View class="w-[74px] flex-row items-center justify-end gap-[4px] shrink-0">
            <If when={st()}>
              {(s) => (
                <>
                  <If when={s().dirty > 0}>
                    <Text class="text-[10.5px] font-semibold text-brand">{t().git.dirtyBadge(s().dirty)}</Text>
                  </If>
                  <If when={s().ahead > 0}>
                    <Text class="font-mono text-[10.5px] text-ok-text">{`↑${s().ahead}`}</Text>
                  </If>
                  <If when={s().behind > 0}>
                    <Text class="font-mono text-[10.5px] text-warn-text">{`↓${s().behind}`}</Text>
                  </If>
                </>
              )}
            </If>
          </View>

          {/* Row-end quick actions */}
          <View class="flex-row items-center gap-[1px] shrink-0">
            <IconButton
              icon="plus"
              size="xs"
              label={t().git.worktrees.newSession}
              disabled={wt.prunable}
              onPress={() => startSessionIn(wt.path)}
            />
            <IconButton
              icon="terminal"
              size="xs"
              label={t().git.worktrees.openTerminal}
              disabled={wt.prunable}
              onPress={() => {
                props.onClose();
                void runtime.openTerminalAt(wt.path);
              }}
            />
            <IconButton
              icon="folder"
              size="xs"
              label={t().git.worktrees.openDir}
              disabled={wt.prunable}
              onPress={() => {
                props.onClose();
                props.onOpenFolder(wt.path);
              }}
            />
          </View>
        </View>

        {/* Linked project sessions (clicking jumps to that chat without changing current viewed worktree) */}
        <If when={sessions().length > 0}>
          <View class="flex-row flex-wrap gap-[4px] pl-[17px]">
            <Each of={sessions()} key={(s) => s.id}>
              {(s) => {
                const live = () => isLiveRun(runtime.snapshot.agentRuns[s().id]);
                return (
                  <View
                    role="button"
                    testID={`git-ctx-session-${s().id}`}
                    tooltip={tip(s().name || t().project.untitled)}
                    onPress={() => {
                      props.onClose();
                      void runtime.openChat(s().id);
                    }}
                    class="cursor-pointer select-none flex-row items-center gap-[4px] px-[6px] h-[21px] rounded-(--radius-control-xs) border border-line bg-pane hover:border-accent-border"
                  >
                    <AgentLogo runner={projectAgentOf(s())} size={12} />
                    <Text class="text-[11px] text-ink max-w-[140px] shrink min-w-0 line-clamp-1">
                      {s().name || t().project.untitled}
                    </Text>
                    <If when={live()}>
                      <View class="w-[5px] h-[5px] rounded-full bg-brand shrink-0" />
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>
        </If>
      </View>
    );
  };

  const body = () => {
    const repos = () => props.tree?.repos ?? [];
    const multiRepo = () => repos().length > 1;
    return (
      <Scroll class="max-h-[420px]" contentClass="p-[6px] gap-[8px]">
        <If when={repos().length === 0}>
          <View class="py-4 px-3 items-center">
            <Text class="text-[12px] text-ink-muted">{t().git.worktrees.empty}</Text>
          </View>
        </If>
        <Each of={repos()} key={(r) => r.id}>
          {(repo) => (
            <View testID={`git-ctx-repo-${repo().id}`} class="gap-[3px]">
              <If when={multiRepo() || Boolean(repo().error)}>
                <View class="flex-row items-center gap-[6px] px-[8px] pt-[4px] pb-[2px]">
                  <Icon name="folder" size={12} class="tint-ink-muted shrink-0" />
                  <Text class="text-[11px] font-semibold text-ink-secondary line-clamp-1 shrink min-w-0">
                    {repo().name}
                  </Text>
                  <If when={repo().id !== "." && repo().id !== repo().name}>
                    <Text class="font-mono text-[10px] text-ink-muted line-clamp-1">{repo().id}</Text>
                  </If>
                </View>
              </If>
              <If when={repo().error}>
                <Text class="text-[11px] text-danger-text px-[8px] py-[2px]">{repo().error}</Text>
              </If>
              <Each of={repo().worktrees} key={(wt) => wt.path}>
                {(wt) => renderWorktreeRow(repo(), wt())}
              </Each>
            </View>
          )}
        </Each>
      </Scroll>
    );
  };

  return (
    <If when={props.open}>
      <If
        when={narrowWindow()}
        else={
          <Overlay
            anchor={props.anchor}
            placement="bottom"
            align="start"
            offset={4}
            margin={8}
            onPressOutside={() => props.onClose()}
            onCancel={() => props.onClose()}
          >
            <View
              role="menu"
              testID="git-context-popover"
              accessibilityLabel={t().git.pickerTitle}
              class={`w-[440px] max-w-[92vw] ${MENU_SURFACE}`}
              style={{ boxShadow: shadow("menu") }}
            >
              {body()}
            </View>
          </Overlay>
        }
      >
        <BottomSheet title={t().git.pickerTitle} closeLabel={t().common.close} onClose={() => props.onClose()}>
          <View role="menu" testID="git-context-popover" accessibilityLabel={t().git.pickerTitle}>
            {body()}
          </View>
        </BottomSheet>
      </If>
    </If>
  );
}
