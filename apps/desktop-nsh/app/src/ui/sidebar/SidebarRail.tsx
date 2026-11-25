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
import { cleanup, computed, effect, Scroll, signal, Text, token, untracked, View, type ContextMenuEvent, type JSX, type ViewRef } from "nsh";
import { viewportSize } from "../../platform/viewport";
import type { SessionDragHandler } from "./session-drag";
import { copy, runtime } from "../../runtime";
import { formatShortcut } from "../../m/keymap";
import { searchShortcutLabel } from "../../m/search/shortcuts";
import { updateChecker } from "../../m/update-checker.svelte";
import { usageWidget } from "../../m/usage/usage-widget.svelte";
import { directElsewhere } from "../../m/sidebar/bot-elsewhere";
import { isLiveRun, liveRunSessionIds, projectAgentOf } from "../../m/sidebar/project-groups";
import { groupSessions, isFileDropSession, isSessionArchived } from "../../m/sidebar/session-groups";
import { botWorkStatus, sameSessionStatus, sidebarStatus } from "../../m/sidebar/session-status";
import { sessionTitle } from "../../m/sidebar/session-title";
import { sessionUnreadCount, unreadBadge } from "../../m/sidebar/unread";
import { loadWorkingOnly, onlyWorking, saveWorkingOnly, workingOrUnreadIds } from "../../m/sidebar/working-only";
import { WINDOW_CHROME } from "../../m/window-chrome";
import { BrandMark } from "../BrandMark";
import { Icon, type IconName } from "../Icon";
import { SessionAvatar } from "../SessionAvatar";
import { AgentMark } from "../settings/AgentLogo";
import { floor } from "../interface/floor";
import { dismissRailTips, RailTooltip } from "./RailTooltip";
import { settingsEntryColours } from "./foot-action";
import { ToolsMenu, type TerminalToReattach } from "./ToolsMenu";
import { previewIndex, statusMessages } from "./sidebar-previews";
import { SIDE_MUTED_TINT } from "../glass";
import { foldMotion } from "./fold-motion";
import { RAIL_STAGGER_CAP } from "../shell/sidebar-fold";

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
  /** The running terminals no tab shows, for the tools' 可接回 rows under 终端 (`ToolsTerminalMenu`). */
  reattachTerminals?: TerminalToReattach[];
  onReattachTerminal?: (id: string) => void;
  /** The archived list is a view of the full list; this opens the list already on it. */
  onOpenArchived: () => void;
  onOpenSettings: () => void;
  /** The folded list has no search field; this opens the same search the field does. */
  onOpenSearch: () => void;
  /** A press on an avatar that may become a drag into the workbench: only where there is one. */
  onDragSession?: SessionDragHandler;
  /** While the list folds to the rail or back: only the conversations in view are made then. */
  folding?: boolean;
}) {
  const snapshot = () => runtime.snapshot;
  // Kept until the Bots change, as the open sidebar keeps them: every avatar asks several times.
  const botsById = computed(() => new Map(snapshot().bots.map((b) => [b.id, b] as const)));
  const aliveBotIds = computed(() => new Set(snapshot().bots.map((b) => b.id)));
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

  /**
   * How many conversations are made. Each avatar takes some 4 ms to make and the rail holds every
   * conversation, while the fold waits for what it mounts before it moves: with 150 of them the
   * edge stood still for 0.7 s. So the rail starts with those that fit in the window, and once no
   * fold is moving it makes the rest a few a frame, below the fold of its list.
   */
  const IN_VIEW_PT = 52;
  const PER_FRAME = 8;
  const made = signal(Math.ceil(untracked(() => viewportSize()).height / IN_VIEW_PT) + 2);
  const sessionCount = () => sections().reduce((sum, section) => sum + section.length, 0);
  const shownSections = computed(() => {
    let left = made();
    const out: SessionSummary[][] = [];
    for (const section of sections()) {
      if (left <= 0) break;
      out.push(section.length <= left ? section : section.slice(0, left));
      left -= section.length;
    }
    return out;
  });
  let makeFrame = 0;
  effect(() => {
    const total = sessionCount();
    const now = made();
    cancelAnimationFrame(makeFrame);
    if (props.folding || now >= total) return;
    makeFrame = requestAnimationFrame(() => made.set(Math.min(total, now + PER_FRAME)));
  });
  cleanup(() => cancelAnimationFrame(makeFrame));

  /**
   * Where each icon comes in when the list folds to the rail (`FoldMotion.railIcon`): top first, the
   * mark (where the rail shows it) and the three actions before the conversations, the foot last.
   */
  const firstAction = () => (mac() ? 0 : 1);
  const firstSession = () => firstAction() + 3;
  const sessionOrder = computed(() => {
    const order = new Map<string, number>();
    for (const section of sections()) for (const session of section) order.set(session.id, order.size);
    return order;
  });
  const orderOf = (id: string) => firstSession() + (sessionOrder().get(id) ?? 0);
  /** An icon of the rail, growing into place with the fold at its `order`. */
  const fold = foldMotion();
  const pop = (order: () => number, child: JSX.Element) => <View style={fold?.railIcon(order())}>{child}</View>;
  const footScale = fold?.railScale(RAIL_STAGGER_CAP);

  /** Each conversation's newest message, from one pass over the messages (each rail item read them all). */
  const index = computed(() => previewIndex(snapshot().messages, snapshot().turns));
  const statusOf = (session: SessionSummary) =>
    sidebarStatus(session, snapshot().turns, snapshot().approvals, statusLabels(), snapshot().pendingJudgements, statusMessages(index(), session));
  /**
   * Answers kept until what they read changes, as the open sidebar keeps them (`Sidebar.tsx`): each
   * avatar asks for its Bot's work status many times, and where a Bot works scans every conversation.
   * Without them an avatar took some 20 ms to make with 150 conversations.
   */
  const workMemo = computed(() => {
    void snapshot().turns;
    void snapshot().approvals;
    void snapshot().pendingJudgements;
    void snapshot().sessions;
    void botsById();
    void copy();
    return { elsewhere: new Map<string, string | null>(), bots: new Map<string, ReturnType<typeof botWorkStatus>>() };
  });
  const botStatusOf = (botId: string) => {
    const memo = workMemo().bots;
    let status = memo.get(botId);
    if (!status) {
      status = botWorkStatus(botId, snapshot().turns, snapshot().approvals, statusLabels(), snapshot().pendingJudgements);
      memo.set(botId, status);
    }
    return status;
  };
  const elsewhereOf = (session: SessionSummary): string | null => {
    const memo = workMemo().elsewhere;
    if (!memo.has(session.id)) memo.set(session.id, directElsewhere(session, false, snapshot(), botsById(), statusLabels(), rosterLabels(), copy().sidebar.elsewhere));
    return memo.get(session.id)!;
  };

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
      const elsewhere = elsewhereOf(session);
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
   * Where the window hides its title bar and the traffic lights sit over the rail's top (macOS: the host
   * places them as 0.4.0's window did), the rail makes room for them and the mark gives them its place.
   */
  const mac = () => WINDOW_CHROME === "mac";

  const ACTION = "group w-[40px] h-[36px] items-center justify-center border border-transparent rounded-(--radius-sm) hover:border-line";
  const action = (active: boolean | undefined, margin = "mx-[12px]") => `${ACTION} ${margin} ${active ? "bg-accent-tint border-accent-border" : ""}`;
  /** The way to Settings is one of the floor (ADR 0108): marked once, its button handed over by the tooltip. */
  const settingsFloor = floor("settings-entry", () => settingsEntryColours(runtime.settingsOpen));
  const glyph = (name: IconName, active: boolean | undefined) => <Icon name={name} class={active ? "tint-brand" : `${SIDE_MUTED_TINT} group-hover:tint-ink`} />;

  const item = (session: SessionSummary) => {
    const title = () => sessionTitle(session, botsById(), rosterLabels());
    const status = computed(() => statusOf(session), { equals: sameSessionStatus });
    const unread = () => sessionUnreadCount(session);
    const on = () => runtime.selectedId === session.id;
    const lit = () => on() || props.contextMenuSessionId === session.id;
    const tileLook = () => {
      if (on()) return "bg-accent-tint border-brand";
      if (lit()) return "bg-ink/8 border-line";
      return "border-transparent hover:bg-row-hover";
    };
    return pop(
      () => orderOf(session.id),
      <View class="relative w-[64px] items-center justify-center">
        <If when={on()}>
          <View
            testID={`rail-active-${session.id}`}
            accessible={false}
            class="absolute left-0 w-[3px] h-[22px] rounded-r-full bg-brand"
          />
        </If>
        <RailTooltip
          testID={`rail-session-${session.id}`}
          class={`relative group w-[48px] h-[48px] items-center justify-center border rounded-(--radius-md) ${tileLook()}`}
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
                {/* Bare agent glyph on a soft translucent tile (no glaring white box on dark glass). */}
                <View
                  testID="rail-agent"
                  accessible={false}
                  class={`relative w-[40px] h-[40px] items-center justify-center rounded-(--radius-card-sm) border ${
                    on() ? "bg-ink/10 border-brand/35" : "bg-ink/7 border-ink/8"
                  }`}
                >
                  <AgentMark runner={projectAgentOf(session)} size={22} />
                  <If when={isLiveRun(snapshot().agentRuns[session.id])}>
                    <View testID="rail-agent-busy" accessible={false} class="absolute -right-[2px] -bottom-[2px] w-[9.5px] h-[9.5px] rounded-full bg-brand border-2 border-ground" />
                  </If>
                </View>
              </If>
            }
          >
            <View testID="rail-file-drop" accessible={false} class="w-[40px] h-[40px] items-center justify-center rounded-(--radius-card-sm) bg-accent-tint">
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
            <View testID="rail-badge-waiting" accessible={false} class="absolute top-[1px] right-[1px] min-w-[15px] h-[15px] px-[3px] items-center justify-center rounded-(--radius-md) bg-warn-text border-[1.5px] border-ground">
              <Text class="text-[10px] font-bold text-on-warn">{String(status().count)}</Text>
            </View>
          </If>
        </RailTooltip>
      </View>,
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
        style={{ paddingTop: mac() ? 40 : 0 }}
      >
        {/* The mark heads the folded list too, where the full one shows it beside the name. */}
        <If when={!mac()}>
          <View accessible={false} class="w-[64px] items-center pt-3 shrink-0" style={fold?.railIcon(0)}>
            <BrandMark size={26} />
          </View>
        </If>
        {pop(
          () => firstAction(),
          <RailTooltip
            testID="rail-expand"
            class={`${action(false)} mt-2 mb-1`}
            label={shortcutTip(copy().sidebar.show, formatShortcut(["mod", "B"]))}
            describedBy="rail-tip-expand"
            expanded={false}
            onPress={props.onExpand}
          >
            {glyph("sidebar-open", false)}
          </RailTooltip>,
        )}
        {pop(
          () => firstAction() + 1,
          <RailTooltip testID="rail-search" class={action(false)} label={shortcutTip(copy().sidebar.searchShort, searchShortcutLabel())} describedBy="rail-tip-search" onPress={props.onOpenSearch}>
            {glyph("search", false)}
          </RailTooltip>,
        )}
        {pop(
          () => firstAction() + 2,
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
          </RailTooltip>,
        )}
        {/* It fills the rail below the actions, so its empty space is what moves the window. */}
        <Scroll
          testID="rail-list"
          scrollbar={false}
          desktop={{ windowDrag: true }}
          class="grow shrink min-h-0 w-[64px]"
          contentClass="items-center gap-1 pt-1 pb-2"
          onScroll={dismissRailTips}
        >
          <Each of={shownSections()} key={(section) => section[0]!.id}>
            {(section, index) => (
              <>
                <If when={index() > 0}>
                  <View role="none" testID="rail-divider" class="w-[28px] h-[1px] my-[3px] bg-line shrink-0" style={fold?.railFade(orderOf(section()[0]!.id))} />
                </If>
                <Each of={section()} key={(session) => session.id}>{(session) => item(session())}</Each>
              </>
            )}
          </Each>
        </Scroll>
        {/* The foot comes in last, its rule fading in with its icons as they grow. */}
        <View testID="rail-foot" class="w-[64px] items-center gap-[2px] pt-[6px] pb-2 border-t border-line shrink-0" style={fold?.railFade(RAIL_STAGGER_CAP)}>
          <View style={footScale}>
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
          </View>
          <View style={footScale}>
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
          </View>
          <View style={footScale}>
            <RailTooltip
              testID="rail-settings"
              onAnchor={settingsFloor}
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
        reattachTerminals={props.reattachTerminals}
        onReattachTerminal={props.onReattachTerminal}
        onOpenArchived={props.onOpenArchived}
      />
    </>
  );
}
