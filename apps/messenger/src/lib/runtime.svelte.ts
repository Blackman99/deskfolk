import {
  USER_MEMBER,
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
} from "@real-bot/protocol";
import { ApiError, probeHealth } from "./api.ts";
import type { LocalEndpoint } from "./discovery.ts";
import { classifyHealth } from "./health.ts";
import { collectUntilMessage } from "./sidebar/search-jump.ts";
import { classifySession, youBotSession } from "./sidebar/session-groups.ts";
import { applyEvent, emptySnapshot, fromRuntimeSnapshot, type Snapshot } from "./snapshot.ts";
import { EventSync } from "./event-sync.ts";
import { stopTarget } from "./chat/transcript.ts";
import type { UrlOverlay } from "./session-url.ts";
import { HOSTED_MESSENGER } from "./remote/mode.ts";
import type { LocalApi } from "./local-api.ts";
import { confirmPairing, openPairing, readPairing } from "./remote/pairing-host.ts";
import type { MessengerApi } from "./messenger-api.ts";
import { RemoteApi, type DurablePendingRequest, type RemoteDeviceRow, type RemoteDiagnostics, type RemoteMaintenanceStatus } from "./remote/api.ts";
import { loadEnrollment, type StoredEnrollment } from "./remote/idb.ts";
import { pairFromQr, type PairingProgress } from "./remote/pairing.ts";
import { disablePush, enablePush, isInboxMessage, pushPermission, type PushPermission } from "./remote/push.ts";

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
  selectedId = $state<string | null>(null);
  /** Workspace-relative path of the open artifact preview, or null when the pane is closed. */
  previewRelpath = $state<string | null>(null);
  previewMessageId = $state<string | null>(null);
  forceArtifactTree = $state(false);
  settingsOpen = $state(false);
  createBotOpen = $state(false);
  createGroupOpen = $state(false);
  sessionSettingsOpen = $state(false);
  routeLogOpen = $state(false);
  routesLoading = $state(false);
  profileBotId = $state<string | null>(null);
  profileRoutineId = $state<string | null>(null);
  workspaceOpen = $state(false);
  workspaceSelected = $state("");
  threadOpen = $state(false);
  searchQuery = $state("");
  searchHits = $state<SearchHit[]>([]);
  composerSuggestions = $state<ComposerSuggestion[]>([]);
  draft = $state("");
  replyingToId = $state<string | null>(null);
  busy = $state(false);
  pendingMutation = $state<{ id: string; code: string } | null>(null);
  focusedTurnId = $state<string | null>(null);
  highlightedMessageId = $state<string | null>(null);
  searchHighlightToken = $state(0);
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
  pushPermission = $state<PushPermission>("unsupported");

  private api: MessengerApi | null = null;
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private searchSeq = 0;
  private pendingFocusTrigger: string | null = null;
  private sessionMessageNext: string | null = null;
  private sessionDetailId: string | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private routesInFlight: string | null = null;
  private suggestAbort: AbortController | null = null;
  private suggestTimer: ReturnType<typeof setTimeout> | null = null;
  private suggestSeq = 0;
  private sync: EventSync | null = null;
  private sessionLoad = Promise.resolve();
  private sessionSeq = 0;
  private historyRevision = 0;
  private profileNavigation = 0;
  private durablePending: DurablePendingRequest[] = [];

  start(): void {
    if (this.timer) clearTimeout(this.timer);
    this.stopped = false;
    this.pushPermission = pushPermission();
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", this.onPushMessage);
    }
    this.pump();
  }

  destroy(): void {
    this.stopped = true;
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.removeEventListener("message", this.onPushMessage);
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
    this.createBotOpen = true;
  }

  openCreateGroup(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.createGroupOpen = true;
  }

  openSessionSettings(): void {
    this.profileNavigation++;
    this.profileRoutineId = null;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
    this.workspaceOpen = false;
    this.profileBotId = null;
    this.sessionSettingsOpen = true;
  }

  /** The model choice log is its own overlay, not a card inside the session panel. */
  toggleRouteLog(): void {
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

  closeRouteLog(): void {
    this.routeLogOpen = false;
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
      const selection = this.sessionSeq;
      await loading;
      if (this.api !== api || this.selectedId !== session.id || this.sessionSeq !== selection ||
        this.profileNavigation !== navigation) return;
    }
    if (!this.snapshot.bots.some((bot) => bot.id === botId)) return;
    this.openProfile(botId);
    this.profileRoutineId = routineId;
  }

  openProfile(botId: string): void {
    this.profileNavigation++;
    this.profileRoutineId = null;
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
    this.workspaceOpen = false;
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

  openSettings(): void {
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = false;
    this.settingsOpen = !this.settingsOpen;
  }

  openWorkspace(selected?: string | null): void {
    this.settingsOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = true;
    if (selected) this.workspaceSelected = selected;
  }

  closeWorkspace(): void {
    this.workspaceOpen = false;
  }

  /** Restore settings, the session drawer, or the workspace overlay from the URL. */
  applyOverlay(overlay: UrlOverlay): void {
    this.profileNavigation++;
    if (overlay.kind === "settings") {
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.closeSessionSettings();
      this.workspaceOpen = false;
      this.settingsOpen = true;
      return;
    }
    if (overlay.kind === "session") {
      this.settingsOpen = false;
      this.createBotOpen = false;
      this.createGroupOpen = false;
      this.threadOpen = false;
      this.workspaceOpen = false;
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
      this.profileBotId = overlay.botId;
      this.sessionSettingsOpen = true;
      return;
    }
    if (overlay.kind === "workspace") {
      this.settingsOpen = false;
      this.createGroupOpen = false;
      this.closeSessionSettings();
      this.workspaceOpen = true;
      this.workspaceSelected = overlay.selected ?? "";
      return;
    }
    this.settingsOpen = false;
    this.closeSessionSettings();
    this.workspaceOpen = false;
  }

  closeSheets(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.routeLogOpen = false;
    this.workspaceOpen = false;
  }

  async selectSession(id: string, opts?: { messageId?: string }): Promise<void> {
    const api = this.api;
    const sync = this.sync;
    const selection = ++this.sessionSeq;
    const messageId = opts?.messageId;
    this.setHighlightedMessage(messageId ?? null);
    this.routeLogOpen = false;
    if (this.selectedId !== id) {
      this.closeSessionSettings();
      this.threadOpen = false;
    }
    // A selected row may still have only summary data, not its history cursor.
    if (this.selectedId === id && this.sessionDetailId === id && messageId) {
      const revision = this.historyRevision;
      await this.ensureMessageLoaded(id, messageId);
      if (this.api !== api || this.sync !== sync || selection !== this.sessionSeq ||
        this.selectedId !== id || revision !== this.historyRevision) return;
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
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((s) =>
        s.id === id ? { ...s, unread_count: 0 } : s,
      ),
    };
    if (!api || !sync) return;
    this.sessionLoad = this.sessionLoad.catch(() => {}).then(async () => {
      if (selection !== this.sessionSeq || this.api !== api || this.sync !== sync) return;
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
        if (selection !== this.sessionSeq) return;
        this.applySessionDetail(id, { ...detail.session, unread_count: 0 }, detail.judgements);
        for (const frame of frames) {
          if (frame.event_instance_id !== detail.event_instance_id) throw new Error("event instance changed");
          if (frame.seq > detail.watermark_seq) this.ingest(frame.payload, frame);
        }
        if (messageId) {
          const revision = this.historyRevision;
          await this.ensureMessageLoaded(id, messageId);
          if (this.api !== api || this.sync !== sync || selection !== this.sessionSeq ||
            this.selectedId !== id || revision !== this.historyRevision) return;
          this.setHighlightedMessage(messageId);
        }
        if (this.api !== api || this.sync !== sync || selection !== this.sessionSeq || this.selectedId !== id) return;
        await this.markSessionRead(id);
      } catch {
        if (this.api === api) this.markDisconnected();
      }
    });
    await this.sessionLoad;
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
      const { items, reviews } = await this.api.routes(sessionId);
      this.snapshot = {
        ...this.snapshot,
        routes: [...this.snapshot.routes.filter((r) => r.session_id !== sessionId), ...items],
        routeReviews: reviews,
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

  async sendAsk(askId: string, body: string): Promise<void> {
    const api = this.api;
    const id = this.selectedId;
    const text = body.trim();
    if (!api || !id || !text || this.busy) return;
    this.busy = true;
    try {
      await api.postMessage(id, text, { askId });
    } catch (error) {
      if (this.api !== api) return;
      if (error instanceof ApiError && error.status === 422) return;
      this.keepUnknownRequest(error, api);
      this.markDisconnected();
    } finally {
      if (this.api === api) this.busy = false;
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

  private readonly onPushMessage = (event: MessageEvent): void => {
    if (!isInboxMessage(event.data)) return;
    this.hostUnreachable = "host";
    this.markDisconnected();
    this.pump();
  };

  async setPushEnabled(enabled: boolean): Promise<boolean> {
    const api = this.api;
    if (!(api instanceof RemoteApi) || this.pushBusy) return false;
    this.pushBusy = true;
    this.pushError = null;
    this.pushPermission = pushPermission();
    try {
      if (enabled) await enablePush(api);
      else await disablePush(api);
      if (this.api !== api) return false;
      this.pushEnabled = enabled;
      this.pushPermission = pushPermission();
      return true;
    } catch (error) {
      this.pushPermission = pushPermission();
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
    if (api instanceof RemoteApi) void this.refreshMaintenance();
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
      void this.selectSession(selected);
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
      const frames = sync.receive(frame);
      if (!frames) {
        this.markDisconnected();
        return;
      }
      for (const event of frames) this.ingest(event.payload, event);
    });
    const frames = sync.receive(ready);
    if (!frames) throw new Error("invalid remote ready");
    const snapshot = await api.snapshot();
    await this.installSnapshot(api, sync, snapshot);
    this.uvReady = api.uvReady;
    try {
      this.pushEnabled = (await api.pushState()).subscribed;
    } catch {
      this.pushEnabled = false;
    }
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
        const frame = api.parseSyncFrame(String(ev.data));
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
    const selection = this.sessionSeq;
    const revision = this.historyRevision;
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
      this.sessionSeq !== selection || this.historyRevision !== revision) return;
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
    if (this.api) this.reconcilePendingMutation(this.api);
    if (event.event === "session.cleared" || event.event === "session.removed") this.historyRevision++;
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
    if (
      (event.event === "message.created" || event.event === "message.upsert") &&
      event.session_id === this.selectedId &&
      event.parent_id === null &&
      event.author !== USER_MEMBER
    ) {
      next = {
        ...next,
        sessions: next.sessions.map((s) =>
          s.id === event.session_id ? { ...s, unread_count: 0 } : s,
        ),
      };
      void this.markSessionRead(event.session_id);
    }
    this.snapshot = next;
    if (this.api instanceof RemoteApi) this.api.observeSnapshot(this.snapshot);
    if (event.event === "settings.changed") {
      this.syncSettingsDraft(event);
    }
    if (event.event === "turn.upsert") {
      this.claimFocus(event.trigger_message_id, event.id);
      if (this.routeLogOpen && event.session_id === this.selectedId) {
        void this.refreshRoutes(event.session_id);
      }
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
    this.sessionSeq++;
    this.busy = false;
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
    this.timer = setTimeout(() => {
      this.pump();
    }, delay);
  }

  /** A tick that throws must still leave a timer behind, or the page never reconnects. */
  private pump(): void {
    void this.tick().catch(() => {
      this.markDisconnected();
      this.schedule();
    });
  }
}

function sameEndpoint(a: LocalEndpoint, b: LocalEndpoint): boolean {
  return a.origin === b.origin && a.token === b.token;
}
