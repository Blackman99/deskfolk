/**
 * The full session list (`sidebar/Sidebar.svelte`): the head (mark, working and focus switches,
 * collapse), search, the holds bar, the pinned band, the sections (file drop, Bots and groups,
 * projects by directory), the archived list, the empty notes, the footer, the tools menu and the
 * phone's floating create button. The rows are in `sidebar-list.tsx`, flattened by
 * `sidebar-list-model.ts` into one virtualised `List`.
 *
 * Props the Svelte one `bind:`s become a value and an `on…Change` (`toolsMenuOpen`, `createMenuOpen`);
 * `bind:this` + `showArchived()` is `onHandle`, called once with `{ showArchived }`. `runtime` and `t`
 * are the app's. A context menu is asked for with its place in the window: `onOpenContextMenu(at,
 * session)`; `onDragSession(phase, point, session)` hears a row pulled out of the list (start, moves, end
 * or cancel, in the window's coordinates), and the shell turns it into the workbench's `dragIn`.
 *
 * Not ported: a row sliding when it moves up the list (`moveFlip`), the window click that closed the
 * create menu (its sheet has its own backdrop), the glass-tint grey override, and the list's empty
 * space dragging the window (the list asks for `windowDrag`, its rows keep their presses).
 */
import { cleanup, computed, effect, safeArea, signal, Text, View, type ViewRef } from "nsh";
import type { Hold, SessionSummary } from "@real-bot/protocol";
import { formatShortcut } from "../../m/keymap";
import { searchShortcutLabel } from "../../m/search/shortcuts";
import { usageWidget } from "../../m/usage/usage-widget.svelte";
import { directElsewhere } from "../../m/sidebar/bot-elsewhere";
import { holdLabel, listedHolds } from "../../m/sidebar/holds-list";
import { formatListTime, listTimeSource } from "../../m/sidebar/list-time";
import { newProjectIn, newProjectInFolder } from "../../m/sidebar/project-actions";
import { dirSession, groupProjectSessions, isLiveRun, liveRunSessionIds, type ProjectDirGroup } from "../../m/sidebar/project-groups";
import { plainPreview } from "../../m/sidebar/preview-text";
import { classifySession, groupSessions, isFileDropSession, isSessionArchived, youBotPeer } from "../../m/sidebar/session-groups";
import { agentRunStatus, botWorkStatus, sidebarStatus } from "../../m/sidebar/session-status";
import { sessionTitle } from "../../m/sidebar/session-title";
import { sessionUnreadCount } from "../../m/sidebar/unread";
import { loadWorkingOnly, onlyWorking, saveWorkingOnly, workingOrUnreadIds } from "../../m/sidebar/working-only";
import { WINDOW_CHROME } from "../../m/window-chrome";
import { copy, runtime } from "../../runtime";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { RolesPage } from "../settings/RolesPage";
import { tip } from "../tip";
import { UsagePage } from "../usage/UsagePage";
import { BotAddMenu } from "./BotAddMenu";
import { CreateFab } from "./CreateFab";
import { FocusToggle } from "./FocusToggle";
import { HoldsBar } from "./HoldsBar";
import { MobileArchivedHead } from "./MobileArchivedHead";
import { PinnedRoster } from "./PinnedRoster";
import { ProjectAddMenu } from "./ProjectAddMenu";
import type { MenuAt } from "./SessionRow";
import { SidebarFoot } from "./SidebarFoot";
import { ToolsMenu } from "./ToolsMenu";
import { ToolsToggle } from "./ToolsToggle";
import { WorkingFilter } from "./WorkingFilter";
import { SidebarList, type SidebarListEnv } from "./sidebar-list";
import { createListRowKeeper, listRows } from "./sidebar-list-model";
import { previewIndex, previewOf as lineOf, statusMessages } from "./sidebar-previews";
import type { SessionDragHandler } from "./session-drag";
import { SIDE_MUTED_TEXT, SIDE_MUTED_TINT } from "../glass";

/** What the shell can call on the list from outside it (the Svelte component's exported `showArchived`). */
export type SidebarHandle = { showArchived: () => void };

