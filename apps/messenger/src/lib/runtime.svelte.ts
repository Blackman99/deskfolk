import {
  USER_MEMBER,
  type Bot,
  type ClientEvent,
  type CreateBotRequest,
  type CreateGroupRequest,
  type McpServer,
  type Message,
  type CreateProviderRequest,
  type PatchProviderRequest,
  type ProbeModelsResponse,
  type Provider,
  type ResolveApprovalRequest,
  type ComposerSuggestion,
  type SearchHit,
  type SessionDetail,
  type SettingsPatch,
  type Skill,
  type ThinkingLevel,
  type CreateSkillRequest,
  type PatchSkillRequest,
  type Turn,
} from "@real-bot/protocol";
import { ApiError, LocalApi, probeHealth } from "./api.ts";
import { discoverEndpoint, type LocalEndpoint } from "./discovery.ts";
import { classifyHealth } from "./health.ts";
import { collectUntilMessage } from "./search-jump.ts";
import { applyEvent, emptySnapshot, type Snapshot } from "./snapshot.ts";
import { stopTarget } from "./transcript.ts";

export type Connection = "disconnected" | "connected";

const RETRY_MS = 1000;

export class MessengerRuntime {
  connection = $state<Connection>("disconnected");
  snapshot = $state<Snapshot>(emptySnapshot());
  selectedId = $state<string | null>(null);
  settingsOpen = $state(false);
  createBotOpen = $state(false);
  createGroupOpen = $state(false);
  sessionSettingsOpen = $state(false);
  routeLogOpen = $state(false);
  routesLoading = $state(false);
  profileBotId = $state<string | null>(null);
  threadOpen = $state(false);
  searchQuery = $state("");
  searchHits = $state<SearchHit[]>([]);
  composerSuggestions = $state<ComposerSuggestion[]>([]);
  draft = $state("");
  replyingToId = $state<string | null>(null);
  busy = $state(false);
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
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private routesInFlight: string | null = null;
  private suggestAbort: AbortController | null = null;
  private suggestTimer: ReturnType<typeof setTimeout> | null = null;
  private suggestSeq = 0;

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  destroy(): void {
    this.stopped = true;
    this.teardownSocket();
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
    this.createBotOpen = true;
  }

  openCreateGroup(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.closeSessionSettings();
    this.createGroupOpen = true;
  }

  openSessionSettings(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
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

  openProfile(botId: string): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.threadOpen = false;
    this.profileBotId = botId;
    this.sessionSettingsOpen = true;
  }

  closeSessionSettings(): void {
    this.sessionSettingsOpen = false;
    this.profileBotId = null;
  }

  openSettings(): void {
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.settingsOpen = !this.settingsOpen;
  }

  closeSheets(): void {
    this.settingsOpen = false;
    this.createBotOpen = false;
    this.createGroupOpen = false;
    this.closeSessionSettings();
    this.routeLogOpen = false;
  }

  async selectSession(id: string, opts?: { messageId?: string }): Promise<void> {
    const messageId = opts?.messageId;
    this.setHighlightedMessage(messageId ?? null);
    this.closeSessionSettings();
    this.routeLogOpen = false;
    this.threadOpen = false;
    if (this.selectedId === id && messageId) {
      await this.ensureMessageLoaded(id, messageId);
      this.setHighlightedMessage(messageId);
      return;
    }
    this.selectedId = id;
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
    if (!this.api) return;
    try {
      const detail = await this.api.session(id);
      const judgements = await this.api.judgements(id);
      this.applySessionDetail(id, { ...detail, unread_count: 0 }, judgements);
      if (messageId) {
        await this.ensureMessageLoaded(id, messageId);
        this.setHighlightedMessage(messageId);
      }
      await this.markSessionRead(id);
    } catch {
      this.markDisconnected();
    }
  }

