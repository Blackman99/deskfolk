/**
 * The window (`Shell.svelte`'s markup): onboarding until it is done, then the sidebar (or its rail,
 * folded), the main column and the preview beside it, and every layer over them. State and the
 * ways back live in `shell-state.ts`; this file only lays them out.
 *
 * Three layouts, as the Svelte grid had them:
 * - **wide** (a desktop window wider than 680 points): sidebar column, the workbench, the preview
 *   column. Every conversation, board, map and file is a workbench tab (`PaneContentHost`).
 * - **hosted tablet** (the phone's web build in a wide window): the sidebar column beside a main
 *   column that shows one page at a time, like the phone.
 * - **narrow** (a phone, or a narrow window): the roster fills the window and a page (a
 *   conversation, the calendar, spending, the remote screen) covers it while it is open, with the
 *   bottom bar on the roster's own pages.
 *
 * Not here, against the Svelte: `ImageCopy` (one DOM listener for every picture's right click;
 * NSH pictures carry their own `ImageContextMenu`), the pages' slide transitions and focus
 * restoring. A conversation dragged from the sidebar comes onto the workbench through
 * `session-drag.ts`; the interface profile is applied from `shell-state.ts` (ADR 0108).
 */
import type { SessionSummary } from "@real-bot/protocol";
import { computed, PanResponder, Text, View } from "nsh";
import { snapshot } from "../../lib/reactive";
import { isSessionPinned } from "../../m/sidebar/pinned-sessions.ts";
import { spendCopyFor } from "../../m/spend/spend-copy.ts";
import { updateChecker } from "../../m/update-checker.svelte.ts";
import { activateTab, focusLeaf, replaceTabParams } from "../../m/workbench/layout-tree.ts";
import type { WorkbenchTab } from "../../m/workbench/layout-types.ts";
import { contentOfTab, contentToParams } from "../../m/workbench/pane-content.ts";
import { paneMin } from "../../m/workbench/pane-mins.ts";
import { classifySession, isFileDropSession } from "../../m/sidebar/session-groups.ts";
import { runtime } from "../../runtime";
import { Button } from "../Button";
import { RoutineCalendar } from "../calendar/RoutineCalendar";
import { BotDmDialog } from "../chat/BotDmDialog";
import { ChatHeader } from "../chat/ChatHeader";
import { ChatStage } from "../chat/ChatStage";
import { ChatTabLabel } from "../chat/ChatTabLabel";
import { PaneChatBar, type PaneBarAction } from "../chat/PaneChatBar";
import { ProjectChat } from "../chat/ProjectChat";
import { Icon } from "../Icon";
import { MobileNavigation } from "../MobileNavigation";
import { Onboarding } from "../Onboarding";
import { ArtifactPreview } from "../overlays/ArtifactPreview";
import { DangerDialog } from "../overlays/DangerDialog";
import { RemoteScreenPane } from "../overlays/RemoteScreenPane";
import { ShellPreview } from "../overlays/ShellPreview";
import { TaskTrace } from "../overlays/TaskTrace";
import { WorkspaceExplorer } from "../overlays/WorkspaceExplorer";
import { SessionSettingsDrawer } from "../panels/SessionSettingsDrawer";
import { GlobalSearch } from "../search/GlobalSearch";
import { CallEditor } from "../settings/CallEditor";
import { SettingsModal } from "../settings/SettingsModal";
import { CreateBotSheet } from "../sidebar/CreateBotSheet";
import { CreateGroupSheet } from "../sidebar/CreateGroupSheet";
import { ProjectSessionSheet } from "../sidebar/ProjectSessionSheet";
import { SessionContextMenu } from "../sidebar/SessionContextMenu";
import type { MenuAt } from "../sidebar/SessionRow";
import { Sidebar } from "../sidebar/Sidebar";
import { SidebarRail } from "../sidebar/SidebarRail";
import { SpendOverlay } from "../spend/SpendOverlay";
import { ToastHost } from "../ToastHost";
import { UsageWidget } from "../usage/UsageWidget";
import { NewPaneMenu } from "../workbench/NewPaneMenu";
import { PaneContentHost } from "../workbench/PaneContentHost";
import { PaneTabLabel } from "../workbench/PaneTabLabel";
import type { TabAction } from "../workbench/types";
import { Workbench, type WorkbenchApi } from "../workbench/Workbench";
import { WorkspaceDragGhost } from "../WorkspaceDragGhost";
import { bindShellKeys } from "./shell-keys";
import { createSessionDrag } from "./session-drag";
import { createShellState, type ShellState } from "./shell-state";
import { WINDOW_CHROME } from "../../m/window-chrome";
import { darkGlass, windowGlass } from "../glass";

