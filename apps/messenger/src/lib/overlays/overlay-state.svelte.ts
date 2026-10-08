import type { Attachment } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import type { SessionView } from "../session-view.svelte.ts";
import type { UrlOverlay } from "../session-url.ts";
import type { PromptTarget } from "../settings/prompts-view.ts";
import { youBotSession } from "../sidebar/session-groups.ts";
import type { Snapshot } from "../snapshot.ts";
import type { PaneContent } from "../workbench/pane-content.ts";
import type { TraceFocus } from "./task-trace.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the conversation the
 * app is pointed at and the snapshot a routine link checks, whether this page is the phone side of
 * a link (only a phone opens the remote screen), the session machinery a routine link waits on,
 * the terminal list a terminal page reads first, and the openers and closers below as the runtime
 * answers to them — a component or a test can replace one on the runtime, and every opener that
 * closes another goes through that replacement, as it did when these were all one class.
 */
export interface OverlayStateHost {
  readonly selectedId: string | null;
  readonly remote: boolean;
  readonly snapshot: Snapshot;
  readonly api: MessengerApi | null;
  selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void>;
  sessionView(id: string): SessionView;
  refreshTerminals(): Promise<void>;
  closeSessionSettings(): void;
  closeSheets(): void;
  openProfile(botId: string): void;
  openSettings(): void;
  openRemoteScreen(): void;
}

/**
 * Which sheet, page or pane is open over or beside the chat — settings, the new-Bot and new-group
 * sheets, the session drawer and a Bot's profile, the trace board, the workspace, the calendar,
 * the spend ledger, the terminal page, the remote screen, the artifact preview — and every opener
 * and closer that keeps them from piling on each other, including restoring one from the URL.
 * `MessengerRuntime` forwards every field and method here under the same public names, and
 * reaches back in through {@link OverlayStateHost}.
 */
export class OverlayState {
  constructor(private readonly host: OverlayStateHost) {}

  /** Workspace-relative path of the open artifact preview, or null when the pane is closed. */
  previewRelpath = $state<string | null>(null);
  previewMessageId = $state<string | null>(null);
  forceArtifactTree = $state(false);
  previewTaskId = $state<string | null>(null);
  previewSiblings = $state<Attachment[] | null>(null);
  settingsOpen = $state(false);
  createBotOpen = $state(false);
  createGroupOpen = $state(false);
  sessionSettingsOpen = $state(false);
  /** The job whose trace is open. Null while closed; an empty string asks for the session's latest. */
  traceTaskId = $state<string | null>(null);
  /** The session the trace was opened from. The chat can move on; the window stays on this job. */
  traceSessionId = $state<string | null>(null);
  /**
   * The message the open board should centre, and which request it was.
   *
   * The token climbs each time a message asks, so asking again for the card already on screen
   * still moves there. The header's board has neither.
   */
  traceFocus = $state<TraceFocus | null>(null);
  traceFocusToken = $state(0);
  profileBotId = $state<string | null>(null);
  profileRoutineId = $state<string | null>(null);
  workspaceOpen = $state(false);
  /** The roster calendar. It replaces the main column; it is not a fourth phone destination. */
  routinesOpen = $state(false);
  /** The spend ledger, same shape as the calendar: one pane on the desktop, a page below 680. */
  spendOpen = $state(false);
  /**
   * Settings asked to open on the prompts tab, and at one prompt's editor when there is one (a card's
   * 「在设置里看」); the prompts tab takes it once it shows.
   */
  promptsTarget = $state<{ prompt: PromptTarget | null } | null>(null);
  workspaceSelected = $state("");
  threadOpen = $state(false);
  previewAttachmentId = $state<string | null>(null);
  private profileNavigation = 0;

  openCreateBot(): void {
    this.settingsOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.createBotOpen = true;
  }

  openCreateGroup(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.createGroupOpen = true;
  }

  openSessionSettings(): void {
    if (this.host.selectedId && this.toPane({ kind: "chat", sessionId: this.host.selectedId, side: { kind: "settings", botId: null } })) return;
    this.profileNavigation++;
    this.profileRoutineId = null;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.profileBotId = null;
    this.sessionSettingsOpen = true;
  }

  /** The model choice log is its own overlay, not a card inside the session panel. */
  /**
   * Where an "open this" goes.
   *
   * The desktop shell sets this while the workbench is on. Openers use panes rather than narrow
   * overlays; Spend also mirrors its active pane into the URL so history can restore it.
   */
  paneOpener: ((content: PaneContent) => void) | null = null;