  async markSessionRead(id: string): Promise<void> {
    if (!this.api) return;
    try {
      const detail = await this.api.markSessionRead(id);
      this.snapshot = {
        ...this.snapshot,
        sessions: this.snapshot.sessions.map((s) =>
          s.id === id
            ? {
                ...s,
                last_read_at: detail.last_read_at ?? s.last_read_at ?? null,
                unread_count: 0,
              }
            : s,
        ),
      };
    } catch {
      this.snapshot = {
        ...this.snapshot,
        sessions: this.snapshot.sessions.map((s) =>
          s.id === id ? { ...s, unread_count: 0 } : s,
        ),
      };
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
    if (!this.api) return null;
    try {
      const settings = await this.api.patchSettings(patch);
      this.snapshot = { ...this.snapshot, settings };
      this.syncSettingsDraft(settings);
      if (patch.endpoint_api_key !== undefined) this.endpointKey = "";
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) return error;
      this.markDisconnected();
      return null;
    }
  }

  async probeModels(
    baseUrl?: string,
    apiKey?: string,
    providerId?: string,
  ): Promise<{ ok: true } & ProbeModelsResponse | { ok: false; error: string }> {
    if (!this.api) return { ok: false, error: "Not connected" };
    try {
      const res = await this.api.probeModels({
        endpoint_base_url: baseUrl,
        endpoint_api_key: apiKey,
        provider_id: providerId,
      });
      return { ok: true, models: res.models, catalog: res.catalog ?? [] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: msg };
    }
  }