export function Shell() {
  const s = createShellState();
  // Bound before any child mounts: a layer's own Escape, bound later, wins while it is open.
  bindShellKeys(s);
  return (
    <If when={!s.showOnboarding()} else={<Onboarding holding={s.onboardingHeld()} onHoldingChange={(on) => s.onboardingHeld.set(on)} onDismiss={() => s.dismissedOnboarding.set(true)} />}>
      <ShellBody s={s} />
    </If>
  );
}

function ShellBody(props: { s: ShellState }) {
  const s = props.s;
  const t = () => s.t();
  const snapshot = () => s.snapshot();
  const artifact = s.artifact;
  const workbench = s.workbench;
  /** A conversation pulled out of the roster onto the workbench: only where the workbench is. */
  const sessionDrag = createSessionDrag({ source: workbench.sessionDragSource, titleOf: s.titleOf });
  /** A page covers the roster on a phone while one is open. */
  const pageOpen = () => Boolean(runtime.routinesOpen || runtime.spendOpen || runtime.terminalOpen || runtime.screenOpen || s.selected());

  const openMenuAt = (at: MenuAt, session: SessionSummary) => {
    const fake = { preventDefault() {}, stopPropagation() {}, clientX: at.x, clientY: at.y } as unknown as MouseEvent;
    s.sessionMenu.openContextMenu(fake, session);
  };

  let originWidth = 0;
  const sidebarPan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      originWidth = s.sidebarWidth();
      s.sidebarDragging.set(true);
    },
    onPanResponderMove: (_e, g) => s.resizeSidebar(originWidth, g.dx),
    onPanResponderRelease: () => s.endSidebarResize(),
    onPanResponderTerminate: () => s.endSidebarResize(),
    onPanResponderTerminationRequest: () => false,
  });

  /**
   * Beside the phone layout the sidebar and the gutters around the cards are one ground; on a
   * window with material only part of it covers the glass, so the glass shows through (`glass.ts`).
   */
  const ground = () => (s.narrow() ? "bg-sidebar-bg" : windowGlass ? "bg-ground-glass" : "bg-ground");
  /** Beside the workbench the column is ground, each pane its own card; on macOS the tabs' centre line meets the lights' (26 pt), and the dark heads keep 4 pt above them. */
  const mainTop = () => (WINDOW_CHROME !== "mac" ? 0 : darkGlass() ? 2 : 6);

  return (
    <View
      class={`flex-1 min-h-0 min-w-0 ${ground()}`}
      onLayout={(e) => {
        s.shellWidth.set(e.bounds.size.width);
        s.shellHeight.set(e.bounds.size.height);
      }}
    >
      <WorkspaceDragGhost />
      <ToastHost />
      <View class="flex-1 min-h-0 flex-row">
        {/*
          * The sidebar: a column (or its rail) beside the main column, or the whole roster on a phone.
          * One frame holds either: as a column its width is the rail's or the sidebar's, and folding
          * eases it between the two (`toggleSidebar`), the one shown drawn at its own width and cut
          * at the frame's edge.
          */}
        <View
          testID="shell-sidebar-frame"
          class="h-full min-h-0"
          classList={{ "flex-1": !s.sidebarColumn(), "overflow-hidden": s.sidebarColumn() }}
          style={s.sidebarColumn() ? { width: s.sidebarFrameWidth() } : undefined}
        >
          <If when={s.sidebarRail()}>
            <View style={{ width: s.railWidth }} class="h-full">
              <SidebarRail
                pinnedSessionIds={s.pinnedSessionIds()}
                toolsMenuOpen={s.toolsMenuOpen()}
                onToolsMenuOpenChange={(open) => s.toolsMenuOpen.set(open)}
                workspaceOpen={runtime.workspaceOpen}
                contextMenuSessionId={s.sessionMenu.contextMenu?.session.id ?? null}
                onOpenContextMenu={(e, session) => openMenuAt({ x: e.pagePosition.x, y: e.pagePosition.y }, session)}
                onExpand={s.toggleSidebar}
                onOpenSearch={s.openGlobalSearch}
                onToggleWorkspace={artifact.toggleWorkspaceExplorer}
                onOpenRoutines={artifact.openRoutinesFromUi}
                onOpenSpend={artifact.openSpendFromUi}
                workbench={s.wide()}
                onNewTerminal={() => void workbench.openNewTerminal(null)}
                onOpenArchived={s.openArchivedFromRail}
                onOpenSettings={() => runtime.openSettings()}
                onDragSession={s.wide() ? sessionDrag.drag : undefined}
              />
            </View>
          </If>
          <If when={!s.sidebarRail()}>
            <View
              testID="shell-sidebar"
              class="h-full min-h-0"
              classList={{ "flex-1": !s.sidebarColumn() }}
              style={s.sidebarColumn() ? { width: s.sidebarWidth() } : undefined}
            >
              <Sidebar
                selected={s.selected()}
                pinnedSessionIds={s.pinnedSessionIds()}
                searchOpen={s.searchOpen()}
                onOpenSearch={s.openGlobalSearch}
                createMenuOpen={s.createMenuOpen()}
                onCreateMenuOpenChange={(open) => s.createMenuOpen.set(open)}
                toolsMenuOpen={s.toolsMenuOpen()}
                onToolsMenuOpenChange={(open) => s.toolsMenuOpen.set(open)}
                workspaceOpen={runtime.workspaceOpen}
                contextMenuSessionId={s.sessionMenu.contextMenu?.session.id ?? null}
                renamingSessionId={s.sessionMenu.renamingSessionId}
                phoneList={s.phoneList()}
                onRenameSession={s.sessionMenu.finishRename}
                onOpenContextMenu={openMenuAt}
                onTogglePin={s.sessionMenu.handleMenuTogglePin}
                onOpenProjectDir={(session) => void s.sessionMenu.handleMenuOpenProjectDir(session)}
                onToggleWorkspace={artifact.toggleWorkspaceExplorer}
                onOpenRoutines={artifact.openRoutinesFromUi}
                onOpenSpend={artifact.openSpendFromUi}
                workbench={s.wide()}
                onNewTerminal={() => void workbench.openNewTerminal(null)}
                onOpenSettings={() => runtime.openSettings()}
                onCreateBot={s.openCreateBot}
                onCreateGroup={s.openCreateGroup}
                onCollapse={s.sidebarColumn() ? s.toggleSidebar : undefined}
                onHandle={(handle) => s.setSidebarHandle(handle)}
                onDragSession={s.wide() ? sessionDrag.drag : undefined}
              />
            </View>
          </If>
        </View>
        <If when={!s.sidebarHidden() && s.sidebarColumn()}>
          <View
            testID="sidebar-split"
            accessibilityLabel={t().sidebar.resize}
            class="w-[6px] h-full ml-[-3px] mr-[-3px] cursor-col-resize"
            style={{ zIndex: 5 }}
            {...sidebarPan.panHandlers}
          />
        </If>
        {/* The main column: the workbench on a desktop; one page at a time elsewhere. */}
        <If when={s.sidebarColumn() || pageOpen()}>
          <View
            testID="shell-main"
            class="min-w-0 min-h-0"
            classList={{ "flex-1": s.sidebarColumn(), "absolute inset-0": !s.sidebarColumn(), "bg-pane": !s.wide(), "mr-1 mb-1": s.wide() }}
            style={!s.sidebarColumn() ? { zIndex: 10 } : s.wide() ? { marginTop: mainTop() } : undefined}
          >
            <If when={s.wide()} else={<MainPages s={s} />}>
              <ShellWorkbench s={s} onApi={sessionDrag.setApi} />
            </If>
          </View>
        </If>
        <ShellPreview wide={s.wide()} locale={snapshot().settings.locale === "en" ? "en" : "zh"} botsById={s.botsById()} artifact={artifact} onPane={(pane) => s.setPreviewPane(pane)} shellWidth={() => s.shellWidth()}>
          {(p) => (
            <ArtifactPreview
              attachment={p.attachment}
              relpath={p.relpath}
              siblings={p.siblings}
              api={p.api}
              workspacePath={p.workspacePath}
              forceTree={p.forceTree}
              taskId={p.taskId}
              projectDir={p.projectDir}
              target={p.target}
              sheet={p.sheet}
              annotations={p.annotations}
              annotationFocusId={p.annotationFocusId}
              annotationFileKey={p.annotationFileKey}
              bots={p.bots}
              locale={p.locale}
              sessions={p.sessions}
              viewedSessionId={p.viewedSessionId}
              onLoadAnnotations={p.onLoadAnnotations}
              onCreateAnnotation={p.onCreateAnnotation}
              onPatchAnnotation={p.onPatchAnnotation}
              onDeleteAnnotation={p.onDeleteAnnotation}
              onSendAnnotations={p.onSendAnnotations}
              onOpenTerminal={p.onOpenTerminal}
              onClose={p.onClose}
              onSelect={p.onSelect}
              onSelectWorkspacePath={p.onSelectWorkspacePath}
              ref={p.ref}
            />
          )}
        </ShellPreview>
      </View>
      {/* The phone's bottom bar: narrow windows only (the Svelte hid it above 680 points by CSS). */}
      <If when={s.narrow() && s.mobileNavigationVisible()}>
        <MobileNavigation active={s.mobileDestination()} updateAvailable={updateChecker.updateVisible} onNavigate={s.navigateMobile} />
      </If>
      <ShellLayers s={s} />
    </View>
  );
}