export function Sidebar(props: {
  selected: SessionSummary | null;
  pinnedSessionIds: string[];
  searchOpen?: boolean;
  onOpenSearch: () => void;
  /** What the phone's + button opens. A menu, so Back and Escape close it first. */
  createMenuOpen?: boolean;
  onCreateMenuOpenChange: (open: boolean) => void;
  /** Back and Escape close the tools menu before navigating. */
  toolsMenuOpen?: boolean;
  onToolsMenuOpenChange: (open: boolean) => void;
  workspaceOpen: boolean;
  /** Marks the row the context menu belongs to. */
  contextMenuSessionId: string | null;
  /** The project session whose row is a name field for now (ADR 0095). */
  renamingSessionId?: string | null;
  /** On a phone, which page of the bottom bar this list is: your Bots' conversations or the projects. */
  phoneList?: "bots" | "projects";
  /** Its new name, or null to leave it; false when the name did not go through. */
  onRenameSession?: (sessionId: string, name: string | null) => Promise<boolean>;
  onOpenContextMenu: (at: MenuAt, session: SessionSummary) => void;
  /** Pin or unpin a conversation from its row, without opening its menu. */
  onTogglePin?: (sessionId: string) => void;
  /** A project directory opened in the preview, by one of its sessions: its tree is that session's project. */
  onOpenProjectDir?: (session: SessionSummary) => void;
  onToggleWorkspace: () => void;
  onOpenRoutines: () => void;
  onOpenSpend: () => void;
  /** Whether the workbench is on screen, so the tools open as its tabs (a tablet on a remote connection has none). */
  workbench: boolean;
  onNewTerminal: () => void;
  onOpenSettings: () => void;
  onCreateBot: () => void;
  onCreateGroup: () => void;
  /** Puts the list away. Only where it can be: the desktop workbench, which has a way back. */
  onCollapse?: () => void;
  /** A press on a conversation that may become a drag into the workbench: only where there is one. */
  onDragSession?: SessionDragHandler;
  /** Called once with the handle (`showArchived`). */
  onHandle?: (handle: SidebarHandle) => void;
}) {
  const t = () => copy();
  const phone = () => narrowWindow();
  const snapshot = () => runtime.snapshot;
  // Made once per change, not on every read: each row read them, on every token streamed anywhere.
  const botsById = computed(() => new Map(snapshot().bots.map((b) => [b.id, b] as const)));
  const sessionsById = computed(() => new Map(snapshot().sessions.map((s) => [s.id, s] as const)));
  const aliveBotIds = computed(() => new Set(snapshot().bots.map((b) => b.id)));
  const rosterLabels = () => ({ deleted: t().top.deleted, archived: t().top.archived, fileDrop: t().sidebar.fileDrop, projectUntitled: t().project.untitled });
  const statusLabels = () => ({
    running: t().sidebar.statusRunning,
    background: t().sidebar.statusBackground,
    replying: t().sidebar.statusReplying,
    waitingApproval: t().sidebar.statusWaitingApproval,
    waitingAsk: t().sidebar.statusWaitingAsk,
    failed: t().sidebar.statusFailed,
    interrupted: t().sidebar.statusInterrupted,
    idle: t().sidebar.statusIdle,
  });
  const grouped = () => groupSessions(snapshot().sessions, props.pinnedSessionIds, aliveBotIds(), botsById());

  /**
   * The list shows only what a Bot is working in or you have not read, and the conversation on
   * screen. The pins above keep every pin. The rail reads and writes the same stored switch.
   */
  const workingOnly = signal(loadWorkingOnly());
  function toggleWorkingOnly(): void {
    workingOnly.set(!workingOnly());
    saveWorkingOnly(workingOnly());
  }
  /** Null while the list is unfiltered. */
  const workingIds = () =>
    workingOnly()
      ? workingOrUnreadIds(snapshot().sessions, snapshot().turns, snapshot().approvals, snapshot().pendingJudgements, liveRunSessionIds(snapshot().agentRuns))
      : null;
  const listed = () => onlyWorking(grouped(), workingIds(), runtime.selectedId);

  /** A phone lists the Bots and the projects on two pages of its bottom bar; a wider window, together. */
  const showBots = () => !phone() || (props.phoneList ?? "bots") === "bots";
  const showProjects = () => !phone() || props.phoneList === "projects";
  // A Bot↔Bot direct pinned before ADR 0091 stays out too: it opens only from its message.
  const pinnedSessions = () =>
    props.pinnedSessionIds
      .map((id) => sessionsById().get(id))
      .filter((session): session is SessionSummary => Boolean(session) && classifySession(session!) !== "bot-bot");
  /** The band above the list. A phone's two pages each show their own. */
  const shownPins = () => (phone() ? pinnedSessions().filter((session) => (session.kind === "project") === showProjects()) : pinnedSessions());
  const pinnedWorking = () => {
    const ids = workingIds();
    return ids !== null && shownPins().some((session) => ids.has(session.id));
  };
  const fileDrop = () => (showBots() ? listed().fileDrop : null);
  const botRows = () => (showBots() ? listed().bots : []);
  /** A pinned session has no row to type in: while it is being renamed it stands under its directory again. */
  const renamingPin = () => pinnedSessions().find((session) => session.id === props.renamingSessionId && session.kind === "project");
  const projectGroups = () => {
    if (!showProjects()) return [];
    const pin = renamingPin();
    return groupProjectSessions(pin ? [...listed().project, pin] : listed().project, snapshot().sessions);
  };
  const nothingWorking = () => workingIds() !== null && !fileDrop() && botRows().length === 0 && projectGroups().length === 0;
  /** No conversation at all yet, unfiltered: the list says how to start one instead of bare headers. */
  const rosterEmpty = () => showBots() && workingIds() === null && !fileDrop() && botRows().length === 0 && projectGroups().length === 0 && shownPins().length === 0;
  /** A phone's projects page with no project session yet says how to start one. */
  const projectsEmpty = () => !showBots() && workingIds() === null && projectGroups().length === 0 && shownPins().length === 0;
  const archivedSessions = () => snapshot().sessions.filter((session) => isSessionArchived(session, botsById()));

  /** Which directories of the 「项目」 section are open: every one until you fold it. */
  const openDirs = signal<Record<string, boolean>>({});
  const dirOpen = (dir: string) => openDirs()[dir] ?? true;
  const toggleDir = (dir: string) => openDirs.set({ ...openDirs(), [dir]: !dirOpen(dir) });

  /** The 「Bot」 section's +: a new Bot or a new group. */
  const botMenuOpen = signal(false);
  const botAnchor = signal<ViewRef | null>(null);
  /** The section's +: a new session of each agent in a folder, or a terminal session carried on. */
  const projectMenuOpen = signal(false);
  const projectAnchor = signal<ViewRef | null>(null);
  /** A directory's +, or a right-click on its row. `point` is where the right-click was. */
  const dirMenuOpen = signal(false);
  const dirMenuFor = signal<{ dir: string; label: string; anchor: ViewRef | null; point?: MenuAt } | null>(null);
  function openDirOfMenu(): void {
    const dir = dirMenuFor()?.dir;
    const group = dir ? projectGroups().find((row) => row.dir === dir) : undefined;
    if (group) props.onOpenProjectDir?.(dirSession(group, runtime.selectedId));
  }

  // Wider than a phone or not, the tools menu belongs to another button: it closes first.
  let wasPhone = false;
  effect(() => {
    const now = phone();
    if (now !== wasPhone) {
      wasPhone = now;
      props.onToolsMenuOpenChange(false);
    }
  });

  /** The archived list in a wide window: part of the list, not a page of its own. */
  const archivedInList = signal(false);
  /** On a phone, usage and the archived list are pages (`runtime.listPage`), so Back walks out of them. */
  const viewingArchived = () => (phone() ? runtime.listPage === "archived" : archivedInList());
  const viewingUsage = () => phone() && runtime.listPage === "usage";
  /** Roles (ADR 0083) where there is no workbench to hold its tab: a page in place of the list. */
  const viewingRoles = () => runtime.listPage === "roles";

  function openArchived(): void {
    if (phone()) runtime.openListPage("archived");
    else archivedInList.set(true);
  }
  function closeArchived(): void {
    if (phone()) runtime.closeListPage();
    else archivedInList.set(false);
  }
  props.onHandle?.({ showArchived: openArchived });

  const toolsAnchor = signal<ViewRef | null>(null);
  const toolsFocusLast = signal(false);

  /** Every row's line from one pass over the messages and turns (`sidebar-previews.ts`). */
  const previews = computed(() => previewIndex(snapshot().messages, snapshot().turns));
  const titleOf = (session: SessionSummary) => sessionTitle(session, botsById(), rosterLabels());
  const statusOf = (session: SessionSummary) =>
    sidebarStatus(session, snapshot().turns, snapshot().approvals, statusLabels(), snapshot().pendingJudgements, statusMessages(previews(), session));
  /** A project session has runs, not turns: its run while one is live, else what its row would say anyway. */
  const projectStatusOf = (session: SessionSummary) => agentRunStatus(snapshot().agentRuns[session.id], statusLabels()) ?? statusOf(session);

  /** Your stops that wait to be lifted, for the bar above the list. */
  const myHolds = (): Hold[] => (snapshot().holdsOn ? listedHolds(snapshot().holds) : []);
  const labelOf = (hold: Hold) => holdLabel(hold, { bots: botsById(), sessions: sessionsById(), roster: rosterLabels(), t: t().control });

  /** Your direct's row, quiet here, with its Bot at work in another conversation: where. */
  /**
   * Answers kept until what they read changes: every row and every avatar in it asked again on each
   * token streamed anywhere (a Bot's work status thirty times a token, where it is at work a dozen).
   */
  const workMemo = computed(() => {
    void snapshot().turns;
    void snapshot().approvals;
    void snapshot().pendingJudgements;
    void snapshot().sessions;
    void botsById();
    void t();
    return { elsewhere: new Map<string, string | null>(), bots: new Map<string, ReturnType<typeof botWorkStatus>>() };
  });
  const elsewhereOf = (session: SessionSummary, status: ReturnType<typeof statusOf>): string | null => {
    if (status.kind !== "idle") return null;
    const memo = workMemo().elsewhere;
    if (!memo.has(session.id)) memo.set(session.id, directElsewhere(session, false, snapshot(), botsById(), statusLabels(), rosterLabels(), t().sidebar.elsewhere));
    return memo.get(session.id)!;
  };
  const botStatusOf = (botId: string) => {
    const memo = workMemo().bots;
    let status = memo.get(botId);
    if (!status) {
      status = botWorkStatus(botId, snapshot().turns, snapshot().approvals, statusLabels(), snapshot().pendingJudgements);
      memo.set(botId, status);
    }
    return status;
  };

  /** The time beside each name only has to be right to the minute: a slow tick, not every snapshot. */
  const listNow = signal(Date.now());
  const timer = setInterval(() => listNow.set(Date.now()), 60_000);
  cleanup(() => clearInterval(timer));
  const timeOf = (session: SessionSummary) => formatListTime(listTimeSource(session), listNow(), snapshot().settings.locale === "en" ? "en" : "zh");
  const unreadOf = (session: SessionSummary) => sessionUnreadCount(session, runtime.selectedId);
  /** A row's line as plain text; the same text gives the same line without working it out again. */
  const plainOf = new Map<string, string>();
  const previewOf = (session: SessionSummary) => {
    const raw = lineOf(previews(), session, 400);
    let plain = plainOf.get(raw);
    if (plain === undefined) {
      if (plainOf.size > 400) plainOf.clear();
      plain = plainPreview(raw);
      plainOf.set(raw, plain);
    }
    return plain;
  };
  const archivedSuffix = (session: SessionSummary): string => {
    if (isFileDropSession(session)) return "";
    if (session.archived_at) return ` · ${t().top.archived}`;
    const peer = youBotPeer(session);
    if (!peer) return "";
    return botsById().get(peer)?.archived_at ? ` · ${t().top.archived}` : "";
  };

  /** The rows, each the object it was while it says the same (the list builds a new one again). */
  const keepRows = createListRowKeeper();
  const rows = computed(() =>
    keepRows(listRows({
      viewingArchived: viewingArchived(),
      phone: phone(),
      archived: archivedSessions(),
      fileDrop: fileDrop(),
      showBots: showBots(),
      showProjects: showProjects(),
      botRows: botRows(),
      projectGroups: projectGroups(),
      filtered: workingIds() !== null,
      isOpen: dirOpen,
      isLive: (group) => group.sessions.some((row) => isLiveRun(snapshot().agentRuns[row.id])),
      renamingSessionId: props.renamingSessionId ?? null,
      nothingWorking: nothingWorking(),
      rosterEmpty: rosterEmpty(),
      projectsEmpty: projectsEmpty(),
      labels: { fileDrop: t().sidebar.fileDrop, bots: t().sidebar.botsTab, projects: t().project.section, workingEmpty: t().sidebar.workingEmpty },
      workingHint: pinnedWorking() ? t().sidebar.workingEmptyPinned : t().sidebar.workingEmpty,
    })),
  );

  const env: SidebarListEnv = {
    get phone() {
      return phone();
    },
    selectedId: () => runtime.selectedId,
    contextMenuSessionId: () => props.contextMenuSessionId,
    renamingSessionId: () => props.renamingSessionId ?? null,
    pinnedSessionIds: () => props.pinnedSessionIds,
    botsById,
    titleOf,
    archivedSuffix,
    timeOf,
    statusOf,
    projectStatusOf,
    unreadOf,
    previewOf,
    elsewhereOf,
    botStatusOf,
    onSelect: (session) => void runtime.selectSession(session.id),
    onOpenContextMenu: (at, session) => props.onOpenContextMenu(at, session),
    get onTogglePin() {
      return props.onTogglePin;
    },
    get onRenameSession() {
      return props.onRenameSession;
    },
    get onDragSession() {
      return props.onDragSession;
    },
    closeArchived,
    onSectionAdd: (section, anchor) => {
      if (section === "bots") {
        botAnchor.set(anchor);
        botMenuOpen.set(!botMenuOpen());
      } else {
        projectAnchor.set(anchor);
        projectMenuOpen.set(!projectMenuOpen());
      }
    },
    sectionMenuOpen: (section) => (section === "bots" ? botMenuOpen() : projectMenuOpen()),
    toggleDir,
    onDirAdd: (group: ProjectDirGroup, anchor) => {
      const again = dirMenuOpen() && dirMenuFor()?.dir === group.dir && !dirMenuFor()?.point;
      dirMenuFor.set({ dir: group.dir, label: group.label, anchor });
      dirMenuOpen.set(!again);
    },
    onDirMenu: (group, anchor, at) => {
      dirMenuFor.set({ dir: group.dir, label: group.label, anchor, point: at });
      dirMenuOpen.set(true);
    },
    dirAddExpanded: (dir) => dirMenuOpen() && dirMenuFor()?.dir === dir && !dirMenuFor()?.point,
    onCreateBot: () => props.onCreateBot(),
    onCreateGroup: () => props.onCreateGroup(),
    onNewProject: (agent) => void newProjectInFolder(runtime, t(), agent),
    onImportProject: () => runtime.openCreateProject("import"),
  };

  // The macOS traffic lights take the start of the brand row: the host places them where the Tauri
  // window had them (\`window.rs\`, from \`tauri.macos.conf.json\`), whether or not they show (full screen).
  const mac = () => WINDOW_CHROME === "mac";
  const brandWidth = signal(0);
  const searchWidth = signal(0);
  /** Behind the traffic lights a list at its narrowest has no room for the mark and its buttons. */
  const markHidden = () => mac() && brandWidth() > 0 && brandWidth() <= 123;
  const kbdHidden = () => phone() || (searchWidth() > 0 && searchWidth() <= 199);

  const fabShown = () =>
    phone() &&
    !props.selected &&
    !props.searchOpen &&
    !viewingArchived() &&
    !viewingUsage() &&
    !viewingRoles() &&
    !props.workspaceOpen &&
    !runtime.settingsOpen &&
    !runtime.routinesOpen &&
    !runtime.spendOpen &&
    !runtime.terminalOpen &&
    !runtime.screenOpen;

  return (
    <>
      <View role="navigation" testID="sidebar" accessibilityLabel={t().sidebar.sessions} class={`flex-1 min-h-0 min-w-0 ${phone() ? "w-full bg-sidebar-bg" : ""}`}>
        {/* The mark heads the list on a wider window; a phone's top bar is the page title instead. */}
        <If when={!phone()}>
          <View
            testID="brand-row"
            desktop={{ windowDrag: true }}
            onLayout={(e) => brandWidth.set(e.bounds.size.width)}
            class="flex-row items-center gap-1 h-[46px] pt-[6px] pr-[10px] shrink-0"
            style={{ paddingLeft: mac() ? 84 : 16 }}
          >
            <If when={!markHidden()}>
              <BrandMark size={22} />
            </If>
            <View class="flex-1" accessible={false} />
            <If when={!viewingArchived()}>
              <WorkingFilter workingOnly={workingOnly()} toggleWorkingOnly={toggleWorkingOnly} />
            </If>
            <FocusToggle />
            <If when={props.onCollapse}>
              {(collapse) => (
                <View
                  role="button"
                  testID="side-collapse"
                  tooltip={tip(`${t().sidebar.hide} (${formatShortcut(["mod", "B"])})`)}
                  accessibilityLabel={t().sidebar.hide}
                  accessibilityState={{ expanded: true }}
                  onPress={() => collapse()()}
                  class="group shrink-0 w-[30px] h-[30px] items-center justify-center rounded-(--radius-sm) hover:bg-row-hover"
                >
                  <Icon name="sidebar-close" class={`${SIDE_MUTED_TINT} group-hover:tint-ink`} />
                </View>
              )}
            </If>
          </View>
        </If>
        {/* Nothing pinned is not news worth the top of the sidebar: the band only appears once something is. */}
        <If when={shownPins().length > 0}>
          <PinnedRoster
            pinnedSessions={shownPins()}
            contextMenuSessionId={props.contextMenuSessionId}
            onOpenContextMenu={props.onOpenContextMenu}
            botsById={botsById()}
            botStatusOf={botStatusOf}
            statusOf={projectStatusOf}
            unreadOf={unreadOf}
            titleOf={titleOf}
            archivedSuffix={archivedSuffix}
            onDragSession={props.onDragSession}
          />
        </If>
        <View testID="side-body" class="relative flex-1 min-h-0">
          <If
            when={viewingRoles()}
            else={
              <If
                when={phone() && viewingUsage()}
                else={
                  <>
                    <If
                      when={phone() && viewingArchived()}
                      else={
                        <>
                          <View
                            testID="search-wrap"
                            onLayout={(e) => searchWidth.set(e.bounds.size.width)}
                            class={`flex-row items-center shrink-0 ${phone() ? "gap-[10px] px-4 pb-2" : "gap-2 mx-3 mt-1 mb-[6px]"}`}
                            style={phone() ? { paddingTop: Math.max(8, safeArea().top) } : undefined}
                          >
                            <If when={phone()}>
                              <ToolsToggle
                                phone
                                open={props.toolsMenuOpen}
                                onOpenChange={props.onToolsMenuOpenChange}
                                onFocusLast={(last) => toolsFocusLast.set(last)}
                                onAnchor={(node) => toolsAnchor.set(node)}
                              />
                            </If>
                            <View
                              role="button"
                              testID="search-trigger"
                              accessibilityLabel={t().sidebar.globalSearch}
                              onPress={() => props.onOpenSearch()}
                              class={`flex-1 min-w-0 flex-row items-center justify-between gap-[6px] border ${
                                phone()
                                  ? "h-[38px] pl-[34px] pr-[14px] rounded-full bg-pane border-line active:bg-row-hover"
                                  : "h-[34px] pl-8 pr-3 rounded-(--radius-md) bg-line-subtle border-transparent hover:bg-row-hover"
                              }`}
                            >
                              <View accessible={false} class={`absolute top-0 bottom-0 items-center justify-center ${phone() ? "left-3" : "left-[10px]"}`}>
                                <Icon name="search" class={SIDE_MUTED_TINT} />
                              </View>
                              <Text class={`${SIDE_MUTED_TEXT} ${phone() ? "text-[14px]" : "text-[13px]"}`}>{t().sidebar.searchShort}</Text>
                              <If when={!kbdHidden()}>
                                <View accessible={false} class="shrink-0 px-1 py-[1px] border border-line rounded-(--radius-xs)">
                                  <Text class={`text-[10px] ${SIDE_MUTED_TEXT}`}>{searchShortcutLabel()}</Text>
                                </View>
                              </If>
                            </View>
                            <If when={phone() && !viewingArchived()}>
                              <WorkingFilter workingOnly={workingOnly()} toggleWorkingOnly={toggleWorkingOnly} />
                            </If>
                            <If when={phone()}>
                              <FocusToggle />
                            </If>
                          </View>
                          <HoldsBar holds={myHolds()} label={labelOf} disabled={runtime.connection !== "connected"} onLift={(hold) => runtime.liftHold(hold.id)} />
                        </>
                      }
                    >
                      <MobileArchivedHead count={archivedSessions().length} onBack={closeArchived} />
                    </If>
                    <SidebarList rows={rows()} env={env} />
                  </>
                }
              >
                <UsagePage onBack={() => runtime.closeListPage()} />
              </If>
            }
          >
            <RolesPage host="page" onBack={() => runtime.closeListPage()} />
          </If>
        </View>
        <If when={!phone()}>
          <SidebarFoot
            workspaceOpen={props.workspaceOpen}
            workspacePath={snapshot().settings.workspace_path}
            onToggleWorkspace={props.onToggleWorkspace}
            onOpenSettings={props.onOpenSettings}
            toolsMenuOpen={props.toolsMenuOpen}
            onToolsMenuOpenChange={props.onToolsMenuOpenChange}
            onToolsFocusLast={(last) => toolsFocusLast.set(last)}
            onToolsAnchor={(node) => toolsAnchor.set(node)}
          />
        </If>
        <BotAddMenu
          anchor={botAnchor()}
          open={botMenuOpen()}
          onOpenChange={(open) => botMenuOpen.set(open)}
          onCreateBot={props.onCreateBot}
          onCreateGroup={props.onCreateGroup}
        />
        <ProjectAddMenu
          anchor={projectAnchor()}
          open={projectMenuOpen()}
          onOpenChange={(open) => projectMenuOpen.set(open)}
          label={t().project.add}
          picksFolder
          onNew={(agent) => void newProjectInFolder(runtime, t(), agent)}
          onImport={() => runtime.openCreateProject("import")}
        />
        <ProjectAddMenu
          anchor={dirMenuFor()?.anchor ?? null}
          point={dirMenuFor()?.point ?? null}
          open={dirMenuOpen()}
          onOpenChange={(open) => dirMenuOpen.set(open)}
          label={dirMenuFor() ? t().project.newHere(dirMenuFor()!.label) : t().project.add}
          picksFolder={false}
          onNew={(agent) => {
            const dir = dirMenuFor()?.dir;
            if (dir) void newProjectIn(runtime, dir, agent);
          }}
          onOpenDir={props.onOpenProjectDir ? openDirOfMenu : undefined}
          onOpenTerminal={() => {
            const dir = dirMenuFor()?.dir;
            if (dir) void runtime.openTerminalAt(dir);
          }}
        />
        <ToolsMenu
          locale={snapshot().settings.locale === "en" ? "en" : "zh"}
          phone={phone()}
          pages={!props.workbench}
          anchor={toolsAnchor()}
          open={props.toolsMenuOpen === true}
          onOpenChange={props.onToolsMenuOpenChange}
          focusLast={toolsFocusLast()}
          onFocusLastChange={(last) => toolsFocusLast.set(last)}
          archivedCount={archivedSessions().length}
          current={{
            routines: !props.workbench && runtime.routinesOpen,
            spend: !props.workbench && runtime.spendOpen,
            usage: phone() ? viewingUsage() : !props.workbench && usageWidget.open,
            roles: viewingRoles(),
            terminal: !props.workbench && runtime.terminalOpen,
            screen: runtime.screenOpen,
            workspace: phone() && runtime.workspaceOpen,
            archived: viewingArchived(),
          }}
          onOpenRoutines={props.onOpenRoutines}
          onOpenSpend={props.onOpenSpend}
          onOpenUsage={() => {
            if (!phone()) return runtime.openUsage();
            runtime.openListPage("usage");
          }}
          onOpenRoles={() => runtime.openRoles()}
          onOpenTerminal={() => (props.workbench ? props.onNewTerminal() : runtime.openTerminal())}
          onOpenScreen={runtime.screenOffered ? () => runtime.openRemoteScreen() : null}
          onOpenWorkspace={phone() ? props.onToggleWorkspace : null}
          screenHost={runtime.screenHost}
          onOpenArchived={openArchived}
        />
      </View>
      {/*
        Creating on a phone: one button that floats over the list rather than a + in each group
        header. This asks which once, where your thumb is.
      */}
      <If when={fabShown()}>
        <CreateFab
          createMenuOpen={props.createMenuOpen === true}
          onCreateMenuOpenChange={props.onCreateMenuOpenChange}
          onCreateBot={showBots() ? props.onCreateBot : undefined}
          onCreateGroup={showBots() ? props.onCreateGroup : undefined}
          onNewProject={showProjects() ? () => void newProjectInFolder(runtime, t()) : undefined}
          onImportProject={showProjects() ? () => runtime.openCreateProject("import") : undefined}
        />
      </If>
    </>
  );
}