  async createBot(body: CreateBotRequest): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const created = await this.api.createBot(body);
      this.ingest({
        event: "bot.upsert",
        occurred_at: created.bot.updated_at,
        ...created.bot,
        deleted_at: null,
      });
      this.ingestSession(created.direct_session);
      this.closeSheets();
      await this.selectSession(created.direct_session.id);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async createGroup(body: CreateGroupRequest): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const session = await this.api.createGroup(body);
      this.ingestSession(session);
      this.closeSheets();
      await this.selectSession(session.id);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async createSkill(body: CreateSkillRequest): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const skill = await this.api.createSkill(body);
      this.ingestSkill(skill);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async patchSkill(id: string, body: PatchSkillRequest): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const skill = await this.api.patchSkill(id, body);
      this.ingestSkill(skill);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async deleteSkill(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      await this.api.deleteSkill(id);
      this.ingest({ event: "skill.removed", occurred_at: new Date().toISOString(), id });
      return null;
    } catch (error) {
      return this.sheetFailure(error);
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
    if (!this.api) return null;
    try {
      const bot = await this.api.patchBot(id, body);
      this.ingestBot(bot, null);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async archiveBot(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const bot = await this.api.archiveBot(id);
      this.ingestBot(bot, null);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async restoreBot(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const bot = await this.api.restoreBot(id);
      this.ingestBot(bot, null);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async deleteBot(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    const existing = this.snapshot.bots.find((bot) => bot.id === id);
    try {
      await this.api.deleteBot(id);
      if (existing) this.ingestBot(existing, new Date().toISOString());
      if (this.profileBotId === id) this.profileBotId = null;
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async patchSession(id: string, body: { name: string }): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const session = await this.api.patchSession(id, body);
      this.ingestSession(session);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async addMember(sessionId: string, botId: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const session = await this.api.addMember(sessionId, botId);
      this.ingestSession(session);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async removeMember(sessionId: string, botId: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const session = await this.api.removeMember(sessionId, botId);
      this.ingestSession(session);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async archiveSession(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const session = await this.api.archiveSession(id);
      this.ingestSession(session);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async restoreSession(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const session = await this.api.restoreSession(id);
      this.ingestSession(session);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async deleteSession(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      await this.api.deleteSession(id);
      this.ingest({ event: "session.removed", occurred_at: new Date().toISOString(), id });
      if (this.selectedId === id) {
        this.selectedId = null;
        this.closeSessionSettings();
        this.focusedTurnId = null;
      }
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async clearSessionHistory(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      await this.api.clearSessionHistory(id);
      this.ingest({ event: "session.cleared", occurred_at: new Date().toISOString(), id });
      if (this.selectedId === id) {
        this.focusedTurnId = null;
        this.setHighlightedMessage(null);
        this.sessionMessageNext = null;
      }
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async createProvider(body: CreateProviderRequest): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const provider = await this.api.createProvider(body);
      this.ingestProvider(provider);
      this.snapshot = { ...this.snapshot, settings: await this.api.settings() };
      this.syncSettingsDraft(this.snapshot.settings);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async patchProvider(id: string, body: PatchProviderRequest): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      const provider = await this.api.patchProvider(id, body);
      this.ingestProvider(provider);
      this.snapshot = { ...this.snapshot, settings: await this.api.settings() };
      this.syncSettingsDraft(this.snapshot.settings);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
    }
  }

  async deleteProvider(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      await this.api.deleteProvider(id);
      this.ingest({ event: "provider.removed", occurred_at: new Date().toISOString(), id });
      this.snapshot = { ...this.snapshot, settings: await this.api.settings() };
      this.syncSettingsDraft(this.snapshot.settings);
      return null;
    } catch (error) {
      return this.sheetFailure(error);
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
    if (!this.api) return null;
    try {
      const server = await this.api.createMcpServer(body);
      this.ingestMcp(server);
      return null;
    } catch (error) {
      return this.mcpFailure(error);
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
    if (!this.api) return null;
    try {
      const server = await this.api.patchMcpServer(id, body);
      this.ingestMcp(server);
      return null;
    } catch (error) {
      return this.mcpFailure(error);
    }
  }

  async deleteMcpServer(id: string): Promise<ApiError | null> {
    if (!this.api) return null;
    try {
      await this.api.deleteMcpServer(id);
      this.ingest({ event: "mcp.removed", occurred_at: new Date().toISOString(), id });
      return null;
    } catch (error) {
      return this.mcpFailure(error);
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
      this.draft = "";
      this.replyingToId = null;
      this.pendingFocusTrigger = message.id;
      this.ingest({
        event: "message.created",
        occurred_at: message.created_at,
        ...message,
      });
      this.claimFocus(message.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) return;
      this.markDisconnected();
    } finally {
      this.busy = false;
    }
  }

  async sendAsk(askId: string, body: string): Promise<void> {
    const api = this.api;
    const id = this.selectedId;
    const text = body.trim();
    if (!api || !id || !text || this.busy) return;
    this.busy = true;
    try {
      const message = await api.postMessage(id, text, { askId });
      this.ingest({
        event: "message.created",
        occurred_at: message.created_at,
        ...message,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) return;
      this.markDisconnected();
    } finally {
      this.busy = false;
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
    if (!this.api || this.connection !== "connected") return;
    const selected = this.snapshot.sessions.find((session) => session.id === this.selectedId);
    const turnId = stopTarget(
      this.snapshot.turns,
      this.selectedId,
      this.focusedTurnId,
      selected?.kind ?? null,
    );
    if (!turnId) return;
    try {
      await this.api.stop(turnId);
    } catch {
      this.markDisconnected();
    }
  }

  async continueInterrupt(messageId: string): Promise<void> {
    if (!this.api || this.connection !== "connected" || this.busy) return;
    this.busy = true;
    try {
      const turn = await this.api.continueInterrupt(messageId);
      this.ingest({
        event: "turn.upsert",
        occurred_at: turn.created_at,
        ...turn,
      });
      this.focusedTurnId = turn.id;
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) return;
      this.markDisconnected();
    } finally {
      this.busy = false;
    }
  }

  async resolveApproval(
    id: string,
    action: ResolveApprovalRequest["action"],
    apiKey?: string,
  ): Promise<ApiError | null> {
    if (!this.api || this.busy) return null;
    this.busy = true;
    try {
      const body: ResolveApprovalRequest = { action };
      if (typeof apiKey === "string" && apiKey.length > 0) body.api_key = apiKey;
      const row = await this.api.resolveApproval(id, body);
      this.ingest({
        event: "approval.upsert",
        occurred_at: row.resolved_at ?? row.created_at,
        ...row,
      });
      return null;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 422 || error.status === 409)) return error;
      this.markDisconnected();
      return null;
    } finally {
      this.busy = false;
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
    const health = await probeHealth(endpoint.origin);
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
    const api = new LocalApi(endpoint);
    const [settings, bots, sessions, spend, approvals, mcpServers, providers, skills] = await Promise.all([
      api.settings(),
      api.bots(),
      api.sessions(),
      api.spend(),
      api.approvals(),
      api.mcpServers(),
      api.providers(),
      api.skills(),
    ]);
    const initialMessages = sessions
      .map((s) => s.last_message)
      .filter((m): m is Message => Boolean(m));
    const initialTurns = sessions.flatMap((s) => s.live_turns ?? []);
    const initialPending = sessions.flatMap((s) => s.pending_judgements ?? []);
    this.api = api;
    this.snapshot = {
      ...emptySnapshot(),
      settings,
      bots,
      sessions,
      spend,
      approvals,
      mcpServers,
      providers,
      skills,
      messages: initialMessages,
      turns: initialTurns,
      pendingJudgements: initialPending,
    };
    this.syncSettingsDraft(settings);
    this.endpointKey = "";
    this.connection = "connected";
    this.focusedTurnId = null;
    this.pendingFocusTrigger = null;
    this.openSocket(api);
    const selected = this.selectedId;
    if (selected && sessions.some((s) => s.id === selected)) {
      await this.selectSession(selected);
    } else if (selected) {
      this.selectedId = null;
    }
  }

  private openSocket(api: LocalApi): void {
    this.teardownSocket();
    const ws = new WebSocket(api.eventsUrl());
    this.ws = ws;
    ws.addEventListener("open", () => {
      ws.send(api.authFrame());
    });
    ws.addEventListener("message", (ev) => {
      const event = api.parseEvent(String(ev.data));
      if (!event) return;
      this.ingest(event);
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.markDisconnected();
    });
    ws.addEventListener("error", () => {
      ws.close();
    });
  }

  private ingestBot(bot: Bot, deletedAt: string | null): void {
    this.ingest({
      event: "bot.upsert",
      occurred_at: bot.updated_at,
      ...bot,
      deleted_at: deletedAt,
    });
  }

  private ingestSkill(skill: Skill): void {
    this.ingest({
      event: "skill.upsert",
      occurred_at: skill.updated_at,
      ...skill,
    });
  }

  private ingestProvider(provider: Provider): void {
    this.ingest({
      event: "provider.upsert",
      occurred_at: provider.updated_at,
      ...provider,
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

  private ingestMcp(server: McpServer): void {
    this.ingest({
      event: "mcp.upsert",
      occurred_at: server.updated_at,
      ...server,
    });
  }

  private mcpFailure(error: unknown): ApiError | null {
    return this.sheetFailure(error);
  }

  private sheetFailure(error: unknown): ApiError | null {
    if (
      error instanceof ApiError &&
      (error.status === 422 || error.status === 404 || error.status === 409)
    ) {
      return error;
    }
    this.markDisconnected();
    return null;
  }

  private async ensureMessageLoaded(sessionId: string, messageId: string): Promise<void> {
    if (!this.api) return;
    const loaded = this.snapshot.messages.filter((m) => m.session_id === sessionId);
    if (loaded.some((m) => m.id === messageId)) return;
    const result = await collectUntilMessage(
      loaded,
      messageId,
      (cursor) => this.api!.messages(sessionId, { cursor }),
      this.sessionMessageNext,
    );
    this.sessionMessageNext = result.next;
    this.snapshot = {
      ...this.snapshot,
      messages: [
        ...this.snapshot.messages.filter((m) => m.session_id !== sessionId),
        ...result.messages,
      ],
    };
  }

  private applySessionDetail(
    id: string,
    detail: SessionDetail,
    judgements: Snapshot["judgements"],
  ): void {
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

  private ingestSession(session: SessionDetail): void {
    this.ingest({
      event: "session.upsert",
      occurred_at: session.updated_at,
      id: session.id,
      kind: session.kind,
      name: session.name,
      last_read_at: session.last_read_at ?? null,
      archived_at: session.archived_at ?? null,
      created_at: session.created_at,
      updated_at: session.updated_at,
      participants: session.participants,
      unread_count: session.unread_count ?? 0,
    });
  }

  private ingest(event: ClientEvent): void {
    if (event.event === "session.removed") {
      if (this.selectedId === event.id) {
        this.selectedId = null;
        this.closeSessionSettings();
        this.focusedTurnId = null;
        this.setHighlightedMessage(null);
        this.sessionMessageNext = null;
      }
    }
    if (event.event === "session.cleared") {
      if (this.selectedId === event.id) {
        this.focusedTurnId = null;
        this.setHighlightedMessage(null);
        this.sessionMessageNext = null;
      }
    }
    let next = applyEvent(this.snapshot, event);
    if (
      event.event === "message.created" &&
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
      (event.event === "message.created" || event.event === "session.cleared") &&
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

  private markDisconnected(): void {
    this.connection = "disconnected";
    this.teardownSocket();
    this.api = null;
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
