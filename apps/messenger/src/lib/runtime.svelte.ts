import {
  FILE_DROP_SESSION_ID,
  USER_MEMBER,
  type Attachment,
  type CatchupResponse,
  type ClientEvent,
  type EventCursor,
  type SyncFrame,
  type SequencedEvent,
  type CreateBotRequest,
  type CreateGroupRequest,
  type PatchMemoryRequest,
  type CreateProviderRequest,
  type PatchProviderRequest,
  type ProbeModelsResponse,
  type ResolveApprovalRequest,
  type ComposerSuggestion,
  type ControlActionResult,
  type ControlOffer,
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
  type Annotation,
  type AnnotationFilter,
  type CreateAnnotationRequest,
  type PatchAnnotationRequest,
} from "@real-bot/protocol";
import { ApiError, probeHealth } from "./api.ts";
import type { FileProgress } from "./file-progress.ts";
import { CommandActivity } from "./chat/command-activity.ts";
import { TurnActivity, type ToolStep } from "./chat/turn-activity.ts";
import { parseStreamFrame, parseToolFrame } from "./ephemeral-frames.ts";
import type { LocalEndpoint } from "./discovery.ts";
import { classifyHealth } from "./health.ts";
import { collectUntilMessage } from "./sidebar/search-jump.ts";
import { classifySession, isFileDropSession, youBotSession } from "./sidebar/session-groups.ts";
import { applyEvent, emptySnapshot, fromRuntimeSnapshot, type Snapshot } from "./snapshot.ts";
import { canonicalRelpath, mergeAnnotationRows } from "./annotations/model.ts";
import { EventSync } from "./event-sync.ts";
import { SessionView } from "./session-view.svelte.ts";
import type { TraceFocus } from "./overlays/task-trace.ts";
import type { PaneContent } from "./workbench/pane-content.ts";
import { isLiveStatus, stopTarget } from "./chat/transcript.ts";
import type { UrlOverlay } from "./session-url.ts";
import { HOSTED_MESSENGER } from "./remote/mode.ts";
import type { LocalApi } from "./local-api.ts";
import type { MessengerApi } from "./messenger-api.ts";
import { RemoteApi, type DurablePendingRequest, type RemoteDeviceRow, type RemoteMaintenanceStatus } from "./remote/api.ts";
import { loadEnrollment, type StoredEnrollment } from "./remote/idb.ts";
import { isInboxMessage, pushPermission } from "./remote/push.ts";
import type { DisablePushResult, PushPermission } from "./remote/push.ts";
import type { PairingProgress } from "./remote/pairing.ts";
import type { HostDevice, HostRelay } from "./remote/pairing-host.ts";
import { supportsWebLocks } from "./notifications/tab-owner.ts";
import type { TabRole } from "./notifications/tab-owner.ts";
import type { InboxState } from "./notifications/inbox-state.ts";
import type {
  AskDraftRecord,
  NativeFocusFacts,
  NativeNotificationCapabilities,
  NotificationCapabilities,
  NotificationDevice,
  NotificationDevicePatch,
  NotificationFilter,
  NotificationItem,
  NotificationPolicy,
  NotificationPolicyPatch,
  NotificationSummary,
  PushRecovery,
  PushStateV2,
  PushTransport,
  SendAskResult,
} from "./notifications/types.ts";
import {
  parseNotificationCapabilities,
  parseNotificationPolicy,
  parseNotificationSummary,
} from "./notifications/parse.ts";
import {
  askSubmitAllowed,
  classifySendAskFailure,
  clearAskIfMatching,
  nextDraftVersion,
  recordAskError,
} from "./notifications/ask-state.ts";
import { NotificationCenter, type NotificationCenterHost } from "./notifications/notification-center.svelte.ts";
import { TabOwnership, type TabOwnershipHost } from "./notifications/tab-ownership.svelte.ts";
import { RemoteAdmin, type RemoteAdminHost } from "./remote/remote-admin.svelte.ts";

/**
 * `connecting` is a real state, not a flavour of `disconnected`: a page that is still trying
 * should not accuse the Mac of being unreachable, and one that has been trying for a while
 * should not pretend it is still about to work.
 */
export type Connection = "connecting" | "connected" | "disconnected";
export type HostUnreachable = "runtime" | "host";
/** A draft kept across a dropped connection, and the conversation it was being written in. */
export type DraftReconnect = { sessionId: string; draft: string; confirm: boolean } | null;

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
/** Attempts that still read as "connecting" before the page says the host cannot be reached. */
const CONNECTING_ATTEMPTS = 3;
/**
 * Past this many missed events a phone takes the snapshot instead: replaying hundreds of frames
 * costs about what the snapshot does, and the snapshot also re-reads the open conversation.
 */
