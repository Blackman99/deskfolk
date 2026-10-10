import type {
  ApiFormat,
  Attachment,
  ClientEvent,
  SequencedEvent,
  CreateBotRequest,
  CreateGroupRequest,
  PatchMemoryRequest,
  CreateProviderRequest,
  PatchProviderRequest,
  ModelSpeed,
  ProbeModelsResponse,
  ResolveApprovalRequest,
  ComposerSuggestion,
  ControlActionResult,
  ControlOffer,
  SearchHit,
  PatchSpeechRequest,
  SettingsPatch,
  ThinkingLevel,
  BotRunner,
  CreateSkillRequest,
  PatchSkillRequest,
  CreateRoutineRequest,
  PatchRoutineRequest,
  RuntimeSnapshot,
  StreamFrame,
  Terminal,
  AnnotationFilter,
  CreateAnnotationRequest,
  PatchAnnotationRequest,
  Message,
  MessageVersion,
  PatchMessageAttributionRequest,
  GroupLeadState,
  WorkAnswerResult,
} from "@real-bot/protocol";
import type { ApiError } from "./api.ts";
import type { AttributedMessage, AttributionPlan } from "./chat/attribution.ts";
import type { CommandActivity, CommandRow } from "./chat/command-activity.ts";
import type { TurnActivity, ToolStep } from "./chat/turn-activity.ts";
import { classifySession, isFileDropSession } from "./sidebar/session-groups.ts";
import { applyEvent, emptySnapshot, type Snapshot } from "./snapshot.ts";
import type { EventSync } from "./event-sync.ts";
import { SessionView } from "./session-view.svelte.ts";
import type { TraceFocus } from "./overlays/task-trace.ts";
import type { PaneContent } from "./workbench/pane-content.ts";
import { isLiveStatus } from "./chat/transcript.ts";
import type { UrlOverlay } from "./session-url.ts";
import type { PromptTarget } from "./settings/prompts-view.ts";
import { HOSTED_MESSENGER } from "./remote/mode.ts";
import type { MessengerApi } from "./messenger-api.ts";
import { RemoteApi, type DurablePendingRequest, type RemoteDeviceRow, type RemoteMaintenanceStatus } from "./remote/api.ts";
import { isInboxMessage, pushPermission } from "./remote/push.ts";
import type { DisablePushResult, PushPermission } from "./remote/push.ts";
import type { PairingProgress } from "./remote/pairing.ts";
import type { HostDevice, HostRelay } from "./remote/pairing-host.ts";
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
import { NotificationCenter, type NotificationCenterHost } from "./notifications/notification-center.svelte.ts";
import { TabOwnership, type NotificationOpenIntent, type TabOwnershipHost } from "./notifications/tab-ownership.svelte.ts";
import { RemoteAdmin, type RemoteAdminHost } from "./remote/remote-admin.svelte.ts";
import { AdminMutations, type AdminMutationsHost } from "./admin-mutations.svelte.ts";
import { AnnotationStore, type AnnotationStoreHost } from "./annotations/annotation-store.svelte.ts";
import { ChatActivity, type ChatActivityHost } from "./chat/activity.svelte.ts";
import { ChatActions, type ChatActionsHost } from "./chat/chat-actions.svelte.ts";
import { MessageEdits, type MessageEditsHost } from "./chat/message-edits.svelte.ts";
import { SessionHistory, type SessionHistoryHost } from "./chat/session-history.svelte.ts";
import { ThreadState, type ThreadStateHost } from "./chat/thread-state.svelte.ts";
import { ConnectionLoop, type ConnectionLoopHost } from "./connection/connection-loop.svelte.ts";
import { OverlayState, type OverlayStateHost, type TraceOpenOptions } from "./overlays/overlay-state.svelte.ts";
import { TerminalList, type TerminalListHost } from "./overlays/terminal-list.svelte.ts";
import { SearchStore, type SearchStoreHost } from "./search/search-store.svelte.ts";

export { nextRemoteRetry } from "./connection/connection-loop.svelte.ts";

/**
 * `connecting` is a real state, not a flavour of `disconnected`: a page that is still trying
 * should not accuse the Mac of being unreachable, and one that has been trying for a while
 * should not pretend it is still about to work.
 */
export type Connection = "connecting" | "connected" | "disconnected";
export type HostUnreachable = "runtime" | "host";
/** A draft kept across a dropped connection, and the conversation it was being written in. */
export type DraftReconnect = { sessionId: string; draft: string; confirm: boolean } | null;

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
      /** Why the last approval did not go through while it can still be tried again (Windows Hello not set up). */
      note?: string;
    }
  | { phase: "paired"; deviceId: string }
  | { phase: "failed"; error: string };

