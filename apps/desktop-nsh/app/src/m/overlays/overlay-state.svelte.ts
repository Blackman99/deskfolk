// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: 02081b86a48c2031
import { state } from "../../lib/reactive";
import type { Attachment, BuiltinModelRole, ProjectAgent } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import type { SessionView } from "../session-view.svelte.ts";
import type { UrlOverlay } from "../session-url.ts";
import type { PromptTarget } from "../settings/prompts-view.ts";
import { youBotSession } from "../sidebar/session-groups.ts";
import type { Snapshot } from "../snapshot.ts";
import { usageWidget } from "../usage/usage-widget.svelte.ts";
import type { PaneContent } from "../workbench/pane-content.ts";
import type { TraceFocus } from "./task-trace.ts";

/** Which view of a job to open, for which conversation, and a ticket for the board to pick. */
export type TraceOpenOptions = {
  /** A line filed under no job, opened as a flow of its own (ADR 0083). */
  line?: string | null;
  /** The conversation whose job it is; the one on screen when left out. */
  sessionId?: string;
  /** The ticket to pick as it opens: the one the message asking for its card was filed under. */
  ticket?: string | null;
};

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

/** What Roles is asked to show: a call, picked as its step (ADR 0085). */
/** Where Roles opens: on one call, and on one engine (a job's, from its title row). */
export type RolesTarget = { role: BuiltinModelRole | null; playbook?: string };

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
  #previewRelpath$s = state<string | null>(null);
	get previewRelpath(): string | null { return this.#previewRelpath$s.get(); }
	set previewRelpath(value: string | null) { this.#previewRelpath$s.set(value); }
  #previewMessageId$s = state<string | null>(null);
	get previewMessageId(): string | null { return this.#previewMessageId$s.get(); }
	set previewMessageId(value: string | null) { this.#previewMessageId$s.set(value); }
  #forceArtifactTree$s = state(false);
	get forceArtifactTree() { return this.#forceArtifactTree$s.get(); }
	set forceArtifactTree(value) { this.#forceArtifactTree$s.set(value); }
  #previewTaskId$s = state<string | null>(null);
	get previewTaskId(): string | null { return this.#previewTaskId$s.get(); }
	set previewTaskId(value: string | null) { this.#previewTaskId$s.set(value); }
  #previewSiblings$s = state<Attachment[] | null>(null);
	get previewSiblings(): Attachment[] | null { return this.#previewSiblings$s.get(); }
	set previewSiblings(value: Attachment[] | null) { this.#previewSiblings$s.set(value); }
  #settingsOpen$s = state(false);
	get settingsOpen() { return this.#settingsOpen$s.get(); }
	set settingsOpen(value) { this.#settingsOpen$s.set(value); }
  #createBotOpen$s = state(false);
	get createBotOpen() { return this.#createBotOpen$s.get(); }
	set createBotOpen(value) { this.#createBotOpen$s.set(value); }
  /** The new project session sheet (ADR 0095). */
  #createProjectOpen$s = state(false);
	get createProjectOpen() { return this.#createProjectOpen$s.get(); }
	set createProjectOpen(value) { this.#createProjectOpen$s.set(value); }
  /** What the project sheet is for (ADR 0095): a new session in a directory, or carrying a terminal session on. */
  #createProjectMode$s = state<"new" | "import">("new");
	get createProjectMode(): "new" | "import" { return this.#createProjectMode$s.get(); }
	set createProjectMode(value: "new" | "import") { this.#createProjectMode$s.set(value); }
  /** The agent the project sheet opens on (ADR 0099): the one whose "new" was chosen. */
  #createProjectAgent$s = state<ProjectAgent>("claude_code");
	get createProjectAgent(): ProjectAgent { return this.#createProjectAgent$s.get(); }
	set createProjectAgent(value: ProjectAgent) { this.#createProjectAgent$s.set(value); }
  #createGroupOpen$s = state(false);
	get createGroupOpen() { return this.#createGroupOpen$s.get(); }
	set createGroupOpen(value) { this.#createGroupOpen$s.set(value); }
  #sessionSettingsOpen$s = state(false);
	get sessionSettingsOpen() { return this.#sessionSettingsOpen$s.get(); }
	set sessionSettingsOpen(value) { this.#sessionSettingsOpen$s.set(value); }
  /** The job whose trace is open. Null while closed; an empty string asks for the session's latest. */
  #traceTaskId$s = state<string | null>(null);
	get traceTaskId(): string | null { return this.#traceTaskId$s.get(); }
	set traceTaskId(value: string | null) { this.#traceTaskId$s.set(value); }
  /** The session the trace was opened from. The chat can move on; the window stays on this job. */
  #traceSessionId$s = state<string | null>(null);
	get traceSessionId(): string | null { return this.#traceSessionId$s.get(); }
	set traceSessionId(value: string | null) { this.#traceSessionId$s.set(value); }
  /**
   * The message the open board should centre, and which request it was.
   *
   * The token climbs each time a message asks, so asking again for the card already on screen
   * still moves there. The header's board has neither.
   */
  #traceFocus$s = state<TraceFocus | null>(null);
	get traceFocus(): TraceFocus | null { return this.#traceFocus$s.get(); }
	set traceFocus(value: TraceFocus | null) { this.#traceFocus$s.set(value); }
  /** The line whose own flow the phone's trace page shows (ADR 0083); null for a job's. */
  #traceLine$s = state<string | null>(null);
	get traceLine(): string | null { return this.#traceLine$s.get(); }
	set traceLine(value: string | null) { this.#traceLine$s.set(value); }
  /** A call the Roles page should open on: a card's 「在设置里看」 about one of its prompts. */
  #rolesTarget$s = state<RolesTarget | null>(null);
	get rolesTarget(): RolesTarget | null { return this.#rolesTarget$s.get(); }
	set rolesTarget(value: RolesTarget | null) { this.#rolesTarget$s.set(value); }
  #traceFocusToken$s = state(0);
	get traceFocusToken() { return this.#traceFocusToken$s.get(); }
	set traceFocusToken(value) { this.#traceFocusToken$s.set(value); }
  #profileBotId$s = state<string | null>(null);
	get profileBotId(): string | null { return this.#profileBotId$s.get(); }
	set profileBotId(value: string | null) { this.#profileBotId$s.set(value); }
  #profileRoutineId$s = state<string | null>(null);
	get profileRoutineId(): string | null { return this.#profileRoutineId$s.get(); }
	set profileRoutineId(value: string | null) { this.#profileRoutineId$s.set(value); }
  #workspaceOpen$s = state(false);
	get workspaceOpen() { return this.#workspaceOpen$s.get(); }
	set workspaceOpen(value) { this.#workspaceOpen$s.set(value); }
  /** The roster calendar. It replaces the main column; it is not a fourth phone destination. */
  #routinesOpen$s = state(false);
	get routinesOpen() { return this.#routinesOpen$s.get(); }
	set routinesOpen(value) { this.#routinesOpen$s.set(value); }
  /** The spend ledger, same shape as the calendar: one pane on the desktop, a page below 680. */
  #spendOpen$s = state(false);
	get spendOpen() { return this.#spendOpen$s.get(); }
	set spendOpen(value) { this.#spendOpen$s.set(value); }
  /**
   * Settings asked to open on the prompts tab, and at one prompt's editor when there is one (a card's
   * 「在设置里看」); the prompts tab takes it once it shows.
   */
  #promptsTarget$s = state<{ prompt: PromptTarget | null } | null>(null);
	get promptsTarget(): { prompt: PromptTarget | null } | null { return this.#promptsTarget$s.get(); }
	set promptsTarget(value: { prompt: PromptTarget | null } | null) { this.#promptsTarget$s.set(value); }
  #workspaceSelected$s = state("");
	get workspaceSelected() { return this.#workspaceSelected$s.get(); }
	set workspaceSelected(value) { this.#workspaceSelected$s.set(value); }
  #threadOpen$s = state(false);
	get threadOpen() { return this.#threadOpen$s.get(); }
	set threadOpen(value) { this.#threadOpen$s.set(value); }
  #previewAttachmentId$s = state<string | null>(null);
	get previewAttachmentId(): string | null { return this.#previewAttachmentId$s.get(); }
	set previewAttachmentId(value: string | null) { this.#previewAttachmentId$s.set(value); }
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
    this.listPage = null;
    this.createProjectOpen = false;
    this.createBotOpen = true;
  }

  openCreateProject(mode: "new" | "import" = "new", agent: ProjectAgent = "claude_code"): void {
    this.openCreateBot();
    this.createBotOpen = false;
    this.createProjectMode = mode;
    this.createProjectAgent = agent;
    this.createProjectOpen = true;
  }

  openCreateGroup(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createProjectOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.listPage = null;
    this.createGroupOpen = true;
  }

  openSessionSettings(): void {
    if (this.host.selectedId && this.toPane({ kind: "chat", sessionId: this.host.selectedId, side: { kind: "settings", botId: null } })) return;
    this.profileNavigation++;
    this.profileRoutineId = null;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createProjectOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.listPage = null;
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

  #terminalOpen$s = state(false);
	get terminalOpen() { return this.#terminalOpen$s.get(); }
	set terminalOpen(value) { this.#terminalOpen$s.set(value); }

  /**
   * The phone's terminal page. A wide window still opens a pane; below the breakpoint this is a
   * page in the URL, the way the calendar is.
   */
  openTerminal(): void {
    void this.host.refreshTerminals();
    if (this.toPane({ kind: "terminal", terminalId: null })) return;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createProjectOpen = false;
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
    this.listPage = null;
    this.terminalOpen = true;
  }

  closeTerminal(): void {
    this.terminalOpen = false;
  }

  /**
   * The remote screen: the Mac's own screen on this phone, through macOS Screen Sharing. Only a
   * phone reaches its Mac this way, so it is a page in the URL and never a desktop pane.
   */
  #screenOpen$s = state(false);
	get screenOpen() { return this.#screenOpen$s.get(); }
	set screenOpen(value) { this.#screenOpen$s.set(value); }

  openRemoteScreen(): void {
    if (!this.host.remote) return;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createProjectOpen = false;
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
    this.listPage = null;
    this.screenOpen = true;
  }

  closeRemoteScreen(): void {
    this.screenOpen = false;
  }

  /**
   * A phone's page in place of the conversation list — usage or the archived conversations. A page
   * in the URL like the remote screen, so the phone's Back walks out of it to the list.
   */
  #listPage$s = state<"usage" | "archived" | "roles" | null>(null);
	get listPage(): "usage" | "archived" | "roles" | null { return this.#listPage$s.get(); }
	set listPage(value: "usage" | "archived" | "roles" | null) { this.#listPage$s.set(value); }

  openListPage(page: "usage" | "archived" | "roles"): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createProjectOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.clearTrace();
    this.threadOpen = false;
    this.listPage = page;
  }

  closeListPage(): void {
    this.listPage = null;
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

  /** Keep a line's own board current with its conversation (ADR 0083). Returns the function that stops watching. */
  watchLineBoard(sessionId: string): () => void {
    return this.watchTrace(`line:${sessionId}`);
  }

  /** A line's own board of this conversation is on screen. */
  lineBoardShows(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    return (this.traceOpen && this.traceLine !== null && this.traceSessionId === sessionId) || this.traceWatchers.has(`line:${sessionId}`);
  }

  /**
   * The Roles page (ADR 0083), at one call when a step asked for it: a tab on the workbench, else a
   * page in place of the list.
   */
  openRoles(role: BuiltinModelRole | null = null, playbook: string | null = null): void {
    this.rolesTarget = { role, ...(playbook ? { playbook } : {}) };
    if (this.toPane({ kind: "roles" })) return;
    this.openListPage("roles");
  }

  boardShows(taskId: string | null | undefined): boolean {
    if (!taskId) return false;
    return (this.traceOpen && taskId === this.traceTaskId) || this.traceWatchers.has(taskId);
  }

  /**
   * `taskId` null opens whatever job this session touched most recently.
   * `focus` is the message whose card the board should move to.
   *
   * On a wide window the job is the conversation's one flow tab (ADR 0086), `ticket` picked in it
   * when there is one; on a phone it is one page over the conversation.
   */
  openTrace(taskId: string | null = null, focus: TraceFocus | null = null, opts: TraceOpenOptions = {}): void {
    const sessionId = opts.sessionId ?? this.host.selectedId;
    if (!sessionId) return;
    const line = opts.line ?? null;
    const token = focus ? (this.traceFocusToken += 1) : 0;
    const ticket = line ? null : (opts.ticket ?? null);
    if (this.toPane({
      kind: "trace",
      sessionId,
      taskId,
      ...(line ? { line } : {}),
      focus,
      focusNonce: token || null,
      ticket,
      askNonce: ticket ? Date.now() : null,
    })) return;
    this.host.closeSheets();
    this.threadOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.listPage = null;
    this.traceSessionId = sessionId;
    this.traceTaskId = taskId ?? "";
    this.traceLine = line;
    this.traceFocus = focus;
    this.traceFocusToken = token;
  }

  closeTrace(): void {
    this.clearTrace();
  }

  private clearTrace(): void {
    this.traceTaskId = null;
    this.traceSessionId = null;
    this.traceLine = null;
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
    this.createProjectOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.listPage = null;
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
    this.createProjectOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.listPage = null;
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
    this.listPage = null;
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
    this.createProjectOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.listPage = null;
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
    this.createProjectOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.listPage = null;
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

  /**
   * Every agent's usage: a tab on the workbench, where the settings say. A wide window without one
   * opens the floating widget's panel instead; the phone's page is the sidebar's own.
   */
  openUsage(): void {
    if (!this.toPane({ kind: "usage" })) usageWidget.show();
  }

  /** Restore settings, the session drawer, or the workspace overlay from the URL. */
  applyOverlay(overlay: UrlOverlay): void {
    this.profileNavigation++;
    if (overlay.kind === "settings") {
      this.createBotOpen = false;
      this.createProjectOpen = false;
      this.createGroupOpen = false;
      this.host.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.listPage = null;
      this.settingsOpen = true;
      return;
    }
    if (overlay.kind === "session") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createProjectOpen = false;
      this.createGroupOpen = false;
      this.threadOpen = false;
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.listPage = null;
      this.profileBotId = null;
      this.sessionSettingsOpen = true;
      return;
    }
    if (overlay.kind === "bot") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createProjectOpen = false;
      this.createGroupOpen = false;
      this.threadOpen = false;
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.listPage = null;
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
      this.listPage = null;
      this.workspaceOpen = true;
      this.workspaceSelected = overlay.selected ?? "";
      return;
    }
    if (overlay.kind === "trace") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createProjectOpen = false;
      this.createGroupOpen = false;
      this.threadOpen = false;
      this.host.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.listPage = null;
      this.traceSessionId = this.traceSessionId ?? this.host.selectedId;
      this.traceTaskId = overlay.taskId ?? "";
      // The address names a job's board; a line's own board is only kept while no job is named.
      if (overlay.taskId) this.traceLine = null;
      return;
    }
    if (overlay.kind === "routines") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createProjectOpen = false;
      this.createGroupOpen = false;
      this.host.closeSessionSettings();
      this.workspaceOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.listPage = null;
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
      this.createProjectOpen = false;
      this.createGroupOpen = false;
      this.host.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.terminalOpen = false;
      this.screenOpen = false;
      this.listPage = null;
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
      this.createProjectOpen = false;
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
      this.listPage = null;
      this.terminalOpen = true;
      return;
    }
    if (overlay.kind === "screen") {
      this.host.openRemoteScreen();
      return;
    }
    if (overlay.kind === "usage" || overlay.kind === "archived" || overlay.kind === "roles") {
      this.openListPage(overlay.kind);
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
    this.listPage = null;
  }

  closeSheets(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createProjectOpen = false;
    this.createGroupOpen = false;
    this.host.closeSessionSettings();
    this.clearTrace();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.screenOpen = false;
    this.listPage = null;
  }
}