/** The narrow and hosted main column: one page, the first of these that is open. */
function MainPages(props: { s: ShellState }) {
  const s = props.s;
  const t = () => s.t();
  const page = () =>
    runtime.routinesOpen ? "routines" : runtime.spendOpen ? "spend" : runtime.screenOpen && runtime.client?.kind === "remote" ? "screen" : s.selected() ? "chat" : null;
  return (
    <View class="flex-1 min-h-0 min-w-0">
      <If when={page() === "routines"}>
        <RoutineCalendar />
      </If>
      <If when={page() === "spend"}>
        <SpendOverlay backLabel={t().common.back} />
      </If>
      <If when={page() === "screen" ? runtime.client : null}>
        {(api) => <RemoteScreenPane api={api() as unknown as Parameters<typeof RemoteScreenPane>[0]["api"]} onClose={() => runtime.closeRemoteScreen()} />}
      </If>
      <If when={page() === "chat" ? s.selected() : null}>
        {(selected) => (
          <View testID="conversation" class="flex-1 min-h-0 min-w-0">
            <ChatHeader
              selected={selected()}
              pinnedSessionIds={s.pinnedSessionIds()}
              onTogglePin={s.togglePin}
              onToggleSessionSettings={s.toggleSessionSettings}
              onCreateBot={s.openCreateBot}
              onShowOnboarding={() => s.dismissedOnboarding.set(false)}
            />
            <If
              when={selected().kind === "project"}
              else={
                <ChatStage
                  selected={selected()}
                  onOpenProfile={(botId) => s.openProfile(botId)}
                  onOpenArtifact={(relpath, att, messageId, forceTree) => s.artifact.openArtifactPath(relpath, att, messageId, forceTree)}
                  onCreateBot={s.openCreateBot}
                />
              }
            >
              <ProjectChat selected={selected()} onOpenArtifact={(relpath, att, messageId) => s.artifact.openArtifactPath(relpath, att, messageId)} />
            </If>
          </View>
        )}
      </If>
    </View>
  );
}