  toPane(content: PaneContent): boolean {
    const open = this.paneOpener;
    if (!open) return false;
    open(content);
    return true;
  }

  terminalOpen = $state(false);

  /**
   * The phone's terminal page. A wide window still opens a pane; below the breakpoint this is a
   * page in the URL, the way the calendar is.
   */
  openTerminal(): void {
    void this.host.refreshTerminals();
    if (this.toPane({ kind: "terminal", terminalId: null })) return;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.clearTrace();
    this.threadOpen = false;
    this.previewRelpath = null;
    this.previewAttachmentId = null;
    this.previewTaskId = null;
    this.previewSiblings = null;
    void this.host.refreshTerminals();
    this.screenOpen = false;
    this.terminalOpen = true;
  }

  closeTerminal(): void {
    this.terminalOpen = false;
  }

  /**
   * The remote screen: the Mac's own screen on this phone, through macOS Screen Sharing. Only a
   * phone reaches its Mac this way, so it is a page in the URL and never a desktop pane.
   */
  screenOpen = $state(false);

  openRemoteScreen(): void {
    if (!this.host.remote) return;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.clearTrace();
    this.threadOpen = false;
    this.previewRelpath = null;
    this.previewAttachmentId = null;
    this.previewTaskId = null;
    this.previewSiblings = null;
    this.screenOpen = true;
  }

  closeRemoteScreen(): void {
    this.screenOpen = false;
  }

  /** Jobs whose board is on screen outside the narrow overlay — a workbench pane — by job. */
  traceWatchers = new Map<string, number>();

  /**
   * Keep a board shown outside the overlay current the way the overlay is: every turn and message
   * of its job reloads it, model choices and all. Returns the function that stops watching.
   */
  watchTrace(taskId: string): () => void {
    this.traceWatchers.set(taskId, (this.traceWatchers.get(taskId) ?? 0) + 1);
    return () => {
      const left = (this.traceWatchers.get(taskId) ?? 1) - 1;
      if (left > 0) this.traceWatchers.set(taskId, left);
      else this.traceWatchers.delete(taskId);
    };
  }

  boardShows(taskId: string | null | undefined): boolean {
    if (!taskId) return false;
    return (this.traceOpen && taskId === this.traceTaskId) || this.traceWatchers.has(taskId);
  }

  /**
   * `taskId` null opens whatever job this session touched most recently.
   * `focus` is the message whose card the board should move to.
   */
  openTrace(taskId: string | null = null, focus: TraceFocus | null = null): void {
    if (!this.host.selectedId) return;
    const token = focus ? (this.traceFocusToken += 1) : 0;
    if (this.toPane({
      kind: "trace",
      sessionId: this.host.selectedId,
      taskId,
      focus,
      focusNonce: token || null,
    })) return;
    this.host.closeSheets();
    this.threadOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.traceSessionId = this.host.selectedId;
    this.traceTaskId = taskId ?? "";
    this.traceFocus = focus;
    this.traceFocusToken = token;
  }

  closeTrace(): void {
    this.clearTrace();
  }

  private clearTrace(): void {
    this.traceTaskId = null;
    this.traceSessionId = null;
    this.traceFocus = null;
  }

  get traceOpen(): boolean {
    return this.traceTaskId !== null;
  }

  async openRoutine(botId: string, routineId: string): Promise<void> {
    let navigation = ++this.profileNavigation;
    if (!this.host.snapshot.bots.some((bot) => bot.id === botId)) return;
    // The profile URL needs the selected conversation's navigation to settle first.
    if (!this.host.selectedId) {
      const session = youBotSession(this.host.snapshot.sessions, botId);
      if (!session) return;
      const api = this.host.api;
      const loading = this.host.selectSession(session.id);
      navigation = this.profileNavigation;
      const view = this.host.sessionView(session.id);
      const selection = view.loadSeq;
      await loading;
      if (this.host.api !== api || this.host.selectedId !== session.id || view.loadSeq !== selection ||
        this.profileNavigation !== navigation) return;
    }
    if (!this.host.snapshot.bots.some((bot) => bot.id === botId)) return;
    this.host.openProfile(botId);
    this.profileRoutineId = routineId;
  }