/** Everything the sub-stores below reach back into the runtime for: each one's host, together. */
type SubStoreHost =
  & OverlayStateHost
  & TerminalListHost
  & ConnectionLoopHost
  & SessionHistoryHost
  & AdminMutationsHost
  & ThreadStateHost
  & MessageEditsHost
  & ChatActivityHost
  & AnnotationStoreHost
  & ChatActionsHost
  & SearchStoreHost;

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

  /**
   * The overlays, the terminal list, the connection loop, a conversation's history, the sheets'
   * writes, the thread panes, line edits, live activity, annotations, the chat's actions and search
   * live in their own classes too, and share one host adapter: they reach for much the same state,
   * and the connection loop reaches for most of it. Its getters read `runtime.x` fresh on every
   * call, like the adapters above. A call to a method the runtime still answers to by name goes
   * through the runtime, so a component or a test that replaces one there (`selectSession`,
   * `closeSessionSettings`, the loop's `tick`) is seen from inside the sub-stores as well; what
   * only a sub-store has is reached on that sub-store.
   */
  private readonly subStoreHost: SubStoreHost = this.buildSubStoreHost();
  private readonly overlayState = new OverlayState(this.subStoreHost);
  private readonly terminalList = new TerminalList(this.subStoreHost);
  private readonly connectionLoop = new ConnectionLoop(this.subStoreHost);
  private readonly sessionHistory = new SessionHistory(this.subStoreHost);
  private readonly adminMutations = new AdminMutations(this.subStoreHost);
  private readonly threadState = new ThreadState(this.subStoreHost);
  private readonly messageEdits = new MessageEdits(this.subStoreHost);
  private readonly chatActivity = new ChatActivity(this.subStoreHost);
  private readonly annotationStore = new AnnotationStore(this.subStoreHost);
  private readonly chatActions = new ChatActions(this.subStoreHost);
  private readonly searchStore = new SearchStore(this.subStoreHost);

  private buildSubStoreHost(): SubStoreHost {
    const runtime = this;
    return {
      get selectedId() { return runtime.selectedId; },
      set selectedId(value) { runtime.selectedId = value; },
      get remote() { return runtime.remote; },
      get snapshot() { return runtime.snapshot; },
      set snapshot(value) { runtime.snapshot = value; },
      get api() { return runtime.api; },
      set api(value) { runtime.api = value; },
      get stopped() { return runtime.stopped; },
      get connection() { return runtime.connection; },
      set connection(value) { runtime.connection = value; },
      get hostUnreachable() { return runtime.hostUnreachable; },
      set hostUnreachable(value) { runtime.hostUnreachable = value; },
      get enrolled() { return runtime.enrolled; },
      set enrolled(value) { runtime.enrolled = value; },
      get tabRole() { return runtime.tabRole; },
      get draft() { return runtime.draft; },
      get draftReconnect() { return runtime.draftReconnect; },
      set draftReconnect(value) { runtime.draftReconnect = value; },
      get sync() { return runtime.sync; },
      set sync(value) { runtime.sync = value; },
      get delegationSnapshotEpoch() { return runtime.delegationSnapshotEpoch; },
      set delegationSnapshotEpoch(value) { runtime.delegationSnapshotEpoch = value; },
      get delegationEventRevisions() { return runtime.delegationEventRevisions; },
      get delegationReadSeq() { return runtime.threadState.delegationReadSeq; },
      get delegationLoading() { return runtime.delegationLoading; },
      set delegationLoading(value) { runtime.delegationLoading = value; },
      get delegationLoadError() { return runtime.delegationLoadError; },
      set delegationLoadError(value) { runtime.delegationLoadError = value; },
      get delegationUnsupported() { return runtime.delegationUnsupported; },
      set delegationUnsupported(value) { runtime.delegationUnsupported = value; },
      get messageSnapshotRevision() { return runtime.messageEdits.messageSnapshotRevision; },
      set messageSnapshotRevision(value) { runtime.messageEdits.messageSnapshotRevision = value; },
      get remoteStatus() { return runtime.remoteStatus; },
      set remoteStatus(value) { runtime.remoteStatus = value; },
      get notificationCapabilities() { return runtime.notificationCapabilities; },
      set notificationCapabilities(value) { runtime.notificationCapabilities = value; },
      get notificationSummary() { return runtime.notificationSummary; },
      set notificationSummary(value) { runtime.notificationSummary = value; },
      get notificationPolicy() { return runtime.notificationPolicy; },
      set notificationPolicy(value) { runtime.notificationPolicy = value; },
      get isDesktopShell() { return runtime.isDesktopShell; },
      get endpointKey() { return runtime.endpointKey; },
      set endpointKey(value) { runtime.endpointKey = value; },
      get views() { return runtime.views; },
      get durablePending() { return runtime.durablePending; },
      set durablePending(value) { runtime.durablePending = value; },
      get uvReady() { return runtime.uvReady; },
      set uvReady(value) { runtime.uvReady = value; },
      get turnActivity() { return runtime.turnActivity; },
      get toolRevision() { return runtime.toolRevision; },
      set toolRevision(value) { runtime.toolRevision = value; },
      get pendingMutation() { return runtime.pendingMutation; },
      set pendingMutation(value) { runtime.pendingMutation = value; },
      get sessionLoad() { return runtime.sessionHistory.sessionLoad; },
      set sessionLoad(value) { runtime.sessionHistory.sessionLoad = value; },
      get searchSeq() { return runtime.searchStore.searchSeq; },
      set searchSeq(value) { runtime.searchStore.searchSeq = value; },
      get searchHits() { return runtime.searchHits; },
      set searchHits(value) { runtime.searchHits = value; },
      get searchLoading() { return runtime.searchLoading; },
      set searchLoading(value) { runtime.searchLoading = value; },
      get searchError() { return runtime.searchError; },
      set searchError(value) { runtime.searchError = value; },
      get connectionSeq() { return runtime.connectionSeq; },
      set connectionSeq(value) { runtime.connectionSeq = value; },
      get activeView() { return runtime.activeView; },
      get spendOpen() { return runtime.spendOpen; },
      get terminalOpen() { return runtime.terminalOpen; },
      get traceOpen() { return runtime.traceOpen; },
      get traceSessionId() { return runtime.traceSessionId; },
      set traceSessionId(value) { runtime.traceSessionId = value; },
      get threadOpen() { return runtime.threadOpen; },
      set threadOpen(value) { runtime.threadOpen = value; },
      get focusedTurnId() { return runtime.focusedTurnId; },
      set focusedTurnId(value) { runtime.focusedTurnId = value; },
      get historyLoading() { return runtime.historyLoading; },
      set historyLoading(value) { runtime.historyLoading = value; },
      get profileBotId() { return runtime.profileBotId; },
      get traceReload() { return runtime.traceReload; },
      set traceReload(value) { runtime.traceReload = value; },
      get workspacePath() { return runtime.workspacePath; },
      closeSessionSettings: () => runtime.closeSessionSettings(),
      refreshTerminals: () => runtime.refreshTerminals(),
      closeSheets: () => runtime.closeSheets(),
      selectSession: (id, opts) => runtime.selectSession(id, opts),
      sessionView: (id) => runtime.sessionView(id),
      openProfile: (botId) => runtime.openProfile(botId),
      openSettings: () => runtime.openSettings(),
      openRemoteScreen: () => runtime.openRemoteScreen(),
      startTerminal: (cwd) => runtime.startTerminal(cwd),
      toPane: (content) => runtime.overlayState.toPane(content),
      openTerminal: () => runtime.openTerminal(),
      pump: () => runtime.pump(),
      tickRemote: () => runtime.tickRemote(),
      markDisconnected: () => runtime.markDisconnected(),
      acquireTabLock: () => runtime.acquireTabLock(),
      syncAppBadge: () => runtime.syncAppBadge(),
      pollDesktopNativeState: () => runtime.pollDesktopNativeState(),
      reportDesktopNotificationView: (atLatest) => runtime.reportDesktopNotificationView(atLatest),
      refreshMaintenance: () => runtime.refreshMaintenance(),
      loadPushState: () => runtime.loadPushState(),
      reconcilePendingMutation: (api) => runtime.reconcilePendingMutation(api),
      syncSettingsDraft: (settings) => runtime.syncSettingsDraft(settings),
      ingest: (event, frame) => runtime.ingest(event, frame),
      resetConnection: () => runtime.resetConnection(),
      installSnapshot: (api, sync, snapshot) => runtime.installSnapshot(api, sync, snapshot),
      acceptEphemeral: (value) => runtime.chatActivity.acceptEphemeral(value),
      reconnectNow: () => runtime.reconnectNow(),
      clearBoundedReads: () => runtime.notificationCenter.clearBoundedReads(),
      tick: () => runtime.tick(),
      closeRoutines: () => runtime.closeRoutines(),
      closeSpend: () => runtime.closeSpend(),
      closeTerminal: () => runtime.closeTerminal(),
      closeRemoteScreen: () => runtime.closeRemoteScreen(),
      setHighlightedMessage: (messageId, sessionId) => runtime.setHighlightedMessage(messageId, sessionId),
      loadAnnotations: (filter) => runtime.loadAnnotations(filter),
      markSessionRead: (id) => runtime.markSessionRead(id),
      openSpend: () => runtime.openSpend(),
      closeProfile: () => runtime.closeProfile(),
      clearHighlight: (view) => runtime.clearHighlight(view),
      sheetFailure: (error, api) => runtime.adminMutations.sheetFailure(error, api),
      loadAttributionPlans: (sessionId, messageId) => runtime.loadAttributionPlans(sessionId, messageId),
      viewFor: (sessionId) => runtime.viewFor(sessionId),
      cancelEdit: (sessionId) => runtime.cancelEdit(sessionId),
      loadAttributionFor: (message) => runtime.loadAttributionFor(message),
      noteAnnotationWrite: (id) => runtime.noteAnnotationWrite(id),
      claimFocus: (sessionId, triggerMessageId, turnId) => runtime.claimFocus(sessionId, triggerMessageId, turnId),
      keepUnknownRequest: (error, api) => runtime.adminMutations.keepUnknownRequest(error, api),
    };
  }

  connection = $state<Connection>("connecting");
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

  /** Bumped when a turn or message of the open job changes, so the trace pulls again. */
  traceReload = $state(0);
  /**
   * Climbs on `spend.created` and `spend.repriced`. The rows themselves are not kept: a view that is open debounces
   * a reload of the summary off this, and one that is closed reads it when it next opens.
   */
  spendRevision = $state(0);
  /** Bumped on every `prompt.changed` (ADR 0064): the prompts settings reload on it. */
  promptsRevision = $state(0);
  pendingMutation = $state<{ id: string; code: string } | null>(null);
  workspacePath = $state("");
  endpointUrl = $state("");
  endpointKey = $state("");
  endpointModelsText = $state("");
  endpointDefaultModel = $state("");
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

  // --- Forwarded to `overlayState` (sheets, pages and panes over the chat, and the trace board). ---
  get previewRelpath(): string | null { return this.overlayState.previewRelpath; }
  set previewRelpath(value: string | null) { this.overlayState.previewRelpath = value; }
  get previewMessageId(): string | null { return this.overlayState.previewMessageId; }
  set previewMessageId(value: string | null) { this.overlayState.previewMessageId = value; }
  get forceArtifactTree(): boolean { return this.overlayState.forceArtifactTree; }
  set forceArtifactTree(value: boolean) { this.overlayState.forceArtifactTree = value; }
  get previewTaskId(): string | null { return this.overlayState.previewTaskId; }
  set previewTaskId(value: string | null) { this.overlayState.previewTaskId = value; }
  get previewSiblings(): Attachment[] | null { return this.overlayState.previewSiblings; }
  set previewSiblings(value: Attachment[] | null) { this.overlayState.previewSiblings = value; }
  get settingsOpen(): boolean { return this.overlayState.settingsOpen; }
  set settingsOpen(value: boolean) { this.overlayState.settingsOpen = value; }
  get createBotOpen(): boolean { return this.overlayState.createBotOpen; }
  set createBotOpen(value: boolean) { this.overlayState.createBotOpen = value; }
  get createGroupOpen(): boolean { return this.overlayState.createGroupOpen; }
  set createGroupOpen(value: boolean) { this.overlayState.createGroupOpen = value; }
  get sessionSettingsOpen(): boolean { return this.overlayState.sessionSettingsOpen; }
  set sessionSettingsOpen(value: boolean) { this.overlayState.sessionSettingsOpen = value; }
  get traceTaskId(): string | null { return this.overlayState.traceTaskId; }
  set traceTaskId(value: string | null) { this.overlayState.traceTaskId = value; }
  get traceSessionId(): string | null { return this.overlayState.traceSessionId; }
  set traceSessionId(value: string | null) { this.overlayState.traceSessionId = value; }
  get traceFocus(): TraceFocus | null { return this.overlayState.traceFocus; }
  set traceFocus(value: TraceFocus | null) { this.overlayState.traceFocus = value; }
  get traceFocusToken(): number { return this.overlayState.traceFocusToken; }
  set traceFocusToken(value: number) { this.overlayState.traceFocusToken = value; }
  get profileBotId(): string | null { return this.overlayState.profileBotId; }
  set profileBotId(value: string | null) { this.overlayState.profileBotId = value; }
  get profileRoutineId(): string | null { return this.overlayState.profileRoutineId; }
  set profileRoutineId(value: string | null) { this.overlayState.profileRoutineId = value; }
  get workspaceOpen(): boolean { return this.overlayState.workspaceOpen; }
  set workspaceOpen(value: boolean) { this.overlayState.workspaceOpen = value; }
  get routinesOpen(): boolean { return this.overlayState.routinesOpen; }
  set routinesOpen(value: boolean) { this.overlayState.routinesOpen = value; }
  get spendOpen(): boolean { return this.overlayState.spendOpen; }
  set spendOpen(value: boolean) { this.overlayState.spendOpen = value; }
  get promptsTarget(): { prompt: PromptTarget | null } | null { return this.overlayState.promptsTarget; }
  set promptsTarget(value: { prompt: PromptTarget | null } | null) { this.overlayState.promptsTarget = value; }
  get workspaceSelected(): string { return this.overlayState.workspaceSelected; }
  set workspaceSelected(value: string) { this.overlayState.workspaceSelected = value; }
  get threadOpen(): boolean { return this.overlayState.threadOpen; }
  set threadOpen(value: boolean) { this.overlayState.threadOpen = value; }
  get previewAttachmentId(): string | null { return this.overlayState.previewAttachmentId; }
  set previewAttachmentId(value: string | null) { this.overlayState.previewAttachmentId = value; }
  openCreateBot(): void { this.overlayState.openCreateBot(); }
  openCreateGroup(): void { this.overlayState.openCreateGroup(); }
  openSessionSettings(): void { this.overlayState.openSessionSettings(); }
  get paneOpener(): ((content: PaneContent) => void) | null { return this.overlayState.paneOpener; }
  set paneOpener(value: ((content: PaneContent) => void) | null) { this.overlayState.paneOpener = value; }
  get terminalOpen(): boolean { return this.overlayState.terminalOpen; }
  set terminalOpen(value: boolean) { this.overlayState.terminalOpen = value; }
  openTerminal(): void { this.overlayState.openTerminal(); }
  closeTerminal(): void { this.overlayState.closeTerminal(); }
  get screenOpen(): boolean { return this.overlayState.screenOpen; }
  set screenOpen(value: boolean) { this.overlayState.screenOpen = value; }
  openRemoteScreen(): void { this.overlayState.openRemoteScreen(); }
  closeRemoteScreen(): void { this.overlayState.closeRemoteScreen(); }
  watchTrace(taskId: string): () => void { return this.overlayState.watchTrace(taskId); }
  openTrace(taskId: string | null = null, focus: TraceFocus | null = null, opts: TraceOpenOptions = {}): void { this.overlayState.openTrace(taskId, focus, opts); }
  closeTrace(): void { this.overlayState.closeTrace(); }
  get traceOpen(): boolean { return this.overlayState.traceOpen; }
  openRoutine(botId: string, routineId: string): Promise<void> { return this.overlayState.openRoutine(botId, routineId); }
  openProfile(botId: string): void { this.overlayState.openProfile(botId); }
  closeProfile(): void { this.overlayState.closeProfile(); }
  closeSessionSettings(): void { this.overlayState.closeSessionSettings(); }
  openSettings(): void { this.overlayState.openSettings(); }
  openPromptSettings(prompt: PromptTarget | null): void { this.overlayState.openPromptSettings(prompt); }
  openWorkspace(selected?: string | null): void { this.overlayState.openWorkspace(selected); }
  closeWorkspace(): void { this.overlayState.closeWorkspace(); }
  openRoutines(): void { this.overlayState.openRoutines(); }
  closeRoutines(): void { this.overlayState.closeRoutines(); }
  openSpend(): void { this.overlayState.openSpend(); }
  closeSpend(): void { this.overlayState.closeSpend(); }
  applyOverlay(overlay: UrlOverlay): void { this.overlayState.applyOverlay(overlay); }
  closeSheets(): void { this.overlayState.closeSheets(); }

  // --- Forwarded to `terminalList` (the daemon's terminal sessions). ---
  get terminals(): Terminal[] { return this.terminalList.terminals; }
  set terminals(value: Terminal[]) { this.terminalList.terminals = value; }
  get terminalsLoaded(): boolean { return this.terminalList.terminalsLoaded; }
  set terminalsLoaded(value: boolean) { this.terminalList.terminalsLoaded = value; }
  startTerminal(cwd?: string): Promise<Terminal | null> { return this.terminalList.startTerminal(cwd); }
  openTerminalAt(cwd: string): Promise<void> { return this.terminalList.openTerminalAt(cwd); }
  refreshTerminals(): Promise<void> { return this.terminalList.refreshTerminals(); }

  // --- Forwarded to `connectionLoop` (the loop that keeps the link). ---
  retryConnection(): void { this.connectionLoop.retryConnection(); }

  // --- Forwarded to `sessionHistory` (selecting a conversation and paging its history). ---
  openChat(id: string, opts?: { messageId?: string }): Promise<void> { return this.sessionHistory.openChat(id, opts); }
  selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void> { return this.sessionHistory.selectSession(id, opts); }
  get hasOlderMessages(): boolean { return this.sessionHistory.hasOlderMessages; }
  loadOlderMessages(sessionId?: string): Promise<void> { return this.sessionHistory.loadOlderMessages(sessionId); }
  markSessionRead(id: string): Promise<void> { return this.sessionHistory.markSessionRead(id); }

  // --- Forwarded to `adminMutations` (the sheets' writes). ---
  patchSettings(patch: SettingsPatch): Promise<ApiError | null> { return this.adminMutations.patchSettings(patch); }
  patchSpeech(patch: PatchSpeechRequest): Promise<ApiError | null> { return this.adminMutations.patchSpeech(patch); }
  probeModels(
    baseUrl?: string,
    apiKey?: string,
    providerId?: string,
    apiFormat?: ApiFormat,
    workspaceId?: string | null,
  ): Promise<{ ok: true } & ProbeModelsResponse | { ok: false; error: string; status?: number }> { return this.adminMutations.probeModels(baseUrl, apiKey, providerId, apiFormat, workspaceId); }
  speedTest(providerId: string, model: string): Promise<{ ok: true; speed: ModelSpeed } | { ok: false; error: string }> { return this.adminMutations.speedTest(providerId, model); }
  createBot(body: CreateBotRequest): Promise<ApiError | null> { return this.adminMutations.createBot(body); }
  createGroup(body: CreateGroupRequest): Promise<ApiError | null> { return this.adminMutations.createGroup(body); }
  createSkill(body: CreateSkillRequest): Promise<ApiError | null> { return this.adminMutations.createSkill(body); }
  patchSkill(id: string, body: PatchSkillRequest): Promise<ApiError | null> { return this.adminMutations.patchSkill(id, body); }
  deleteSkill(id: string): Promise<ApiError | null> { return this.adminMutations.deleteSkill(id); }
  createRoutine(body: CreateRoutineRequest): Promise<ApiError | null> { return this.adminMutations.createRoutine(body); }
  patchRoutine(id: string, body: PatchRoutineRequest): Promise<ApiError | null> { return this.adminMutations.patchRoutine(id, body); }
  deleteRoutine(id: string, ifRevision: string): Promise<ApiError | null> { return this.adminMutations.deleteRoutine(id, ifRevision); }
  patchMemory(id: string, body: PatchMemoryRequest): Promise<ApiError | null> { return this.adminMutations.patchMemory(id, body); }
  deleteMemory(id: string): Promise<ApiError | null> { return this.adminMutations.deleteMemory(id); }
  patchBot(
    id: string,
    body: {
      name?: string;
      duties?: string;
      boundaries?: string;
      avatar?: string | null;
      model?: string | null;
      provider_id?: string | null;
      thinking_level?: ThinkingLevel | null;
      runner?: BotRunner | null;
      agent_model?: string | null;
      agent_effort?: string | null;
      agent_custom_id?: string | null;
    },
  ): Promise<ApiError | null> { return this.adminMutations.patchBot(id, body); }
  archiveBot(id: string): Promise<ApiError | null> { return this.adminMutations.archiveBot(id); }
  restoreBot(id: string): Promise<ApiError | null> { return this.adminMutations.restoreBot(id); }
  deleteBot(id: string): Promise<ApiError | null> { return this.adminMutations.deleteBot(id); }
  patchSession(id: string, body: { name: string }): Promise<ApiError | null> { return this.adminMutations.patchSession(id, body); }
  addMember(sessionId: string, botId: string): Promise<ApiError | null> { return this.adminMutations.addMember(sessionId, botId); }
  removeMember(sessionId: string, botId: string): Promise<ApiError | null> { return this.adminMutations.removeMember(sessionId, botId); }
  archiveSession(id: string): Promise<ApiError | null> { return this.adminMutations.archiveSession(id); }
  restoreSession(id: string): Promise<ApiError | null> { return this.adminMutations.restoreSession(id); }
  deleteSession(id: string, opts: { eraseQuotes?: boolean } = {}): Promise<ApiError | null> { return this.adminMutations.deleteSession(id, opts); }
  clearSessionHistory(id: string, opts: { eraseQuotes?: boolean } = {}): Promise<ApiError | null> { return this.adminMutations.clearSessionHistory(id, opts); }
  retryPendingMutation(): Promise<ApiError | null> { return this.adminMutations.retryPendingMutation(); }
  resolveCredentialOperation(id: string, action: "repair" | "cancel", value?: string): Promise<boolean> { return this.adminMutations.resolveCredentialOperation(id, action, value); }
  createProvider(body: CreateProviderRequest): Promise<ApiError | null> { return this.adminMutations.createProvider(body); }
  patchProvider(id: string, body: PatchProviderRequest): Promise<ApiError | null> { return this.adminMutations.patchProvider(id, body); }
  deleteProvider(id: string): Promise<ApiError | null> { return this.adminMutations.deleteProvider(id); }
  createMcpServer(body: {
    name: string;
    transport?: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    auth?: string;
    enabled: boolean;
    usage_note?: string;
  }): Promise<ApiError | null> { return this.adminMutations.createMcpServer(body); }
  patchMcpServer(
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
  ): Promise<ApiError | null> { return this.adminMutations.patchMcpServer(id, body); }
  deleteMcpServer(id: string): Promise<ApiError | null> { return this.adminMutations.deleteMcpServer(id); }

  // --- Forwarded to `threadState` (delegations, group leads, attribution plans). ---
  get delegationLoading(): Record<string, boolean> { return this.threadState.delegationLoading; }
  set delegationLoading(value: Record<string, boolean>) { this.threadState.delegationLoading = value; }
  get delegationLoadError(): Record<string, boolean> { return this.threadState.delegationLoadError; }
  set delegationLoadError(value: Record<string, boolean>) { this.threadState.delegationLoadError = value; }
  get delegationUnsupported(): Record<string, boolean> { return this.threadState.delegationUnsupported; }
  set delegationUnsupported(value: Record<string, boolean>) { this.threadState.delegationUnsupported = value; }
  get delegationSnapshotEpoch(): number { return this.threadState.delegationSnapshotEpoch; }
  set delegationSnapshotEpoch(value: number) { this.threadState.delegationSnapshotEpoch = value; }
  loadDelegations(sessionId: string): Promise<void> { return this.threadState.loadDelegations(sessionId); }
  get groupLeads(): Record<string, GroupLeadState> { return this.threadState.groupLeads; }
  set groupLeads(value: Record<string, GroupLeadState>) { this.threadState.groupLeads = value; }
  get groupLeadLoading(): Record<string, boolean> { return this.threadState.groupLeadLoading; }
  set groupLeadLoading(value: Record<string, boolean>) { this.threadState.groupLeadLoading = value; }
  get groupLeadLoadError(): Record<string, boolean> { return this.threadState.groupLeadLoadError; }
  set groupLeadLoadError(value: Record<string, boolean>) { this.threadState.groupLeadLoadError = value; }
  get groupLeadUnsupported(): Record<string, boolean> { return this.threadState.groupLeadUnsupported; }
  set groupLeadUnsupported(value: Record<string, boolean>) { this.threadState.groupLeadUnsupported = value; }
  loadGroupLead(sessionId: string): Promise<void> { return this.threadState.loadGroupLead(sessionId); }
  confirmGroupLead(sessionId: string, botId: string | null): Promise<ApiError | null> { return this.threadState.confirmGroupLead(sessionId, botId); }
  get attributionPlans(): Record<string, AttributionPlan[]> { return this.threadState.attributionPlans; }
  set attributionPlans(value: Record<string, AttributionPlan[]>) { this.threadState.attributionPlans = value; }
  get attributionLoading(): Record<string, boolean> { return this.threadState.attributionLoading; }
  set attributionLoading(value: Record<string, boolean>) { this.threadState.attributionLoading = value; }
  get attributionLoadError(): Record<string, boolean> { return this.threadState.attributionLoadError; }
  set attributionLoadError(value: Record<string, boolean>) { this.threadState.attributionLoadError = value; }
  loadAttributionPlans(sessionId: string, messageId?: string): Promise<void> { return this.threadState.loadAttributionPlans(sessionId, messageId); }

  // --- Forwarded to `messageEdits` (line edits, refiling, work answers). ---
  startEdit(sessionId: string, message: Message): void { this.messageEdits.startEdit(sessionId, message); }
  cancelEdit(sessionId: string): void { this.messageEdits.cancelEdit(sessionId); }
  saveEdit(sessionId: string): Promise<boolean> { return this.messageEdits.saveEdit(sessionId); }
  withdrawLine(sessionId: string, message: Message): Promise<boolean> { return this.messageEdits.withdrawLine(sessionId, message); }
  refillLine(sessionId: string, message: Message, opts?: { append?: boolean }): boolean { return this.messageEdits.refill(sessionId, message, opts); }
  insertLine(sessionId: string, message: Message): Promise<boolean> { return this.messageEdits.insertLine(sessionId, message); }
  messageVersions(id: string, editedAt: string): Promise<MessageVersion[] | null> { return this.messageEdits.messageVersions(id, editedAt); }
  patchMessageAttribution(id: string, filings: PatchMessageAttributionRequest["filings"]): Promise<ApiError | null> { return this.messageEdits.patchMessageAttribution(id, filings); }
  newJobFromMessage(id: string): Promise<ApiError | null> { return this.messageEdits.newJobFromMessage(id); }
  answerWorkQuestion(id: string, body: string): Promise<WorkAnswerResult | ApiError> { return this.messageEdits.answerWorkQuestion(id, body); }

  // --- Forwarded to `chatActivity` (live commands, kept commands, tool steps, streams). ---
  get activity(): CommandActivity { return this.chatActivity.activity; }
  get activityRevision(): number { return this.chatActivity.activityRevision; }
  set activityRevision(value: number) { this.chatActivity.activityRevision = value; }
  get keptCommandsRevision(): number { return this.chatActivity.keptCommandsRevision; }
  set keptCommandsRevision(value: number) { this.chatActivity.keptCommandsRevision = value; }
  get toolRevision(): number { return this.chatActivity.toolRevision; }
  set toolRevision(value: number) { this.chatActivity.toolRevision = value; }
  commandsOf(turnId: string): CommandRow[] { return this.chatActivity.commandsOf(turnId); }
  loadTurnCommands(turnId: string): void { this.chatActivity.loadTurnCommands(turnId); }
  stepOf(turnId: string): ToolStep | null { return this.chatActivity.stepOf(turnId); }
  stepsOf(turnId: string): readonly ToolStep[] { return this.chatActivity.stepsOf(turnId); }
  onStream(id: string, sink: (frame: StreamFrame) => void): () => void { return this.chatActivity.onStream(id, sink); }

  // --- Forwarded to `annotationStore` (annotations). ---
  get annotationFocusId(): string | null { return this.annotationStore.annotationFocusId; }
  set annotationFocusId(value: string | null) { this.annotationStore.annotationFocusId = value; }
  get annotationFileKeys(): Record<string, string> { return this.annotationStore.annotationFileKeys; }
  set annotationFileKeys(value: Record<string, string>) { this.annotationStore.annotationFileKeys = value; }
  loadAnnotations(filter: AnnotationFilter & { target_session_id?: string }): Promise<void> { return this.annotationStore.loadAnnotations(filter); }
  createAnnotation(input: CreateAnnotationRequest): Promise<ApiError | null> { return this.annotationStore.createAnnotation(input); }
  patchAnnotation(id: string, patch: PatchAnnotationRequest): Promise<ApiError | null> { return this.annotationStore.patchAnnotation(id, patch); }
  deleteAnnotation(id: string): Promise<ApiError | null> { return this.annotationStore.deleteAnnotation(id); }
  sendAnnotations(sessionId: string, summary: string, ids: string[]): Promise<ApiError | null> { return this.annotationStore.sendAnnotations(sessionId, summary, ids); }

  // --- Forwarded to `chatActions` (send, ask drafts and answers, reactions, stops, interrupts, approvals). ---
  get askDrafts(): Map<string, AskDraftRecord> { return this.chatActions.askDrafts; }
  set askDrafts(value: Map<string, AskDraftRecord>) { this.chatActions.askDrafts = value; }
  send(opts?: { attachments?: File[]; paths?: string[]; sessionId?: string }): Promise<boolean> { return this.chatActions.send(opts); }
  getAskDraft(askId: string): AskDraftRecord | undefined { return this.chatActions.getAskDraft(askId); }
  setAskDraft(askId: string, body: string): void { this.chatActions.setAskDraft(askId, body); }
  setAskSelection(askId: string, selected: readonly string[]): void { this.chatActions.setAskSelection(askId, selected); }
  clearAskDraft(askId: string, submittedVersion: number): void { this.chatActions.clearAskDraft(askId, submittedVersion); }
  setAskError(askId: string, error: string): void { this.chatActions.setAskError(askId, error); }
  sendAsk(askId: string, answer: { selected?: readonly string[]; custom?: string }, sessionId?: string): Promise<SendAskResult> { return this.chatActions.sendAsk(askId, answer, sessionId); }
  toggleReaction(messageId: string, emoji: string): Promise<void> { return this.chatActions.toggleReaction(messageId, emoji); }
  stopTurn(sessionId?: string, turnId?: string): Promise<void> { return this.chatActions.stopTurn(sessionId, turnId); }
  stopScope(
    scope: "global" | "bot" | "session" | "plan",
    scopeId: string | null,
    sessionId?: string | null,
    opts: { liftOnNext?: boolean } = {},
  ): Promise<ApiError | null> { return this.chatActions.stopScope(scope, scopeId, sessionId, opts); }
  liftHold(holdId: string): Promise<ApiError | null> { return this.chatActions.liftHold(holdId); }
  controlAction(messageId: string, action: ControlOffer, taskId?: string, note?: string): Promise<ApiError | { partial: NonNullable<ControlActionResult["partial"]> } | null> { return this.chatActions.controlAction(messageId, action, taskId, note); }
  continueInterrupt(messageId: string, sessionId?: string): Promise<void> { return this.chatActions.continueInterrupt(messageId, sessionId); }
  resolveApproval(
    id: string,
    action: ResolveApprovalRequest["action"],
    apiKey?: string,
    sessionId?: string,
  ): Promise<ApiError | null> { return this.chatActions.resolveApproval(id, action, apiKey, sessionId); }

  // --- Forwarded to `searchStore` (global search). ---
  get searchQuery(): string { return this.searchStore.searchQuery; }
  set searchQuery(value: string) { this.searchStore.searchQuery = value; }
  get searchHits(): SearchHit[] { return this.searchStore.searchHits; }
  set searchHits(value: SearchHit[]) { this.searchStore.searchHits = value; }
  get searchLoading(): boolean { return this.searchStore.searchLoading; }
  set searchLoading(value: boolean) { this.searchStore.searchLoading = value; }
  get searchError(): boolean { return this.searchStore.searchError; }
  set searchError(value: boolean) { this.searchStore.searchError = value; }
  clearSearchHighlight(): void { this.searchStore.clearSearchHighlight(); }
  closeSearch(): void { this.searchStore.closeSearch(); }
  runSearch(q: string): Promise<void> { return this.searchStore.runSearch(q); }

  // --- Private, forwarded: `ingest`, `start`/`destroy`, the window handlers and the tests reach these by name. ---
  private get traceWatchers(): Map<string, number> { return this.overlayState.traceWatchers; }
  private set traceWatchers(value: Map<string, number>) { this.overlayState.traceWatchers = value; }
  private boardShows(taskId: string | null | undefined): boolean { return this.overlayState.boardShows(taskId); }
  private get connectFailures(): number { return this.connectionLoop.connectFailures; }
  private set connectFailures(value: number) { this.connectionLoop.connectFailures = value; }
  private get remoteRetryMs(): number { return this.connectionLoop.remoteRetryMs; }
  private set remoteRetryMs(value: number) { this.connectionLoop.remoteRetryMs = value; }
  private get timer(): ReturnType<typeof setTimeout> | null { return this.connectionLoop.timer; }
  private set timer(value: ReturnType<typeof setTimeout> | null) { this.connectionLoop.timer = value; }
  private get nextAttemptAt(): number { return this.connectionLoop.nextAttemptAt; }
  private set nextAttemptAt(value: number) { this.connectionLoop.nextAttemptAt = value; }
  private tick(): Promise<void> { return this.connectionLoop.tick(); }
  private tickRemote(): Promise<void> { return this.connectionLoop.tickRemote(); }
  private installSnapshot(api: MessengerApi, sync: EventSync, snapshot: RuntimeSnapshot): Promise<void> { return this.connectionLoop.installSnapshot(api, sync, snapshot); }
  private resetConnection(): void { this.connectionLoop.resetConnection(); }
  private reconnectNow(): void { this.connectionLoop.reconnectNow(); }
  private pump(): void { this.connectionLoop.pump(); }
  private reconcilePendingMutation(api: MessengerApi): void { this.adminMutations.reconcilePendingMutation(api); }
  private get delegationEventSeq(): number { return this.threadState.delegationEventSeq; }
  private set delegationEventSeq(value: number) { this.threadState.delegationEventSeq = value; }
  private get delegationEventRevisions(): Map<string, number> { return this.threadState.delegationEventRevisions; }
  private get groupLeadSeq(): Map<string, number> { return this.threadState.groupLeadSeq; }
  private get groupLeadRevision(): Map<string, number> { return this.threadState.groupLeadRevision; }
  private loadAttributionFor(message: AttributedMessage & { id: string; session_id: string }): void { this.threadState.loadAttributionFor(message); }
  private renameAttributionPlan(id: string, title: string): void { this.threadState.renameAttributionPlan(id, title); }
  private get attributionRevision(): Map<string, number> { return this.messageEdits.attributionRevision; }
  private get messageInvalidationSeq(): number { return this.messageEdits.messageInvalidationSeq; }
  private set messageInvalidationSeq(value: number) { this.messageEdits.messageInvalidationSeq = value; }
  private get messageSessionInvalidated(): Map<string, number> { return this.messageEdits.messageSessionInvalidated; }
  private get keptCommands(): Map<string, CommandRow[]> { return this.chatActivity.keptCommands; }
  private get keptCommandsRead(): Set<string> { return this.chatActivity.keptCommandsRead; }
  private get turnActivity(): TurnActivity { return this.chatActivity.turnActivity; }
  private noteAnnotationWrite(id: string): void { this.annotationStore.noteAnnotationWrite(id); }

  private api: MessengerApi | null = null;
  private stopped = false;
  private sync: EventSync | null = null;
  /**
   * Bumped when the connection is replaced. The per-conversation counters say "a newer read of
   * this conversation started"; this one says "every read in flight belongs to a dead socket".
   * They were one counter, which is why loading a second conversation cancelled the first.
   */
  private connectionSeq = 0;
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

  /** Whether the Mac this phone reached offers its screen; learned on each link (`/remote/features`). */
  get screenOffered(): boolean {
    void this.connection;
    const api = this.api;
    return api?.kind === "remote" && api.screenOffered;
  }

  /** Whether that screen is a Mac's or a Windows PC's, for its words and its key row. */
  get screenHost(): "mac" | "windows" {
    void this.connection;
    const api = this.api;
    return api?.kind === "remote" ? api.screenHost : "mac";
  }

  setNotificationIntentHandler(handler: ((intent: NotificationOpenIntent) => void) | null): void {
    this.notificationCenter.setNotificationIntentHandler(handler);
  }

  private dispatchNotificationIntent(intent: NotificationOpenIntent): void {
    this.notificationCenter.dispatchNotificationIntent(intent);
  }

  applyNotificationIntent(intent: NotificationOpenIntent): void {
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
  async submitBoundedRead(sessionId: string, messageId: string, noticeMark: number = 0): Promise<void> {
    return this.notificationCenter.submitBoundedRead(sessionId, messageId, noticeMark);
  }

  noticeMark(sessionId: string): number {
    return this.notificationCenter.noticeMark(sessionId);
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

  private syncAppBadge(): void {
    this.notificationCenter.syncAppBadge();
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
      // Late message-write receipts cannot resurrect history erased by a newer event.
      this.messageSessionInvalidated.set(event.id, ++this.messageInvalidationSeq);
      // Only that conversation's reads are invalidated; another pane's are none of its business.
      const gone = this.views.get(event.id);
      if (gone) {
        gone.revision++;
        gone.resetHistory();
        // What it was following, flashing, replying to or changing went with the history.
        gone.focusedTurnId = null;
        gone.pendingFocusTrigger = null;
        gone.replyingToId = null;
        gone.editingMessageId = null;
        gone.editDraft = "";
        gone.editError = null;
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
    if (event.event === "delegation.changed") {
      this.delegationEventRevisions.set(event.id, ++this.delegationEventSeq);
      this.delegationUnsupported = { ...this.delegationUnsupported, [event.thread_session_id]: false };
      this.delegationLoadError = { ...this.delegationLoadError, [event.thread_session_id]: false };
    }
    if (event.event === "group_lead.changed") {
      const { event: _event, occurred_at: _at, ...state } = event;
      this.groupLeadRevision.set(state.session_id, (this.groupLeadRevision.get(state.session_id) ?? 0) + 1);
      this.groupLeadSeq.set(state.session_id, (this.groupLeadSeq.get(state.session_id) ?? 0) + 1);
      this.groupLeads = { ...this.groupLeads, [state.session_id]: state };
      this.groupLeadLoading = { ...this.groupLeadLoading, [state.session_id]: false };
      this.groupLeadUnsupported = { ...this.groupLeadUnsupported, [state.session_id]: false };
      this.groupLeadLoadError = { ...this.groupLeadLoadError, [state.session_id]: false };
    }
    if (event.event === "attribution.changed" || event.event === "message.upsert") {
      const id = event.event === "attribution.changed" ? event.message_id : event.id;
      this.attributionRevision.set(id, (this.attributionRevision.get(id) ?? 0) + 1);
      if (event.event === "attribution.changed") {
        this.traceReload += 1;
        if (this.attributionPlans[event.session_id]) void this.loadAttributionPlans(event.session_id);
      }
    }
    if (event.event === "message.created" || event.event === "message.upsert") this.loadAttributionFor(event);
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
    if (event.event === "prompt.changed") this.promptsRevision += 1;
    if (event.event === "turn.upsert") {
      this.claimFocus(event.session_id, event.trigger_message_id, event.id);
      // A finished turn keeps nothing of what it was doing: the transcript and its trace remain,
      // and its commands go under its reply — what this page saw now, the Mac's record once read.
      if (!isLiveStatus(event.status)) {
        const seen = this.activity.forTurn(event.id).map((row) => ({ ...row, running: false }));
        const kept = this.keptCommands.get(event.id);
        if (seen.length && (!kept || kept.length < seen.length)) {
          this.keptCommands.set(event.id, seen);
          this.keptCommandsRevision += 1;
        }
        this.keptCommandsRead.delete(event.id);
        // One read while it was waiting on you is behind it now: read it again.
        if (kept) this.loadTurnCommands(event.id);
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
    // You renamed a job: every tag that names it says the new name, without a reload.
    if (event.event === "task.upsert") this.renameAttributionPlan(event.id, event.title);
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
}