/** The desktop's workbench, with every tab's body, label, bar and menus. */
function ShellWorkbench(props: { s: ShellState; onApi: (api: WorkbenchApi) => void }) {
  const s = props.s;
  const t = () => s.t();
  const workbench = s.workbench;
  /**
   * The layout as plain objects: the mirrored workbench keeps it in a deep `state()`, and `Each`
   * over a reactive proxy's arrays draws nothing (PORTING.md). Every change replaces the whole
   * layout (the tree's operations are pure), so the top-level read is the one to follow.
   */
  const layout = computed(() => snapshot(workbench.layout));
  /** What a conversation's tab offers: pin, its job, its map, its settings (a project: its map). Drawn in the tab's bar and under its ⋯. */
  const chatBarActions = (leafId: string, tab: WorkbenchTab): PaneBarAction[] => {
    const content = contentOfTab(tab);
    if (content?.kind !== "chat") return [];
    const session = s.sessionsById().get(content.sessionId);
    if (session?.kind === "project") {
      return [{ id: "map", label: t().taskmap.open, icon: "minimap", run: () => workbench.openGuarded({ kind: "map", sessionId: session.id }) }];
    }
    if (!session || isFileDropSession(session)) return [];
    const pinned = isSessionPinned(s.pinnedSessionIds(), session.id);
    return [
      { id: "pin", label: pinned ? t().top.unpin : t().top.pin, icon: "pin", active: pinned, run: () => s.togglePin(session.id) },
      {
        id: "trace",
        label: t().plan.segmentTrace,
        icon: "hierarchy",
        run: () => workbench.openGuarded({ kind: "trace", sessionId: session.id, taskId: null, focus: null, focusNonce: null }),
      },
      { id: "map", label: t().taskmap.open, icon: "minimap", run: () => workbench.openGuarded({ kind: "map", sessionId: session.id }) },
      {
        id: "settings",
        label: classifySession(session) === "group" ? t().top.groupSettings : t().top.botSettings,
        icon: "settings",
        active: Boolean(content.side && !content.side.botId),
        run: () => {
          workbench.commitLayout(activateTab(focusLeaf(workbench.layout, leafId), leafId, tab.id));
          s.togglePaneSettings(session.id);
        },
      },
    ];
  };

  /** The same actions for the workbench's ⋯ menu, which draws a picture rather than naming one. */
  const chatTabActions = (leafId: string, tab: WorkbenchTab): TabAction[] =>
    chatBarActions(leafId, tab).map((action) => {
      const name = action.icon;
      return { ...action, icon: name ? () => <Icon name={name} filled={action.id === "pin" && action.active === true} /> : undefined };
    });

  const settingsSide = (sessionId: string, botId: string | null) => <SessionSettings s={s} beside={{ sessionId, botId }} />;

  return (
    <Workbench
      layout={layout()}
      mins={paneMin}
      wide={true}
      onApi={props.onApi}
      tabName={workbench.paneTitle}
      tabActions={chatTabActions}
      onLayout={workbench.commitLayout}
      onViewport={workbench.setViewport}
      onFloatAdjusted={workbench.rememberFloat}
      onActivate={(leafId, tabId) => workbench.commitLayout(activateTab(workbench.layout, leafId, tabId))}
      onCloseTab={workbench.onPaneCloseTab}
      onCloseTabs={workbench.onPaneCloseTabs}
      onClosePane={workbench.onPaneClose}
      tabBody={(tab, leafId) => (
        <PaneContentHost
          tab={tab}
          leafId={leafId}
          onOpenProfile={s.openProfile}
          onOpenArtifact={s.artifact.openArtifactPath}
          onRemoveTab={workbench.onPaneCloseTab}
          onBindTerminal={workbench.bindTerminalTab}
          onUpdateContent={(content) => workbench.commitLayout(replaceTabParams(workbench.layout, leafId, tab.id, contentToParams(content)))}
          onOpenContent={workbench.openGuarded}
          onPreviewPane={workbench.trackPreviewPane}
          onJump={s.jumpToTrace}
          onCloseSide={s.closePaneSide}
          settingsSide={settingsSide}
          chatBar={(barTab, barLeaf) => {
            // Read inside the `If`, not here: the pane calls this in a tracked insert, and the tab's
            // params and the session list read here made the bar again on every layout commit and
            // every session update (each streamed line updates its session's last message).
            const session = () => {
              const content = contentOfTab(barTab);
              return content?.kind === "chat" ? s.sessionsById().get(content.sessionId) : undefined;
            };
            return (
              <If when={session()} else={<View />}>
                {(row) => <PaneChatBar session={row()} actions={chatBarActions(barLeaf, barTab)} />}
              </If>
            );
          }}
          onCreateBot={s.openCreateBot}
        />
      )}
      tabLabel={(tab) => {
        // Read inside the `If`, as the chat bar's: here, in the strip's tracked insert, they made the
        // label again on every layout commit and every session update.
        const session = () => {
          const content = contentOfTab(tab);
          return content?.kind === "chat" ? s.sessionsById().get(content.sessionId) : undefined;
        };
        return (
          <If when={session()} else={<PaneTabLabel kind={contentOfTab(tab)?.kind ?? null} title={workbench.paneTitle(tab)} />}>
            {(row) => <ChatTabLabel session={row()} title={workbench.paneTitle(tab)} />}
          </If>
        );
      }}
      emptyLead={() => (
        <View class="flex-row gap-2">
          <Button variant="primary" icon="user-plus" onPress={s.openCreateBot}>
            {t().sidebar.addBot}
          </Button>
          <Button variant="secondary" icon="users" onPress={s.openCreateGroup}>
            {t().sidebar.addGroup}
          </Button>
        </View>
      )}
      emptyActions={(leafId) => (
        <View class="gap-1">
          <PaneOpen label={t().terminal.newTab} onPress={() => void workbench.openNewTerminal(leafId)} />
          <Each of={workbench.untabbedTerminals.slice()} key={(row) => row.id}>
            {(row) => <PaneOpen label={t().terminal.reattach(workbench.terminalName(row()))} onPress={() => workbench.openInPane(leafId, { kind: "terminal", terminalId: row().id })} />}
          </Each>
          <PaneOpen
            label={t().sidebar.workspace}
            disabled={!s.snapshot().settings.workspace_path}
            onPress={() => workbench.openInPane(leafId, { kind: "workspace", selected: null })}
          />
          <PaneOpen label={t().routines.title} onPress={() => workbench.openInPane(leafId, { kind: "routines" })} />
          <PaneOpen
            label={spendCopyFor(s.snapshot().settings.locale === "en" ? "en" : "zh").title}
            onPress={() => workbench.openInPane(leafId, { kind: "spend" })}
          />
          <PaneOpen label={t().usage.title} onPress={() => workbench.openInPane(leafId, { kind: "usage" })} />
        </View>
      )}
      menuActions={(leafId, query, close) => <NewPaneMenu workbench={workbench} leafId={leafId} query={query} onPick={close} />}
    />
  );
}

