import {
  USER_MEMBER,
  type Attachment,
  type ClientEvent,
  type SequencedEvent,
  type CreateBotRequest,
  type CreateGroupRequest,
  type PatchMemoryRequest,
  type CreateProviderRequest,
  type PatchProviderRequest,
  type ProbeModelsResponse,
  type ResolveApprovalRequest,
  type ComposerSuggestion,
  type SearchHit,
  type SessionDetail,
  type SettingsPatch,
  type ThinkingLevel,
  type CreateSkillRequest,
  type PatchSkillRequest,
  type CreateRoutineRequest,
  type PatchRoutineRequest,
  type RuntimeSnapshot,
  type StreamFrame,
  type Terminal,
  type ToolFrame,
} from "@real-bot/protocol";
import { ApiError, probeHealth } from "./api.ts";
import { copyFor } from "./copy.ts";
import { CommandActivity } from "./chat/command-activity.ts";
import { parseStreamFrame, parseToolFrame } from "./ephemeral-frames.ts";
import type { LocalEndpoint } from "./discovery.ts";
import { classifyHealth } from "./health.ts";
import { collectUntilMessage } from "./sidebar/search-jump.ts";
import { classifySession, youBotSession } from "./sidebar/session-groups.ts";
import { applyEvent, emptySnapshot, fromRuntimeSnapshot, type Snapshot } from "./snapshot.ts";
import { EventSync } from "./event-sync.ts";
import { SessionView } from "./session-view.svelte.ts";
import type { PaneContent } from "./workbench/pane-content.ts";
import { SvelteMap } from "svelte/reactivity";
import { stopTarget } from "./chat/transcript.ts";
import type { UrlOverlay } from "./session-url.ts";
import { HOSTED_MESSENGER } from "./remote/mode.ts";
import type { LocalApi } from "./local-api.ts";
import { confirmPairing, listHostDevices, openPairing, readPairing, removeHostDevice, type HostDevice } from "./remote/pairing-host.ts";
import type { MessengerApi } from "./messenger-api.ts";
import { RemoteApi, type DurablePendingRequest, type RemoteDeviceRow, type RemoteDiagnostics, type RemoteMaintenanceStatus } from "./remote/api.ts";
import { loadEnrollment, type StoredEnrollment } from "./remote/idb.ts";
import { pairFromQr, type PairingProgress } from "./remote/pairing.ts";
import { disablePush, enablePush, isInboxMessage, pushPermission, refreshPush, type DisablePushResult, type PushPermission } from "./remote/push.ts";
import { readTauriInternals } from "./tauri.ts";
import type {
  AskDraftRecord,
  NativeFocusFacts,
  NativeNotificationCapabilities,
  NotificationCapabilities,
  NotificationDevice,
  NotificationDevicePatch,
  NotificationFilter,
  NotificationIntent,
  NotificationItem,
  NotificationPermissionStateDto,
  NotificationPolicy,
  NotificationPolicyPatch,
  NotificationSummary,
  NotificationViewReport,
  PushRecovery,
  PushStateV2,
  PushTransport,
  SendAskResult,
} from "./notifications/types.ts";
import {
  EMPTY_NATIVE_CAPABILITIES,
  EMPTY_NOTIFICATION_CAPABILITIES,
  EMPTY_NOTIFICATION_SUMMARY,
} from "./notifications/types.ts";
import {
  parseNotificationCapabilities,
  parseNotificationPolicy,
  parseNotificationSummary,
} from "./notifications/parse.ts";
import {
  acceptFirstPage,
  acceptMore,
  applySummary,
  beginInboxLoad,
  beginMore,
  emptyInbox,
  markLocalRead,
  rejectInboxLoad,
  removeInboxItem,
  upsertInboxItem,
  type InboxReplayEvent,
  type InboxState,
} from "./notifications/inbox-state.ts";
import {
  askSubmitAllowed,
  classifySendAskFailure,
  clearAskIfMatching,
  nextDraftVersion,
  recordAskError,
} from "./notifications/ask-state.ts";
import {
  TAB_CHANNEL,
  TAB_LOCK_NAME,
  TAKEOVER_MS,
  type TabControlMessage,
  type TabRole,
  isTabControlMessage,
  supportsWebLocks,
} from "./notifications/tab-owner.ts";

/**
 * `connecting` is a real state, not a flavour of `disconnected`: a page that is still trying
 * should not accuse the Mac of being unreachable, and one that has been trying for a while
 * should not pretend it is still about to work.
 */
export type Connection = "connecting" | "connected" | "disconnected";
export type HostUnreachable = "runtime" | "host";
export type DraftReconnect = { draft: string; confirm: boolean } | null;

const RETRY_MS = 1000;
/**
 * A remote retry is a WebSocket handshake at the relay, and the relay allows ten per minute from
 * one address. Retrying every second during a host outage spends that budget in ten seconds and
 * then gets refused for the rest of the minute — the harder the device tries, the longer it takes
 * to come back once the Mac is up. So remote attempts back off, with jitter so several devices on
 * one address do not line up, and reset the moment a connection succeeds.
 */
const REMOTE_RETRY_MIN_MS = 1000;
const REMOTE_RETRY_MAX_MS = 20_000;

export function nextRemoteRetry(previous: number, random = Math.random): number {
  const grown = Math.min(previous * 2, REMOTE_RETRY_MAX_MS);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(grown * jitter, REMOTE_RETRY_MAX_MS));
}
/** A pairing window lasts ten minutes; checking it every three seconds is not a busy loop. */
const HOST_PAIRING_POLL_MS = 3000;
/** Attempts that still read as "connecting" before the page says the host cannot be reached. */
const CONNECTING_ATTEMPTS = 3;

export type HostPairing =
  | null
  | { phase: "offer"; pairingId: string; code: string; expiresUnix: number; fingerprint: string }
  | {
      phase: "confirm";
      pairingId: string;
      code: string;
      expiresUnix: number;
      fingerprint: string;
      name: string;
      deviceFingerprint: string;
      challenge: string;
    }
  | { phase: "paired"; deviceId: string }
  | { phase: "failed"; error: string };

export class MessengerRuntime {
  connection = $state<Connection>("connecting");
  /** Consecutive failed attempts since the last connection; the first few are still "connecting". */
  private connectFailures = 0;
  snapshot = $state<Snapshot>(emptySnapshot());
  private selectedIdValue = $state<string | null>(null);
  /**
   * The conversation the app is pointed at. Setting it makes its view first: everything below
   * reads through `activeView`, so a view that arrived late would leave the first read of a draft
   * or a loading flag looking at the empty defaults.
   */
  get selectedId(): string | null { return this.selectedIdValue; }
  set selectedId(value: string | null) {
    if (value) this.sessionView(value);
    this.selectedIdValue = value;
  }
  /**
   * Every conversation that is open, by id. Today exactly one is, because only the selected
   * session gets a view; panes will keep several. Reactive because the accessors below read
   * through it, and a view created after an effect first ran must wake that effect.
   */
  private readonly views = new SvelteMap<string, SessionView>();

  /** The view for a session, made on first use. */
  sessionView(id: string): SessionView {
    let view = this.views.get(id);
    if (!view) {
      view = new SessionView(id);
      this.views.set(id, view);
    }
    return view;
  }

  /** The conversation the app is pointed at, or null when none is. */
  get activeView(): SessionView | null {
    return this.selectedId ? (this.views.get(this.selectedId) ?? null) : null;
  }

  /**
   * The fields below used to be plain state on this class, one slot each, which is what made a
   * second open conversation impossible. They now live on the view and are forwarded here under
   * their old names so that every caller — the composer, the stage, the sidebar, the URL effects —
   * kept working untouched when they moved.
   */
  get draft(): string { return this.activeView?.draft ?? ""; }
  set draft(value: string) { const view = this.activeView; if (view) view.draft = value; }

  get replyingToId(): string | null { return this.activeView?.replyingToId ?? null; }
  set replyingToId(value: string | null) { const view = this.activeView; if (view) view.replyingToId = value; }

  get focusedTurnId(): string | null { return this.activeView?.focusedTurnId ?? null; }
  set focusedTurnId(value: string | null) { const view = this.activeView; if (view) view.focusedTurnId = value; }

  get highlightedMessageId(): string | null { return this.activeView?.highlightedMessageId ?? null; }
  set highlightedMessageId(value: string | null) { const view = this.activeView; if (view) view.highlightedMessageId = value; }

  get searchHighlightToken(): number { return this.activeView?.searchHighlightToken ?? 0; }
  set searchHighlightToken(value: number) { const view = this.activeView; if (view) view.searchHighlightToken = value; }

  get composerSuggestions(): ComposerSuggestion[] { return this.activeView?.composerSuggestions ?? []; }
  set composerSuggestions(value: ComposerSuggestion[]) { const view = this.activeView; if (view) view.composerSuggestions = value; }

  get historyLoading(): boolean { return this.activeView?.historyLoading ?? false; }
  set historyLoading(value: boolean) { const view = this.activeView; if (view) view.historyLoading = value; }

  get olderLoading(): boolean { return this.activeView?.olderLoading ?? false; }
  set olderLoading(value: boolean) { const view = this.activeView; if (view) view.olderLoading = value; }

  private get sessionMessageNext(): string | null { return this.activeView?.messageNext ?? null; }
  private set sessionMessageNext(value: string | null) { const view = this.activeView; if (view) view.messageNext = value; }

  private get sessionDetailId(): string | null {
    const view = this.activeView;
    return view?.detailLoaded ? view.sessionId : null;
  }
  private set sessionDetailId(value: string | null) {
    const view = this.activeView;
    if (view) view.detailLoaded = value === view.sessionId;
  }
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
  routeLogOpen = $state(false);
  /** The job whose trace is open. Null while closed; an empty string asks for the session's latest. */
  traceTaskId = $state<string | null>(null);
  /** The session the trace was opened from. The chat can move on; the window stays on this job. */
  traceSessionId = $state<string | null>(null);
  /** Bumped when a turn or message of the open job changes, so the trace pulls again. */
  traceReload = $state(0);
  routesLoading = $state(false);
  profileBotId = $state<string | null>(null);
  profileRoutineId = $state<string | null>(null);
  workspaceOpen = $state(false);
  /** The roster calendar. It replaces the main column; it is not a fourth phone destination. */
  routinesOpen = $state(false);
  workspaceSelected = $state("");
  threadOpen = $state(false);
  searchQuery = $state("");
  searchHits = $state<SearchHit[]>([]);
  busy = $state(false);
  pendingMutation = $state<{ id: string; code: string } | null>(null);
  workspacePath = $state("");
  endpointUrl = $state("");
  endpointKey = $state("");
  endpointModelsText = $state("");
  endpointDefaultModel = $state("");
  previewAttachmentId = $state<string | null>(null);
  hosted = HOSTED_MESSENGER;
  pairing = $state<PairingProgress>({ phase: "scan" });
  pairingBusy = $state(false);
  /** Host side of pairing: what the settings panel shows while a device is being enrolled. */
  hostPairing = $state<HostPairing>(null);
  hostPairingBusy = $state(false);
  hostDevices = $state<HostDevice[]>([]);
  hostDevicesBusy = $state(false);
  hostDevicesError = $state<string | null>(null);
  hostRemoveDeviceId = $state<string | null>(null);
  /** How long to wait before the next relay handshake; grows while the Mac is unreachable. */
  private remoteRetryMs = REMOTE_RETRY_MIN_MS;
  enrolled = $state(false);
  hostUnreachable = $state<HostUnreachable>("runtime");
  draftReconnect = $state<DraftReconnect>(null);
  remoteStatus = $state<RuntimeSnapshot["remoteStatus"] | null>(null);
  uvReady = $state(false);
  uvError = $state<string | null>(null);
  maintenance = $state<RemoteMaintenanceStatus | null>(null);
  maintenanceBusy = $state(false);
  maintenanceError = $state<string | null>(null);
  maintenanceForceConfirm = $state(false);
  maintenanceStopConfirm = $state(false);
  maintenanceRevokeId = $state<string | null>(null);
  pushEnabled = $state(false);
  pushBusy = $state(false);
  pushError = $state<string | null>(null);
  pushErrorCode = $state<string | null>(null);
  pushPermission = $state<PushPermission>("unsupported");

