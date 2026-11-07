/**
 * The session list put away (`SidebarRail.svelte`): every conversation it shows, as its avatar alone,
 * in the same order and sections. Enough to see who is talking and to switch; names are in the
 * tooltips (`RailTooltip`). The footer is icons: workspace, tools and settings, the tools menu flown
 * out beside the rail so it covers none of them.
 *
 * Props the Svelte one took as `bind:`: `toolsMenuOpen` + `onToolsMenuOpenChange`. `runtime` and `t`
 * are the app's (`runtime`, `copy()`).
 */
import type { SessionSummary } from "@real-bot/protocol";
import { Scroll, signal, Text, token, View, type ContextMenuEvent, type ViewRef } from "nsh";
import type { SessionDragHandler } from "./session-drag";
import { titleBar } from "nsh/desktop";
import { copy, runtime } from "../../runtime";
import { formatShortcut } from "../../m/keymap";
import { searchShortcutLabel } from "../../m/search/shortcuts";
import { updateChecker } from "../../m/update-checker.svelte";
import { usageWidget } from "../../m/usage/usage-widget.svelte";
import { directElsewhere } from "../../m/sidebar/bot-elsewhere";
import { isLiveRun, liveRunSessionIds, projectAgentOf } from "../../m/sidebar/project-groups";
import { groupSessions, isFileDropSession, isSessionArchived } from "../../m/sidebar/session-groups";
import { botWorkStatus, sidebarStatus } from "../../m/sidebar/session-status";
import { sessionTitle } from "../../m/sidebar/session-title";
import { sessionUnreadCount, unreadBadge } from "../../m/sidebar/unread";
import { loadWorkingOnly, onlyWorking, saveWorkingOnly, workingOrUnreadIds } from "../../m/sidebar/working-only";
import { BrandMark } from "../BrandMark";
import { Icon, type IconName } from "../Icon";
import { SessionAvatar } from "../SessionAvatar";
import { AgentLogo } from "../settings/AgentLogo";
import { dismissRailTips, RailTooltip } from "./RailTooltip";
import { ToolsMenu } from "./ToolsMenu";