function PaneOpen(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled ?? false }}
      class="cursor-pointer select-none rounded-[8px] px-3 py-[6px] hover:bg-line-subtle"
      classList={{ "opacity-50": props.disabled ?? false }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
    >
      <Text class="text-[13px] text-ink">{props.label}</Text>
    </View>
  );
}

/** A conversation's settings: the drawer over the shell (`beside` null) or beside a workbench tab. */
function SessionSettings(props: { s: ShellState; beside: { sessionId: string; botId: string | null } | null }) {
  const s = props.s;
  return (
    <SessionSettingsDrawer
      beside={props.beside}
      narrow={s.narrow()}
      botsById={s.botsById()}
      sessionsById={s.sessionsById()}
      danger={s.danger}
      openProfile={s.openProfile}
      closePaneSide={s.closePaneSide}
      selected={s.selected()}
      selectedKind={s.selectedKind()}
      nestedProfile={s.nestedProfile()}
      profileBot={s.profileBot()}
      closeNestedProfile={s.closeNestedProfile}
      closeCurrentDrawerScreen={s.closeCurrentDrawerScreen}
      onProfilePane={(pane) => s.setProfilePane(pane ?? null)}
      profileFailed={s.profileFailed()}
      onProfileFailedChange={(v) => s.profileFailed.set(v)}
      paneMobileDetail={s.paneMobileDetail()}
      onPaneMobileDetailChange={(v) => s.paneMobileDetail.set(v)}
      groupDetail={s.groupDetail()}
      onGroupDetailChange={(v) => s.groupDetail.set(v)}
    />
  );
}

