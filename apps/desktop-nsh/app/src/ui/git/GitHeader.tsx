/**
 * Responsive header for `GitPane` (ADR 0118).
 * - Desktop workbench (`host="pane"`): single bar with `[Repo › Branch·Dirty ▾]`, actions, `[Changes|History|GitHub]`, Refresh.
 * - Hosted tablet (`host="page"`, `!narrow`): single bar with back arrow + safe-area top.
 * - Phone (`host="page"`, `narrow`): two-row header (`[‹] [Breadcrumb] [⋯]` + full-width `[Changes|History|GitHub]`),
 *   tucking refresh and worktree actions into a `BottomSheet`.
 */
import { GIT_PANE_VIEWS, type GitPaneView, type GitRepoSummary } from "@real-bot/protocol";
import { Overlay, safeArea, signal, Text, View, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { BottomSheet, SheetItem, SheetSeparator } from "../BottomSheet";
import { Icon, type IconName } from "../Icon";
import { IconButton } from "../IconButton";
import { MENU_ITEM, MENU_SURFACE, shadow } from "../styles";
import { tip } from "../tip";
import type { GitHost } from "./git-levels";

const VIEW_ICONS: Record<GitPaneView, IconName> = {
  changes: "git-branch",
  graph: "history",
  github: "globe",
};

export function GitHeader(props: {
  host: GitHost;
  narrow: boolean;
  showInlineActions: boolean;
  summary: GitRepoSummary | null;
  activeView: GitPaneView;
  totalRepos: number;
  canSwitchContext: boolean;
  currentRepoName: string;
  currentWorktreePath: string;
  branchText: string;
  isViewingOtherWorktree: boolean;
  pickerOpen: boolean;
  onPickerAnchor: (node: ViewRef | null) => void;
  onTogglePicker: () => void;
  onBackProjectDefault: () => void;
  onSwitchView: (v: GitPaneView) => void;
  onRefresh: () => void;
  onNewSession: () => void;
  onOpenTerminal: () => void;
  onOpenFolder: () => void;
  onClose?: () => void;
}) {
  const t = () => copy();
  const actionsOpen = signal(false);
  const actionsAnchor = signal<ViewRef | null>(null);
  const isPhonePage = () => props.host === "page" && props.narrow;
  const tabLabel = (v: GitPaneView) => t().git.tabs[v];

  const runAction = (fn: () => void) => {
    actionsOpen.set(false);
    fn();
  };

  const breadcrumb = (fillWidth: boolean) => (
    <If when={props.summary?.is_repo ? props.summary : null}>
      {(s) => (
        <View
          role="button"
          ref={(node) => props.onPickerAnchor(node)}
          testID="git-context-breadcrumb"
          accessibilityLabel={t().git.worktreePicker}
          accessibilityState={{ expanded: props.pickerOpen }}
          tooltip={tip(
            props.isViewingOtherWorktree
              ? `${t().git.viewingOtherWorktree} · ${props.currentWorktreePath}`
              : props.currentWorktreePath,
          )}
          disabled={!props.canSwitchContext}
          onPress={() => {
            if (props.canSwitchContext) props.onTogglePicker();
          }}
          class={`select-none flex-row items-center gap-[5px] px-[8px] rounded-(--radius-control-sm) border min-w-0 ${
            fillWidth ? "flex-1 h-[34px]" : "shrink h-[28px]"
          } ${props.canSwitchContext ? "cursor-pointer hover:border-line-hover active:bg-row-hover" : "cursor-default"} ${
            props.isViewingOtherWorktree ? "bg-accent-tint/40 border-accent-border" : "bg-sidebar-bg border-line-subtle"
          }`}
        >
          <If when={props.totalRepos > 1}>
            <View class="flex-row items-center gap-[4px] shrink-0 max-w-[110px]">
              <Icon name="folder" size={12} class="tint-ink-muted shrink-0" />
              <Text testID="git-pane-repo" class="text-[11.5px] font-medium text-ink-secondary line-clamp-1 shrink min-w-0">
                {props.currentRepoName}
              </Text>
              <Icon name="chevron-right" size={12} class="tint-ink-muted shrink-0" />
            </View>
          </If>
          <Icon
            name="git-branch"
            size={12}
            class={`shrink-0 ${props.isViewingOtherWorktree ? "tint-brand" : "tint-ink-muted"}`}
          />
          <Text
            testID="git-pane-branch"
            class={`font-mono text-[12px] font-semibold line-clamp-1 shrink min-w-0 ${
              props.isViewingOtherWorktree ? "text-brand" : "text-ink"
            }`}
          >
            {props.branchText}
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
          <If when={props.canSwitchContext}>
            <Icon name="chevron-down" size={12} class={`tint-ink-muted shrink-0 ${fillWidth ? "ml-auto" : ""}`} />
          </If>
        </View>
      )}
    </If>
  );

  const segmented = (fullWidth: boolean) => (
    <View
      class={`flex-row items-center gap-[2px] p-[2px] rounded-(--radius-control) bg-sidebar-bg border border-line-subtle ${
        fullWidth ? "flex-1" : ""
      }`}
    >
      <Each of={[...GIT_PANE_VIEWS]} key={(v) => v}>
        {(v) => {
          const on = () => props.activeView === v();
          return (
            <View
              role="tab"
              testID={`git-tab-${v()}`}
              accessibilityLabel={tabLabel(v())}
              accessibilityState={{ selected: on() }}
              onPress={() => props.onSwitchView(v())}
              class={`cursor-pointer select-none flex-row items-center justify-center gap-[5px] rounded-(--radius-control-sm) ${
                fullWidth ? "flex-1 h-[30px] px-[6px]" : "px-[9px] h-[24px]"
              } ${on() ? "bg-pane" : "hover:bg-row-hover"}`}
            >
              <Icon name={VIEW_ICONS[v()]} size={16} class={on() ? "tint-brand" : "tint-ink-muted"} />
              <Text class={`text-[12px] ${on() ? "font-semibold text-brand" : "text-ink-muted"}`}>{tabLabel(v())}</Text>
            </View>
          );
        }}
      </Each>
    </View>
  );

  return (
    <>
      <If
        when={isPhonePage()}
        else={
          <View
            testID="git-header"
            class="flex-row items-center gap-[6px] px-[10px] min-h-[42px] py-[6px] border-b border-line bg-pane shrink-0 flex-wrap"
            style={props.host === "page" ? { paddingTop: Math.max(6, safeArea().top) } : undefined}
          >
            <If when={props.host === "page" && props.onClose}>
              <IconButton icon="chevron-left" size="sm" label={t().common.back} testID="git-page-back" onPress={() => props.onClose?.()} />
            </If>

            <View class="flex-row items-center gap-[5px] min-w-0 shrink">
              {breadcrumb(false)}
              <If when={props.isViewingOtherWorktree}>
                <IconButton
                  icon="rotate-ccw"
                  size="sm"
                  label={t().git.backToProjectDir}
                  testID="git-back-project-dir"
                  onPress={props.onBackProjectDefault}
                />
              </If>
              <If when={props.summary?.operation}>
                {(op) => (
                  <View class="px-[6px] h-[20px] rounded-(--radius-xs) bg-warn-bg items-center justify-center shrink-0">
                    <Text class="text-[11px] font-semibold text-warn-text">{t().git.operation[op()]}</Text>
                  </View>
                )}
              </If>
            </View>

            <View class="flex-row items-center gap-[6px] ml-auto shrink-0">
              <If when={props.summary?.is_repo}>
                <If
                  when={props.showInlineActions}
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
                    <IconButton icon="plus" size="sm" label={t().git.worktrees.newSession} testID="git-action-new-session" onPress={props.onNewSession} />
                    <IconButton icon="terminal" size="sm" label={t().git.worktrees.openTerminal} testID="git-action-terminal" onPress={props.onOpenTerminal} />
                    <IconButton icon="folder" size="sm" label={t().git.worktrees.openDir} testID="git-action-folder" onPress={props.onOpenFolder} />
                  </View>
                </If>
              </If>
              {segmented(false)}
              <IconButton icon="refresh" size="sm" label={t().git.refresh} testID="git-pane-refresh" onPress={props.onRefresh} />
            </View>
          </View>
        }
      >
        {/* Phone 2-row header (only shown at drill depth 0) */}
        <View
          testID="git-header"
          class="border-b border-line bg-pane shrink-0"
          style={{ paddingTop: safeArea().top }}
        >
          <View class="flex-row items-center gap-[4px] h-[48px] px-[4px]">
            <View
              role="button"
              testID="git-page-back"
              accessibilityLabel={t().common.back}
              onPress={() => props.onClose?.()}
              class="cursor-pointer select-none items-center justify-center w-[44px] h-[44px] rounded-(--radius-control-sm) active:bg-row-hover shrink-0"
            >
              <Icon name="chevron-left" size={20} class="tint-ink-secondary" />
            </View>
            <If
              when={props.summary?.is_repo}
              else={
                <Text class="flex-1 text-[16px] font-semibold text-ink px-[6px] line-clamp-1">{t().git.title}</Text>
              }
            >
              {breadcrumb(true)}
            </If>
            <View
              role="button"
              testID="git-worktree-more-actions"
              accessibilityLabel={t().git.moreActions}
              onPress={() => actionsOpen.set(true)}
              class="cursor-pointer select-none items-center justify-center w-[44px] h-[44px] rounded-(--radius-control-sm) active:bg-row-hover shrink-0"
            >
              <Icon name="more" size={20} class="tint-ink-secondary" />
            </View>
          </View>
          <If when={props.summary?.is_repo}>
            <View class="flex-row items-center gap-[6px] px-[10px] pb-[8px]">
              {segmented(true)}
            </View>
          </If>
        </View>
      </If>

      {/* Overflow menu: BottomSheet on phone page, anchored Overlay on desktop/tablet */}
      <If when={actionsOpen()}>
        <If
          when={isPhonePage()}
          else={
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
                <View role="menuitem" onPress={() => runAction(props.onNewSession)} class={`cursor-pointer select-none ${MENU_ITEM}`}>
                  <Icon name="plus" size={16} class="tint-ink-muted" />
                  <Text class="text-[13px] font-medium text-ink">{t().git.worktrees.newSession}</Text>
                </View>
                <View role="menuitem" onPress={() => runAction(props.onOpenTerminal)} class={`cursor-pointer select-none ${MENU_ITEM}`}>
                  <Icon name="terminal" size={16} class="tint-ink-muted" />
                  <Text class="text-[13px] font-medium text-ink">{t().git.worktrees.openTerminal}</Text>
                </View>
                <View role="menuitem" onPress={() => runAction(props.onOpenFolder)} class={`cursor-pointer select-none ${MENU_ITEM}`}>
                  <Icon name="folder" size={16} class="tint-ink-muted" />
                  <Text class="text-[13px] font-medium text-ink">{t().git.worktrees.openDir}</Text>
                </View>
              </View>
            </Overlay>
          }
        >
          <BottomSheet title={t().git.moreActions} closeLabel={t().common.close} onClose={() => actionsOpen.set(false)}>
            <View role="menu" testID="git-worktree-actions-menu">
              <SheetItem role="menuitem" testID="git-sheet-refresh" icon="refresh" label={t().git.refresh} onPress={() => runAction(props.onRefresh)} />
              <If when={props.isViewingOtherWorktree}>
                <SheetItem
                  role="menuitem"
                  testID="git-sheet-back-default"
                  icon="rotate-ccw"
                  label={t().git.backToProjectDir}
                  onPress={() => runAction(props.onBackProjectDefault)}
                />
              </If>
              <If when={props.summary?.is_repo}>
                <SheetSeparator />
                <SheetItem role="menuitem" testID="git-sheet-new-session" icon="plus" label={t().git.worktrees.newSession} onPress={() => runAction(props.onNewSession)} />
                <SheetItem role="menuitem" testID="git-sheet-terminal" icon="terminal" label={t().git.worktrees.openTerminal} onPress={() => runAction(props.onOpenTerminal)} />
                <SheetItem role="menuitem" testID="git-sheet-folder" icon="folder" label={t().git.worktrees.openDir} onPress={() => runAction(props.onOpenFolder)} />
              </If>
            </View>
          </BottomSheet>
        </If>
      </If>
    </>
  );
}
