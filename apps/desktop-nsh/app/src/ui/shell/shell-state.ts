/**
 * What `Shell.svelte`'s script holds, for the NSH shell (`src/ui/Shell.tsx`): the window's open
 * layers and their ways back, the sidebar's width and fold, the pinned conversations, search, the
 * settings and session drawers' drafts, and the four helpers the messenger already split out of
 * its shell (the workbench, the artifact preview, the session menu, the danger confirm), built on
 * the same getters. Made once per window, inside the Shell component, so its effects stop with it.
 *
 * What differs from the Svelte script: no DOM (`document.querySelector`, focus restoring, the
 * window's `keydown`): the keys are `keymap` bindings in `Shell.tsx`, the shell's size comes from
 * its own layout, and the narrow breakpoint is the window's width (`watchNarrow` listened to the
 * same query). The interface profile is wired with NSH's side of it (`ui/interface/look.ts`, ADR
 * 0108); its words reach every screen through `copy()`, which is `t` here.
 */
import { batch, cleanup, computed, effect, setColorScheme, signal, untracked, windowSize } from "nsh";
import type { Bot, SearchHit, SessionSummary } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { dangerCopy, shouldDropConfirm } from "../../m/overlays/danger-confirm.ts";
import { ShellDangerConfirm } from "../../m/overlays/danger-confirm.svelte.ts";
import { ShellArtifact } from "../../m/overlays/shell-artifact.svelte.ts";
import { ShellSessionMenu } from "../../m/sidebar/session-menu-actions.svelte.ts";
import { ShellWorkbench } from "../../m/workbench/shell-workbench.svelte.ts";
import { classifySession, presentBotIds, youBotPeer } from "../../m/sidebar/session-groups.ts";
import { sessionTitle } from "../../m/sidebar/session-title.ts";
import { cleanPinnedIds, loadPinnedIds, savePinnedIds, togglePinnedId } from "../../m/sidebar/pinned-sessions.ts";
import {
  clampSidebarWidth,
  loadSidebarCollapsed,
  loadSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
  SIDEBAR_RAIL,
} from "../../m/sidebar/sidebar-width.ts";
import { searchJump } from "../../m/sidebar/search-jump.ts";
import { topLayer, type MobileDestination } from "../../m/mobile-route.ts";
import { closeEnlargedImage, imageEnlarged } from "../../m/chat/enlarged-images.ts";
import { closeMessageText, messageTextOpen } from "../../m/chat/message-text-pages.ts";
import { closeFullscreenPreview } from "../../m/overlays/fullscreen-preview.ts";
import { composerLocked } from "../../m/chat/composer-mode.ts";
import { isWorkbenchSurface, NARROW_MAX_WIDTH, sidebarFolds } from "../../m/workbench/surface.ts";
import { closeChatSide, settingsSide, toggleChatSide } from "../../m/workbench/pane-open.ts";
import type { GroupDetailDraft } from "../../m/panels/group-edit.ts";
import type { ProviderEditorState } from "../../m/settings/provider-form.ts";
import { WINDOW_CHROME } from "../../m/window-chrome.ts";
import { widthAtMost } from "../../platform/viewport";
import { wireInterfaceHere } from "../interface/look";
import { reduceMotion } from "../interface/motion";
import { sidebarFoldAt } from "./sidebar-fold";

/** What a pane hosting a file answers the shell (the preview column, the workspace page). */
export type PaneHandle = {
  requestCloseFromParent: (afterClose?: () => void) => void;
  closeFind: () => boolean;
  blocksClose: () => boolean;
};

const PHONE_LIST_KEY = "real-bot-phone-list";

function readPhoneList(): "bots" | "projects" {
  try {
    return localStorage.getItem(PHONE_LIST_KEY) === "projects" ? "projects" : "bots";
  } catch {
    return "bots";
  }
}