/** Everything over the shell: the job page, the workspace, the drawers, dialogs, sheets and menus. */
function ShellLayers(props: { s: ShellState }) {
  const s = props.s;
  const t = () => s.t();
  const snapshot = () => s.snapshot();
  const artifact = s.artifact;
  return (
    <>
      <If when={runtime.traceOpen ? s.selected() : null}>
        {(selected) => (
          <TaskTrace
            api={runtime.client}
            taskId={runtime.traceTaskId || null}
            line={runtime.traceLine}
            focus={runtime.traceFocus}
            focusToken={runtime.traceFocusToken}
            sessionId={runtime.traceSessionId || selected().id}
            activeSessionId={selected().id}
            sessions={snapshot().sessions}
            bots={snapshot().bots}
            providers={snapshot().providers}
            youLabel={t().common.you}
            deletedLabel={t().top.deleted}
            workspacePath={snapshot().settings.workspace_path}
            reloadToken={runtime.traceReload}
            onClose={() => runtime.closeTrace()}
            onJump={s.jumpFromTracePage}
            onOpenArtifact={artifact.openArtifactPath}
            holds={snapshot().holdsOn ? snapshot().holds : null}
            onStop={(choice) => runtime.stopScope(choice.scope, choice.id, runtime.traceSessionId || selected().id)}
            onLift={(hold) => runtime.liftHold(hold.id)}
            controlsDisabled={runtime.connection !== "connected"}
            onOpenRoles={(id) => runtime.openRoles(null, id)}
            onTask={(id) => {
              if (runtime.traceTaskId !== id) runtime.traceTaskId = id;
            }}
            callEditor={(role) => <CallEditor role={role} />}
          />
        )}
      </If>
      <If when={runtime.workspaceOpen}>
        <WorkspaceExplorer
          api={runtime.client}
          workspacePath={snapshot().settings.workspace_path}
          selected={runtime.workspaceSelected}
          onClose={artifact.closeWorkspaceExplorer}
          onOpenSettings={() => s.navigateMobile("settings")}
          onOpenTerminal={artifact.openTerminalFromWorkspace}
          onSelect={artifact.openWorkspaceFile}
          onHandle={(handle) => s.setWorkspacePane(handle)}
        >
          {(p) => (
            <ArtifactPreview
              attachment={null}
              relpath={p.relpath}
              siblings={[]}
              api={p.api}
              workspacePath={p.workspacePath}
              mode="workspace"
              onClose={p.onClose}
              onSelect={() => {}}
              onSelectWorkspacePath={p.onSelectWorkspacePath}
              onOpenTerminal={p.onOpenTerminal}
              ref={p.ref}
            />
          )}
        </WorkspaceExplorer>
      </If>
      <If when={runtime.threadOpen}>
        <View testID="thread" class="absolute top-0 right-0 bottom-0 w-[320px] border-l border-line bg-pane p-4 gap-3" style={{ zIndex: 20 }}>
          <View class="flex-row items-center">
            <Text class="flex-1 text-[14px] font-semibold text-ink">{t().thread.title}</Text>
            <Button variant="ghost" onPress={() => (runtime.threadOpen = false)}>
              {t().common.close}
            </Button>
          </View>
          <Text class="text-[13px] text-ink-muted">{t().thread.none}</Text>
        </View>
      </If>
      <SessionSettings s={s} beside={null} />
      <If when={s.dangerConfirmCopy()}>
        {(dangerCopy) => (
          <DangerDialog
            copy={dangerCopy()}
            onDismiss={() => s.danger.dismissDangerConfirm()}
            busy={Boolean(s.danger.dangerConfirm?.running)}
            optionChecked={s.danger.dangerConfirm?.eraseQuotes ?? false}
            onOptionChange={(checked) => s.danger.setDangerOption(checked)}
            onConfirm={() => void s.danger.confirmDanger()}
          />
        )}
      </If>
      <If when={s.settingsEverOpened()}>
        <SettingsModal
          mobileSettingsDetail={s.mobileSettingsDetail()}
          onMobileSettingsDetailChange={(v) => s.mobileSettingsDetail.set(v)}
          saveFailed={s.saveFailed()}
          onSaveFailedChange={(v) => s.saveFailed.set(v)}
          providerEditor={s.providerEditor()}
          onProviderEditorChange={(v) => s.providerEditor.set(v)}
          confirmingProvider={s.danger.dangerConfirm?.kind === "provider"}
          confirmingIndependent={s.danger.confirmingIndependent}
          onConfirmingIndependentChange={(v) => (s.danger.confirmingIndependent = v)}
          patchImmediate={s.patchImmediate}
          openDeleteProviderConfirm={(id) => s.danger.openDeleteProviderConfirm(id)}
          closeSettings={s.closeSettings}
          workbench={s.wide()}
          onHandle={(handle) => s.setSettingsHandle(handle)}
        />
      </If>
      <If when={runtime.createBotOpen}>
        <CreateBotSheet onClose={() => (runtime.createBotOpen = false)} />
      </If>
      <If when={runtime.createProjectOpen}>
        <ProjectSessionSheet mode={runtime.createProjectMode} agent={runtime.createProjectAgent} onClose={() => (runtime.createProjectOpen = false)} />
      </If>
      <If when={runtime.createGroupOpen}>
        <CreateGroupSheet bots={s.visibleBots()} onClose={() => (runtime.createGroupOpen = false)} />
      </If>
      <If when={s.botDmSession()}>
        {(session) => (
          <BotDmDialog
            session={session()}
            onClose={() => runtime.closeBotDm()}
            onOpenProfile={(botId) => {
              runtime.closeBotDm();
              s.openProfile(botId);
            }}
            onOpenArtifact={(relpath, att, messageId, forceTree) => {
              runtime.closeBotDm();
              artifact.openArtifactPath(relpath, att, messageId, forceTree);
            }}
            onCreateBot={s.openCreateBot}
          />
        )}
      </If>
      <If when={s.sessionMenu.contextMenu}>
        {(menu) => (
          <SessionContextMenu
            session={menu().session}
            botsById={s.botsById()}
            isPinned={isSessionPinned(s.pinnedSessionIds(), menu().session.id)}
            x={menu().x}
            y={menu().y}
            onClose={s.sessionMenu.closeContextMenu}
            onTogglePin={() => s.sessionMenu.handleMenuTogglePin(menu().session.id)}
            onViewInfo={() => void s.sessionMenu.handleMenuViewInfo(menu().session)}
            onClearHistory={() => s.sessionMenu.handleMenuClearHistory(menu().session)}
            onToggleArchive={() => void s.sessionMenu.handleMenuToggleArchive(menu().session)}
            onDelete={() => s.sessionMenu.handleMenuDelete(menu().session)}
            onShowJobView={() => void s.sessionMenu.handleMenuShowJobView(menu().session)}
            onShowMap={runtime.paneOpener ? () => s.sessionMenu.handleMenuShowMap(menu().session) : undefined}
            onOpenProjectDir={() => void s.sessionMenu.handleMenuOpenProjectDir(menu().session)}
            onOpenProjectTerminal={() => s.sessionMenu.handleMenuOpenProjectTerminal(menu().session)}
            onRename={s.sidebarHidden() ? undefined : () => s.sessionMenu.handleMenuRename(menu().session)}
          />
        )}
      </If>
      <If when={s.searchOpen()}>
        <GlobalSearch onClose={s.closeGlobalSearch} onSelect={s.selectSearchHit} />
      </If>
      {/* Every agent's usage, floating over a wide window (ADR 0080); a phone has the page in Tools. */}
      <If when={!s.narrow()}>
        <UsageWidget />
      </If>
    </>
  );
}