  openProfile(botId: string): void {
    if (this.host.selectedId && this.toPane({ kind: "chat", sessionId: this.host.selectedId, side: { kind: "settings", botId } })) return;
    this.profileNavigation++;
    this.profileRoutineId = null;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.profileBotId = botId;
    this.sessionSettingsOpen = true;
  }

  closeProfile(): void {
    this.profileNavigation++;
    this.profileRoutineId = null;
    this.profileBotId = null;
  }

  closeSessionSettings(): void {
    this.profileNavigation++;
    this.profileRoutineId = null;
    this.sessionSettingsOpen = false;
    this.profileBotId = null;
  }

  /** The settings panel loads its own device list, from wherever it was opened; see the card. */
  openSettings(): void {
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.settingsOpen = !this.settingsOpen;
  }

  /** Settings at the prompts tab, and at one prompt's history when the card knows which (ADR 0064). */
  openPromptSettings(prompt: PromptTarget | null): void {
    if (!this.settingsOpen) this.host.openSettings();
    this.promptsTarget = { prompt };
  }

  openWorkspace(selected?: string | null): void {
    if (this.toPane({ kind: "workspace", selected: selected ?? null })) return;
    this.settingsOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.workspaceOpen = true;
    if (selected) this.workspaceSelected = selected;
  }

  closeWorkspace(): void {
    this.workspaceOpen = false;
  }

  /**
   * Open the roster calendar. The caller has already settled an unsaved workspace file.
   * A preview open beside the chat would cover the grid, so it goes too.
   */
  openRoutines(): void {
    if (this.toPane({ kind: "routines" })) return;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.clearTrace();
    this.threadOpen = false;
    this.previewRelpath = null;
    this.previewAttachmentId = null;
    this.previewTaskId = null;
    this.previewSiblings = null;
    this.routinesOpen = true;
  }

  closeRoutines(): void {
    this.routinesOpen = false;
  }

  /** The spend ledger. One pane, like the calendar; below the breakpoint it is a page. */
  openSpend(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.clearTrace();
    this.threadOpen = false;
    this.previewRelpath = null;
    this.previewAttachmentId = null;
    this.previewTaskId = null;
    this.previewSiblings = null;
    this.spendOpen = true;
    this.toPane({ kind: "spend" });
  }

  closeSpend(): void {
    this.spendOpen = false;
  }

  /** Restore settings, the session drawer, or the workspace overlay from the URL. */
  applyOverlay(overlay: UrlOverlay): void {
    this.profileNavigation++;
    if (overlay.kind === "settings") {
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.host.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.settingsOpen = true;
      return;
    }
    if (overlay.kind === "session") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.threadOpen = false;
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.profileBotId = null;
      this.sessionSettingsOpen = true;
      return;
    }
    if (overlay.kind === "bot") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.threadOpen = false;
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.profileBotId = overlay.botId;
      this.sessionSettingsOpen = true;
      return;
    }
    if (overlay.kind === "workspace") {
      this.settingsOpen = false;
      this.createGroupOpen = false;
      this.host.closeSessionSettings();
      this.clearTrace();
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.workspaceOpen = true;
      this.workspaceSelected = overlay.selected ?? "";
      return;
    }
    if (overlay.kind === "trace") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.threadOpen = false;
      this.host.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.traceSessionId = this.traceSessionId ?? this.host.selectedId;
      this.traceTaskId = overlay.taskId ?? "";
      return;
    }
    if (overlay.kind === "routines") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.host.closeSessionSettings();
      this.workspaceOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.clearTrace();
        this.threadOpen = false;
      this.previewRelpath = null;
      this.previewAttachmentId = null;
      this.previewTaskId = null;
      this.previewSiblings = null;
      this.routinesOpen = true;
      return;
    }
    if (overlay.kind === "spend") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.host.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.clearTrace();
      this.threadOpen = false;
      this.previewRelpath = null;
      this.previewAttachmentId = null;
      this.previewTaskId = null;
      this.previewSiblings = null;
      this.spendOpen = true;
      return;
    }
    if (overlay.kind === "terminal") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.host.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.clearTrace();
      this.threadOpen = false;
      this.previewRelpath = null;
      this.previewAttachmentId = null;
      this.previewTaskId = null;
      this.previewSiblings = null;
      this.screenOpen = false;
      this.terminalOpen = true;
      return;
    }
    if (overlay.kind === "screen") {
      this.host.openRemoteScreen();
      return;
    }
    this.settingsOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.clearTrace();
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
  }

  closeSheets(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.clearTrace();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
  }
}