  notificationSummary = $state<NotificationSummary>(EMPTY_NOTIFICATION_SUMMARY);
  notificationPolicy = $state<NotificationPolicy | null>(null);
  notificationDevice = $state<NotificationDevice | null>(null);
  notificationCapabilities = $state<NotificationCapabilities>(EMPTY_NOTIFICATION_CAPABILITIES);
  nativeCapabilities = $state<NativeNotificationCapabilities>(EMPTY_NATIVE_CAPABILITIES);
  notificationInboxState = $state<InboxState>(emptyInbox());
  pushTransport = $state<PushTransport>("legacy");
  pushSubscribed = $state(false);
  pushRecovery = $state<PushRecovery>("none");
  remoteGated = $state(false);
  get isDesktopShell(): boolean {
    return !HOSTED_MESSENGER && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  }
  askDrafts = $state<Map<string, AskDraftRecord>>(new Map());
  instanceId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  tabRole = $state<TabRole>("single");
  tabTakeoverTimeout = $state(false);
  nativeFocusFacts = $state<NativeFocusFacts>({
    visible: false,
    focused: false,
    minimized: false,
    effectiveFocused: false,
  });
  private tabChannel: BroadcastChannel | null = null;
  private releaseLock: (() => void) | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  private api: MessengerApi | null = null;
  /**
   * The read each conversation has already put on record, session id to message id. One slot for
   * the whole app was enough while only one conversation could be on screen; with several, the
   * second one's read landed on the first one's slot and was swallowed.
   */
  private readonly boundedReadSent = new Map<string, string>();
  private ws: WebSocket | null = null;
  /**
   * The readers of each live stream id — a terminal session, or a Bot's running command. A set
   * rather than one sink: the same terminal can be shown in two places at once, and a second
   * reader used to replace the first silently instead of joining it.
   */
  private readonly streamSinks = new Map<string, Set<(frame: StreamFrame) => void>>();
  /**
   * What the Bots' commands are printing right now. Not `$state` itself — it is a plain map that
   * a frame mutates many times a second; {@link activityRevision} is what the view watches.
   */
  readonly activity = new CommandActivity();
  activityRevision = $state(0);
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the loop owes its next attempt. A wake-up may bring the timer here, never past it. */
  private nextAttemptAt = 0;
  private ticking = false;
  private stopped = false;
  private searchSeq = 0;
  private pendingFocusTrigger: string | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private routesInFlight: string | null = null;
  private suggestAbort: AbortController | null = null;
  private suggestTimer: ReturnType<typeof setTimeout> | null = null;
  private suggestSeq = 0;
  private sync: EventSync | null = null;
  private sessionLoad = Promise.resolve();
  /**
   * Bumped when the connection is replaced. The per-conversation counters say "a newer read of
   * this conversation started"; this one says "every read in flight belongs to a dead socket".
   * They were one counter, which is why loading a second conversation cancelled the first.
   */
  private connectionSeq = 0;
  private profileNavigation = 0;
  private durablePending: DurablePendingRequest[] = [];
  private notificationIntentHandler: ((intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }) => void) | null = null;

  start(): void {
    if (this.timer) clearTimeout(this.timer);
    this.stopped = false;
    this.pushPermission = pushPermission();
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", this.onPushMessage);
    }
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = setInterval(() => {
      void this.sendPresenceHeartbeat();
      if (this.isDesktopShell) void this.pollDesktopNativeState();
    }, 5000);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", this.onWindowFocus);
      window.addEventListener("blur", this.onWindowBlur);
      window.addEventListener("online", this.onNetworkOnline);
      document.addEventListener("visibilitychange", this.onWindowVisibility);
    }
    this.pump();
  }

  destroy(): void {
    this.stopped = true;
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    this.releaseLock?.();
    this.releaseLock = null;
    this.tabChannel?.close();
    this.tabChannel = null;
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.removeEventListener("message", this.onPushMessage);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", this.onWindowFocus);
      window.removeEventListener("blur", this.onWindowBlur);
      window.removeEventListener("online", this.onNetworkOnline);
      document.removeEventListener("visibilitychange", this.onWindowVisibility);
    }
    this.markDisconnected();
    if (this.timer) clearTimeout(this.timer);
    this.clearHighlightTimer();
    this.cancelComposerSuggestions();
  }

  get client(): MessengerApi | null {
    return this.api;
  }

  get remote(): boolean {
    return this.api?.kind === "remote" || (HOSTED_MESSENGER && this.connection !== "connected");
  }

  openCreateBot(): void {
    this.settingsOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.createBotOpen = true;
  }

  openCreateGroup(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.createGroupOpen = true;
  }

  openSessionSettings(): void {
    if (this.selectedId && this.toPane({ kind: "session-settings", sessionId: this.selectedId, botId: null })) return;
    this.profileNavigation++;
    this.profileRoutineId = null;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.profileBotId = null;
    this.sessionSettingsOpen = true;
  }

  /** The model choice log is its own overlay, not a card inside the session panel. */
  /**
   * Where an "open this" goes.
   *
   * The desktop shell sets this while the workbench is on, and every opener below asks it first.
   * One branch point rather than a condition inside each of them: with a dozen call sites the
   * rule "the desktop never sets those flags" has to be enforceable, not merely intended.
   */
  paneOpener: ((content: PaneContent) => void) | null = null;

  private toPane(content: PaneContent): boolean {
    const open = this.paneOpener;
    if (!open) return false;
    open(content);
    return true;
  }

  toggleRouteLog(): void {
    if (this.selectedId && this.toPane({ kind: "route-log", sessionId: this.selectedId })) return;
    if (this.routeLogOpen) {
      this.routeLogOpen = false;
      return;
    }
    if (!this.selectedId) return;
    this.closeSheets();
    this.threadOpen = false;
    this.routeLogOpen = true;
    void this.refreshRoutes(this.selectedId);
  }

  /** Sessions the daemon holds. Lifecycle only; the bytes are a stream, not state. */
  terminals = $state<Terminal[]>([]);
  terminalOpen = $state(false);

  openTerminal(): void {
    void this.refreshTerminals();
    if (this.toPane({ kind: "terminal", terminalId: null })) return;
    this.closeSheets();
    void this.refreshTerminals();
    this.threadOpen = false;
    this.routeLogOpen = false;
    this.terminalOpen = true;
  }

  /** The daemon is the list's source of truth; events keep it fresh after this first read. */
  async refreshTerminals(): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const items = await api.terminals();
      if (this.api === api) this.terminals = items;
    } catch {
      // A list that will not load is not worth a banner; the pane shows its own failure.
    }
  }

  closeTerminal(): void {
    this.terminalOpen = false;
  }

  closeRouteLog(): void {
    this.routeLogOpen = false;
  }

  /** `taskId` null opens whatever job this session touched most recently. */
  openTrace(taskId: string | null = null): void {
    if (!this.selectedId) return;
    if (this.toPane({ kind: "trace", sessionId: this.selectedId, taskId })) return;
    this.closeSheets();
    this.threadOpen = false;
    this.routinesOpen = false;
    this.traceSessionId = this.selectedId;
    this.traceTaskId = taskId ?? "";
  }

  closeTrace(): void {
    this.traceTaskId = null;
    this.traceSessionId = null;
  }

  get traceOpen(): boolean {
    return this.traceTaskId !== null;
  }

  async openRoutine(botId: string, routineId: string): Promise<void> {
    let navigation = ++this.profileNavigation;
    if (!this.snapshot.bots.some((bot) => bot.id === botId)) return;
    // The profile URL needs the selected conversation's navigation to settle first.
    if (!this.selectedId) {
      const session = youBotSession(this.snapshot.sessions, botId);
      if (!session) return;
      const api = this.api;
      const loading = this.selectSession(session.id);
      navigation = this.profileNavigation;
      const view = this.sessionView(session.id);
      const selection = view.loadSeq;
      await loading;
      if (this.api !== api || this.selectedId !== session.id || view.loadSeq !== selection ||
        this.profileNavigation !== navigation) return;
    }
    if (!this.snapshot.bots.some((bot) => bot.id === botId)) return;
    this.openProfile(botId);
    this.profileRoutineId = routineId;
  }

  openProfile(botId: string): void {
    if (this.selectedId && this.toPane({ kind: "session-settings", sessionId: this.selectedId, botId })) return;
    this.profileNavigation++;
    this.profileRoutineId = null;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
    this.workspaceOpen = false;
    this.routinesOpen = false;
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
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.settingsOpen = !this.settingsOpen;
  }

  openWorkspace(selected?: string | null): void {
    if (this.toPane({ kind: "workspace", selected: selected ?? null })) return;
    this.settingsOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.routinesOpen = false;
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
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.traceTaskId = null;
    this.traceSessionId = null;
    this.routeLogOpen = false;
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

  /** Restore settings, the session drawer, or the workspace overlay from the URL. */
  applyOverlay(overlay: UrlOverlay): void {
    this.profileNavigation++;
    if (overlay.kind === "settings") {
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
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
      this.profileBotId = overlay.botId;
      this.sessionSettingsOpen = true;
      return;
    }
    if (overlay.kind === "workspace") {
      this.settingsOpen = false;
      this.createGroupOpen = false;
      this.closeSessionSettings();
      this.traceTaskId = null;
      this.routinesOpen = false;
      this.workspaceOpen = true;
      this.workspaceSelected = overlay.selected ?? "";
      return;
    }
    if (overlay.kind === "trace") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.threadOpen = false;
      this.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.traceSessionId = this.traceSessionId ?? this.selectedId;
      this.traceTaskId = overlay.taskId ?? "";
      return;
    }
    if (overlay.kind === "routines") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.closeSessionSettings();
      this.workspaceOpen = false;
      this.traceTaskId = null;
      this.traceSessionId = null;
      this.routeLogOpen = false;
      this.threadOpen = false;
      this.previewRelpath = null;
      this.previewAttachmentId = null;
      this.previewTaskId = null;
      this.previewSiblings = null;
      this.routinesOpen = true;
      return;
    }
    this.settingsOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.traceTaskId = null;
    this.traceSessionId = null;
    this.routinesOpen = false;
  }

  closeSheets(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.routeLogOpen = false;
    this.traceTaskId = null;
    this.traceSessionId = null;
    this.workspaceOpen = false;
    this.routinesOpen = false;
  }

  async selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void> {
    if (!opts?.preservePage) this.closeRoutines();
    const api = this.api;
    const sync = this.sync;
    const view = this.sessionView(id);
    const connection = this.connectionSeq;
    const selection = ++view.loadSeq;
    const messageId = opts?.messageId;
    this.setHighlightedMessage(messageId ?? null);
    this.routeLogOpen = false;
    // The window stays open across conversations and follows the one on screen.
    if (this.traceOpen && this.selectedId !== id) this.traceSessionId = id;
    if (this.selectedId !== id) {
      this.closeSessionSettings();
      this.threadOpen = false;
    }
    // A selected row may still have only summary data, not its history cursor.
    if (this.selectedId === id && this.sessionDetailId === id && messageId) {
      const revision = view.revision;
      await this.ensureMessageLoaded(id, messageId);
      if (this.api !== api || this.sync !== sync || this.connectionSeq !== connection ||
        selection !== view.loadSeq || this.selectedId !== id || revision !== view.revision) return;
      this.setHighlightedMessage(messageId);
      return;
    }
    this.selectedId = id;
    this.sessionDetailId = null;
    this.sessionMessageNext = null;
    this.replyingToId = null;
    this.composerSuggestions = [];
    this.scheduleComposerSuggestions(id);
    if (this.focusedTurnId) {
      const focused = this.snapshot.turns.find((turn) => turn.id === this.focusedTurnId);
      if (!focused || focused.session_id !== id) this.focusedTurnId = null;
    }
    if (!this.notificationCapabilities.bounded_read_v1) {
      this.snapshot = {
        ...this.snapshot,
        sessions: this.snapshot.sessions.map((s) =>
          s.id === id ? { ...s, unread_count: 0 } : s,
        ),
      };
    }
    if (!api || !sync) return;
    this.historyLoading = true;
    this.sessionLoad = this.sessionLoad.catch(() => {}).then(async () => {
      if (selection !== view.loadSeq || this.connectionSeq !== connection ||
        this.api !== api || this.sync !== sync) return;
      sync.pause();
      try {
        const detail = await api.sessionSnapshot(id);
        if (this.api !== api || this.sync !== sync) return;
        const ready = await sync.waitThrough(detail);
        if (this.api !== api || this.sync !== sync) return;
        if (!ready) throw new Error("event instance changed");
        const frames = sync.install();
        if (!frames) throw new Error("event gap");
        for (const frame of frames) this.ingest(frame.payload, frame);
        if (selection !== view.loadSeq || this.connectionSeq !== connection) return;
        const unread = this.notificationCapabilities.bounded_read_v1 ? detail.session.unread_count : 0;
        this.applySessionDetail(id, { ...detail.session, unread_count: unread }, detail.judgements);
        for (const frame of frames) {
          if (frame.event_instance_id !== detail.event_instance_id) throw new Error("event instance changed");
          if (frame.seq > detail.watermark_seq) this.ingest(frame.payload, frame);
        }
        if (messageId) {
          const revision = view.revision;
          await this.ensureMessageLoaded(id, messageId);
          if (this.api !== api || this.sync !== sync || this.connectionSeq !== connection ||
            selection !== view.loadSeq || this.selectedId !== id || revision !== view.revision) return;
          this.setHighlightedMessage(messageId);
        }
        if (this.api !== api || this.sync !== sync || this.connectionSeq !== connection ||
          selection !== view.loadSeq || this.selectedId !== id) return;
        if (!this.notificationCapabilities.bounded_read_v1) {
          await this.markSessionRead(id);
        }
      } catch {
        if (this.api === api) this.markDisconnected();
      } finally {
        // Only the newest read of this conversation owns its flag; an older one must not clear it.
        if (selection === view.loadSeq && this.connectionSeq === connection) view.historyLoading = false;
      }
    });
    await this.sessionLoad;
  }

  /** The transcript holds everything that was fetched for it, and the Mac has more behind it. */
  get hasOlderMessages(): boolean {
    return this.sessionMessageNext !== null;
  }

  /**
   * One page further back. The cursor belongs to the fetch that produced it, so a page landing
   * after the selection moved, the history was cleared, or the connection was replaced is
   * dropped rather than mixed into a transcript it does not belong to.
   */
  async loadOlderMessages(): Promise<void> {
    const api = this.api;
    const sync = this.sync;
    const id = this.selectedId;
    const cursor = this.sessionMessageNext;
    if (!api || !id || !cursor || this.olderLoading) return;
    const view = this.sessionView(id);
    const connection = this.connectionSeq;
    const selection = view.loadSeq;
    const revision = view.revision;
    this.olderLoading = true;
    try {
      const page = await api.messages(id, { cursor });
      if (this.api !== api || this.sync !== sync || this.selectedId !== id ||
        this.connectionSeq !== connection || view.loadSeq !== selection || view.revision !== revision) return;
      this.sessionMessageNext = page.next ?? null;
      const known = new Set(this.snapshot.messages.map((message) => message.id));
      const added = page.items.filter((message) => !known.has(message.id));
      if (added.length > 0) {
        this.snapshot = { ...this.snapshot, messages: [...this.snapshot.messages, ...added] };
      }
    } catch {
      // What is on screen stays; a real drop surfaces as the socket closing.
    } finally {
      this.olderLoading = false;
    }
  }

  async markSessionRead(id: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      await api.markSessionRead(id);
    } catch {
      // The selected session is already shown as read; socket failure owns reconnection.
    }
  }

  /**
   * Model choices are not pushed over the socket. The log pulls them when it opens and again
   * whenever a turn here changes state, so a finished turn's outcome and feedback land on their own.
   */
  async refreshRoutes(sessionId: string): Promise<void> {
    if (!this.api || this.routesInFlight === sessionId) return;
    this.routesInFlight = sessionId;
    this.routesLoading = true;
    try {
      const { items, reviews, learnings } = await this.api.routes(sessionId);
      this.snapshot = {
        ...this.snapshot,
        routes: [...this.snapshot.routes.filter((r) => r.session_id !== sessionId), ...items],
        // All three are spliced by session: a second pane holding another session must keep its
        // rows when this one reloads. Replacing wholesale wiped them.
        routeReviews: [
          ...this.snapshot.routeReviews.filter((r) => r.session_id !== sessionId),
          ...reviews,
        ],
        routeLearnings: [
          ...this.snapshot.routeLearnings.filter((r) => r.session_id !== sessionId),
          ...learnings,
        ],
      };
    } catch {
      // Keep the rows already on screen; a real drop shows up as the socket closing.
    } finally {
      this.routesInFlight = null;
      this.routesLoading = false;
    }
  }

  async patchSettings(patch: SettingsPatch): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.patchSettings(patch);
      if (this.api !== api) return null;
      this.reconcilePendingMutation(api);
      if (patch.endpoint_api_key !== undefined) this.endpointKey = "";
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async probeModels(
    baseUrl?: string,
    apiKey?: string,
    providerId?: string,
  ): Promise<{ ok: true } & ProbeModelsResponse | { ok: false; error: string }> {
    const api = this.api;
    if (!api) return { ok: false, error: "Not connected" };
    try {
      const res = await api.probeModels({
        endpoint_base_url: baseUrl,
        endpoint_api_key: apiKey,
        provider_id: providerId,
      });
      if (this.api !== api) return { ok: false, error: "Connection changed" };
      return { ok: true, models: res.models, catalog: res.catalog ?? [] };
    } catch (error) {
      if (this.api !== api) return { ok: false, error: "Connection changed" };
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: msg };
    }
  }

  async createBot(body: CreateBotRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      const created = await api.createBot(body);
      if (this.api !== api) return null;
      this.closeSheets();
      await this.selectSession(created.direct_session.id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async createGroup(body: CreateGroupRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      const session = await api.createGroup(body);
      if (this.api !== api) return null;
      this.closeSheets();
      await this.selectSession(session.id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async createSkill(body: CreateSkillRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.createSkill(body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async patchSkill(id: string, body: PatchSkillRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.patchSkill(id, body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteSkill(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.deleteSkill(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async createRoutine(body: CreateRoutineRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return new ApiError(0, "disconnected", "Not connected");
    try {
      await api.createRoutine(body);
      this.reconcilePendingMutation(api);
      return this.api === api ? null : new ApiError(0, "disconnected", "Connection changed");
    } catch (error) {
      return this.routineFailure(error, api);
    }
  }

  async patchRoutine(id: string, body: PatchRoutineRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return new ApiError(0, "disconnected", "Not connected");
    try {
      await api.patchRoutine(id, body);
      this.reconcilePendingMutation(api);
      return this.api === api ? null : new ApiError(0, "disconnected", "Connection changed");
    } catch (error) {
      return this.routineFailure(error, api);
    }
  }

  async deleteRoutine(id: string, ifRevision: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return new ApiError(0, "disconnected", "Not connected");
    try {
      await api.deleteRoutine(id, ifRevision);
      this.reconcilePendingMutation(api);
      return this.api === api ? null : new ApiError(0, "disconnected", "Connection changed");
    } catch (error) {
      return this.routineFailure(error, api);
    }
  }

  private routineFailure(error: unknown, api: MessengerApi): ApiError {
    if (this.api !== api) return new ApiError(0, "disconnected", "Connection changed");
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && !error.requestId) return error;
    return this.sheetFailure(error, api) ?? new ApiError(0, "disconnected", "Save result unknown");
  }

  /** Correcting a memory, not creating one — the Bot is the only writer. */
  async patchMemory(id: string, body: PatchMemoryRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.patchMemory(id, body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteMemory(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.deleteMemory(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async patchBot(
    id: string,
    body: {
      name?: string;
      duties?: string;
      boundaries?: string;
      avatar?: string | null;
      model?: string | null;
      provider_id?: string | null;
      thinking_level?: ThinkingLevel | null;
    },
  ): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.patchBot(id, body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async archiveBot(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.archiveBot(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async restoreBot(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.restoreBot(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteBot(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.deleteBot(id);
      if (this.api !== api) return null;
      if (this.profileBotId === id) this.closeProfile();
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async patchSession(id: string, body: { name: string }): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.patchSession(id, body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async addMember(sessionId: string, botId: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.addMember(sessionId, botId);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async removeMember(sessionId: string, botId: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.removeMember(sessionId, botId);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async archiveSession(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.archiveSession(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async restoreSession(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.restoreSession(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteSession(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.deleteSession(id);
      if (this.api !== api) return null;
      if (this.selectedId === id) {
        this.selectedId = null;
        this.closeSessionSettings();
        this.focusedTurnId = null;
      }
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async clearSessionHistory(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.clearSessionHistory(id);
      if (this.api !== api) return null;
      if (this.selectedId === id) {
        this.focusedTurnId = null;
        this.setHighlightedMessage(null);
        this.sessionMessageNext = null;
      }
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async retryPendingMutation(): Promise<ApiError | null> {
    const api = this.api;
    const pending = this.pendingMutation;
    if (!api || !pending) return new ApiError(0, "disconnected", "No pending request");
    try {
      await api.retryPending(pending.id);
      if (this.api !== api) return new ApiError(0, "disconnected", "Connection changed");
      if (this.pendingMutation?.id === pending.id) this.pendingMutation = null;
      this.rememberDurablePending(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api) ?? new ApiError(0, "disconnected", "Retry result unconfirmed");
    }
  }

  async resolveCredentialOperation(id: string, action: "repair" | "cancel", value?: string): Promise<boolean> {
    const api = this.api;
    if (!api) return false;
    try {
      await api.resolveCredential(id, action, value);
      if (this.api !== api) return false;
      this.reconcilePendingMutation(api);
      return true;
    } catch (error) { this.sheetFailure(error, api); return false; }
  }

  async createProvider(body: CreateProviderRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.createProvider(body);
      this.reconcilePendingMutation(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async patchProvider(id: string, body: PatchProviderRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.patchProvider(id, body);
      this.reconcilePendingMutation(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteProvider(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.deleteProvider(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async createMcpServer(body: {
    name: string;
    transport?: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    auth?: string;
    enabled: boolean;
    usage_note?: string;
  }): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.createMcpServer(body);
      this.reconcilePendingMutation(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async patchMcpServer(
    id: string,
    body: {
      name?: string;
      transport?: "stdio" | "http";
      command?: string;
      args?: string[];
      url?: string;
      headers?: Array<{ name: string; value: string }>;
      auth?: string;
      enabled?: boolean;
      usage_note?: string | null;
    },
  ): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.patchMcpServer(id, body);
      this.reconcilePendingMutation(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteMcpServer(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.deleteMcpServer(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async send(opts?: { attachments?: File[] }): Promise<void> {
    const api = this.api;
    const id = this.selectedId;
    const body = this.draft.trim();
    const hasAttachments = Boolean(opts?.attachments && opts.attachments.length > 0);
    if (!api || !id || (!body && !hasAttachments) || this.busy) return;
    if (this.draftReconnect && !this.draftReconnect.confirm) return;
    const parentId = this.replyingToId;
    this.busy = true;
    try {
      const message = await api.postMessage(id, body, {
        attachments: opts?.attachments,
        parentId,
      });
      if (this.draftReconnect?.confirm) this.draftReconnect = null;
      if (this.api !== api) return;
      this.draft = "";
      this.replyingToId = null;
      this.pendingFocusTrigger = message.id;
      this.claimFocus(message.id);
    } catch (error) {
      if (this.api !== api) return;
      if (error instanceof ApiError && error.status === 422) return;
      this.keepUnknownRequest(error, api);
      this.markDisconnected();
    } finally {
      if (this.api === api) this.busy = false;
    }
  }

  getAskDraft(askId: string): AskDraftRecord | undefined {
    return this.askDrafts.get(askId);
  }

  setAskDraft(askId: string, body: string): void {
    const current = this.askDrafts.get(askId);
    const updated = { ...nextDraftVersion(current, body), askId };
    const nextMap = new Map(this.askDrafts);
    nextMap.set(askId, updated);
    this.askDrafts = nextMap;
  }

  clearAskDraft(askId: string, submittedVersion: number): void {
    const current = this.askDrafts.get(askId);
    const turn = this.snapshot.turns.find((t) => t.pending_ask_id === askId);
    const stillCurrent = Boolean(turn && turn.status === "waiting_ask" && turn.pending_ask_id === askId);
    const cleared = clearAskIfMatching(current, submittedVersion, stillCurrent);
    const nextMap = new Map(this.askDrafts);
    if (!cleared) nextMap.delete(askId);
    else nextMap.set(askId, cleared);
    this.askDrafts = nextMap;
  }

  setAskError(askId: string, error: string): void {
    const current = this.askDrafts.get(askId);
    const updated = recordAskError(current, askId, current?.body ?? "", error);
    const nextMap = new Map(this.askDrafts);
    nextMap.set(askId, updated);
    this.askDrafts = nextMap;
  }

  async sendAsk(askId: string, body: string): Promise<SendAskResult> {
    const api = this.api;
    const id = this.selectedId;
    const text = body.trim();
    const existingDraft = this.askDrafts.get(askId);
    const turn = this.snapshot.turns.find((t) => t.pending_ask_id === askId);
    if (this.notificationCapabilities.pending_ask_v1) {
      const pendingId = turn ? (turn.pending_ask_id ?? null) : null;
      const notAllowed = askSubmitAllowed(
        this.connection === "connected",
        this.busy,
        text,
        pendingId,
        askId,
        true,
      );
      if (notAllowed) return notAllowed;
    } else {
      if (!text) return { status: "not_submitted", reason: "empty" };
      if (this.connection !== "connected") return { status: "not_submitted", reason: "disconnected" };
      if (this.busy) return { status: "not_submitted", reason: "busy" };
    }
    if (!api || !id) return { status: "not_submitted", reason: "disconnected" };

    const reqId = existingDraft?.requestId;
    this.busy = true;
    try {
      const res = await api.postMessage(id, text, { askId, ...(reqId ? { requestId: reqId } : {}) });
      return {
        status: "accepted",
        request_id: reqId,
        message_id: res.id,
      };
    } catch (error) {
      if (this.api !== api) return { status: "not_submitted", reason: "stale_connection" };
      if (error instanceof ApiError) {
        if (error.status === 422 || error.status === 409) {
          void this.selectSession(id);
          const stillCurrent = Boolean(turn && turn.status === "waiting_ask" && turn.pending_ask_id === askId);
          return classifySendAskFailure(error, stillCurrent);
        }
        if (error.code === "request_unknown" || error.code === "request_pending") {
          this.keepUnknownRequest(error, api);
          const activeRequestId = error.requestId ?? reqId;
          const draft = existingDraft ?? { ...nextDraftVersion(undefined, text), askId };
          draft.requestId = activeRequestId;
          draft.error = error.message;
          const nextMap = new Map(this.askDrafts);
          nextMap.set(askId, draft);
          this.askDrafts = nextMap;
          return { status: "unknown", request_id: activeRequestId, error };
        }
        this.keepUnknownRequest(error, api);
        this.markDisconnected();
        return { status: "rejected", error };
      }
      const apiError = new ApiError(500, "failed", error instanceof Error ? error.message : "request failed");
      return { status: "rejected", error: apiError };
    } finally {
      if (this.api === api) this.busy = false;
    }
  }

  setNotificationIntentHandler(handler: ((intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }) => void) | null): void {
    this.notificationIntentHandler = handler;
  }

  private dispatchNotificationIntent(intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }): void {
    if (this.notificationIntentHandler) {
      this.notificationIntentHandler(intent);
      return;
    }
    this.applyNotificationIntent(intent);
  }

  /**
   * A system banner or a PWA push click lands on the conversation it belongs to. A generic
   * pending push has no session in it, so it returns to the chat list, where that state shows.
   */
  applyNotificationIntent(intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }): void {
    this.closeSheets();
    if (!intent.sessionId) {
      this.selectedId = null;
      return;
    }
    void this.selectSession(intent.sessionId, { messageId: intent.messageId ?? undefined });
  }

  async loadNotificationPolicy(): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      this.notificationPolicy = await api.getNotificationPolicy();
    } catch {
      // Graceful
    }
  }

  async patchNotificationPolicy(patch: Omit<NotificationPolicyPatch, "if_revision">): Promise<void> {
    const api = this.api;
    if (!api || !this.notificationPolicy) return;
    try {
      const res = await api.patchNotificationPolicy({
        ...patch,
        if_revision: this.notificationPolicy.revision,
      });
      this.notificationPolicy = res;
    } catch {
      // Graceful
    }
  }

  async loadNotificationDevice(): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      this.notificationDevice = await api.getNotificationDevice();
    } catch {
      // Graceful
    }
  }

  async patchNotificationDevice(patch: Omit<NotificationDevicePatch, "if_revision">): Promise<void> {
    const api = this.api;
    if (!api || !this.notificationDevice) return;
    try {
      const res = await api.patchNotificationDevice({
        ...patch,
        if_revision: this.notificationDevice.revision,
      });
      this.notificationDevice = res;
    } catch {
      // Graceful
    }
  }

  private liveInboxWatermark(): { event_instance_id: string; watermark_seq: number } | null {
    return this.sync?.snapshotCursor() ?? null;
  }

  private inboxReplayAfter(page: { event_instance_id: string; watermark_seq: number }): {
    complete: boolean;
    replay: InboxReplayEvent[];
    reason?: "invalid" | "instance" | "truncated";
  } {
    const result = this.sync?.notificationEventsAfter({
      event_instance_id: page.event_instance_id,
      watermark_seq: page.watermark_seq,
    });
    if (!result) return { complete: true, replay: [] };
    if (!result.complete) return { complete: false, replay: [], reason: result.reason };
    const replay: InboxReplayEvent[] = [];
    for (const frame of result.frames) {
      const payload = frame.payload;
      if (payload.event === "notification.upsert") {
        const { event: _e, occurred_at: _at, ...item } = payload;
        replay.push({ seq: frame.seq, event: "notification.upsert", item: item as NotificationItem });
      } else if (payload.event === "notification.removed") {
        replay.push({ seq: frame.seq, event: "notification.removed", id: payload.id });
      } else if (payload.event === "notification.summary") {
        replay.push({ seq: frame.seq, event: "notification.summary", summary: payload.summary });
      }
    }
    return { complete: true, replay };
  }

  private deferInboxReload(filter: NotificationFilter, generation: number, overflow: boolean): void {
    if (overflow) {
      this.notificationInboxState = {
        ...this.notificationInboxState,
        loading: false,
        loadingMore: false,
        error: "stale",
      };
      return;
    }
    queueMicrotask(() => {
      if (this.stopped || this.notificationInboxState.generation !== generation) return;
      void this.loadNotificationInbox(filter);
    });
  }

  async loadNotificationInbox(filter: NotificationFilter): Promise<void> {
    const api = this.api;
    if (!api) return;
    this.notificationInboxState = beginInboxLoad(this.notificationInboxState, filter);
    const gen = this.notificationInboxState.generation;
    const priorSummary = this.notificationInboxState.summary;
    try {
      const page = await api.listNotifications({ filter, limit: 50 });
      if (this.notificationInboxState.generation !== gen) return;
      const live = this.liveInboxWatermark();
      const liveAhead = Boolean(live && live.event_instance_id === page.event_instance_id && live.watermark_seq > page.watermark_seq);
      const replayed = this.inboxReplayAfter(page);
      const instanceMismatch = replayed.reason === "invalid" || replayed.reason === "instance";
      if (instanceMismatch || (liveAhead && !replayed.complete)) {
        this.deferInboxReload(filter, gen, replayed.reason === "truncated");
        return;
      }
      this.notificationInboxState = acceptFirstPage(this.notificationInboxState, {
        filter,
        generation: gen,
        instanceId: page.event_instance_id,
        watermark: page.watermark_seq,
        upperOrdinal: page.upper_ordinal,
        page,
        live,
        replay: replayed.replay,
        replayComplete: replayed.complete,
      });
      if (!liveAhead) {
        this.notificationSummary = this.notificationInboxState.summary;
        this.syncAppBadge();
      } else if (this.notificationInboxState.summary !== priorSummary) {
        this.notificationSummary = this.notificationInboxState.summary;
        this.syncAppBadge();
      }
    } catch {
      this.notificationInboxState = rejectInboxLoad(this.notificationInboxState, gen, "offline");
    }
  }

  async loadMoreNotifications(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const state = this.notificationInboxState;
    if (!state.next || state.loadingMore || state.loading) return;
    this.notificationInboxState = beginMore(state);
    const gen = this.notificationInboxState.generation;
    const priorSummary = state.summary;
    try {
      const page = await api.listNotifications({
        filter: state.filter,
        limit: 50,
        cursor: state.next,
      });
      if (this.notificationInboxState.generation !== gen) return;
      const live = this.liveInboxWatermark();
      const liveAhead = Boolean(live && live.event_instance_id === page.event_instance_id && live.watermark_seq > page.watermark_seq);
      const replayed = this.inboxReplayAfter(page);
      const instanceMismatch = replayed.reason === "invalid" || replayed.reason === "instance";
      if (instanceMismatch || (liveAhead && !replayed.complete)) {
        this.notificationInboxState = { ...state, loadingMore: false, error: replayed.reason === "truncated" ? "stale" : state.error };
        if (replayed.reason !== "truncated") this.deferInboxReload(state.filter, gen, false);
        return;
      }
      this.notificationInboxState = acceptMore(this.notificationInboxState, {
        filter: state.filter,
        generation: gen,
        instanceId: page.event_instance_id,
        watermark: page.watermark_seq,
        upperOrdinal: state.upperOrdinal,
        page,
        live,
        replay: replayed.replay,
        replayComplete: replayed.complete,
      });
      if (!liveAhead) {
        this.notificationSummary = this.notificationInboxState.summary;
        this.syncAppBadge();
      } else if (this.notificationInboxState.summary !== priorSummary) {
        this.notificationSummary = this.notificationInboxState.summary;
        this.syncAppBadge();
      }
    } catch {
      this.notificationInboxState = {
        ...this.notificationInboxState,
        loadingMore: false,
        error: "offline",
      };
    }
  }

  async markNotificationRead(id: string): Promise<void> {
    await this.markNotificationsRead([id]);
  }

  async markNotificationsRead(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const api = this.api;
    if (!api) return;
    try {
      await api.markNotificationsRead({ ids });
      const now = new Date().toISOString();
      let openDecrements = 0;
      for (const id of ids) {
        const item = this.notificationInboxState.items.find((i) => i.id === id);
        if (item && !item.read_at && item.action_state !== "open") {
          openDecrements++;
        }
      }
      this.notificationInboxState = markLocalRead(this.notificationInboxState, ids, now);
      this.notificationSummary = {
        ...this.notificationSummary,
        unread_count: Math.max(0, this.notificationSummary.unread_count - ids.length),
        attention_count: Math.max(0, this.notificationSummary.attention_count - openDecrements),
      };
      this.syncAppBadge();
    } catch {
      // Non-fatal
    }
  }

  async markAllNotificationsRead(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const upper = this.notificationInboxState.upperOrdinal;
    try {
      await api.markNotificationsRead({ through_ordinal: upper, filter: "all" });
      const now = new Date().toISOString();
      const allIds = this.notificationInboxState.items.map((i: NotificationItem) => i.id);
      this.notificationInboxState = markLocalRead(this.notificationInboxState, allIds, now);
      this.notificationSummary = {
        ...this.notificationSummary,
        unread_count: 0,
        attention_count: this.notificationSummary.open_count,
      };
      this.syncAppBadge();
    } catch {
      // Non-fatal
    }
  }

  async acknowledgeNotification(id: string, ifRevision: number): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      await api.acknowledgeNotification(id, ifRevision);
      const item = this.notificationInboxState.items.find((i: NotificationItem) => i.id === id);
      if (item) {
        const updated: NotificationItem = {
          ...item,
          action_state: "resolved",
          resolution_reason: "acknowledged",
          revision: item.revision + 1,
          read_at: item.read_at ?? new Date().toISOString(),
        };
        this.notificationInboxState = upsertInboxItem(this.notificationInboxState, updated);
      }
    } catch {
      // Non-fatal
    }
  }

  private syncAppBadge(): void {
    if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) return;
    const attention = this.notificationSummary.attention_count;
    if (attention <= 0) {
      if ("clearAppBadge" in navigator) {
        navigator.clearAppBadge().catch(() => {});
      }
    } else {
      if (this.notificationDevice?.badge !== false) {
        navigator.setAppBadge(attention).catch(() => {});
      }
    }
  }

  isSessionMuted(sessionId: string): boolean {
    const session = this.snapshot.sessions.find((s) => s.id === sessionId);
    return session?.notification_preference?.muted === true;
  }

  async setSessionMuted(sessionId: string, muted: boolean): Promise<void> {
    const api = this.api;
    if (!api) return;
    const session = this.snapshot.sessions.find((s) => s.id === sessionId);
    const revision = session?.notification_preference?.revision ?? 0;
    try {
      const pref = await api.putSessionNotificationPreference(sessionId, { muted, if_revision: revision });
      this.snapshot = {
        ...this.snapshot,
        sessions: this.snapshot.sessions.map((s) =>
          s.id === sessionId ? { ...s, notification_preference: pref } : s
        ),
      };
    } catch {
      // Non-fatal
    }
  }

  async sendTestNotification(): Promise<{ ok: boolean; status: string; error_code?: string | null }> {
    const api = this.api;
    const copy = copyFor(this.snapshot.settings.locale).notifications;
    if (!api) {
      throw new ApiError(0, "disconnected", copyFor(this.snapshot.settings.locale).disconnected.host);
    }
    const localNativePath = this.isDesktopShell || api.kind === "local";
    if (localNativePath) {
      if (!this.nativeCapabilities.native_delivery_v1 || this.pushPermission !== "granted" || !this.notificationDevice?.enabled) {
        throw new ApiError(409, "delivery_gated", copy.testDeliveryGated);
      }
      if ("testDesktopNotification" in api) {
        return api.testDesktopNotification();
      }
      throw new ApiError(409, "delivery_gated", copy.testDeliveryGated);
    }
    if (this.remoteGated) {
      throw new ApiError(503, "gateway_unavailable", copyFor(this.snapshot.settings.locale).notifications.remoteGated);
    }
    if ("testRemotePush" in api) {
      return api.testRemotePush();
    }
    throw new ApiError(409, "capability_unavailable", copy.upgradeRequired);
  }

  async enableDeviceNotifications(): Promise<boolean> {
    const res = await this.setPushEnabled(true);
    return Boolean(res);
  }

  async disableDeviceNotifications(): Promise<DisablePushResult | boolean> {
    return this.setPushEnabled(false);
  }

  async pollDesktopNativeState(): Promise<void> {
    const internals = readTauriInternals();
    if (!internals?.invoke) return;
    try {
      const stateDto = (await internals.invoke("notification_permission_state")) as NotificationPermissionStateDto;
      if (stateDto) {
        this.nativeCapabilities = {
          native_reading_v1: stateDto.nativeReadingV1,
          native_delivery_v1: stateDto.nativeDeliveryV1,
        };
        this.pushPermission = (stateDto.permission === "granted" || stateDto.permission === "denied")
          ? stateDto.permission
          : "default";
      }
    } catch {
      // Native call failure
    }
    try {
      const intent = (await internals.invoke("take_notification_intent")) as NotificationIntent | null;
      if (intent?.clickRef) {
        await this.handleDesktopNotificationIntent(intent.clickRef);
      }
    } catch {
      // Intent error
    }
  }

  async handleDesktopNotificationIntent(clickRef: string): Promise<void> {
    const api = this.api;
    if (!api || !("getDesktopClickTarget" in api)) {
      this.dispatchNotificationIntent({ openInbox: true });
      return;
    }
    try {
      const res = await api.getDesktopClickTarget(clickRef);
      if (res.target?.session_id) {
        this.dispatchNotificationIntent({
          sessionId: res.target.session_id,
          messageId: res.target.message_id ?? null,
          openInbox: false,
        });
        return;
      }
      this.dispatchNotificationIntent({ openInbox: true });
    } catch {
      this.dispatchNotificationIntent({ openInbox: true });
    }
  }

  async reportDesktopNotificationView(atLatest: boolean): Promise<NativeFocusFacts | null> {
    const internals = readTauriInternals();
    if (!internals?.invoke) return null;
    try {
      const report: NotificationViewReport = {
        sessionId: this.selectedId,
        atLatest,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
      };
      const facts = (await internals.invoke("report_notification_view", { report })) as NativeFocusFacts;
      if (facts) {
        this.nativeFocusFacts = facts;
        return facts;
      }
    } catch {
      // ignore
    }
    return null;
  }

  async requestDesktopNotificationPermission(): Promise<void> {
    const internals = readTauriInternals();
    if (!internals?.invoke) return;
    try {
      const stateDto = (await internals.invoke("request_notification_permission")) as NotificationPermissionStateDto;
      if (stateDto) {
        this.nativeCapabilities = {
          native_reading_v1: stateDto.nativeReadingV1,
          native_delivery_v1: stateDto.nativeDeliveryV1,
        };
        this.pushPermission = (stateDto.permission === "granted" || stateDto.permission === "denied")
          ? stateDto.permission
          : "default";
        if (stateDto.permission === "granted") {
          await this.patchNotificationDevice({ enabled: true });
        }
      }
    } catch {
      // ignore
    }
  }

  async sendPresenceHeartbeat(atLatest: boolean = false): Promise<void> {
    const api = this.api;
    if (!api || this.connection !== "connected" || typeof document === "undefined" || document.visibilityState !== "visible") return;
    if (this.isDesktopShell) {
      await this.reportDesktopNotificationView(atLatest);
      return;
    }
    try {
      await api.postNotificationPresence({
        instance_id: this.instanceId,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        session_id: this.selectedId,
        at_latest: atLatest,
      });
    } catch {
      // Non-fatal
    }
  }

  private applyPushState(v2: PushStateV2): void {
    this.pushSubscribed = v2.subscribed;
    this.pushEnabled = v2.enabled;
    this.pushRecovery = v2.recovery;
    this.pushTransport = v2.push_transport;
    const state = this.remoteStatus?.state;
    this.remoteGated =
      state === "activation_gated" ||
      state === "native_unavailable" ||
      state === "off" ||
      state === "trust_mismatch";
  }

  async loadPushState(): Promise<void> {
    const api = this.api;
    if (!(api instanceof RemoteApi)) return;
    let v2: PushStateV2 | null = null;
    try {
      v2 = await api.getPushStateV2();
      this.applyPushState(v2);
    } catch {
      try {
        const legacy = await api.pushState();
        this.pushSubscribed = legacy.subscribed;
        this.pushEnabled = legacy.subscribed;
        this.pushTransport = "legacy";
      } catch {
        // ignore
      }
      return;
    }
    if (!v2.enabled || v2.push_transport !== "policy_v2") return;
    try {
      const result = await refreshPush(api, v2);
      if (result === "needs_repair") {
        if (this.pushRecovery === "none") this.pushRecovery = "registration_missing";
        return;
      }
      this.applyPushState(await api.getPushStateV2());
    } catch {
      if (this.pushRecovery === "none") this.pushRecovery = "registration_missing";
    }
  }

  async prefetchPushState(): Promise<PushStateV2 | null> {
    const api = this.api;
    if (!(api instanceof RemoteApi)) return null;
    try {
      const v2 = await api.getPushStateV2();
      this.applyPushState(v2);
      return v2;
    } catch {
      return null;
    }
  }

  /**
   * The Mac answers a read with `session.upsert`, so a read that is already on record still comes
   * back as a new snapshot. Sending it again on the strength of that snapshot is a loop: the same
   * message was read once a second for as long as the conversation stayed on screen, and every
   * pane that reads the snapshot — the file tree beside the chat, the workspace — was rebuilt each
   * time. A read is sent once per message, and again only if it failed.
   */
  async submitBoundedRead(sessionId: string, messageId: string): Promise<void> {
    const api = this.api;
    if (!api || this.connection !== "connected" || this.selectedId !== sessionId) return;
    if (this.boundedReadSent.get(sessionId) === messageId) return;
    this.boundedReadSent.set(sessionId, messageId);
    try {
      const detail = await api.markSessionReadThrough(sessionId, messageId);
      if (this.api !== api) return;
      const current = this.snapshot.sessions.find((s) => s.id === sessionId);
      // Writing the row back unchanged is a new snapshot object for nothing.
      if (
        current &&
        current.unread_count === detail.unread_count &&
        current.last_read_at === detail.last_read_at
      ) {
        return;
      }
      this.snapshot = {
        ...this.snapshot,
        sessions: this.snapshot.sessions.map((s) =>
          s.id === sessionId ? { ...s, unread_count: detail.unread_count, last_read_at: detail.last_read_at } : s
        ),
      };
    } catch {
      // Bounded read failure is non-fatal, but the next attempt must be allowed through.
      if (this.boundedReadSent.get(sessionId) === messageId) this.boundedReadSent.delete(sessionId);
    }
  }

  setupTabChannel(): void {
    if (typeof BroadcastChannel === "undefined") return;
    if (this.tabChannel) return;
    try {
      const ch = new BroadcastChannel(TAB_CHANNEL);
      this.tabChannel = ch;
      ch.onmessage = (ev) => {
        if (!isTabControlMessage(ev.data)) return;
        const msg = ev.data as TabControlMessage;
        if (msg.type === "inbox") {
          this.dispatchNotificationIntent({ openInbox: true });
        } else if (msg.type === "takeover-request") {
          if (this.tabRole === "owner") {
            this.releaseLock?.();
            this.releaseLock = null;
            this.resetConnection();
            this.tabRole = "standby";
            try { ch.postMessage({ type: "takeover-ack" }); } catch {}
          }
        } else if (msg.type === "takeover-ack") {
          if (this.tabRole === "standby") {
            void this.acquireTabLock().then((got) => {
              if (got) {
                this.tabTakeoverTimeout = false;
                void this.tick();
              }
            });
          }
        }
      };
    } catch {
      // BroadcastChannel not available in this environment
    }
  }

  async acquireTabLock(): Promise<boolean> {
    if (typeof navigator === "undefined" || !supportsWebLocks(navigator.locks)) {
      this.tabRole = "single";
      return true;
    }
    return new Promise<boolean>((resolve) => {
      navigator.locks.request(TAB_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          this.tabRole = "standby";
          this.setupTabChannel();
          resolve(false);
          return;
        }
        this.tabRole = "owner";
        this.tabTakeoverTimeout = false;
        this.setupTabChannel();
        resolve(true);
        await new Promise<void>((held) => {
          this.releaseLock = held;
        });
      }).catch(() => {
        this.tabRole = "single";
        resolve(true);
      });
    });
  }

  async requestTabTakeover(): Promise<void> {
    if (!this.tabChannel) this.setupTabChannel();
    this.tabTakeoverTimeout = false;
    try {
      this.tabChannel?.postMessage({ type: "takeover-request" });
    } catch {}

    const timer = setTimeout(() => {
      if (this.tabRole === "standby") {
        this.tabTakeoverTimeout = true;
      }
    }, TAKEOVER_MS);

    const start = Date.now();
    while (Date.now() - start < TAKEOVER_MS) {
      const got = await this.acquireTabLock();
      if (got) {
        clearTimeout(timer);
        this.tabTakeoverTimeout = false;
        void this.tick();
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async toggleReaction(messageId: string, emoji: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    const message = this.snapshot.messages.find((m) => m.id === messageId);
    const hasReacted = message?.reactions.some((r) => r.actor === USER_MEMBER && r.emoji === emoji);
    try {
      if (hasReacted) {
        await api.deleteReaction(messageId, emoji);
      } else {
        await api.putReaction(messageId, emoji);
      }
    } catch {
      // ignore
    }
  }

  async stopTurn(): Promise<void> {
    const api = this.api;
    if (!api || this.connection !== "connected") return;
    const selected = this.snapshot.sessions.find((session) => session.id === this.selectedId);
    const turnId = stopTarget(
      this.snapshot.turns,
      this.selectedId,
      this.focusedTurnId,
      selected?.kind ?? null,
    );
    if (!turnId) return;
    try {
      await api.stop(turnId);
    } catch {
      if (this.api === api) this.markDisconnected();
    }
  }

  async continueInterrupt(messageId: string): Promise<void> {
    const api = this.api;
    if (!api || this.connection !== "connected" || this.busy) return;
    this.busy = true;
    try {
      const turn = await api.continueInterrupt(messageId);
      if (this.api === api) this.focusedTurnId = turn.id;
    } catch (error) {
      if (this.api !== api) return;
      if (error instanceof ApiError && error.status === 422) return;
      this.markDisconnected();
    } finally {
      if (this.api === api) this.busy = false;
    }
  }

  async resolveApproval(
    id: string,
    action: ResolveApprovalRequest["action"],
    apiKey?: string,
  ): Promise<ApiError | null> {
    const api = this.api;
    if (!api || this.busy) return null;
    this.busy = true;
    try {
      const body: ResolveApprovalRequest = { action };
      if (typeof apiKey === "string" && apiKey.length > 0) body.api_key = apiKey;
      await api.resolveApproval(id, body);
      return null;
    } catch (error) {
      if (this.api !== api) return null;
      if (error instanceof ApiError && (error.status === 422 || error.status === 409)) return error;
      this.markDisconnected();
      return null;
    } finally {
      if (this.api === api) this.busy = false;
    }
  }

  clearSearchHighlight(): void {
    this.setHighlightedMessage(null);
  }

  closeSearch(): void {
    this.searchQuery = "";
    this.searchHits = [];
    this.searchSeq++;
  }

  async runSearch(q: string): Promise<void> {
    this.searchQuery = q;
    if (!this.api) {
      this.searchHits = [];
      return;
    }
    const trimmed = q.trim();
    if (!trimmed) {
      this.searchHits = [];
      return;
    }
    const seq = ++this.searchSeq;
    try {
      const hits = await this.api.search(trimmed);
      if (seq === this.searchSeq) this.searchHits = hits;
    } catch {
      if (seq === this.searchSeq) this.searchHits = [];
    }
  }

  async submitPairing(raw: string): Promise<PairingProgress> {
    if (this.pairingBusy) return this.pairing;
    this.pairingBusy = true;
    this.pairing = { phase: "waiting" };
    try {
      const result = await pairFromQr(raw, { onWaiting: () => { this.pairing = { phase: "waiting" }; } });
      this.pairing = result;
      if (result.phase === "enrolled") {
        this.enrolled = true;
        this.start();
      }
      return result;
    } finally {
      this.pairingBusy = false;
    }
  }

  confirmDraftReconnect(): void {
    this.draftReconnect = this.draftReconnect ? { ...this.draftReconnect, confirm: true } : null;
  }

  discardDraftReconnect(): void {
    this.draft = "";
    this.draftReconnect = null;
  }

  async registerUv(): Promise<boolean> {
    const api = this.api;
    if (!(api instanceof RemoteApi)) return false;
    this.uvError = null;
    try {
      await api.registerUv();
      this.uvReady = true;
      return true;
    } catch {
      this.uvReady = false;
      this.uvError = "uv_failed";
      return false;
    }
  }

  async refreshHostDevices(): Promise<void> {
    const api = this.api;
    if (this.remote || !api || api instanceof RemoteApi || this.hostDevicesBusy) return;
    this.hostDevicesBusy = true;
    this.hostDevicesError = null;
    try {
      this.hostDevices = await listHostDevices(api);
    } catch (error) {
      this.hostDevicesError = error instanceof ApiError ? error.code : "request_unknown";
    } finally {
      this.hostDevicesBusy = false;
    }
  }

  async removeHostDevice(id: string): Promise<boolean> {
    const api = this.api;
    if (this.remote || !api || api instanceof RemoteApi || this.hostDevicesBusy) return false;
    this.hostDevicesBusy = true;
    this.hostDevicesError = null;
    try {
      await removeHostDevice(api, id);
      this.hostRemoveDeviceId = null;
      this.hostDevices = await listHostDevices(api);
      return true;
    } catch (error) {
      this.hostDevicesError = error instanceof ApiError ? error.code : "request_unknown";
      return false;
    } finally {
      this.hostDevicesBusy = false;
    }
  }

  /**
   * Opens a pairing window on this Mac and keeps checking it. The window lasts ten minutes; the
   * card shows the code for that long, then says so rather than leaving a dead code on screen.
   */
  async startHostPairing(): Promise<void> {
    const api = this.api;
    if (this.hostPairingBusy || !api || api instanceof RemoteApi) return;
    this.hostPairingBusy = true;
    try {
      const offer = await openPairing(api);
      this.hostPairing = { phase: "offer", ...offer };
      void this.watchHostPairing(api, offer.pairingId);
    } catch (error) {
      this.hostPairing = { phase: "failed", error: error instanceof ApiError ? error.code : "request_unknown" };
    } finally {
      this.hostPairingBusy = false;
    }
  }

  private async watchHostPairing(api: LocalApi, pairingId: string): Promise<void> {
    while (!this.stopped) {
      const current = this.hostPairing;
      if (this.api !== api || current?.phase !== "offer" || current.pairingId !== pairingId) return;
      if (Math.floor(Date.now() / 1000) >= current.expiresUnix) {
        this.hostPairing = { phase: "failed", error: "expired" };
        return;
      }
      try {
        const waited = await readPairing(api, pairingId);
        const live = this.hostPairing;
        if (this.api !== api || live?.phase !== "offer" || live.pairingId !== pairingId) return;
        if (waited.phase === "confirm") {
          this.hostPairing = { ...live, phase: "confirm", name: waited.name, deviceFingerprint: waited.fingerprint, challenge: waited.challenge };
          return;
        }
      } catch (error) {
        this.hostPairing = { phase: "failed", error: error instanceof ApiError ? error.code : "request_unknown" };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, HOST_PAIRING_POLL_MS));
    }
  }

  /** The person compared the fingerprint on the device; this is the local confirmation. */
  async confirmHostPairing(): Promise<void> {
    const api = this.api, current = this.hostPairing;
    if (this.hostPairingBusy || !api || api instanceof RemoteApi || current?.phase !== "confirm") return;
    this.hostPairingBusy = true;
    try {
      const deviceId = await confirmPairing(api, current.pairingId, current.challenge);
      if (this.hostPairing === current) this.hostPairing = { phase: "paired", deviceId };
      await this.refreshHostDevices();
    } catch (error) {
      if (this.hostPairing === current) {
        this.hostPairing = { phase: "failed", error: error instanceof ApiError ? error.code : "request_unknown" };
      }
    } finally {
      this.hostPairingBusy = false;
    }
  }

  /** The button on the unreachable screen: try now, and look like it. */
  retryConnection(): void {
    if (this.stopped || this.connection === "connected") return;
    this.connectFailures = 0;
    this.remoteRetryMs = REMOTE_RETRY_MIN_MS;
    this.connection = "connecting";
    if (this.timer) clearTimeout(this.timer);
    this.pump();
  }

  /** Closing the card abandons the window; it still expires on the host by itself. */
  closeHostPairing(): void {
    if (this.hostPairingBusy) return;
    this.hostPairing = null;
  }

  async refreshMaintenance(): Promise<void> {
    const api = this.api;
    if (!(api instanceof RemoteApi)) return;
    try {
      this.maintenance = await api.remoteStatus();
      this.uvReady = api.uvReady || this.maintenance.devices.some((row) => row.id === api.enrollment.deviceId && row.hasUv);
      this.maintenanceError = null;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "request_unknown";
    }
  }

  async downloadDiagnostics(): Promise<boolean> {
    const api = this.api;
    if (!(api instanceof RemoteApi) || this.maintenanceBusy) return false;
    this.maintenanceBusy = true;
    this.maintenanceError = null;
    try {
      const report = await api.privilegedAction({ action: "diagnostics.download", targetId: "runtime" }) as RemoteDiagnostics;
      const blob = new Blob([JSON.stringify(report)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "real-bot-diagnostics.json";
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      return true;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "uv_failed";
      return false;
    } finally {
      this.maintenanceBusy = false;
    }
  }

  async restartRuntime(force = false): Promise<boolean> {
    const api = this.api;
    if (!(api instanceof RemoteApi) || this.maintenanceBusy) return false;
    this.maintenanceBusy = true;
    this.maintenanceError = null;
    try {
      await api.privilegedAction({ action: "runtime.restart", targetId: "runtime", force });
      this.maintenanceForceConfirm = false;
      await this.refreshMaintenance();
      return true;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "uv_failed";
      await this.refreshMaintenance();
      return false;
    } finally {
      this.maintenanceBusy = false;
    }
  }

  async stopRuntime(): Promise<boolean> {
    const api = this.api;
    if (!(api instanceof RemoteApi) || this.maintenanceBusy) return false;
    this.maintenanceBusy = true;
    this.maintenanceError = null;
    try {
      await api.privilegedAction({ action: "runtime.stop", targetId: "runtime" });
      this.maintenanceStopConfirm = false;
      await this.refreshMaintenance();
      return true;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "uv_failed";
      await this.refreshMaintenance();
      return false;
    } finally {
      this.maintenanceBusy = false;
    }
  }

  async revokeRemoteDevice(id: string): Promise<boolean> {
    const api = this.api;
    if (!(api instanceof RemoteApi) || this.maintenanceBusy) return false;
    this.maintenanceBusy = true;
    this.maintenanceError = null;
    try {
      await api.privilegedAction({ action: "device.revoke", targetId: id });
      this.maintenanceRevokeId = null;
      await this.refreshMaintenance();
      return true;
    } catch (error) {
      this.maintenanceError = error instanceof ApiError ? error.code : "uv_failed";
      await this.refreshMaintenance();
      return false;
    } finally {
      this.maintenanceBusy = false;
    }
  }

  otherRemoteDevices(): RemoteDeviceRow[] {
    const api = this.api;
    if (!(api instanceof RemoteApi) || !this.maintenance) return [];
    return this.maintenance.devices.filter((row) => row.id !== api.enrollment.deviceId && !row.revoked);
  }

  private readonly onWindowFocus = (): void => {
    if (this.isDesktopShell) void this.reportDesktopNotificationView(false);
    else void this.sendPresenceHeartbeat();
    this.reconnectNow();
  };

  private readonly onWindowBlur = (): void => {
    if (this.isDesktopShell) void this.reportDesktopNotificationView(false);
  };

  private readonly onWindowVisibility = (): void => {
    if (this.isDesktopShell) void this.reportDesktopNotificationView(false);
    else if (document.visibilityState === "visible") void this.sendPresenceHeartbeat();
    // A phone freezes this page while it is away and thaws it when you look again. That is the
    // moment the timer it left behind is worth the least, so the loop is asked again here.
    if (document.visibilityState === "visible") this.reconnectNow();
  };

  /** The radio came back. Nothing else is going to say so. */
  private readonly onNetworkOnline = (): void => {
    this.reconnectNow();
  };

  private readonly onPushMessage = (event: MessageEvent): void => {
    if (!isInboxMessage(event.data)) return;
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      if (navigator.serviceWorker.controller && event.source !== navigator.serviceWorker.controller) {
        return;
      }
    }
    this.dispatchNotificationIntent({ openInbox: true });
    this.reconnectNow();
  };

  async setPushEnabled(enabled: boolean): Promise<DisablePushResult | boolean> {
    const api = this.api;
    if (this.isDesktopShell) {
      if (enabled) {
        await this.requestDesktopNotificationPermission();
      } else {
        await this.patchNotificationDevice({ enabled: false });
      }
      return true;
    }
    if (!(api instanceof RemoteApi) || this.pushBusy) return false;
    this.pushBusy = true;
    this.pushError = null;
    this.pushErrorCode = null;
    this.pushPermission = pushPermission();
    try {
      if (enabled) {
        await enablePush(api, "enable");
        this.pushEnabled = true;
        this.pushSubscribed = true;
        this.pushRecovery = "none";
        this.pushPermission = pushPermission();
        await this.loadNotificationDevice();
        return true;
      } else {
        const outcome = await disablePush(api);
        this.pushEnabled = !outcome.hostDisabled;
        this.pushSubscribed = !outcome.localRemoved;
        this.pushPermission = pushPermission();
        await this.loadNotificationDevice();
        return outcome;
      }
    } catch (error) {
      this.pushPermission = pushPermission();
      this.pushErrorCode = error instanceof ApiError ? error.code
        : error instanceof Error && error.name !== "Error" ? error.name : null;
      this.pushError = error instanceof Error && error.message === "denied" ? "denied"
        : error instanceof Error && error.message === "unsupported" ? "unsupported"
        : "failed";
      return false;
    } finally {
      this.pushBusy = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.connection !== "connected") {
      this.connection = this.connectFailures >= CONNECTING_ATTEMPTS ? "disconnected" : "connecting";
    }
    if (HOSTED_MESSENGER) {
      await this.tickRemote();
      return;
    }
    const { discoverEndpoint } = await import("./local-discovery.ts");
    const endpoint = await discoverEndpoint();
    if (!endpoint) {
      this.hostUnreachable = "runtime";
      this.markDisconnected();
      this.schedule();
      return;
    }
    if (this.stopped) return;
    const health = await probeHealth(endpoint.origin);
    if (this.stopped) return;
    if (classifyHealth(health.status, health.body) !== "ours") {
      this.hostUnreachable = "runtime";
      this.markDisconnected();
      this.schedule();
      return;
    }
    if (this.connection === "connected" && this.api && this.api.kind === "local" && sameEndpoint(this.api.endpoint, endpoint)) {
      this.schedule();
      return;
    }
    try {
      await this.connectLocal(endpoint);
    } catch {
      this.hostUnreachable = "runtime";
      this.markDisconnected();
    }
    this.schedule();
  }

  private async tickRemote(): Promise<void> {
    // Clearing site data under a live page force-closes the IndexedDB connection, so the next
    // read throws. That is the state right after someone wipes a dead enrollment by hand: treat
    // it as not enrolled and let the pairing screen come back.
    let enrollment: StoredEnrollment | null = null;
    try {
      enrollment = await loadEnrollment();
    } catch {
      enrollment = null;
    }
    this.enrolled = Boolean(enrollment);
    if (!enrollment) {
      this.hostUnreachable = "host";
      this.markDisconnected();
      // Nothing to reconnect to, so this is a cheap local poll, not a relay handshake.
      this.remoteRetryMs = REMOTE_RETRY_MIN_MS;
      this.schedule();
      return;
    }
    if (this.connection === "connected" && this.api instanceof RemoteApi && this.api.enrollment.deviceId === enrollment.deviceId) {
      this.remoteRetryMs = REMOTE_RETRY_MIN_MS;
      this.schedule();
      return;
    }
    if (this.tabRole === "standby") {
      this.schedule(this.remoteRetryMs);
      return;
    }
    if (this.tabRole !== "owner" && typeof navigator !== "undefined" && supportsWebLocks(navigator.locks)) {
      const acquired = await this.acquireTabLock();
      if (!acquired) {
        this.schedule(this.remoteRetryMs);
        return;
      }
    }
    try {
      await this.connectRemote(enrollment);
      // The Mac is back: the next drop starts from the short delay again.
      this.remoteRetryMs = REMOTE_RETRY_MIN_MS;
      this.schedule();
      return;
    } catch {
      this.hostUnreachable = "host";
      this.markDisconnected();
    }
    this.schedule(this.remoteRetryMs);
    this.remoteRetryMs = nextRemoteRetry(this.remoteRetryMs);
  }

  private rememberDraftOnDisconnect(): void {
    const draft = this.draft.trim();
    if (draft && !this.draftReconnect) this.draftReconnect = { draft, confirm: false };
  }

  private async installSnapshot(api: MessengerApi, sync: EventSync, snapshot: RuntimeSnapshot): Promise<void> {
    if (this.stopped || this.api !== api || this.sync !== sync) return;
    if (api instanceof RemoteApi) api.observeSnapshot(snapshot);
    const frames = sync.install(snapshot);
    if (!frames) throw new Error("event gap during snapshot");
    this.snapshot = fromRuntimeSnapshot(snapshot);
    this.remoteStatus = snapshot.remoteStatus ?? null;
    if (snapshot.notificationCapabilities) {
      this.notificationCapabilities = parseNotificationCapabilities(snapshot.notificationCapabilities);
    }
    if (snapshot.notificationSummary) {
      this.notificationSummary = parseNotificationSummary(snapshot.notificationSummary);
      this.syncAppBadge();
    }
    if (snapshot.notificationPolicy) {
      const parsed = parseNotificationPolicy(snapshot.notificationPolicy);
      if (parsed) this.notificationPolicy = parsed;
    }
    if (this.isDesktopShell) {
      void this.pollDesktopNativeState();
      void this.reportDesktopNotificationView(false);
    }
    if (api instanceof RemoteApi) {
      void this.refreshMaintenance();
      void this.loadPushState();
    }
    this.reconcilePendingMutation(api);
    this.syncSettingsDraft(snapshot.settings);
    for (const frame of frames) this.ingest(frame.payload, frame);
    this.endpointKey = "";
    this.connection = "connected";
    this.connectFailures = 0;
    this.focusedTurnId = null;
    this.pendingFocusTrigger = null;
    if (this.draftReconnect && !this.draftReconnect.confirm) this.draft = this.draftReconnect.draft;
    const selected = this.selectedId;
    if (selected && this.snapshot.sessions.some((s) => s.id === selected)) {
      void this.selectSession(selected, { preservePage: true });
    } else if (selected) {
      this.selectedId = null;
    }
  }

  private async connectLocal(endpoint: LocalEndpoint): Promise<void> {
    const { LocalApi } = await import("./local-api.ts");
    this.resetConnection();
    const api = new LocalApi(endpoint);
    const sync = new EventSync();
    this.api = api;
    this.sync = sync;
    this.hostUnreachable = "runtime";
    await this.openSocket(api, sync);
    const snapshot = await api.snapshot();
    await this.installSnapshot(api, sync, snapshot);
  }

  private async connectRemote(enrollment: StoredEnrollment): Promise<void> {
    this.resetConnection();
    const api = new RemoteApi(enrollment, {}, this.durablePending);
    const sync = new EventSync();
    this.api = api;
    this.sync = sync;
    this.hostUnreachable = "host";
    const ready = await api.connect((frame) => {
      if (this.api !== api || this.sync !== sync) return;
      // The relay carries stream and tool frames on the same channel as events. Letting one
      // reach `EventSync` reads as a cursor mismatch and drops the link, which is what "the
      // host is unreachable" looked like the moment a terminal was opened on a phone.
      if (this.acceptEphemeral(frame)) return;
      const frames = sync.receive(frame);
      if (!frames) {
        this.markDisconnected();
        return;
      }
      for (const event of frames) this.ingest(event.payload, event);
    }, () => {
      // The link went without being asked to: the relay closed it, the Mac went away, the phone
      // changed network. Nobody is going to type to find out, so the page notices by itself and
      // the loop tries again on its own delay.
      if (this.api !== api) return;
      this.markDisconnected();
      this.reconnectNow();
    });
    const frames = sync.receive(ready);
    if (!frames) throw new Error("invalid remote ready");
    const snapshot = await api.snapshot();
    await this.installSnapshot(api, sync, snapshot);
    this.uvReady = api.uvReady;
  }

  private openSocket(api: LocalApi, sync: EventSync): Promise<void> {
    const ws = new WebSocket(api.eventsUrl());
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        reject(new Error("event subscription timeout"));
        ws.close();
      }, 5000);
      ws.addEventListener("open", () => ws.send(api.authFrame()));
      ws.addEventListener("message", (ev) => {
        if (this.ws !== ws) return;
        const raw = String(ev.data);
        // Ephemeral frames ride the same socket but not the event cursor, so they have to leave
        // before the sequenced path, which reads anything without an instance id as a gap.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        if (this.acceptEphemeral(parsed)) return;
        const frame = api.parseSyncFrame(raw);
        if (!frame || (!ready && frame.type !== "ready")) {
          reject(new Error("invalid event stream"));
          this.markDisconnected();
          return;
        }
        if (frame.type === "ready") {
          ready = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        const frames = sync.receive(frame);
        if (!frames) {
          reject(new Error("event gap"));
          this.markDisconnected();
          return;
        }
        for (const event of frames) this.ingest(event.payload, event);
      });
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        reject(new Error("event socket closed"));
        if (this.ws === ws) this.markDisconnected();
      });
      ws.addEventListener("error", () => ws.close());
    });
  }

  private syncSettingsDraft(settings: {
    workspace_path: string | null;
    endpoint_base_url: string | null;
    endpoint_models: string[];
    endpoint_default_model: string | null;
  }): void {
    this.workspacePath = settings.workspace_path ?? "";
    this.endpointUrl = settings.endpoint_base_url ?? "";
    this.endpointModelsText = settings.endpoint_models.join("\n");
    this.endpointDefaultModel = settings.endpoint_default_model ?? "";
  }

  private rememberDurablePending(api: MessengerApi): void {
    if (api instanceof RemoteApi) this.durablePending = api.durablePending();
  }

  private reconcilePendingMutation(api: MessengerApi): void {
    if (this.api !== api) return;
    if (this.pendingMutation && !api.hasPendingRequest(this.pendingMutation.id)) this.pendingMutation = null;
    this.rememberDurablePending(api);
  }

  private keepUnknownRequest(error: unknown, api: MessengerApi): boolean {
    if (!(error instanceof ApiError) || !error.requestId) return false;
    const pending = api.hasPendingRequest(error.requestId);
    const resumable = ["key_write_pending", "request_pending", "request_unknown"].includes(error.code);
    if (pending && resumable) this.pendingMutation = { id: error.requestId, code: error.code };
    else if (this.pendingMutation?.id === error.requestId) this.pendingMutation = null;
    this.rememberDurablePending(api);
    return pending && resumable;
  }

  private sheetFailure(error: unknown, api: MessengerApi): ApiError | null {
    if (this.api !== api) return null;
    if (error instanceof ApiError && error.requestId) {
      const pending = this.keepUnknownRequest(error, api);
      if (!pending && ["key_write_pending", "request_pending", "request_unknown"].includes(error.code)) return null;
    }
    if (
      error instanceof ApiError &&
      (error.status === 422 || error.status === 404 || error.status === 409 || ["key_write_pending", "request_pending", "request_unknown"].includes(error.code))
    ) {
      return error;
    }
    this.markDisconnected();
    return null;
  }

  private async ensureMessageLoaded(sessionId: string, messageId: string): Promise<void> {
    const api = this.api;
    const sync = this.sync;
    const view = this.sessionView(sessionId);
    const connection = this.connectionSeq;
    const selection = view.loadSeq;
    const revision = view.revision;
    if (!api) return;
    const loaded = this.snapshot.messages.filter((m) => m.session_id === sessionId);
    if (loaded.some((m) => m.id === messageId)) return;
    const result = await collectUntilMessage(
      loaded,
      messageId,
      (cursor) => api.messages(sessionId, { cursor }),
      this.sessionMessageNext,
    );
    if (this.selectedId !== sessionId || this.api !== api || this.sync !== sync ||
      this.connectionSeq !== connection || view.loadSeq !== selection || view.revision !== revision) return;
    this.sessionMessageNext = result.next;
    const current = new Map(this.snapshot.messages.map((message) => [message.id, message]));
    for (const message of result.messages) if (!current.has(message.id)) current.set(message.id, message);
    this.snapshot = { ...this.snapshot, messages: [...current.values()] };
  }

  private applySessionDetail(
    id: string,
    detail: SessionDetail,
    judgements: Snapshot["judgements"],
  ): void {
    this.sessionDetailId = id;
    this.sessionMessageNext = detail.messages.next ?? null;
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((s) =>
        s.id === id
          ? {
              id: detail.id,
              kind: detail.kind,
              name: detail.name,
              last_read_at: detail.last_read_at ?? s.last_read_at ?? null,
              archived_at: detail.archived_at ?? s.archived_at ?? null,
              origin_session_id: detail.origin_session_id ?? s.origin_session_id ?? null,
              origin_message_id: detail.origin_message_id ?? s.origin_message_id ?? null,
              created_at: detail.created_at,
              updated_at: detail.updated_at,
              participants: detail.participants,
              last_message: s.last_message,
              live_turns: s.live_turns,
              unread_count: detail.unread_count ?? s.unread_count ?? 0,
              notification_preference: detail.notification_preference ?? s.notification_preference,
            }
          : s,
      ),
      messages: [
        ...this.snapshot.messages.filter((m) => m.session_id !== id),
        ...detail.messages.items,
      ],
      turns: [
        ...this.snapshot.turns.filter((t) => t.session_id !== id),
        ...detail.turns,
      ],
      judgements: [
        ...this.snapshot.judgements.filter((j) => j.session_id !== id),
        ...judgements,
      ],
      pendingJudgements: [
        ...this.snapshot.pendingJudgements.filter((j) => j.session_id !== id),
        ...(detail.pending_judgements ?? []),
      ],
    };
  }

  private ingest(event: ClientEvent, frame?: SequencedEvent): void {
    if (frame) this.api?.observeCredentialFrame(frame);
    if (event.event === "terminal.upsert") {
      const { event: _event, occurred_at: _at, ...row } = event;
      const rest = this.terminals.filter((existing) => existing.id !== row.id);
      this.terminals = [...rest, row];
    }
    if (event.event === "terminal.removed") {
      this.terminals = this.terminals.filter((existing) => existing.id !== event.id);
    }
    if (this.api) this.reconcilePendingMutation(this.api);
    if (event.event === "session.cleared" || event.event === "session.removed") {
      // Only that conversation's reads are invalidated; another pane's are none of its business.
      const gone = this.views.get(event.id);
      if (gone) {
        gone.revision++;
        gone.resetHistory();
      }
    }
    if (event.event === "session.removed") {
      if (this.selectedId === event.id) {
        this.selectedId = null;
        this.closeSessionSettings();
        this.focusedTurnId = null;
        this.setHighlightedMessage(null);
        this.sessionMessageNext = null;
        this.sessionDetailId = null;
      }
    }
    if (event.event === "session.cleared") {
      if (this.selectedId === event.id) {
        this.focusedTurnId = null;
        this.setHighlightedMessage(null);
        this.sessionMessageNext = null;
        this.sessionDetailId = null;
      }
    }
    let next = applyEvent(this.snapshot, event);
    this.snapshot = next;
    if (event.event === "notification.upsert") {
      this.notificationInboxState = upsertInboxItem(this.notificationInboxState, event as unknown as NotificationItem);
      this.syncAppBadge();
    }
    if (event.event === "notification.removed" && typeof event.id === "string") {
      this.notificationInboxState = removeInboxItem(this.notificationInboxState, event.id);
      this.syncAppBadge();
    }
    if (event.event === "notification.summary") {
      this.notificationSummary = event.summary;
      this.notificationInboxState = applySummary(this.notificationInboxState, event.summary);
      this.syncAppBadge();
    }
    if (event.event === "notification_policy.changed") {
      const { event: _e, occurred_at: _at, ...policy } = event;
      this.notificationPolicy = policy;
    }
    if (this.api instanceof RemoteApi) this.api.observeSnapshot(this.snapshot);
    if (event.event === "settings.changed") {
      this.syncSettingsDraft(event);
    }
    if (event.event === "turn.upsert") {
      this.claimFocus(event.trigger_message_id, event.id);
      if (this.routeLogOpen && event.session_id === this.selectedId) {
        void this.refreshRoutes(event.session_id);
      }
      if (this.traceOpen && event.task_id && event.task_id === this.traceTaskId) this.traceReload += 1;
    }
    if (
      (event.event === "message.created" || event.event === "message.upsert") &&
      this.traceOpen &&
      event.task_id &&
      event.task_id === this.traceTaskId
    ) {
      this.traceReload += 1;
    }
    if (
      (event.event === "message.created" || event.event === "message.upsert" || event.event === "session.cleared") &&
      this.selectedId &&
      (event.event === "session.cleared" ? event.id : event.session_id) === this.selectedId
    ) {
      this.scheduleComposerSuggestions(this.selectedId);
    }
  }

  private claimFocus(triggerMessageId: string, turnId?: string): void {
    if (this.pendingFocusTrigger !== triggerMessageId) return;
    const id =
      turnId ??
      this.snapshot.turns.find((turn) => turn.trigger_message_id === triggerMessageId)?.id;
    if (!id) return;
    this.focusedTurnId = id;
    this.pendingFocusTrigger = null;
  }

  private resetConnection(): void {
    this.rememberDraftOnDisconnect();
    this.boundedReadSent.clear();
    this.connectFailures += 1;
    this.connection = this.connectFailures >= CONNECTING_ATTEMPTS ? "disconnected" : "connecting";
    this.teardownSocket();
    if (this.api instanceof RemoteApi) {
      this.durablePending = this.api.durablePending();
      this.api.close();
    } else if (this.api) {
      this.pendingMutation = null;
      this.durablePending = [];
    }
    this.api = null;
    this.sync?.close();
    this.sync = null;
    this.sessionLoad = Promise.resolve();
    this.sessionDetailId = null;
    this.sessionMessageNext = null;
    this.connectionSeq++;
    this.busy = false;
  }

  /**
   * Receive one stream's bytes until the caller lets go. Watching is asked for over HTTP; this
   * only says where the frames should land once they arrive.
   */
  /**
   * Take a stream or tool frame off the socket. True means it was one and the sequenced reader
   * must not see it.
   */
  private acceptEphemeral(value: unknown): value is StreamFrame | ToolFrame {
    const stream = parseStreamFrame(value);
    if (stream) {
      // A copy: a reader that lets go while the frame is being delivered must not skip its peers.
      for (const sink of [...(this.streamSinks.get(stream.id) ?? [])]) sink(stream);
      this.activity.applyStream(stream);
      this.activityRevision += 1;
      return true;
    }
    const tool = parseToolFrame(value);
    if (!tool) return false;
    this.activity.applyTool(tool);
    this.activityRevision += 1;
    // A command's bytes are only worth carrying while someone can see them run — and only for
    // the conversation that is open. A phone on a radio should not receive the output of a
    // build happening in a session nobody is looking at.
    const streamId = `${tool.turn_id}:${tool.id}`;
    if (tool.phase === "started" && this.watchesTurn(tool.turn_id)) void this.watchCommand(streamId);
    if (tool.phase === "exited") void this.unwatchCommand(streamId);
    return true;
  }

  /** Whether this turn belongs to the conversation on screen. */
  private watchesTurn(turnId: string): boolean {
    if (!this.selectedId) return false;
    return this.snapshot.turns.some((turn) => turn.id === turnId && turn.session_id === this.selectedId);
  }

  /** Ask the daemon to send a command's bytes. Nothing is sent to a client that never asks. */
  private async watchCommand(id: string): Promise<void> {
    try {
      await this.api?.watchCommand(id, 0);
    } catch {
      // A command whose output cannot be followed still runs; the turn is what matters.
    }
  }

  private async unwatchCommand(id: string): Promise<void> {
    try {
      await this.api?.unwatchCommand(id);
    } catch {
      // Nothing to undo: the stream ends with the command either way.
    }
  }

  onStream(id: string, sink: (frame: StreamFrame) => void): () => void {
    let sinks = this.streamSinks.get(id);
    if (!sinks) {
      sinks = new Set();
      this.streamSinks.set(id, sinks);
    }
    sinks.add(sink);
    return () => {
      const current = this.streamSinks.get(id);
      if (!current?.delete(sink)) return;
      // The id is dropped only once nobody is left, so a second reader keeps the entry alive.
      if (current.size === 0) this.streamSinks.delete(id);
    };
  }

  private markDisconnected(): void {
    this.resetConnection();
    this.closeSheets();
    this.searchHits = [];
    this.composerSuggestions = [];
    this.cancelComposerSuggestions();
    this.focusedTurnId = null;
    this.setHighlightedMessage(null);
    this.pendingFocusTrigger = null;
    this.sessionMessageNext = null;
  }

  private cancelComposerSuggestions(): void {
    if (this.suggestTimer) {
      clearTimeout(this.suggestTimer);
      this.suggestTimer = null;
    }
    this.suggestAbort?.abort();
    this.suggestAbort = null;
  }

  /**
   * Composer chips follow the transcript, not a live stream. Debounce so a burst of Bot messages
   * only pays for one short call, and abort the in-flight one when the user switches sessions.
   */
  private scheduleComposerSuggestions(sessionId: string): void {
    this.cancelComposerSuggestions();
    if (!this.api || this.selectedId !== sessionId) {
      this.composerSuggestions = [];
      return;
    }
    // These draft what you would send. A Bot↔Bot direct has no composer to put them in.
    const session = this.snapshot.sessions.find((s) => s.id === sessionId);
    if (session && classifySession(session) === "bot-bot") {
      this.composerSuggestions = [];
      return;
    }
    this.suggestTimer = setTimeout(() => {
      this.suggestTimer = null;
      void this.refreshComposerSuggestions(sessionId);
    }, 400);
  }

  private async refreshComposerSuggestions(sessionId: string): Promise<void> {
    if (!this.api || this.selectedId !== sessionId) return;
    this.suggestAbort?.abort();
    const abort = new AbortController();
    this.suggestAbort = abort;
    const seq = ++this.suggestSeq;
    try {
      const items = await this.api.composerSuggestions(sessionId, abort.signal);
      if (seq !== this.suggestSeq || this.selectedId !== sessionId) return;
      this.composerSuggestions = items;
    } catch (error) {
      if (abort.signal.aborted) return;
      if (seq !== this.suggestSeq || this.selectedId !== sessionId) return;
      this.composerSuggestions = [];
      void error;
    } finally {
      if (this.suggestAbort === abort) this.suggestAbort = null;
    }
  }

  setHighlightedMessage(messageId: string | null): void {
    this.clearHighlightTimer();
    this.highlightedMessageId = messageId;
    if (!messageId) return;
    this.searchHighlightToken += 1;
    this.highlightTimer = setTimeout(() => {
      if (this.highlightedMessageId === messageId) this.highlightedMessageId = null;
      this.highlightTimer = null;
    }, 4000);
  }

  private clearHighlightTimer(): void {
    if (!this.highlightTimer) return;
    clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
  }

  private teardownSocket(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  private schedule(delay = RETRY_MS): void {
    if (this.stopped) return;
    // One timer, always the newest: a drop landing while a tick is in flight must not leave two
    // loops running, which on a relay that allows ten handshakes a minute is a way to be refused.
    if (this.timer) clearTimeout(this.timer);
    this.nextAttemptAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.pump();
    }, delay);
  }

  /**
   * Try now — as soon as the delay the loop already owes allows it. A phone comes back from a
   * dropped link, a locked screen or a changed network with its timers frozen and no interaction
   * to ride on, and asking again is worth nothing if the relay refuses it: the handshake budget
   * is spent per minute, so a page that just tried still waits, and one frozen for an hour does
   * not.
   */
  private reconnectNow(): void {
    if (this.stopped || this.connection === "connected") return;
    this.schedule(Math.max(0, this.nextAttemptAt - Date.now()));
  }

  /** A tick that throws must still leave a timer behind, or the page never reconnects. */
  private pump(): void {
    // An attempt already running owns the next one; a second pass would open a second socket for
    // the same device, which the relay refuses while the first route is still there.
    if (this.ticking) return;
    this.ticking = true;
    void this.tick()
      .catch(() => {
        this.markDisconnected();
        this.schedule();
      })
      .finally(() => {
        this.ticking = false;
      });
  }
}

function sameEndpoint(a: LocalEndpoint, b: LocalEndpoint): boolean {
  return a.origin === b.origin && a.token === b.token;
}