const RESUME_MAX_EVENTS = 300;

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
  /**
   * The notifications/push/desktop-native cluster, tab ownership, and remote pairing/maintenance
   * each live in their own class below. Every field and method on `MessengerRuntime` that touches
   * one of these domains forwards to it, under the same public name components and tests already
   * use. Each sub-store gets a host adapter built here, not this object itself: the adapter's
   * getters and methods read `runtime.x` fresh on every call, so a test that replaces `api`,
   * `sync`, or a method on this instance is seen by the sub-store too, while the fields themselves
   * stay `private`.
   */
  private readonly notificationCenter: NotificationCenter = new NotificationCenter(this.notificationCenterHost());
  private readonly tabOwnership: TabOwnership = new TabOwnership(this.tabOwnershipHost());
  private readonly remoteAdmin: RemoteAdmin = new RemoteAdmin(this.remoteAdminHost());

  private notificationCenterHost(): NotificationCenterHost {
    const runtime = this;
    return {
      get api() { return runtime.api; },
      get sync() { return runtime.sync; },
      get snapshot() { return runtime.snapshot; },
      set snapshot(value) { runtime.snapshot = value; },
      get selectedId() { return runtime.selectedId; },
      set selectedId(value) { runtime.selectedId = value; },
      get connection() { return runtime.connection; },
      get isDesktopShell() { return runtime.isDesktopShell; },
      get stopped() { return runtime.stopped; },
      get remoteStatus() { return runtime.remoteStatus; },
      selectSession: (id, opts) => runtime.selectSession(id, opts),
      closeSheets: () => runtime.closeSheets(),
    };
  }

  private tabOwnershipHost(): TabOwnershipHost {
    const runtime = this;
    return {
      resetConnection: () => runtime.resetConnection(),
      tick: () => runtime.tick(),
      dispatchNotificationIntent: (intent) => runtime.dispatchNotificationIntent(intent),
    };
  }

  private remoteAdminHost(): RemoteAdminHost {
    const runtime = this;
    return {
      get api() { return runtime.api; },
      get remote() { return runtime.remote; },
      get stopped() { return runtime.stopped; },
      start: () => runtime.start(),
      sessionView: (id) => runtime.sessionView(id),
    };
  }

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
   * Every conversation that is open, by id: each pane on the workbench reads its own. A plain map,
   * so a pane can make its conversation's view while it renders — a view is made once and never
   * replaced, its fields are what is reactive, and `selectedId` makes the selected one's view
   * before it moves, so the forwards below never read a view that is not there yet.
   */
  private readonly views = new Map<string, SessionView>();

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

  /** The view an action is about: the conversation it names, or the selected one. */
  private viewFor(sessionId: string | null | undefined): SessionView | null {
    return sessionId ? this.sessionView(sessionId) : this.activeView;
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

  /** Whether the selected conversation has a send in flight. Each conversation has its own. */
  get busy(): boolean { return this.activeView?.sending ?? false; }
  set busy(value: boolean) { const view = this.activeView; if (view) view.sending = value; }

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
  /** The annotation a card or a row asked the preview to scroll to; cleared with the preview. */
  annotationFocusId = $state<string | null>(null);
  /**
   * The file each previewed path resolves to, as the daemon named it on the rows it returned for
   * that path: how a preview recognises annotations made on another spelling of the same file.
   */
  annotationFileKeys = $state<Record<string, string>>({});
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
  /** Bumped when a turn or message of the open job changes, so the trace pulls again. */
  traceReload = $state(0);
  profileBotId = $state<string | null>(null);
  profileRoutineId = $state<string | null>(null);
  workspaceOpen = $state(false);
  /** The roster calendar. It replaces the main column; it is not a fourth phone destination. */
  routinesOpen = $state(false);
  /** The spend ledger, same shape as the calendar: one pane on the desktop, a page below 680. */
  spendOpen = $state(false);
  /**
   * Climbs on `spend.created` and `spend.repriced`. The rows themselves are not kept: a view that is open debounces
   * a reload of the summary off this, and one that is closed reads it when it next opens.
   */
  spendRevision = $state(0);
  workspaceSelected = $state("");
  threadOpen = $state(false);
  searchQuery = $state("");
  searchHits = $state<SearchHit[]>([]);
  searchLoading = $state(false);
  searchError = $state(false);
  pendingMutation = $state<{ id: string; code: string } | null>(null);
  workspacePath = $state("");
  endpointUrl = $state("");
  endpointKey = $state("");
  endpointModelsText = $state("");
  endpointDefaultModel = $state("");
  previewAttachmentId = $state<string | null>(null);
  hosted = HOSTED_MESSENGER;
  // --- Forwarded to `remoteAdmin` (pairing, host pairing/devices, draft-reconnect, maintenance). ---
  get pairing(): PairingProgress { return this.remoteAdmin.pairing; }
  set pairing(value: PairingProgress) { this.remoteAdmin.pairing = value; }
  get pairingBusy(): boolean { return this.remoteAdmin.pairingBusy; }
  set pairingBusy(value: boolean) { this.remoteAdmin.pairingBusy = value; }
  /** Host side of pairing: what the settings panel shows while a device is being enrolled. */
  get hostPairing(): HostPairing { return this.remoteAdmin.hostPairing; }
  set hostPairing(value: HostPairing) { this.remoteAdmin.hostPairing = value; }
  get hostPairingBusy(): boolean { return this.remoteAdmin.hostPairingBusy; }
  set hostPairingBusy(value: boolean) { this.remoteAdmin.hostPairingBusy = value; }
  get hostDevices(): HostDevice[] { return this.remoteAdmin.hostDevices; }
  set hostDevices(value: HostDevice[]) { this.remoteAdmin.hostDevices = value; }
  get hostDevicesBusy(): boolean { return this.remoteAdmin.hostDevicesBusy; }
  set hostDevicesBusy(value: boolean) { this.remoteAdmin.hostDevicesBusy = value; }
  get hostDevicesError(): string | null { return this.remoteAdmin.hostDevicesError; }
  set hostDevicesError(value: string | null) { this.remoteAdmin.hostDevicesError = value; }
  get hostRemoveDeviceId(): string | null { return this.remoteAdmin.hostRemoveDeviceId; }
  set hostRemoveDeviceId(value: string | null) { this.remoteAdmin.hostRemoveDeviceId = value; }
  get hostSetupBusy(): boolean { return this.remoteAdmin.hostSetupBusy; }
  set hostSetupBusy(value: boolean) { this.remoteAdmin.hostSetupBusy = value; }
  get hostSetupError(): string | null { return this.remoteAdmin.hostSetupError; }
  set hostSetupError(value: string | null) { this.remoteAdmin.hostSetupError = value; }
  /** How long to wait before the next relay handshake; grows while the Mac is unreachable. */
  private remoteRetryMs = REMOTE_RETRY_MIN_MS;
  get enrolled(): boolean { return this.remoteAdmin.enrolled; }
  set enrolled(value: boolean) { this.remoteAdmin.enrolled = value; }
  get hostUnreachable(): HostUnreachable { return this.remoteAdmin.hostUnreachable; }
  set hostUnreachable(value: HostUnreachable) { this.remoteAdmin.hostUnreachable = value; }
  get draftReconnect(): DraftReconnect { return this.remoteAdmin.draftReconnect; }
  set draftReconnect(value: DraftReconnect) { this.remoteAdmin.draftReconnect = value; }
  get remoteStatus(): RuntimeSnapshot["remoteStatus"] | null { return this.remoteAdmin.remoteStatus; }
  set remoteStatus(value: RuntimeSnapshot["remoteStatus"] | null) { this.remoteAdmin.remoteStatus = value; }
  get uvReady(): boolean { return this.remoteAdmin.uvReady; }
  set uvReady(value: boolean) { this.remoteAdmin.uvReady = value; }
  get uvError(): string | null { return this.remoteAdmin.uvError; }
  set uvError(value: string | null) { this.remoteAdmin.uvError = value; }
  get maintenance(): RemoteMaintenanceStatus | null { return this.remoteAdmin.maintenance; }
  set maintenance(value: RemoteMaintenanceStatus | null) { this.remoteAdmin.maintenance = value; }
  get maintenanceBusy(): boolean { return this.remoteAdmin.maintenanceBusy; }
  set maintenanceBusy(value: boolean) { this.remoteAdmin.maintenanceBusy = value; }
  get maintenanceError(): string | null { return this.remoteAdmin.maintenanceError; }
  set maintenanceError(value: string | null) { this.remoteAdmin.maintenanceError = value; }
  get maintenanceForceConfirm(): boolean { return this.remoteAdmin.maintenanceForceConfirm; }
  set maintenanceForceConfirm(value: boolean) { this.remoteAdmin.maintenanceForceConfirm = value; }
  get maintenanceStopConfirm(): boolean { return this.remoteAdmin.maintenanceStopConfirm; }
  set maintenanceStopConfirm(value: boolean) { this.remoteAdmin.maintenanceStopConfirm = value; }
  get maintenanceRevokeId(): string | null { return this.remoteAdmin.maintenanceRevokeId; }
  set maintenanceRevokeId(value: string | null) { this.remoteAdmin.maintenanceRevokeId = value; }

  // --- Forwarded to `notificationCenter` (notifications, push, desktop-native, presence). ---
  get pushEnabled(): boolean { return this.notificationCenter.pushEnabled; }
  set pushEnabled(value: boolean) { this.notificationCenter.pushEnabled = value; }
  get pushBusy(): boolean { return this.notificationCenter.pushBusy; }
  set pushBusy(value: boolean) { this.notificationCenter.pushBusy = value; }
  get pushError(): string | null { return this.notificationCenter.pushError; }
  set pushError(value: string | null) { this.notificationCenter.pushError = value; }
  get pushErrorCode(): string | null { return this.notificationCenter.pushErrorCode; }
  set pushErrorCode(value: string | null) { this.notificationCenter.pushErrorCode = value; }
  get pushPermission(): PushPermission { return this.notificationCenter.pushPermission; }
  set pushPermission(value: PushPermission) { this.notificationCenter.pushPermission = value; }

  get notificationSummary(): NotificationSummary { return this.notificationCenter.notificationSummary; }
  set notificationSummary(value: NotificationSummary) { this.notificationCenter.notificationSummary = value; }
  get notificationPolicy(): NotificationPolicy | null { return this.notificationCenter.notificationPolicy; }
  set notificationPolicy(value: NotificationPolicy | null) { this.notificationCenter.notificationPolicy = value; }
  get notificationDevice(): NotificationDevice | null { return this.notificationCenter.notificationDevice; }
  set notificationDevice(value: NotificationDevice | null) { this.notificationCenter.notificationDevice = value; }
  get notificationCapabilities(): NotificationCapabilities { return this.notificationCenter.notificationCapabilities; }
  set notificationCapabilities(value: NotificationCapabilities) { this.notificationCenter.notificationCapabilities = value; }
  get nativeCapabilities(): NativeNotificationCapabilities { return this.notificationCenter.nativeCapabilities; }
  set nativeCapabilities(value: NativeNotificationCapabilities) { this.notificationCenter.nativeCapabilities = value; }
  get notificationInboxState(): InboxState { return this.notificationCenter.notificationInboxState; }
  set notificationInboxState(value: InboxState) { this.notificationCenter.notificationInboxState = value; }
  get pushTransport(): PushTransport { return this.notificationCenter.pushTransport; }
  set pushTransport(value: PushTransport) { this.notificationCenter.pushTransport = value; }
  get pushSubscribed(): boolean { return this.notificationCenter.pushSubscribed; }
  set pushSubscribed(value: boolean) { this.notificationCenter.pushSubscribed = value; }
  get pushRecovery(): PushRecovery { return this.notificationCenter.pushRecovery; }
  set pushRecovery(value: PushRecovery) { this.notificationCenter.pushRecovery = value; }
  get remoteGated(): boolean { return this.notificationCenter.remoteGated; }
  set remoteGated(value: boolean) { this.notificationCenter.remoteGated = value; }
  get isDesktopShell(): boolean {
    return !HOSTED_MESSENGER && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  }
  askDrafts = $state<Map<string, AskDraftRecord>>(new Map());
  get instanceId(): string { return this.notificationCenter.instanceId; }
  // --- Forwarded to `tabOwnership`. ---
  get tabRole(): TabRole { return this.tabOwnership.tabRole; }
  set tabRole(value: TabRole) { this.tabOwnership.tabRole = value; }
  get tabTakeoverTimeout(): boolean { return this.tabOwnership.tabTakeoverTimeout; }
  set tabTakeoverTimeout(value: boolean) { this.tabOwnership.tabTakeoverTimeout = value; }
  get nativeFocusFacts(): NativeFocusFacts { return this.notificationCenter.nativeFocusFacts; }
  set nativeFocusFacts(value: NativeFocusFacts) { this.notificationCenter.nativeFocusFacts = value; }
  private get tabChannel(): BroadcastChannel | null { return this.tabOwnership.tabChannel; }
  private set tabChannel(value: BroadcastChannel | null) { this.tabOwnership.tabChannel = value; }
  private get releaseLock(): (() => void) | null { return this.tabOwnership.releaseLock; }
  private set releaseLock(value: (() => void) | null) { this.tabOwnership.releaseLock = value; }
  private get presenceTimer(): ReturnType<typeof setInterval> | null { return this.notificationCenter.presenceTimer; }
  private set presenceTimer(value: ReturnType<typeof setInterval> | null) { this.notificationCenter.presenceTimer = value; }

  private api: MessengerApi | null = null;
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
  /**
   * The step each running turn is in, or last finished — the line that replaces a bare "思考中".
   * Its own revision: command output moves {@link activityRevision} many times a second, and the
   * lines under every message need not follow that.
   */
  private readonly turnActivity = new TurnActivity();
  toolRevision = $state(0);
  /**
   * When this client last started listening for tool frames. They are not replayed, so a turn
   * that began earlier may have steps it never saw.
   */
  listeningSince = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the loop owes its next attempt. A wake-up may bring the timer here, never past it. */
  private nextAttemptAt = 0;
  private ticking = false;
  private stopped = false;
  private searchSeq = 0;
  private sync: EventSync | null = null;
  /**
   * Where the page was when its last remote link went: the event cursor it had applied and each
   * open conversation's history state. Coming back to the same Mac, it replays only what it
   * missed from here — a few KB — instead of the whole snapshot and every open transcript.
   */
  private resumePoint: {
    cursor: EventCursor;
    views: Map<SessionView, { detailLoaded: boolean; messageNext: string | null }>;
  } | null = null;
  private sessionLoad = Promise.resolve();
  /**
   * Bumped when the connection is replaced. The per-conversation counters say "a newer read of
   * this conversation started"; this one says "every read in flight belongs to a dead socket".
   * They were one counter, which is why loading a second conversation cancelled the first.
   */
  private connectionSeq = 0;
  /**
   * While an annotation list is on its way, the ids an event or a write's reply changed since, by
   * a running count: the list was read before them, so for those rows the snapshot is the newer
   * word. Only kept while a list is in flight.
   */
  private annotationWriteSeq = 0;
  private readonly annotationWrites = new Map<string, number>();
  private annotationLoads = 0;
  private profileNavigation = 0;
  private durablePending: DurablePendingRequest[] = [];

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
    this.closeSearch();
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
    for (const view of this.views.values()) this.clearHighlightTimer(view);
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
    this.spendOpen = false;
    this.terminalOpen = false;
    this.createBotOpen = true;
  }

  openCreateGroup(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.createGroupOpen = true;
  }

  openSessionSettings(): void {
    if (this.selectedId && this.toPane({ kind: "chat", sessionId: this.selectedId, side: { kind: "settings", botId: null } })) return;
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

  private toPane(content: PaneContent): boolean {
    const open = this.paneOpener;
    if (!open) return false;
    open(content);
    return true;
  }

  /** Sessions the daemon holds. Lifecycle only; the bytes are a stream, not state. */
  terminals = $state<Terminal[]>([]);
  /** Whether `terminals` has been read at all. An empty list before that means "not asked yet". */
  terminalsLoaded = $state(false);
  terminalOpen = $state(false);

  /**
   * The phone's terminal page. A wide window still opens a pane; below the breakpoint this is a
   * page in the URL, the way the calendar is.
   */
  openTerminal(): void {
    void this.refreshTerminals();
    if (this.toPane({ kind: "terminal", terminalId: null })) return;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.clearTrace();
    this.threadOpen = false;
    this.previewRelpath = null;
    this.previewAttachmentId = null;
    this.previewTaskId = null;
    this.previewSiblings = null;
    void this.refreshTerminals();
    this.terminalOpen = true;
  }

  /**
   * A new shell in the workspace (or in `cwd`, a folder in it), in the list before the next read
   * comes back: a desktop tab bound to it must not be healed away for naming a session nobody has
   * heard of yet. Null when there is no workspace or the daemon would not start one; the tab says
   * so itself.
   */
  async startTerminal(cwd?: string): Promise<Terminal | null> {
    const api = this.api;
    const root = this.snapshot.settings.workspace_path;
    const where = cwd ?? root;
    if (!api || !root || !where) return null;
    try {
      const created = await api.openTerminal(where, 24, 80);
      if (this.api === api && !this.terminals.some((row) => row.id === created.id)) {
        this.terminals = [...this.terminals, created];
      }
      return created;
    } catch {
      return null;
    }
  }

  /**
   * A shell started in `cwd` and put in front of you: a tab of its own on the desktop, the phone's
   * terminal page elsewhere, which shows the newest live session first. Nothing opens when the
   * shell would not start.
   */
  async openTerminalAt(cwd: string): Promise<void> {
    const created = await this.startTerminal(cwd);
    if (!created) return;
    if (this.toPane({ kind: "terminal", terminalId: created.id, cwd: created.cwd })) return;
    this.openTerminal();
  }

  /** The daemon is the list's source of truth; events keep it fresh after this first read. */
  async refreshTerminals(): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const items = await api.terminals();
      if (this.api === api) {
        this.terminals = items;
        this.terminalsLoaded = true;
      }
    } catch {
      // A list that will not load is not worth a banner; the pane shows its own failure.
    }
  }

  closeTerminal(): void {
    this.terminalOpen = false;
  }

  /** Jobs whose board is on screen outside the narrow overlay — a workbench pane — by job. */
  private traceWatchers = new Map<string, number>();

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

  private boardShows(taskId: string | null | undefined): boolean {
    if (!taskId) return false;
    return (this.traceOpen && taskId === this.traceTaskId) || this.traceWatchers.has(taskId);
  }

  /**
   * `taskId` null opens whatever job this session touched most recently.
   * `focus` is the message whose card the board should move to.
   */
  openTrace(taskId: string | null = null, focus: TraceFocus | null = null): void {
    if (!this.selectedId) return;
    const token = focus ? (this.traceFocusToken += 1) : 0;
    if (this.toPane({
      kind: "trace",
      sessionId: this.selectedId,
      taskId,
      focus,
      focusNonce: token || null,
    })) return;
    this.closeSheets();
    this.threadOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
    this.traceSessionId = this.selectedId;
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
    if (this.selectedId && this.toPane({ kind: "chat", sessionId: this.selectedId, side: { kind: "settings", botId } })) return;
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
    this.spendOpen = false;
    this.terminalOpen = false;
    this.settingsOpen = !this.settingsOpen;
  }

  openWorkspace(selected?: string | null): void {
    if (this.toPane({ kind: "workspace", selected: selected ?? null })) return;
    this.settingsOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
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
    this.spendOpen = false;
    this.terminalOpen = false;
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
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.terminalOpen = false;
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
      this.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
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
      this.profileBotId = overlay.botId;
      this.sessionSettingsOpen = true;
      return;
    }
    if (overlay.kind === "workspace") {
      this.settingsOpen = false;
      this.createGroupOpen = false;
      this.closeSessionSettings();
      this.clearTrace();
      this.routinesOpen = false;
      this.spendOpen = false;
      this.terminalOpen = false;
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
      this.spendOpen = false;
      this.terminalOpen = false;
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
      this.spendOpen = false;
      this.terminalOpen = false;
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
      this.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.terminalOpen = false;
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
      this.closeSessionSettings();
      this.workspaceOpen = false;
      this.routinesOpen = false;
      this.spendOpen = false;
      this.clearTrace();
      this.threadOpen = false;
      this.previewRelpath = null;
      this.previewAttachmentId = null;
      this.previewTaskId = null;
      this.previewSiblings = null;
      this.terminalOpen = true;
      return;
    }
    this.settingsOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.clearTrace();
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
  }

  closeSheets(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.clearTrace();
    this.workspaceOpen = false;
    this.routinesOpen = false;
    this.spendOpen = false;
    this.terminalOpen = false;
  }

  /** A ledger or search link can outlive the conversation it names. */
  async openChat(id: string, opts?: { messageId?: string }): Promise<void> {
    if (!this.snapshot.sessions.some((session) => session.id === id)) return;
    await this.selectSession(id, opts);
  }

  async selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void> {
    const previousId = this.selectedId;
    const previousSpend = this.spendOpen;
    const previousTerminal = this.terminalOpen;
    if (!opts?.preservePage) {
      this.closeRoutines();
      this.closeSpend();
      this.closeTerminal();
      // Selecting the conversation already underneath a pane must still bring it forward.
      if (this.selectedId === id) this.toPane({ kind: "chat", sessionId: id });
    }
    const api = this.api;
    const sync = this.sync;
    const view = this.sessionView(id);
    const connection = this.connectionSeq;
    const selection = ++view.loadSeq;
    const messageId = opts?.messageId;
    this.setHighlightedMessage(messageId ?? null, id);
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
      this.setHighlightedMessage(messageId, id);
      return;
    }
    this.selectedId = id;
    this.sessionDetailId = null;
    this.sessionMessageNext = null;
    // The reply you were aiming and the chips offered stay with the conversation, like its draft:
    // clicking into another pane is not leaving this one. Opening one drafts nothing: that is ✨.
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
      let readingDetail = true;
      try {
        const detail = await api.sessionSnapshot(id);
        readingDetail = false;
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
        // Pulled, not in the snapshot: what was sent here, and what hangs on this conversation's
        // deliveries (drafts on a Bot↔Bot artifact live in your direct but belong to this view).
        // The file drop has no Bot, so nothing there can be annotated or annotated from.
        if (id !== FILE_DROP_SESSION_ID) {
          void this.loadAnnotations({ session_id: id });
          void this.loadAnnotations({ target_session_id: id });
        }
        for (const frame of frames) {
          if (frame.event_instance_id !== detail.event_instance_id) throw new Error("event instance changed");
          if (frame.seq > detail.watermark_seq) this.ingest(frame.payload, frame);
        }
        if (messageId) {
          const revision = view.revision;
          await this.ensureMessageLoaded(id, messageId);
          if (this.api !== api || this.sync !== sync || this.connectionSeq !== connection ||
            selection !== view.loadSeq || this.selectedId !== id || revision !== view.revision) return;
          this.setHighlightedMessage(messageId, id);
        }
        if (this.api !== api || this.sync !== sync || this.connectionSeq !== connection ||
          selection !== view.loadSeq || this.selectedId !== id) return;
        if (!this.notificationCapabilities.bounded_read_v1) {
          await this.markSessionRead(id);
        }
      } catch (error) {
        if (this.api !== api || this.sync !== sync) return;
        if (readingDetail && error instanceof ApiError && error.status === 404 && error.code === "not_found") {
          // Resume the event stream even when a stale ledger link has no detail to install.
          const frames = sync.install();
          if (!frames) { this.markDisconnected(); return; }
          const stillSelected = this.selectedId === id;
          for (const frame of frames) this.ingest(frame.payload, frame);
          if (stillSelected && selection === view.loadSeq) {
            this.selectedId = previousId && previousId !== id && this.snapshot.sessions.some((session) => session.id === previousId)
              ? previousId : null;
            if (previousSpend) this.openSpend();
            if (previousTerminal) this.openTerminal();
          }
          return;
        }
        this.markDisconnected();
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
  async loadOlderMessages(sessionId?: string): Promise<void> {
    const api = this.api;
    const sync = this.sync;
    const id = sessionId ?? this.selectedId;
    if (!api || !id) return;
    // A pane scrolled to its top pages its own conversation back, in front or not.
    const view = this.sessionView(id);
    const cursor = view.messageNext;
    if (!cursor || view.olderLoading) return;
    const connection = this.connectionSeq;
    const selection = view.loadSeq;
    const revision = view.revision;
    view.olderLoading = true;
    try {
      const page = await api.messages(id, { cursor });
      if (this.api !== api || this.sync !== sync ||
        this.connectionSeq !== connection || view.loadSeq !== selection || view.revision !== revision) return;
      view.messageNext = page.next ?? null;
      const known = new Set(this.snapshot.messages.map((message) => message.id));
      const added = page.items.filter((message) => !known.has(message.id));
      if (added.length > 0) {
        this.snapshot = { ...this.snapshot, messages: [...this.snapshot.messages, ...added] };
      }
    } catch {
      // What is on screen stays; a real drop surfaces as the socket closing.
    } finally {
      view.olderLoading = false;
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

  // Annotations ----------------------------------------------------------------------------
  /**
   * Pull the annotations one filter names and put them in the snapshot in place of whatever it
   * held for that filter — a draft deleted from another device is gone here too. Events keep
   * them current afterwards; a failed pull keeps what is on screen.
   */
  async loadAnnotations(filter: AnnotationFilter & { target_session_id?: string }): Promise<void> {
    const api = this.api;
    if (!api) return;
    const since = this.annotationWriteSeq;
    this.annotationLoads++;
    try {
      const rows = await api.listAnnotations(filter);
      if (this.api !== api) return;
      const fetched = new Set(rows.map((row) => row.id));
      if (filter.relpath) {
        const key = rows.find((row) => row.file_key)?.file_key;
        if (key && this.annotationFileKeys[filter.relpath] !== key) this.annotationFileKeys = { ...this.annotationFileKeys, [filter.relpath]: key };
      }
      // The daemon folds a path filter (absolute, `./`, `//`) and also matches the file's resolved
      // spelling, so a row it returned is in scope whatever this filter looked like, and the rest
      // are compared folded the same way — else a reload would keep the old copy beside the new.
      const wantPath = filter.relpath ? canonicalRelpath(filter.relpath, this.workspacePath || null) : null;
      const scoped = (row: Annotation): boolean =>
        (!filter.relpath || fetched.has(row.id) || row.relpath === filter.relpath || canonicalRelpath(row.relpath, this.workspacePath || null) === wantPath) &&
        (!filter.session_id || row.session_id === filter.session_id) &&
        (!filter.target_session_id || row.target_session_id === filter.target_session_id) &&
        (!filter.message_id || row.message_id === filter.message_id) &&
        (!filter.target_message_id || row.target_message_id === filter.target_message_id) &&
        (!filter.status || row.status === filter.status);
      // What the filter covers is replaced (a draft deleted elsewhere is gone), but a row an event
      // or a write's reply touched while the list was on its way stays as it left it: one created
      // after the read is kept, one deleted after it is not brought back, and an updated one keeps
      // the newer copy.
      const touched = (id: string): boolean => (this.annotationWrites.get(id) ?? 0) > since;
      const current = this.snapshot.annotations;
      const held = new Set(current.map((row) => row.id));
      const kept = current.filter((row) => !scoped(row) && !fetched.has(row.id));
      const inScope = current.filter(scoped);
      const merged = mergeAnnotationRows(
        inScope.filter((row) => fetched.has(row.id) || touched(row.id)),
        rows.filter((row) => held.has(row.id) || !touched(row.id)),
        "replace",
      );
      // One row per id, whatever else went wrong: every keyed list over annotations relies on it.
      this.snapshot = { ...this.snapshot, annotations: mergeAnnotationRows(kept, merged, "replace") };
    } catch {
      // Keep what is on screen.
    } finally {
      if (--this.annotationLoads === 0) this.annotationWrites.clear();
    }
  }

  /** An event or a write's reply changed (or removed) this row; see {@link annotationWrites}. */
  private noteAnnotationWrite(id: string): void {
    if (this.annotationLoads > 0) this.annotationWrites.set(id, ++this.annotationWriteSeq);
  }

  async createAnnotation(input: CreateAnnotationRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      const row = await api.createAnnotation(input);
      if (this.api !== api) return null;
      // The event follows; showing the draft now spares the pane a flicker.
      this.snapshot = { ...this.snapshot, annotations: mergeAnnotationRows(this.snapshot.annotations, [row]) };
      this.noteAnnotationWrite(row.id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async patchAnnotation(id: string, patch: PatchAnnotationRequest): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      const row = await api.patchAnnotation(id, patch);
      if (this.api !== api) return null;
      if (this.snapshot.annotations.some((a) => a.id === row.id)) {
        this.snapshot = { ...this.snapshot, annotations: mergeAnnotationRows(this.snapshot.annotations, [row]) };
        this.noteAnnotationWrite(row.id);
      }
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteAnnotation(id: string): Promise<ApiError | null> {
    const api = this.api;
    if (!api) return null;
    try {
      await api.deleteAnnotation(id);
      if (this.api !== api) return null;
      this.snapshot = { ...this.snapshot, annotations: this.snapshot.annotations.filter((a) => a.id !== id) };
      this.noteAnnotationWrite(id);
      if (this.annotationFocusId === id) this.annotationFocusId = null;
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  /**
   * Send a batch: one reply the Mac composes, quoting the delivery and naming the Bot. The
   * transcript follows the new message the way `send()` does; a batch that lands in another
   * conversation (a Bot↔Bot artifact) takes you there.
   */
  async sendAnnotations(sessionId: string, summary: string, ids: string[]): Promise<ApiError | null> {
    const api = this.api;
    if (!api || ids.length === 0) return null;
    try {
      const sent = await api.sendAnnotations({ session_id: sessionId, body: summary, annotation_ids: ids });
      if (this.api !== api) return null;
      // A quick Bot may have resolved the batch before this reply landed; its events are newer.
      const held = new Set(this.snapshot.annotations.map((a) => a.id));
      this.snapshot = {
        ...this.snapshot,
        annotations: mergeAnnotationRows(this.snapshot.annotations, sent.annotations.filter((row) => held.has(row.id))),
      };
      for (const row of sent.annotations) if (held.has(row.id)) this.noteAnnotationWrite(row.id);
      this.annotationFocusId = null;
      // The conversation the reply landed in follows the turn it wakes, whichever pane shows it.
      const landed = sent.message.session_id;
      this.sessionView(landed).pendingFocusTrigger = sent.message.id;
      this.claimFocus(landed, sent.message.id);
      if (landed === this.selectedId) this.setHighlightedMessage(sent.message.id, landed);
      else void this.selectSession(landed, { messageId: sent.message.id });
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
      const view = this.views.get(id);
      if (view) view.focusedTurnId = null;
      if (this.selectedId === id) {
        this.selectedId = null;
        this.closeSessionSettings();
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
      // That conversation's own view, whether or not it is the one in front.
      const view = this.views.get(id);
      if (view) {
        view.focusedTurnId = null;
        view.messageNext = null;
        this.clearHighlight(view);
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

  /**
   * Send what is drafted in a conversation — the one named, or the selected one. On the workbench
   * a pane always names its own: the selected conversation is whichever pane has the keyboard.
   * True once the Mac has the message; the composer keeps what it staged until then.
   */
  async send(opts?: { attachments?: File[]; paths?: string[]; sessionId?: string }): Promise<boolean> {
    const api = this.api;
    const id = opts?.sessionId ?? this.selectedId;
    const view = this.viewFor(id);
    if (!view) return false;
    const body = view.draft.trim();
    const hasAttachments = Boolean(opts?.attachments && opts.attachments.length > 0);
    const hasPaths = Boolean(opts?.paths && opts.paths.length > 0);
    if (!api || !id || (!body && !hasAttachments && !hasPaths) || view.sending) return false;
    const kept = this.draftReconnect;
    if (kept && !kept.confirm && kept.sessionId === id) return false;
    const parentId = view.replyingToId;
    view.sending = true;
    view.upload = null;
    const files = opts?.attachments ?? [];
    try {
      const message = await api.postMessage(id, body, {
        attachments: opts?.attachments,
        ...(hasPaths ? { paths: opts?.paths } : {}),
        parentId,
        ...(hasAttachments ? { onUploadProgress: (progress: FileProgress) => { view.upload = { files, loaded: progress.loaded }; } } : {}),
      });
      if (this.draftReconnect?.confirm && this.draftReconnect.sessionId === id) this.draftReconnect = null;
      if (this.api !== api) return true;
      view.draft = "";
      view.replyingToId = null;
      view.pendingFocusTrigger = message.id;
      this.claimFocus(id, message.id);
      return true;
    } catch (error) {
      if (this.api !== api) return false;
      if (error instanceof ApiError && error.status === 422) return false;
      this.keepUnknownRequest(error, api);
      this.markDisconnected();
      return false;
    } finally {
      if (this.api === api) {
        view.sending = false;
        view.upload = null;
      }
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

  /** The choices ticked on a question so far; the text you wrote stays as it was. */
  setAskSelection(askId: string, selected: readonly string[]): void {
    const current = this.askDrafts.get(askId);
    const updated = { ...nextDraftVersion(current, current?.body ?? "", selected), askId };
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

  /**
   * Your answer to a question: the choices you ticked, what you wrote, or both. It is written onto
   * the question, which comes back already answered, so the card turns over without waiting for
   * the event.
   */
  async sendAsk(askId: string, answer: { selected?: readonly string[]; custom?: string }, sessionId?: string): Promise<SendAskResult> {
    const api = this.api;
    const id = sessionId ?? this.selectedId;
    const view = this.viewFor(id);
    const sending = view?.sending ?? false;
    const text = (answer.custom ?? "").trim();
    const selected = [...(answer.selected ?? [])];
    const existingDraft = this.askDrafts.get(askId);
    const turn = this.snapshot.turns.find((t) => t.pending_ask_id === askId);
    if (this.notificationCapabilities.pending_ask_v1) {
      const pendingId = turn ? (turn.pending_ask_id ?? null) : null;
      const notAllowed = askSubmitAllowed(
        this.connection === "connected",
        sending,
        text,
        pendingId,
        askId,
        true,
        selected.length,
      );
      if (notAllowed) return notAllowed;
    } else {
      if (!text && selected.length === 0) return { status: "not_submitted", reason: "empty" };
      if (this.connection !== "connected") return { status: "not_submitted", reason: "disconnected" };
      if (sending) return { status: "not_submitted", reason: "busy" };
    }
    if (!api || !id || !view) return { status: "not_submitted", reason: "disconnected" };

    const reqId = existingDraft?.requestId;
    view.sending = true;
    try {
      const res = await api.answerAsk(askId, { selected, custom: text || null }, reqId ? { requestId: reqId } : {});
      if (this.api === api && res?.id === askId) {
        this.snapshot = applyEvent(this.snapshot, { event: "message.upsert", occurred_at: new Date().toISOString(), ...res });
      }
      return {
        status: "accepted",
        request_id: reqId,
        message_id: res?.id,
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
          const draft = existingDraft ?? { ...nextDraftVersion(undefined, text, selected), askId };
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
      if (this.api === api) view.sending = false;
    }
  }

  setNotificationIntentHandler(handler: ((intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }) => void) | null): void {
    this.notificationCenter.setNotificationIntentHandler(handler);
  }

  private dispatchNotificationIntent(intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }): void {
    this.notificationCenter.dispatchNotificationIntent(intent);
  }

  applyNotificationIntent(intent: { sessionId?: string | null; messageId?: string | null; openInbox: boolean }): void {
    this.notificationCenter.applyNotificationIntent(intent);
  }

  async loadNotificationPolicy(): Promise<void> {
    return this.notificationCenter.loadNotificationPolicy();
  }

  async patchNotificationPolicy(patch: Omit<NotificationPolicyPatch, "if_revision">): Promise<void> {
    return this.notificationCenter.patchNotificationPolicy(patch);
  }

  async loadNotificationDevice(): Promise<void> {
    return this.notificationCenter.loadNotificationDevice();
  }

  async patchNotificationDevice(patch: Omit<NotificationDevicePatch, "if_revision">): Promise<void> {
    return this.notificationCenter.patchNotificationDevice(patch);
  }

  async loadNotificationInbox(filter: NotificationFilter): Promise<void> {
    return this.notificationCenter.loadNotificationInbox(filter);
  }

  async loadMoreNotifications(): Promise<void> {
    return this.notificationCenter.loadMoreNotifications();
  }

  async markNotificationRead(id: string): Promise<void> {
    return this.notificationCenter.markNotificationRead(id);
  }

  async markNotificationsRead(ids: string[]): Promise<void> {
    return this.notificationCenter.markNotificationsRead(ids);
  }

  async markAllNotificationsRead(): Promise<void> {
    return this.notificationCenter.markAllNotificationsRead();
  }

  async acknowledgeNotification(id: string, ifRevision: number): Promise<void> {
    return this.notificationCenter.acknowledgeNotification(id, ifRevision);
  }

  isSessionMuted(sessionId: string): boolean {
    return this.notificationCenter.isSessionMuted(sessionId);
  }

  async setSessionMuted(sessionId: string, muted: boolean): Promise<void> {
    return this.notificationCenter.setSessionMuted(sessionId, muted);
  }

  async sendTestNotification(): Promise<{ ok: boolean; status: string; error_code?: string | null }> {
    return this.notificationCenter.sendTestNotification();
  }

  async enableDeviceNotifications(): Promise<boolean> {
    return this.notificationCenter.enableDeviceNotifications();
  }

  async disableDeviceNotifications(): Promise<DisablePushResult | boolean> {
    return this.notificationCenter.disableDeviceNotifications();
  }

  async pollDesktopNativeState(): Promise<void> {
    return this.notificationCenter.pollDesktopNativeState();
  }

  async handleDesktopNotificationIntent(clickRef: string): Promise<void> {
    return this.notificationCenter.handleDesktopNotificationIntent(clickRef);
  }

  async reportDesktopNotificationView(atLatest: boolean): Promise<NativeFocusFacts | null> {
    return this.notificationCenter.reportDesktopNotificationView(atLatest);
  }

  async requestDesktopNotificationPermission(): Promise<void> {
    return this.notificationCenter.requestDesktopNotificationPermission();
  }

  async sendPresenceHeartbeat(atLatest: boolean = false): Promise<void> {
    return this.notificationCenter.sendPresenceHeartbeat(atLatest);
  }

  async loadPushState(): Promise<void> {
    return this.notificationCenter.loadPushState();
  }

  async prefetchPushState(): Promise<PushStateV2 | null> {
    return this.notificationCenter.prefetchPushState();
  }

  /**
   * The Mac answers a read with `session.upsert`, so a read that is already on record still comes
   * back as a new snapshot. Sending it again on the strength of that snapshot is a loop: the same
   * message was read once a second for as long as the conversation stayed on screen, and every
   * pane that reads the snapshot — the file tree beside the chat, the workspace — was rebuilt each
   * time. A read is sent once per message, and again only if it failed.
   */
  async submitBoundedRead(sessionId: string, messageId: string): Promise<void> {
    return this.notificationCenter.submitBoundedRead(sessionId, messageId);
  }

  setupTabChannel(): void {
    this.tabOwnership.setupTabChannel();
  }

  async acquireTabLock(): Promise<boolean> {
    return this.tabOwnership.acquireTabLock();
  }

  async requestTabTakeover(): Promise<void> {
    return this.tabOwnership.requestTabTakeover();
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

  /**
   * Stop the turn a conversation is on — the one named, or the selected one. In a group, where
   * several Bots may be at work, the Stop on one Bot's reply names that turn.
   */
  async stopTurn(sessionId?: string, turnId?: string): Promise<void> {
    const api = this.api;
    if (!api || this.connection !== "connected") return;
    const id = sessionId ?? this.selectedId;
    const session = this.snapshot.sessions.find((row) => row.id === id);
    const target =
      turnId ??
      stopTarget(
        this.snapshot.turns,
        id,
        this.viewFor(id)?.focusedTurnId ?? null,
        session?.kind ?? null,
      );
    if (!target) return;
    try {
      await api.stop(target);
    } catch {
      if (this.api === api) this.markDisconnected();
    }
  }

  /**
   * A stop chosen from a menu: everything, one Bot, a conversation or a plan. The receipt goes to
   * the conversation it was chosen in, when one is named. A refusal comes back to show; a dropped
   * link marks the connection.
   */
  async stopScope(scope: "global" | "bot" | "session" | "plan", scopeId: string | null, sessionId?: string | null): Promise<ApiError | null> {
    return this.controlCall((api) => api.createHold({ scope, scope_id: scopeId, ...(sessionId ? { session_id: sessionId } : {}) }));
  }

  /** Your lift of one stop, from the list of them or the board. */
  async liftHold(holdId: string): Promise<ApiError | null> {
    return this.controlCall((api) => api.liftHold(holdId));
  }

  /** A button on a line about your stops; `taskId` names the plan a widen or narrow button is about. */
  /**
   * A button on a line's control row. Resolves to a refusal to show; to `{ partial }` when a
   * restart notice's 继续 went on with some of its turns and a stop of yours holds the rest; or null.
   */
  async controlAction(messageId: string, action: ControlOffer, taskId?: string): Promise<ApiError | { partial: NonNullable<ControlActionResult["partial"]> } | null> {
    const answer: { partial?: ControlActionResult["partial"] } = {};
    const refused = await this.controlCall(async (api) => {
      answer.partial = (await api.controlAction(messageId, taskId ? { action, task_id: taskId } : { action })).partial;
    });
    return refused ?? (answer.partial ? { partial: answer.partial } : null);
  }

  private async controlCall(call: (api: MessengerApi) => Promise<unknown>): Promise<ApiError | null> {
    const api = this.api;
    if (!api || this.connection !== "connected") return null;
    try {
      await call(api);
      return null;
    } catch (error) {
      if (this.api !== api) return null;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) return error;
      this.markDisconnected();
      return null;
    }
  }

  async continueInterrupt(messageId: string, sessionId?: string): Promise<void> {
    const api = this.api;
    const view = this.viewFor(sessionId);
    if (!api || !view || this.connection !== "connected" || view.sending) return;
    view.sending = true;
    try {
      const turn = await api.continueInterrupt(messageId);
      if (this.api === api) view.focusedTurnId = turn.id;
    } catch (error) {
      if (this.api !== api) return;
      if (error instanceof ApiError && error.status === 422) return;
      this.markDisconnected();
    } finally {
      if (this.api === api) view.sending = false;
    }
  }

  async resolveApproval(
    id: string,
    action: ResolveApprovalRequest["action"],
    apiKey?: string,
    sessionId?: string,
  ): Promise<ApiError | null> {
    const api = this.api;
    const view = this.viewFor(sessionId);
    if (!api || !view || view.sending) return null;
    view.sending = true;
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
      if (this.api === api) view.sending = false;
    }
  }

  clearSearchHighlight(): void {
    this.setHighlightedMessage(null);
  }

  closeSearch(): void {
    this.searchQuery = "";
    this.searchHits = [];
    this.searchLoading = false;
    this.searchError = false;
    this.searchSeq++;
  }

  /** Clearing a query invalidates in-flight replies too; results belong to one connection. */
  async runSearch(q: string): Promise<void> {
    this.searchQuery = q;
    this.searchHits = [];
    this.searchError = false;
    const seq = ++this.searchSeq;
    const api = this.api;
    const connection = this.connectionSeq;
    const trimmed = q.trim();
    if (!api || this.connection !== "connected" || !trimmed) {
      this.searchLoading = false;
      return;
    }
    this.searchLoading = true;
    const current = () =>
      seq === this.searchSeq && this.api === api && this.connectionSeq === connection;
    try {
      const hits = await api.search(trimmed);
      if (!current()) return;
      this.searchHits = hits;
      this.searchError = false;
    } catch {
      if (!current()) return;
      this.searchHits = [];
      this.searchError = true;
    } finally {
      if (current()) this.searchLoading = false;
    }
  }

  async submitPairing(raw: string): Promise<PairingProgress> {
    return this.remoteAdmin.submitPairing(raw);
  }

  confirmDraftReconnect(): void {
    this.remoteAdmin.confirmDraftReconnect();
  }

  discardDraftReconnect(): void {
    this.remoteAdmin.discardDraftReconnect();
  }

  async registerUv(): Promise<boolean> {
    return this.remoteAdmin.registerUv();
  }

  async refreshHostDevices(): Promise<void> {
    return this.remoteAdmin.refreshHostDevices();
  }

  async removeHostDevice(id: string): Promise<boolean> {
    return this.remoteAdmin.removeHostDevice(id);
  }

  /** Registers this Mac with the person's relay; the connect form in the remote card. */
  async connectHost(relay: HostRelay): Promise<boolean> {
    return this.remoteAdmin.connectHost(relay);
  }

  /**
   * Opens a pairing window on this Mac and keeps checking it. The window lasts ten minutes; the
   * card shows the code for that long, then says so rather than leaving a dead code on screen.
   */
  async startHostPairing(): Promise<void> {
    return this.remoteAdmin.startHostPairing();
  }

  /** The person compared the fingerprint on the device; this is the local confirmation. */
  async confirmHostPairing(): Promise<void> {
    return this.remoteAdmin.confirmHostPairing();
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
    this.remoteAdmin.closeHostPairing();
  }

  async refreshMaintenance(): Promise<void> {
    return this.remoteAdmin.refreshMaintenance();
  }

  async downloadDiagnostics(): Promise<boolean> {
    return this.remoteAdmin.downloadDiagnostics();
  }

  async restartRuntime(force = false): Promise<boolean> {
    return this.remoteAdmin.restartRuntime(force);
  }

  async stopRuntime(): Promise<boolean> {
    return this.remoteAdmin.stopRuntime();
  }

  async revokeRemoteDevice(id: string): Promise<boolean> {
    return this.remoteAdmin.revokeRemoteDevice(id);
  }

  otherRemoteDevices(): RemoteDeviceRow[] {
    return this.remoteAdmin.otherRemoteDevices();
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
    return this.notificationCenter.setPushEnabled(enabled);
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
    const id = this.selectedId;
    const draft = this.draft.trim();
    if (id && draft && !this.draftReconnect) this.draftReconnect = { sessionId: id, draft, confirm: false };
  }

  private syncAppBadge(): void {
    this.notificationCenter.syncAppBadge();
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
    for (const view of this.views.values()) {
      view.focusedTurnId = null;
      view.pendingFocusTrigger = null;
    }
    // Back into the conversation it was written in, whichever pane has the keyboard now.
    const kept = this.draftReconnect;
    if (kept && !kept.confirm) this.sessionView(kept.sessionId).draft = kept.draft;
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
    if (await this.resumeRemote(api, sync, ready)) {
      this.uvReady = api.uvReady;
      return;
    }
    this.resumePoint = null;
    const snapshot = await api.snapshot();
    await this.installSnapshot(api, sync, snapshot);
    this.uvReady = api.uvReady;
  }

  /**
   * Back on the Mac this page left — the same event instance — it asks for the events it missed
   * and keeps everything on screen. A restarted Mac, a ring that rolled over, too many missed
   * events or any gap: false, and the caller takes the snapshot.
   */
  private async resumeRemote(api: RemoteApi, sync: EventSync, ready: SyncFrame): Promise<boolean> {
    const point = this.resumePoint;
    if (!point || ready.type !== "ready" || ready.event_instance_id !== point.cursor.event_instance_id) return false;
    const missed = ready.watermark_seq - point.cursor.watermark_seq;
    if (missed < 0 || missed > RESUME_MAX_EVENTS) return false;
    let caught: CatchupResponse;
    try {
      caught = await api.catchup(point.cursor);
    } catch {
      return false;
    }
    if (this.stopped || this.api !== api || this.sync !== sync) return true;
    if (caught.resnapshot || caught.event_instance_id !== point.cursor.event_instance_id) return false;
    const frames = sync.resume(point.cursor, caught.events);
    if (!frames) return false;
    this.resumePoint = null;
    for (const [view, kept] of point.views) {
      if (this.views.get(view.sessionId) !== view) continue;
      view.detailLoaded = kept.detailLoaded;
      view.messageNext = kept.messageNext;
    }
    // A new link is a new client: it learns the revisions edits carry from what is on screen.
    api.observeSnapshot(this.snapshot);
    this.reconcilePendingMutation(api);
    for (const frame of frames) this.ingest(frame.payload, frame);
    void this.refreshMaintenance();
    void this.loadPushState();
    this.endpointKey = "";
    this.connection = "connected";
    this.connectFailures = 0;
    for (const view of this.views.values()) {
      view.focusedTurnId = null;
      view.pendingFocusTrigger = null;
      // Streamed text is not an event, so a reply that ran while the link was down is missing
      // what arrived meanwhile: its conversation reads its history again.
      if (this.snapshot.turns.some((turn) => turn.session_id === view.sessionId && turn.status === "running")) {
        view.detailLoaded = false;
      }
    }
    const kept = this.draftReconnect;
    if (kept && !kept.confirm) this.sessionView(kept.sessionId).draft = kept.draft;
    const selected = this.selectedId;
    if (selected && this.snapshot.sessions.some((s) => s.id === selected)) {
      if (!this.views.get(selected)?.detailLoaded) void this.selectSession(selected, { preservePage: true });
    } else if (selected) {
      this.selectedId = null;
    }
    return true;
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
        // What it was following, flashing or replying to went with the history.
        gone.focusedTurnId = null;
        gone.pendingFocusTrigger = null;
        gone.replyingToId = null;
        this.dropComposerSuggestions(gone);
        this.clearHighlight(gone);
      }
    }
    if (event.event === "session.removed") {
      if (this.selectedId === event.id) {
        this.selectedId = null;
        this.closeSessionSettings();
      }
      // Nothing will read it again; a draft for a conversation that is gone is not kept.
      this.views.delete(event.id);
    }
    let next = applyEvent(this.snapshot, event);
    this.snapshot = next;
    if (event.event === "annotation.upsert" || event.event === "annotation.removed") this.noteAnnotationWrite(event.id);
    if (event.event === "notification.upsert") {
      this.notificationCenter.applyNotificationUpsert(event as unknown as NotificationItem);
    }
    if (event.event === "notification.removed" && typeof event.id === "string") {
      this.notificationCenter.applyNotificationRemoved(event.id);
    }
    if (event.event === "notification.summary") {
      this.notificationCenter.applyLiveNotificationSummary(event.summary);
    }
    if (event.event === "notification_policy.changed") {
      const { event: _e, occurred_at: _at, ...policy } = event;
      this.notificationCenter.applyNotificationPolicyChanged(policy);
    }
    if (this.api instanceof RemoteApi) this.api.observeSnapshot(this.snapshot);
    if (event.event === "settings.changed") {
      this.syncSettingsDraft(event);
    }
    if (event.event === "spend.created" || event.event === "spend.repriced") this.spendRevision += 1;
    if (event.event === "turn.upsert") {
      this.claimFocus(event.session_id, event.trigger_message_id, event.id);
      // A finished turn keeps nothing of what it was doing: the transcript and its trace remain.
      if (!isLiveStatus(event.status)) {
        this.activity.forget(event.id);
        this.turnActivity.forget(event.id);
      }
      if (this.boardShows(event.task_id)) this.traceReload += 1;
    }
    if ((event.event === "message.created" || event.event === "message.upsert") && this.boardShows(event.task_id)) {
      this.traceReload += 1;
    }
    // The organizer's filing and your own edits: the plan's spec and tickets are part of the picture.
    if (event.event === "task.upsert" && this.boardShows(event.id)) this.traceReload += 1;
    if ((event.event === "ticket.upsert" || event.event === "ticket.removed") && this.boardShows(event.task_id)) {
      this.traceReload += 1;
    }
    // A stop made or lifted can park a plan, put it back, or hold it without touching its row (one
    // on everything): a board on screen reads its plan again, so its next edit is from the version
    // the stop wrote and not refused as stale.
    if (event.event === "hold.upsert" && (this.traceOpen || this.traceWatchers.size > 0)) this.traceReload += 1;
    if (event.event === "message.created") {
      // Drafted for what was there before, in front or not; ✨ drafts again for what is there now.
      // An upsert is a reaction, an edit or an answer to a row already there: the talk has not moved.
      const view = this.views.get(event.session_id);
      if (view) this.dropComposerSuggestions(view);
    }
  }

  /** Follow the turn a message sent from this conversation woke, once it is known. */
  private claimFocus(sessionId: string, triggerMessageId: string, turnId?: string): void {
    const view = this.views.get(sessionId);
    if (!view || view.pendingFocusTrigger !== triggerMessageId) return;
    const id =
      turnId ??
      this.snapshot.turns.find((turn) => turn.trigger_message_id === triggerMessageId)?.id;
    if (!id) return;
    view.focusedTurnId = id;
    view.pendingFocusTrigger = null;
  }

  private resetConnection(): void {
    // Only a remote link that had applied events leaves a point to resume from; an attempt that
    // never got that far keeps the previous one.
    const cursor = this.api instanceof RemoteApi ? (this.sync?.snapshotCursor() ?? null) : null;
    if (cursor) {
      this.resumePoint = {
        cursor,
        views: new Map([...this.views.values()].map((view) => [view, { detailLoaded: view.detailLoaded, messageNext: view.messageNext }])),
      };
    }
    this.rememberDraftOnDisconnect();
    this.notificationCenter.clearBoundedReads();
    // A step that ended while the link was down would read as running forever.
    this.turnActivity.clear();
    this.listeningSince = Date.now();
    this.toolRevision += 1;
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
    this.searchSeq++;
    this.searchHits = [];
    this.searchLoading = false;
    this.searchError = false;
    // Every open conversation reads its history again from the next connection, not only the selected one.
    for (const view of this.views.values()) {
      view.detailLoaded = false;
      view.messageNext = null;
    }
    this.connectionSeq++;
    for (const view of this.views.values()) {
      view.sending = false;
      view.upload = null;
    }
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
    this.turnActivity.applyTool(tool);
    this.toolRevision += 1;
    // A command's bytes are only worth carrying while someone can see them run — and only for
    // the conversation that is open. A phone on a radio should not receive the output of a
    // build happening in a session nobody is looking at.
    const streamId = `${tool.turn_id}:${tool.id}`;
    if (tool.phase === "started" && this.watchesTurn(tool.turn_id)) void this.watchCommand(streamId);
    if (tool.phase === "exited") void this.unwatchCommand(streamId);
    return true;
  }

  /** The step this turn is in or last finished; reading it follows the next tool frame. */
  stepOf(turnId: string): ToolStep | null {
    void this.toolRevision;
    return this.turnActivity.latestFor(turnId);
  }

  /** Every step this client has seen the turn take, oldest first. */
  stepsOf(turnId: string): readonly ToolStep[] {
    void this.toolRevision;
    return this.turnActivity.stepsFor(turnId);
  }

  /** Earlier steps of a long turn that fell off the front of {@link stepsOf}. */
  droppedStepsOf(turnId: string): number {
    void this.toolRevision;
    return this.turnActivity.droppedFor(turnId);
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
    // Every conversation on screen, not only the one in front: each holds its own.
    for (const view of this.views.values()) {
      this.dropComposerSuggestions(view);
      view.focusedTurnId = null;
      view.pendingFocusTrigger = null;
      view.messageNext = null;
      this.clearHighlight(view);
    }
  }

  /**
   * Draft next steps for a conversation's composer, when you press ✨ there. Each draft is one
   * short model call on the spend ledger, so nothing asks for them on its own any more: they used
   * to be fetched on opening a conversation and after every message, whether you looked or not.
   */
  async suggestComposer(sessionId: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    // These draft what you would send. A Bot↔Bot direct and the file conversation have no one to send to.
    const session = this.snapshot.sessions.find((s) => s.id === sessionId);
    if (!session || classifySession(session) === "bot-bot" || isFileDropSession(session)) return;
    const view = this.sessionView(sessionId);
    this.dropComposerSuggestions(view);
    const abort = new AbortController();
    view.suggestAbort = abort;
    view.suggestionsLoading = true;
    try {
      const items = await api.composerSuggestions(sessionId, abort.signal);
      if (view.suggestAbort !== abort) return;
      view.composerSuggestions = items;
      view.suggestionsEmpty = items.length === 0;
    } catch {
      if (view.suggestAbort !== abort) return;
      view.suggestionsEmpty = true;
    } finally {
      if (view.suggestAbort === abort) {
        view.suggestAbort = null;
        view.suggestionsLoading = false;
      }
    }
  }

  /** Put a conversation's chips away, and stop drafts still on the way. */
  dismissComposerSuggestions(sessionId: string): void {
    const view = this.views.get(sessionId);
    if (view) this.dropComposerSuggestions(view);
  }

  private dropComposerSuggestions(view: SessionView): void {
    view.suggestAbort?.abort();
    view.suggestAbort = null;
    view.suggestionsLoading = false;
    view.suggestionsEmpty = false;
    if (view.composerSuggestions.length > 0) view.composerSuggestions = [];
  }

  /** Flash a message in a conversation — the one named, or the selected one. */
  setHighlightedMessage(messageId: string | null, sessionId?: string): void {
    const view = this.viewFor(sessionId);
    if (!view) return;
    this.clearHighlightTimer(view);
    view.highlightedMessageId = messageId;
    if (!messageId) return;
    view.searchHighlightToken += 1;
    view.highlightTimer = setTimeout(() => {
      if (view.highlightedMessageId === messageId) view.highlightedMessageId = null;
      view.highlightTimer = null;
    }, 4000);
  }

  private clearHighlight(view: SessionView): void {
    this.clearHighlightTimer(view);
    view.highlightedMessageId = null;
  }

  private clearHighlightTimer(view: SessionView): void {
    if (!view.highlightTimer) return;
    clearTimeout(view.highlightTimer);
    view.highlightTimer = null;
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