export function SidebarRail(props: {
  pinnedSessionIds: string[];
  /** Marks the avatar the context menu belongs to. */
  contextMenuSessionId: string | null;
  /** Escape closes the tools menu before anything else, so the shell holds it. */
  toolsMenuOpen?: boolean;
  onToolsMenuOpenChange: (open: boolean) => void;
  workspaceOpen: boolean;
  onOpenContextMenu: (e: ContextMenuEvent, session: SessionSummary) => void;
  onExpand: () => void;
  onToggleWorkspace: () => void;
  onOpenRoutines: () => void;
  onOpenSpend: () => void;
  /** Whether the workbench is on screen; a tablet on a remote connection folds its list without one. */
  workbench: boolean;
  onNewTerminal: () => void;
  /** The archived list is a view of the full list; this opens the list already on it. */
  onOpenArchived: () => void;
  onOpenSettings: () => void;
  /** The folded list has no search field; this opens the same search the field does. */
  onOpenSearch: () => void;
  /** A press on an avatar that may become a drag into the workbench: only where there is one. */
  onDragSession?: SessionDragHandler;
}) {
  const snapshot = () => runtime.snapshot;
  const botsById = () => new Map(snapshot().bots.map((b) => [b.id, b] as const));
  const aliveBotIds = () => new Set(snapshot().bots.map((b) => b.id));
  const rosterLabels = () => ({ deleted: copy().top.deleted, archived: copy().top.archived, fileDrop: copy().sidebar.fileDrop, projectUntitled: copy().project.untitled });
  const statusLabels = () => ({
    running: copy().sidebar.statusRunning,
    replying: copy().sidebar.statusReplying,
    waitingApproval: copy().sidebar.statusWaitingApproval,
    waitingAsk: copy().sidebar.statusWaitingAsk,
    failed: copy().sidebar.statusFailed,
    interrupted: copy().sidebar.statusInterrupted,
    idle: copy().sidebar.statusIdle,
  });
  const grouped = () => groupSessions(snapshot().sessions, props.pinnedSessionIds, aliveBotIds(), botsById());

  /** The list's "working and unread" switch, the same stored one, so folding the list keeps its view. */
  const workingOnly = signal(loadWorkingOnly());
  function toggleWorkingOnly(): void {
    workingOnly.set(!workingOnly());
    saveWorkingOnly(workingOnly());
  }
  const workingIds = () =>
    workingOnly()
      ? workingOrUnreadIds(snapshot().sessions, snapshot().turns, snapshot().approvals, snapshot().pendingJudgements, liveRunSessionIds(snapshot().agentRuns))
      : null;
  const listed = () => onlyWorking(grouped(), workingIds(), runtime.selectedId);

  /**
   * The list's sections, empty ones dropped so no two dividers meet. A Bot↔Bot direct is not one:
   * it opens from the message it hangs under, in a popup (ADR 0091).
   */
  const sections = () => {
    const l = listed();
    return [l.pinned, l.fileDrop ? [l.fileDrop] : [], l.bots, l.project].filter((section) => section.length > 0);
  };

  const statusOf = (session: SessionSummary) =>
    sidebarStatus(session, snapshot().turns, snapshot().approvals, statusLabels(), snapshot().pendingJudgements, snapshot().messages);
  const botStatusOf = (botId: string) => botWorkStatus(botId, snapshot().turns, snapshot().approvals, statusLabels(), snapshot().pendingJudgements);

  const archivedCount = () => snapshot().sessions.filter((session) => isSessionArchived(session, botsById())).length;
  const toolsAnchor = signal<ViewRef | null>(null);
  const toolsFocusLast = signal(false);

  /** A control's tip: what it does, then the shortcut. The accessible name stays the function. */
  const shortcutTip = (label: string, shortcut: string): string[] => [label, shortcut];

  /**
   * The full title, then a short line of whatever the avatar already shows: what is waiting, or how
   * many are unread. Idle and a clean badge say nothing more.
   */
  function sessionTip(session: SessionSummary, title: string, status: ReturnType<typeof statusOf>, unread: number): string[] {
    const lines = [title];
    if (status.kind === "waiting_approval" && status.count) {
      lines.push(`${status.label} ${status.count}`);
    } else if (status.kind !== "idle") {
      lines.push(status.label);
    } else {
      // Your direct, quiet here while its Bot's face says it is busy: where it is.
      const elsewhere = directElsewhere(session, false, snapshot(), botsById(), statusLabels(), rosterLabels(), copy().sidebar.elsewhere);
      if (elsewhere) lines.push(elsewhere);
    }
    const run = snapshot().agentRuns[session.id];
    if (session.kind === "project" && isLiveRun(run)) lines.push(run?.idle ? copy().sidebar.statusBackground : copy().project.live);
    if (unread > 0) lines.push(`${copy().sidebar.unread} ${unread}`);
    return lines;
  }

  const workspaceSet = () => Boolean(snapshot().settings.workspace_path);
  const settingsTip = () => (updateChecker.updateVisible ? `${copy().sidebar.settings} · ${copy().sidebar.updateAvailable}` : copy().sidebar.settings);
  /**
   * Where the window hides its title bar and the traffic lights sit over the rail's top (`titleBar().left`,
   * 0 while the system shows its bar), the rail makes room for them and the mark gives them its place.
   */
  const mac = () => titleBar().left > 0;

  const ACTION = "group w-[40px] h-[36px] items-center justify-center border border-transparent rounded-(--radius-sm) hover:border-line";
  const action = (active: boolean | undefined, margin = "mx-[12px]") => `${ACTION} ${margin} ${active ? "bg-accent-tint border-accent-border" : ""}`;
  const glyph = (name: IconName, active: boolean | undefined) => <Icon name={name} class={active ? "tint-brand" : "tint-ink-muted group-hover:tint-ink"} />;

  const item = (session: SessionSummary) => {
    const title = () => sessionTitle(session, botsById(), rosterLabels());
    const status = () => statusOf(session);
    const unread = () => sessionUnreadCount(session);
    const on = () => runtime.selectedId === session.id;
    const lit = () => on() || props.contextMenuSessionId === session.id;
    return (
      <RailTooltip
        testID={`rail-session-${session.id}`}
        class={`group w-[48px] h-[48px] items-center justify-center border border-transparent rounded-(--radius-md) ${lit() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
        label={sessionTip(session, title(), status(), unread())}
        name={unread() > 0 ? `${title()} · ${copy().sidebar.unread} ${unread()}` : title()}
        describedBy={`rail-tip-${session.id}`}
        current={on()}
        onPress={() => void runtime.selectSession(session.id)}
        onContextMenu={(e) => props.onOpenContextMenu(e, session)}
        onDrag={props.onDragSession ? (phase, point) => props.onDragSession?.(phase, point, session) : undefined}
      >
        <If
          when={isFileDropSession(session)}
          else={
            <If when={session.kind === "project"} else={<SessionAvatar session={session} bots={botsById()} botStatus={botStatusOf} ringColor={token(lit() ? "accent-tint" : "ground")} />}>
              {/* Its agent's mark, as its row in the open sidebar wears it; the dot while the agent works. */}
              <View testID="rail-agent" accessible={false} class="relative w-[40px] h-[40px]">
                <AgentLogo runner={projectAgentOf(session)} size={40} />
                <If when={isLiveRun(snapshot().agentRuns[session.id])}>
                  <View testID="rail-agent-busy" accessible={false} class="absolute right-0 bottom-0 w-[9.5px] h-[9.5px] rounded-full bg-brand border-2 border-ground" />
                </If>
              </View>
            </If>
          }
        >
          <View testID="rail-file-drop" accessible={false} class="w-[40px] h-[40px] items-center justify-center rounded-[12px] bg-accent-tint">
            <Icon name="file-down" class="tint-brand" />
          </View>
        </If>
        {/* What waits on you comes before what is merely unread, as in the pinned row. */}
        <If
          when={status().count}
          else={
            <If when={unread() > 0}>
              <View testID="rail-badge" accessible={false} class="absolute top-[1px] right-[1px] min-w-[15px] h-[15px] px-[3px] items-center justify-center rounded-(--radius-md) bg-mustard border-[1.5px] border-ground">
                <Text class="text-[10px] font-bold text-on-mustard">{unreadBadge(unread())}</Text>
              </View>
            </If>
          }
        >
          <View testID="rail-badge-waiting" accessible={false} class="absolute top-[1px] right-[1px] min-w-[15px] h-[15px] px-[3px] items-center justify-center rounded-(--radius-md) bg-warn border-[1.5px] border-ground">
            <Text class="text-[10px] font-bold text-on-warn">{String(status().count)}</Text>
          </View>
        </If>
      </RailTooltip>
    );
  };

  return (
    <>
      <View
        role="navigation"
        testID="sidebar-rail"
        accessibilityLabel={copy().sidebar.sessions}
        desktop={{ windowDrag: true }}
        class={`flex-1 min-w-0 min-h-0 overflow-hidden items-start ${mac() ? "pl-[10px]" : ""}`}
        style={{ paddingTop: mac() ? Math.max(40, titleBar().height) : 0 }}
      >
        {/* The mark heads the folded list too, where the full one shows it beside the name. */}
        <If when={!mac()}>
          <View accessible={false} class="w-[64px] items-center pt-3 shrink-0">
            <BrandMark size={26} />
          </View>
        </If>
        <RailTooltip
          testID="rail-expand"
          class={`${action(false)} mt-2 mb-1`}
          label={shortcutTip(copy().sidebar.show, formatShortcut(["mod", "B"]))}
          describedBy="rail-tip-expand"
          expanded={false}
          onPress={props.onExpand}
        >
          {glyph("sidebar-open", false)}
        </RailTooltip>
        <RailTooltip testID="rail-search" class={action(false)} label={shortcutTip(copy().sidebar.searchShort, searchShortcutLabel())} describedBy="rail-tip-search" onPress={props.onOpenSearch}>
          {glyph("search", false)}
        </RailTooltip>
        <RailTooltip
          testID="rail-working"
          class={action(workingOnly())}
          label={[workingOnly() ? copy().sidebar.workingOnlyOff : copy().sidebar.workingOnly]}
          name={copy().sidebar.workingOnly}
          describedBy="rail-tip-working"
          pressed={workingOnly()}
          onPress={toggleWorkingOnly}
        >
          {glyph("activity", workingOnly())}
        </RailTooltip>
        {/* It fills the rail below the actions, so its empty space is what moves the window. */}
        <Scroll
          testID="rail-list"
          scrollbar={false}
          desktop={{ windowDrag: true }}
          class="grow shrink min-h-0 w-[64px]"
          contentClass="items-center gap-1 pt-1 pb-2"
          onScroll={dismissRailTips}
        >
          <Each of={sections()} key={(section) => section[0]!.id}>
            {(section, index) => (
              <>
                <If when={index() > 0}>
                  <View role="none" testID="rail-divider" class="w-[28px] h-[1px] my-[3px] bg-line shrink-0" />
                </If>
                <Each of={section()} key={(session) => session.id}>{(session) => item(session())}</Each>
              </>
            )}
          </Each>
        </Scroll>
        <View testID="rail-foot" class="w-[64px] items-center gap-[2px] pt-[6px] pb-2 border-t border-line shrink-0">
          <RailTooltip
            testID="rail-workspace"
            class={action(props.workspaceOpen, "")}
            label={workspaceSet() ? shortcutTip(copy().sidebar.workspace, formatShortcut(["mod", "O"])) : [copy().sidebar.workspace, copy().sidebar.workspaceUnset]}
            name={copy().sidebar.workspace}
            describedBy="rail-tip-workspace"
            enabled={workspaceSet()}
            expanded={props.workspaceOpen}
            onPress={props.onToggleWorkspace}
          >
            {glyph("folder", props.workspaceOpen)}
          </RailTooltip>
          <RailTooltip
            testID="rail-tools"
            class={action(props.toolsMenuOpen, "")}
            label={[copy().sidebar.tools]}
            describedBy="rail-tip-tools"
            expanded={props.toolsMenuOpen === true}
            onAnchor={(node) => toolsAnchor.set(node)}
            onArrow={(key) => {
              toolsFocusLast.set(key === "up");
              props.onToolsMenuOpenChange(true);
            }}
            onPress={() => props.onToolsMenuOpenChange(!props.toolsMenuOpen)}
          >
            {glyph("grid", props.toolsMenuOpen)}
          </RailTooltip>
          <RailTooltip
            testID="rail-settings"
            class={`relative ${action(runtime.settingsOpen, "")}`}
            label={[settingsTip()]}
            describedBy="rail-tip-settings"
            onPress={props.onOpenSettings}
          >
            {glyph("settings", runtime.settingsOpen)}
            {/* An update is news, not an error: the same dot as the full sidebar's. */}
            <If when={updateChecker.updateVisible}>
              <View testID="rail-update-dot" accessible={false} class="absolute top-[5px] right-[7px] w-[8px] h-[8px] rounded-full bg-brand" />
            </If>
          </RailTooltip>
        </View>
      </View>
      <ToolsMenu
        locale={snapshot().settings.locale === "en" ? "en" : "zh"}
        phone={false}
        pages={!props.workbench}
        anchor={toolsAnchor()}
        open={props.toolsMenuOpen === true}
        onOpenChange={props.onToolsMenuOpenChange}
        focusLast={toolsFocusLast()}
        onFocusLastChange={(last) => toolsFocusLast.set(last)}
        placement="flyout"
        archivedCount={archivedCount()}
        current={{
          routines: !props.workbench && runtime.routinesOpen,
          spend: !props.workbench && runtime.spendOpen,
          usage: !props.workbench && usageWidget.open,
          terminal: !props.workbench && runtime.terminalOpen,
        }}
        onOpenRoutines={props.onOpenRoutines}
        onOpenSpend={props.onOpenSpend}
        onOpenUsage={() => runtime.openUsage()}
        onOpenRoles={() => runtime.openRoles()}
        onOpenTerminal={() => (props.workbench ? props.onNewTerminal() : runtime.openTerminal())}
        onOpenArchived={props.onOpenArchived}
      />
    </>
  );
}