export function createShellState() {
  const snapshot = () => runtime.snapshot;
  const t = () => copy();
  const botsById = computed(() => new Map(snapshot().bots.map((b) => [b.id, b] as const)));
  const visibleBots = computed(() => snapshot().bots.filter((b) => !b.archived_at));
  const sessionsById = computed(() => new Map(snapshot().sessions.map((s) => [s.id, s] as const)));
  const rosterLabels = () => ({ deleted: t().top.deleted, archived: t().top.archived, fileDrop: t().sidebar.fileDrop, projectUntitled: t().project.untitled });
  const titleOf = (session: SessionSummary) => sessionTitle(session, botsById(), rosterLabels());

  // --- pinned conversations: kept in this browser, dropped once their conversation is gone ---
  const pinnedSessionIds = signal<string[]>(loadPinnedIds());
  effect(() => {
    const valid = new Set(snapshot().sessions.map((s) => s.id));
    const pinned = pinnedSessionIds();
    const cleaned = cleanPinnedIds(pinned, valid);
    if (cleaned.length !== pinned.length) {
      untracked(() => pinnedSessionIds.set(cleaned));
      savePinnedIds(cleaned);
    }
  });
  function togglePin(sessionId: string): void {
    const next = togglePinnedId(pinnedSessionIds(), sessionId);
    pinnedSessionIds.set(next);
    savePinnedIds(next);
  }

  // --- the window's look: the setting decides, the system when it says so ---
  effect(() => {
    const theme = snapshot().settings.theme;
    if (theme === "light" || theme === "dark") setColorScheme(theme);
    else if (theme === "system") setColorScheme("system");
  });

  // --- your interface profile (ADR 0106; on NSH, ADR 0108): painted, its floor kept, its way back bound ---
  wireInterfaceHere({
    connected: () => runtime.connection === "connected",
    api: () => runtime.client,
    state: () => snapshot().interface ?? null,
    bots: () => snapshot().bots,
    t: () => t(),
  });

  // --- the shell's size: the narrow window is the phone layout (≤ 680 points wide) ---
  const shellWidth = signal(Number.POSITIVE_INFINITY);
  const shellHeight = signal(0);
  const narrow = () => widthAtMost(NARROW_MAX_WIDTH);
  const wide = () => isWorkbenchSurface(narrow());
  const isMobile = () => shellWidth() <= NARROW_MAX_WIDTH;
  /** The stand-in for the Svelte shell's element: the helpers read only its size. */
  const shellBox = { get clientWidth() { return untracked(shellWidth); }, get clientHeight() { return untracked(shellHeight); } };
  const shellEl = () => shellBox as unknown as HTMLElement;

  // --- the sidebar: its width, dragged and remembered; folded to a rail where it is a column ---
  const sidebarPreferred = signal(loadSidebarWidth());
  const sidebarDragging = signal(false);
  const sidebarWidth = () => clampSidebarWidth(sidebarPreferred(), shellWidth());
  const sidebarCollapsed = signal(loadSidebarCollapsed());
  const sidebarColumn = () => sidebarFolds(narrow());
  const sidebarHidden = () => sidebarColumn() && sidebarCollapsed();
  /** On macOS the traffic lights sit at the top of the rail: it gives them room (Shell.svelte). */
  const railWidth = WINDOW_CHROME === "mac" ? SIDEBAR_RAIL + 20 : SIDEBAR_RAIL;
  const toolsMenuOpen = signal(false);
  const createMenuOpen = signal(false);
  let sidebarHandle: { showArchived(): void } | null = null;
  /**
   * Folding moves the column's edge between the sidebar's width and the rail's a frame at a time,
   * over the quarter second of the Svelte shell's grid transition, and what is beside it is laid out
   * afresh at each frame, as a drag of the split lays it out. Closing, the sidebar stays and the edge
   * closes over it; the rail takes its place once the edge has come to rest. Opening, the sidebar is
   * there at once and the edge uncovers it. `null` at rest.
   *
   * Not NSH's `LayoutAnimation`: it laid the panes out at their end width at once and eased each of
   * their views there on its own, so a reply jumped up or down and its path chips slid across its
   * text. Not with reduced motion, not across the phone layout, not for a drag of the split.
   */
  const sidebarFoldWidth = signal<number | null>(null);
  let foldFrame = 0;
  /** The width of the sidebar's frame where it is a column. */
  const sidebarFrameWidth = () => sidebarFoldWidth() ?? (sidebarHidden() ? railWidth : sidebarWidth());
  /** Whether the frame holds the rail: folded, and the fold at rest. */
  const sidebarRail = () => sidebarHidden() && sidebarFoldWidth() === null;
  function foldSidebar(from: number): void {
    cancelAnimationFrame(foldFrame);
    const to = sidebarHidden() ? railWidth : sidebarWidth();
    if (!sidebarColumn() || reduceMotion() || from === to) {
      sidebarFoldWidth.set(null);
      return;
    }
    sidebarFoldWidth.set(from);
    // The clock starts at the first frame drawn after the fold, so mounting the sidebar takes none of it.
    let start = -1;
    const step = (now: number) => {
      if (start < 0) start = now;
      const width = sidebarFoldAt(from, to, now - start);
      sidebarFoldWidth.set(width);
      if (width !== null) foldFrame = requestAnimationFrame(step);
    };
    foldFrame = requestAnimationFrame(step);
  }
  cleanup(() => cancelAnimationFrame(foldFrame));
  function toggleSidebar(): void {
    const next = !sidebarCollapsed();
    const from = sidebarFrameWidth();
    batch(() => {
      toolsMenuOpen.set(false);
      sidebarCollapsed.set(next);
      foldSidebar(from);
    });
    saveSidebarCollapsed(next);
  }
  function openArchivedFromRail(): void {
    if (!sidebarCollapsed()) return;
    toggleSidebar();
    setTimeout(() => sidebarHandle?.showArchived(), 0);
  }
  function resizeSidebar(originWidth: number, dx: number): void {
    sidebarPreferred.set(clampSidebarWidth(originWidth + dx, shellWidth()));
  }
  function endSidebarResize(): void {
    sidebarDragging.set(false);
    saveSidebarWidth(sidebarPreferred());
  }

  // --- the selected conversation and what follows from it ---
  const selected = computed(() => snapshot().sessions.find((s) => s.id === runtime.selectedId) ?? null);
  const connected = () => runtime.connection === "connected";
  const selectedKind = () => (selected() ? classifySession(selected()!) : null);
  const botDmSession = computed(() =>
    runtime.botDmSessionId ? (snapshot().sessions.find((row) => row.id === runtime.botDmSessionId) ?? null) : null,
  );
  const selectedPeer = () => (selected() ? youBotPeer(selected()!) : null);
  const selectedPeerBot = () => (selectedPeer() ? (botsById().get(selectedPeer()!) ?? null) : null);
  const lockedComposer = () => composerLocked(selected(), botsById());
  const profileBot = () =>
    runtime.profileBotId
      ? (snapshot().bots.find((bot) => bot.id === runtime.profileBotId) ?? null)
      : selectedKind() === "you-bot" && runtime.sessionSettingsOpen
        ? selectedPeerBot()
        : null;
  const sessionSettingsLabel = () => (selectedKind() === "group" ? t().top.groupSettings : t().top.botSettings);
  const nestedProfile = () => Boolean(runtime.profileBotId && selectedKind() !== "you-bot");
  const groupPresent = () => (selected() ? presentBotIds(selected()!) : []);

  // --- the panes that host files, and the layers they answer for ---
  let previewPane: PaneHandle | null = null;
  let workspacePane: PaneHandle | null = null;
  const artifact = new ShellArtifact({
    runtime: () => runtime,
    selected: () => selected(),
    wide: () => wide(),
    shellEl,
    shellWidth: () => shellWidth(),
    workspacePane: () => workspacePane,
    previewPane: () => previewPane,
  });
  const workbench = new ShellWorkbench({
    runtime: () => runtime,
    wide: () => wide(),
    shellWidth: () => shellWidth(),
    shellEl,
    sessionsById: () => sessionsById(),
    titleOf,
    t: () => t(),
  });

  // --- the settings window and the drawers' drafts ---
  const saveFailed = signal(false);
  const providerEditor = signal<ProviderEditorState | null>(null);
  const profileFailed = signal(false);
  const mobileSettingsDetail = signal(false);
  const paneMobileDetail = signal(false);
  let settingsHandle: { backWithinSettings(): boolean; backFromProviderEditor(): void } | null = null;
  let profilePane: { backFromEditor(): boolean } | null = null;
  const settingsEverOpened = signal(false);
  effect(() => {
    if (runtime.settingsOpen) untracked(() => settingsEverOpened.set(true));
  });
  const groupDetail = signal<GroupDetailDraft>({ sessionId: null, name: "", nameError: undefined, failed: false, pullPick: "" });

  function closeNestedProfile(): void {
    runtime.closeProfile();
    if (danger.dangerConfirm?.source !== "menu") danger.clearDanger("bot");
    profileFailed.set(false);
  }

  const danger: ShellDangerConfirm = new ShellDangerConfirm({
    runtime: () => runtime,
    selected: () => selected(),
    sessionsById: () => sessionsById(),
    groupDetail: () => groupDetail(),
    setProfileFailed: (value) => profileFailed.set(value),
    setSaveFailed: (value) => saveFailed.set(value),
    closeNestedProfile,
  });
  const dangerConfirmCopy = () => (danger.dangerConfirmKind ? dangerCopy(danger.dangerConfirmKind, t()) : null);

  function openProfile(botId: string, sessionId?: string): void {
    if (!botsById().has(botId)) return;
    if (danger.dangerConfirm?.source !== "menu") danger.clearDanger("bot");
    profileFailed.set(false);
    if (sessionId && runtime.paneOpener) {
      runtime.paneOpener({ kind: "chat", sessionId, side: { kind: "settings", botId } });
      return;
    }
    runtime.openProfile(botId);
  }

  const sessionMenu = new ShellSessionMenu({
    runtime: () => runtime,
    botsById: () => botsById(),
    danger: () => danger,
    togglePin,
    openProfile,
    openArtifact: (...args) => artifact.openArtifactPath(...args),
  });

  /** On the workbench, the conversation whose settings are open beside it. */
  const settingsBeside = () => (wide() ? settingsSide(workbench.layout) : null);
  const draftSession = () => {
    const beside = settingsBeside();
    return beside ? (sessionsById().get(beside.sessionId) ?? null) : selected();
  };
  effect(() => {
    const session = draftSession();
    if (!session) {
      untracked(() => {
        if (groupDetail().sessionId !== null) groupDetail.set({ ...groupDetail(), sessionId: null });
        if (shouldDropConfirm("no-session", danger.dangerConfirm)) danger.clearDanger("group", "history");
      });
      return;
    }
    if (untracked(groupDetail).sessionId === session.id) return;
    untracked(() => {
      groupDetail.set({ sessionId: session.id, name: session.kind === "group" ? (session.name ?? "") : "", nameError: undefined, failed: false, pullPick: "" });
      if (shouldDropConfirm("session-changed", danger.dangerConfirm)) danger.clearDanger("group", "history");
    });
  });
  effect(() => {
    if (!runtime.sessionSettingsOpen && !settingsBeside()) {
      untracked(() => {
        if (shouldDropConfirm("session-settings-closed", danger.dangerConfirm)) danger.clearDanger("bot", "group", "history");
      });
    }
  });
  effect(() => {
    if (!runtime.settingsOpen) {
      untracked(() => {
        providerEditor.set(null);
        if (shouldDropConfirm("settings-closed", danger.dangerConfirm)) danger.clearDanger("provider");
      });
      return;
    }
    const pending = untracked(() => danger.dangerConfirm);
    if (pending?.providerId && !snapshot().providers.some((row) => row.id === pending.providerId)) danger.dangerConfirm = null;
  });
  // A different Bot or session, or a closed drawer: back to the list of sections.
  effect(() => {
    void runtime.profileBotId;
    void runtime.selectedId;
    void runtime.sessionSettingsOpen;
    untracked(() => paneMobileDetail.set(false));
  });

  function closeSettings(): void {
    providerEditor.set(null);
    danger.clearDanger("provider");
    runtime.settingsOpen = false;
  }

  async function patchImmediate(patch: { locale?: "zh" | "en"; theme?: "system" | "light" | "dark"; launch_at_login?: boolean }): Promise<boolean> {
    saveFailed.set(false);
    const error = await runtime.patchSettings(patch);
    if (error) saveFailed.set(true);
    return !error;
  }

  function togglePaneSettings(sessionId: string): void {
    if (danger.dangerConfirm?.source !== "menu") danger.clearDanger("bot");
    profileFailed.set(false);
    workbench.commitLayout(toggleChatSide(workbench.layout, sessionId, { kind: "settings", botId: null }, { id: workbench.freshPaneId }));
  }
  function closePaneSide(sessionId: string): void {
    workbench.commitLayout(closeChatSide(workbench.layout, sessionId));
  }
  function toggleSessionSettings(): void {
    if (runtime.sessionSettingsOpen) {
      runtime.closeSessionSettings();
      return;
    }
    if (selectedKind() === "you-bot" && selectedPeerBot()) {
      openProfile(selectedPeerBot()!.id);
      return;
    }
    runtime.openSessionSettings();
  }
  function closeCurrentDrawerScreen(): void {
    if (nestedProfile() && narrow()) {
      runtime.closeSessionSettings();
      return;
    }
    if (paneMobileDetail()) {
      paneMobileDetail.set(false);
      return;
    }
    if (nestedProfile()) {
      closeNestedProfile();
      return;
    }
    runtime.closeSessionSettings();
  }

  function jumpToTrace(sessionId: string, messageId: string): void {
    void runtime.selectSession(sessionId, { messageId });
  }
  function jumpFromTracePage(sessionId: string, messageId: string): void {
    runtime.closeTrace();
    jumpToTrace(sessionId, messageId);
  }

  // The Bot↔Bot popup steps aside for what opens under it (ADR 0091).
  let openUnderBotDm = "";
  effect(() => {
    const opened = [runtime.traceOpen, artifact.artifactPreview !== null, runtime.sessionSettingsOpen, runtime.workspaceOpen].map((on) => (on ? "1" : "0")).join("");
    const before = openUnderBotDm;
    openUnderBotDm = opened;
    if (untracked(() => runtime.botDmSessionId) && [...opened].some((bit, i) => bit === "1" && before[i] === "0")) runtime.closeBotDm();
  });

  // --- onboarding ---
  const dismissedOnboarding = signal(false);
  const onboardingHeld = signal(false);
  const showOnboarding = () => (!snapshot().settings.wizard_complete || onboardingHeld()) && !dismissedOnboarding();

  // --- search ---
  const searchOpen = signal(false);
  function searchBlocked(): boolean {
    return Boolean(
      showOnboarding() ||
        danger.dangerConfirm ||
        runtime.createBotOpen ||
        runtime.createGroupOpen ||
        runtime.createProjectOpen ||
        providerEditor() ||
        danger.confirmingIndependent,
    );
  }
  function openGlobalSearch(): void {
    if (searchOpen()) return;
    if (searchBlocked()) return;
    batch(() => {
      toolsMenuOpen.set(false);
      createMenuOpen.set(false);
      sessionMenu.contextMenu = null;
      runtime.closeSearch();
      searchOpen.set(true);
    });
  }
  function closeGlobalSearch(): boolean {
    if (!searchOpen()) return false;
    searchOpen.set(false);
    runtime.closeSearch();
    return true;
  }
  function selectSearchHit(hit: SearchHit): void {
    const jump = searchJump(hit, snapshot().sessions, snapshot().routines, snapshot().bots);
    const path = hit.kind === "file" ? hit.path : null;
    if (!path && !jump) return;
    closeGlobalSearch();
    const open = () => {
      closeSettings();
      if (!wide()) {
        runtime.closeSessionSettings();
        runtime.closeTerminal();
        runtime.closeRemoteScreen();
        runtime.closeTrace();
        runtime.threadOpen = false;
      }
      if (path) artifact.openArtifactPath(path);
      else if (jump && "routineId" in jump) void runtime.openRoutine(jump.botId, jump.routineId);
      else if (jump) void runtime.selectSession(jump.sessionId, { messageId: jump.messageId });
    };
    if (wide()) open();
    else artifact.guardNotificationNavigation(open);
  }

  // --- the phone's list pages and bottom bar ---
  const phoneList = signal<"bots" | "projects">(readPhoneList());
  effect(() => {
    const list = phoneList();
    try {
      localStorage.setItem(PHONE_LIST_KEY, list);
    } catch {
      // Blocked storage: the page opens on the Bots next time.
    }
  });
  effect(() => {
    const kind = selected()?.kind;
    if (!kind) return;
    untracked(() => phoneList.set(kind === "project" ? "projects" : "bots"));
  });
  const mobileDestination = (): MobileDestination => (runtime.settingsOpen ? "settings" : phoneList() === "projects" ? "projects" : "sessions");
  function navigateMobile(destination: MobileDestination): void {
    if (destination === mobileDestination()) return;
    const navigate = () => {
      toolsMenuOpen.set(false);
      createMenuOpen.set(false);
      closeGlobalSearch();
      if (destination === "settings") {
        runtime.openSettings();
      } else {
        closeSettings();
        runtime.closeWorkspace();
        runtime.selectedId = null;
        phoneList.set(destination === "projects" ? "projects" : "bots");
      }
    };
    if (runtime.workspaceOpen && workspacePane) workspacePane.requestCloseFromParent(navigate);
    else navigate();
  }
  const mobileNavigationVisible = () =>
    !searchOpen() &&
    !runtime.routinesOpen &&
    !runtime.spendOpen &&
    !runtime.terminalOpen &&
    !runtime.screenOpen &&
    !runtime.createBotOpen &&
    !runtime.createGroupOpen &&
    !runtime.createProjectOpen &&
    !runtime.sessionSettingsOpen &&
    !runtime.profileBotId &&
    !danger.dangerConfirm &&
    (runtime.settingsOpen ? !mobileSettingsDetail() && !providerEditor() : !runtime.workspaceOpen && !selected() && !artifact.artifactPreview);

  /**
   * One step out of whatever is on top (the phone's Back first, Escape the same order). True:
   * handled here, a layer closed or refused to; false: the screen is history's, Back walks it.
   */
  function backMobileLayer(): boolean {
    if (closeFullscreenPreview()) return true;
    switch (
      topLayer({
        imageOpen: imageEnlarged(),
        messageTextOpen: messageTextOpen(),
        toolsMenuOpen: toolsMenuOpen(),
        createMenuOpen: createMenuOpen(),
        dangerConfirm: danger.dangerConfirm !== null,
        createBotOpen: runtime.createBotOpen,
        createGroupOpen: runtime.createGroupOpen,
        createProjectOpen: runtime.createProjectOpen,
        providerEditor: providerEditor() !== null,
        confirmingIndependent: danger.confirmingIndependent,
        searchOpen: searchOpen(),
        botDmOpen: botDmSession() !== null,
        settingsOpen: runtime.settingsOpen,
        sessionSettingsOpen: runtime.sessionSettingsOpen,
        terminalOpen: runtime.terminalOpen,
        screenOpen: runtime.screenOpen,
        listPageOpen: runtime.listPage !== null,
        traceOpen: runtime.traceOpen,
        routinesOpen: runtime.routinesOpen,
        spendOpen: runtime.spendOpen,
        threadOpen: runtime.threadOpen,
        workspaceOpen: runtime.workspaceOpen,
        artifactPreview: artifact.artifactPreview !== null,
      })
    ) {
      case "image":
        return closeEnlargedImage();
      case "message-text":
        return closeMessageText();
      case "tools-menu":
        toolsMenuOpen.set(false);
        return true;
      case "create-menu":
        createMenuOpen.set(false);
        return true;
      case "danger":
        if (danger.escapeDismissesDanger) danger.dismissDangerConfirm();
        return true;
      case "create-bot":
        runtime.createBotOpen = false;
        return true;
      case "create-project":
        runtime.createProjectOpen = false;
        return true;
      case "create-group":
        runtime.createGroupOpen = false;
        return true;
      case "provider-editor":
        settingsHandle?.backFromProviderEditor();
        return true;
      case "independent-confirm":
        return true;
      case "search":
        return closeGlobalSearch();
      case "bot-dm":
        runtime.closeBotDm();
        return true;
      case "settings":
        return settingsHandle?.backWithinSettings() ?? false;
      case "session-settings":
        if (profilePane?.backFromEditor()) return true;
        if (paneMobileDetail()) {
          paneMobileDetail.set(false);
          return true;
        }
        return false;
      case "trace":
        if (artifact.artifactPreview) {
          if (!previewPane?.closeFind()) {
            if (previewPane) previewPane.requestCloseFromParent();
            else artifact.closeArtifactPreview();
          }
          return true;
        }
        return false;
      case "thread":
        runtime.threadOpen = false;
        return true;
      case "workspace":
        if (workspacePane?.closeFind()) return true;
        if (workspacePane?.blocksClose()) {
          workspacePane.requestCloseFromParent();
          return true;
        }
        return false;
      case "preview":
        if (previewPane?.closeFind()) return true;
        if (previewPane?.blocksClose()) {
          previewPane.requestCloseFromParent();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** Back with no history left under it: a layer, else the screen showing closes to the one under it. */
  function backFromFloor(): boolean {
    if (backMobileLayer()) return true;
    if (runtime.settingsOpen) closeSettings();
    else if (runtime.sessionSettingsOpen && nestedProfile()) closeNestedProfile();
    else if (runtime.sessionSettingsOpen) runtime.closeSessionSettings();
    else if (runtime.terminalOpen) runtime.closeTerminal();
    else if (runtime.screenOpen) runtime.closeRemoteScreen();
    else if (runtime.listPage) runtime.listPage = null;
    else if (runtime.traceOpen) runtime.closeTrace();
    else if (runtime.routinesOpen) runtime.closeRoutines();
    else if (runtime.spendOpen) runtime.closeSpend();
    else if (runtime.workspaceOpen) runtime.closeWorkspace();
    else if (artifact.artifactPreview) artifact.closeArtifactPreview();
    else if (runtime.selectedId) runtime.selectedId = null;
    else return false;
    return true;
  }

  /** The window's Escape (Shell.svelte's `keydown`), after the open layers' own. True when used. */
  function escape(): boolean {
    if (closeFullscreenPreview()) return true;
    if (searchOpen()) return closeGlobalSearch();
    if (toolsMenuOpen()) toolsMenuOpen.set(false);
    else if (createMenuOpen()) createMenuOpen.set(false);
    else if (danger.escapeDismissesDanger) danger.dismissDangerConfirm();
    else if (runtime.createBotOpen) runtime.createBotOpen = false;
    else if (runtime.createGroupOpen) runtime.createGroupOpen = false;
    else if (runtime.createProjectOpen) runtime.createProjectOpen = false;
    else if (providerEditor()) settingsHandle?.backFromProviderEditor();
    else if (danger.confirmingIndependent) return true;
    else if (botDmSession()) runtime.closeBotDm();
    else if (runtime.settingsOpen) closeSettings();
    else if (runtime.sessionSettingsOpen && nestedProfile()) closeNestedProfile();
    else if (runtime.sessionSettingsOpen && profilePane?.backFromEditor()) return true;
    else if (runtime.sessionSettingsOpen) runtime.closeSessionSettings();
    else if (runtime.terminalOpen) runtime.closeTerminal();
    else if (runtime.screenOpen) runtime.closeRemoteScreen();
    else if (runtime.traceOpen && !artifact.artifactPreview) runtime.closeTrace();
    else if (runtime.routinesOpen) runtime.closeRoutines();
    else if (runtime.spendOpen) runtime.closeSpend();
    else if (runtime.workspaceOpen) {
      if (workspacePane?.closeFind()) return true;
      if (workspacePane) workspacePane.requestCloseFromParent();
      else runtime.closeWorkspace();
    } else if (artifact.artifactPreview) {
      if (previewPane?.closeFind()) return true;
      if (previewPane) previewPane.requestCloseFromParent();
      else artifact.closeArtifactPreview();
    } else return false;
    return true;
  }

  // The notification a person clicked opens its conversation, through the file guard.
  runtime.setNotificationIntentHandler((intent) => {
    artifact.guardNotificationNavigation(() => {
      runtime.applyNotificationIntent(intent);
    });
  });

  return {
    snapshot,
    t,
    botsById,
    visibleBots,
    sessionsById,
    titleOf,
    pinnedSessionIds,
    togglePin,
    shellWidth,
    shellHeight,
    narrow,
    wide,
    isMobile,
    sidebarPreferred,
    sidebarDragging,
    sidebarWidth,
    sidebarCollapsed,
    sidebarFrameWidth,
    sidebarRail,
    sidebarColumn,
    sidebarHidden,
    railWidth,
    toolsMenuOpen,
    createMenuOpen,
    setSidebarHandle: (h: { showArchived(): void } | null) => (sidebarHandle = h),
    toggleSidebar,
    openArchivedFromRail,
    resizeSidebar,
    endSidebarResize,
    selected,
    connected,
    selectedKind,
    botDmSession,
    selectedPeerBot,
    lockedComposer,
    profileBot,
    sessionSettingsLabel,
    nestedProfile,
    groupPresent,
    setPreviewPane: (h: PaneHandle | null) => (previewPane = h),
    setWorkspacePane: (h: PaneHandle | null) => (workspacePane = h),
    artifact,
    workbench,
    saveFailed,
    providerEditor,
    profileFailed,
    mobileSettingsDetail,
    paneMobileDetail,
    setSettingsHandle: (h: { backWithinSettings(): boolean; backFromProviderEditor(): void } | null) => (settingsHandle = h),
    setProfilePane: (h: { backFromEditor(): boolean } | null) => (profilePane = h),
    settingsEverOpened,
    groupDetail,
    danger,
    dangerConfirmCopy,
    sessionMenu,
    openProfile,
    closeNestedProfile,
    closeSettings,
    patchImmediate,
    togglePaneSettings,
    closePaneSide,
    toggleSessionSettings,
    closeCurrentDrawerScreen,
    settingsBeside,
    jumpToTrace,
    jumpFromTracePage,
    dismissedOnboarding,
    onboardingHeld,
    showOnboarding,
    searchOpen,
    openGlobalSearch,
    closeGlobalSearch,
    selectSearchHit,
    phoneList,
    mobileDestination,
    navigateMobile,
    mobileNavigationVisible,
    backMobileLayer,
    backFromFloor,
    escape,
    openCreateBot: () => runtime.openCreateBot(),
    openCreateGroup: () => runtime.openCreateGroup(),
    openCreateProject: () => runtime.openCreateProject(),
  };
}

export type ShellState = ReturnType<typeof createShellState>;
export type { Bot };
