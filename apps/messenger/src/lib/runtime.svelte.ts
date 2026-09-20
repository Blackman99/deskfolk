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
} from "@real-bot/protocol";
import { ApiError, LocalApi, probeHealth } from "./api.ts";
import { discoverEndpoint, type LocalEndpoint } from "./discovery.ts";
import { classifyHealth } from "./health.ts";
import { collectUntilMessage } from "./sidebar/search-jump.ts";
import { classifySession, youBotSession } from "./sidebar/session-groups.ts";
import { applyEvent, emptySnapshot, fromRuntimeSnapshot, type Snapshot } from "./snapshot.ts";
import { EventSync } from "./event-sync.ts";
import { stopTarget } from "./chat/transcript.ts";
import type { UrlOverlay } from "./session-url.ts";

export type Connection = "disconnected" | "connected";

const RETRY_MS = 1000;

export class MessengerRuntime {
  connection = $state<Connection>("disconnected");
  snapshot = $state<Snapshot>(emptySnapshot());
  selectedId = $state<string | null>(null);
  /** Workspace-relative path of the open artifact preview, or null when the pane is closed. */
  previewRelpath = $state<string | null>(null);
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

  private api: LocalApi | null = null;
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

  start(): void {
    if (this.timer) clearTimeout(this.timer);
    this.stopped = false;
    void this.tick();
  }

  destroy(): void {
    this.stopped = true;
    this.markDisconnected();
    if (this.timer) clearTimeout(this.timer);
    this.clearHighlightTimer();
    this.cancelComposerSuggestions();
  }

  get client(): LocalApi | null {
    return this.api;
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

  private routineFailure(error: unknown, api: LocalApi): ApiError {
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
    const parentId = this.replyingToId;
    this.busy = true;
    try {
      const message = await api.postMessage(id, body, {
        attachments: opts?.attachments,
        parentId,
      });
      if (this.api !== api) return;
      this.draft = "";
      this.replyingToId = null;
      this.pendingFocusTrigger = message.id;
      this.claimFocus(message.id);
    } catch (error) {
      if (this.api !== api) return;
      if (error instanceof ApiError && error.status === 422) return;
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

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const endpoint = await discoverEndpoint();
    if (!endpoint) {
      this.markDisconnected();
      this.schedule();
      return;
    }
    if (this.stopped) return;
    const health = await probeHealth(endpoint.origin);
    if (this.stopped) return;
    if (classifyHealth(health.status, health.body) !== "ours") {
      this.markDisconnected();
      this.schedule();
      return;
    }
    if (this.connection === "connected" && this.api && sameEndpoint(this.api.endpoint, endpoint)) {
      this.schedule();
      return;
    }
    try {
      await this.connect(endpoint);
    } catch {
      this.markDisconnected();
    }
    this.schedule();
  }

  private async connect(endpoint: LocalEndpoint): Promise<void> {
    this.resetConnection();
    const api = new LocalApi(endpoint);
    const sync = new EventSync();
    this.api = api;
    this.sync = sync;
    await this.openSocket(api, sync);
    const snapshot = await api.snapshot();
    if (this.stopped || this.api !== api || this.sync !== sync) return;
    const frames = sync.install(snapshot);
    if (!frames) throw new Error("event gap during snapshot");
    this.snapshot = fromRuntimeSnapshot(snapshot);
    this.syncSettingsDraft(snapshot.settings);
    for (const frame of frames) this.ingest(frame.payload, frame);
    this.endpointKey = "";
    this.connection = "connected";
    this.focusedTurnId = null;
    this.pendingFocusTrigger = null;
    const selected = this.selectedId;
    if (selected && this.snapshot.sessions.some((s) => s.id === selected)) {
      void this.selectSession(selected);
    } else if (selected) {
      this.selectedId = null;
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

  private reconcilePendingMutation(api: LocalApi): void {
    if (this.api === api && this.pendingMutation && !api.hasPendingRequest(this.pendingMutation.id)) this.pendingMutation = null;
  }

  private sheetFailure(error: unknown, api: LocalApi): ApiError | null {
    if (this.api !== api) return null;
    if (error instanceof ApiError && error.requestId) {
      const pending = api.hasPendingRequest(error.requestId);
      const resumable = ["key_write_pending", "request_pending", "request_unknown"].includes(error.code);
      if (pending && resumable) this.pendingMutation = { id: error.requestId, code: error.code };
      else if (this.pendingMutation?.id === error.requestId) this.pendingMutation = null;
      if (!pending && resumable) return null;
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
    this.connection = "disconnected";
    this.teardownSocket();
    this.api = null;
    this.pendingMutation = null;
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

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, RETRY_MS);
  }
}

function sameEndpoint(a: LocalEndpoint, b: LocalEndpoint): boolean {
  return a.origin === b.origin && a.token === b.token;
}
