import type {
  Approval,
  CredentialOperation,
  AllowRule,
  Routine,
  CreateRoutineRequest,
  PatchRoutineRequest,
  RuntimeSnapshot,
  SessionSnapshot,
  SyncFrame,
  StreamFrame,
  Terminal,
  ToolFrame,
  TerminalScrollback,
  TerminalScreenSnapshot,
  TerminalColors,
  TerminalSignal,
  SequencedEvent,
  Bot,
  CreateBotRequest,
  CreateBotResponse,
  CreateGroupRequest,
  CreateProviderRequest,
  CreateSkillRequest,
  ErrorBody,
  Judgement,
  ListPage,
  McpServer,
  Memory,
  Message,
  PatchMemoryRequest,
  PatchProviderRequest,
  PatchSkillRequest,
  ProbeModelsResponse,
  Provider,
  ResolveApprovalRequest,
  ComposerSuggestion,
  SearchHit,
  SessionDetail,
  SessionSummary,
  Settings,
  SettingsPatch,
  Skill,
  Spend,
  SpendDetail,
  SpendFilter,
  SpendPage,
  SpendSummary,
  SpendSummaryQuery,
  ThinkingLevel,
  Turn,
  TaskArtifacts,
  TaskTrace,
  SessionTaskSummary,
  WorkspaceTreePage,
} from "@real-bot/protocol";
import { isNonReceiptPath } from "@real-bot/protocol";
import { spendSearchParams } from "./spend/spend-query.ts";
import { parseStreamFrame, parseToolFrame } from "./ephemeral-frames.ts";
import type { LocalEndpoint } from "./discovery.ts";
import { ApiError, rememberBlobEtag, rememberBlobOriginalSize } from "./api.ts";
import { readResponseBlob, type FileLoadOptions, type FileProgressHandler } from "./file-progress.ts";
import type {
  DesktopClickResponse,
  NotificationDevice,
  NotificationDevicePatch,
  NotificationFilter,
  NotificationItem,
  NotificationListPage,
  NotificationPolicy,
  NotificationPolicyPatch,
  NotificationPresence,
  SessionNotificationPreference,
} from "./notifications/types.ts";
import {
  listNotifications,
  getNotification,
  markNotificationsRead,
  acknowledgeNotification,
  markSessionReadThrough,
  getNotificationPolicy,
  patchNotificationPolicy,
  putSessionNotificationPreference,
  getNotificationDevice,
  patchNotificationDevice,
  postNotificationPresence,
  type NotificationTestResult,
} from "./notifications/client.ts";

type PendingRequest = {
  id: string; method: string; path: string; payload?: BodyInit; fingerprint: string; pending: boolean;
  headers?: Record<string, string>; returnEtag?: boolean; supersedes?: string | null;
  terminal?: boolean;
  credential?: { operationId: string; instance: string; seq: number };
};

function requestId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = BigInt(Date.now());
  let prefix = "";
  for (let i = 0; i < 10; i++) { prefix = alphabet[Number(time & 31n)] + prefix; time >>= 5n; }
  return prefix + Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => alphabet[byte & 31]).join("");
}

export class LocalApi {
  readonly kind = "local" as const;
  private readonly pending = new Map<string, PendingRequest>();

  pendingRequests(): Array<{ id: string; method: string; path: string }> {
    return [...this.pending.values()].filter((row) => row.pending).map(({ id, method, path }) => ({ id, method, path }));
  }

  hasPendingRequest(id: string): boolean {
    return [...this.pending.values()].some((row) => row.id === id);
  }

  /** Only an accepted stream transition after this request's own operation proves retirement. */
  observeCredentialFrame(frame: SequencedEvent): void {
    if (frame.payload.event !== "credential_operations.changed") return;
    for (const row of this.pending.values()) {
      const seen = row.credential;
      if (seen && (seen.instance !== frame.event_instance_id || frame.seq <= seen.seq)) continue;
      const operation = frame.payload.items.find((op) => op.request_id === row.id);
      if (seen && operation?.id !== seen.operationId) this.retireSuperseded(row.id);
      else if (operation) row.credential = { operationId: operation.id, instance: frame.event_instance_id, seq: frame.seq };
    }
  }

  credentialOperations(): Promise<{ items: CredentialOperation[] }> { return this.get("/v1/credential-operations"); }

  async resolveCredential(id: string, action: "repair" | "cancel", value?: string): Promise<void> {
    const predecessor = (await this.credentialOperations()).items.find((op) => op.id === id)?.request_id;
    await this.request("POST", `/v1/credential-operations/${id}/resolve`, { action, ...(action === "repair" ? { value } : {}) }, undefined, {}, false, predecessor);
  }

  async retryPending(id: string): Promise<unknown> {
    const row = [...this.pending.values()].find((item) => item.id === id && item.pending);
    if (!row) throw new ApiError(404, "not_found", "pending request not found", id);
    return this.sendRequest(row);
  }

  forgetResolvedRequest(id: string): void {
    for (const [key, row] of this.pending) if (row.id === id) {
      row.terminal = true;
      row.pending = false;
      row.payload = undefined;
      row.fingerprint = "";
      this.pending.delete(key);
    }
  }

  private retireSuperseded(id: string): void {
    const row = [...this.pending.values()].find((item) => item.id === id);
    if (!row) return;
    this.forgetResolvedRequest(id);
    if (row.supersedes) this.retireSuperseded(row.supersedes);
  }

  constructor(readonly endpoint: LocalEndpoint) {}

  headers(): HeadersInit {
    return { Authorization: `Bearer ${this.endpoint.token}` };
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, undefined, signal);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    return this.get<RuntimeSnapshot>("/v1/snapshot");
  }

  async sessionSnapshot(id: string): Promise<SessionSnapshot> {
    return this.get<SessionSnapshot>(`/v1/sessions/${id}/snapshot`);
  }

  async routines(): Promise<Routine[]> {
    return (await this.get<ListPage<Routine>>("/v1/routines")).items;
  }

  async createRoutine(body: CreateRoutineRequest): Promise<Routine> {
    return this.post<Routine>("/v1/routines", body);
  }

  async patchRoutine(id: string, body: PatchRoutineRequest): Promise<Routine> {
    return this.patch<Routine>(`/v1/routines/${encodeURIComponent(id)}`, body);
  }

  async deleteRoutine(id: string, ifRevision: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/routines/${encodeURIComponent(id)}`, { if_revision: ifRevision });
  }

  async allowRules(): Promise<AllowRule[]> {
    return (await this.get<ListPage<AllowRule>>("/v1/allow-rules")).items;
  }

  async settings(): Promise<Settings> {
    return this.get<Settings>("/v1/settings");
  }

  async patchSettings(patch: SettingsPatch): Promise<Settings> {
    return this.patch<Settings>("/v1/settings", patch);
  }

  async probeModels(body: {
    endpoint_base_url?: string;
    endpoint_api_key?: string;
    provider_id?: string;
  }): Promise<ProbeModelsResponse> {
    return this.post<ProbeModelsResponse>("/v1/models/probe", body);
  }

  async providers(): Promise<Provider[]> {
    const page = await this.get<ListPage<Provider>>("/v1/providers");
    return page.items;
  }

  async createProvider(body: CreateProviderRequest): Promise<Provider> {
    return this.post<Provider>("/v1/providers", body);
  }

  async patchProvider(id: string, body: PatchProviderRequest): Promise<Provider> {
    return this.patch<Provider>(`/v1/providers/${id}`, body);
  }

  async deleteProvider(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/providers/${id}`);
  }

  async bots(): Promise<Bot[]> {
    const page = await this.get<ListPage<Bot>>("/v1/bots");
    return page.items;
  }

  async createBot(body: CreateBotRequest): Promise<CreateBotResponse> {
    return this.post<CreateBotResponse>("/v1/bots", body);
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
  ): Promise<Bot> {
    return this.patch<Bot>(`/v1/bots/${id}`, body);
  }

  async archiveBot(id: string): Promise<Bot> {
    return this.post<Bot>(`/v1/bots/${id}/archive`);
  }

  async restoreBot(id: string): Promise<Bot> {
    return this.post<Bot>(`/v1/bots/${id}/restore`);
  }

  async deleteBot(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/bots/${id}`);
  }

  async sessions(): Promise<SessionSummary[]> {
    const page = await this.get<ListPage<SessionSummary>>("/v1/sessions");
    return page.items;
  }

  async createGroup(body: CreateGroupRequest): Promise<SessionDetail> {
    return this.post<SessionDetail>("/v1/sessions", body);
  }

  async patchSession(id: string, body: { name: string }): Promise<SessionDetail> {
    return this.patch<SessionDetail>(`/v1/sessions/${id}`, body);
  }

  async addMember(sessionId: string, botId: string): Promise<SessionDetail> {
    return this.post<SessionDetail>(`/v1/sessions/${sessionId}/members`, { bot_id: botId });
  }

  async removeMember(sessionId: string, botId: string): Promise<SessionDetail> {
    return this.request<SessionDetail>("DELETE", `/v1/sessions/${sessionId}/members`, {
      bot_id: botId,
    });
  }

  async session(id: string): Promise<SessionDetail> {
    return this.get<SessionDetail>(`/v1/sessions/${id}`);
  }

  async markSessionRead(id: string): Promise<SessionSummary> {
    return this.post<SessionSummary>(`/v1/sessions/${id}/read`);
  }

  async archiveSession(id: string): Promise<SessionDetail> {
    return this.post<SessionDetail>(`/v1/sessions/${id}/archive`);
  }

  async restoreSession(id: string): Promise<SessionDetail> {
    return this.post<SessionDetail>(`/v1/sessions/${id}/restore`);
  }

  async deleteSession(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/sessions/${id}`);
  }

  async clearSessionHistory(id: string): Promise<void> {
    await this.post<void>(`/v1/sessions/${id}/clear`, {});
  }

  async messages(
    sessionId: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<ListPage<Message>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const query = params.toString();
    return this.get<ListPage<Message>>(
      `/v1/sessions/${sessionId}/messages${query ? `?${query}` : ""}`,
    );
  }

  async spend(): Promise<Spend[]> {
    const page = await this.spendPage({});
    return page.items;
  }

  /** Aggregates. The view asks for these instead of summing the ledger itself. */
  async spendSummary(query: SpendSummaryQuery = {}): Promise<SpendSummary> {
    return this.get<SpendSummary>(`/v1/spend/summary${spendSearchParams(query)}`);
  }

  /** One page of the ledger. `next` is the cursor for the following page. */
  async spendPage(filter: SpendFilter & { limit?: number; cursor?: string | null } = {}): Promise<SpendPage> {
    return this.get<SpendPage>(`/v1/spend${spendSearchParams({ ...filter, cursor: filter.cursor ?? undefined })}`);
  }

  async judgements(sessionId: string): Promise<Judgement[]> {
    const page = await this.get<ListPage<Judgement>>(`/v1/sessions/${sessionId}/judgements`);
    return page.items;
  }

  async composerSuggestions(sessionId: string, signal?: AbortSignal): Promise<ComposerSuggestion[]> {
    const page = await this.get<ListPage<ComposerSuggestion>>(
      `/v1/sessions/${sessionId}/composer-suggestions`,
      signal,
    );
    return page.items;
  }

  async search(q: string): Promise<SearchHit[]> {
    const page = await this.get<ListPage<SearchHit>>(`/v1/search?q=${encodeURIComponent(q)}`);
    return page.items;
  }

  async postMessage(
    sessionId: string,
    body: string,
    opts: {
      fork?: boolean;
      askId?: string | null;
      attachments?: File[];
      parentId?: string | null;
      requestId?: string;
      /** Not heard here: fetch reports no upload progress, and loopback takes a file at once. */
      onUploadProgress?: FileProgressHandler;
    } = {},
  ): Promise<Message> {
    const parentId = opts.parentId ?? null;
    const path = `/v1/sessions/${sessionId}/messages`;
    if (opts.attachments && opts.attachments.length > 0) {
      const form = new FormData();
      form.append("body", body);
      if (opts.fork) form.append("fork", "true");
      if (opts.askId) form.append("ask_id", opts.askId);
      if (parentId) form.append("parent_id", parentId);
      for (const file of opts.attachments) {
        form.append("files", file, file.name);
      }
      return this.request<Message>("POST", path, form, undefined, {}, false, null, opts.requestId);
    }
    return this.request<Message>("POST", path, {
      body,
      parent_id: parentId,
      fork: opts.fork ?? false,
      ask_id: opts.askId ?? null,
    }, undefined, {}, false, null, opts.requestId);
  }

  /** What this job cited, pulled once when its entry is opened. There is no push event for it. */
  async taskArtifacts(taskId: string, signal?: AbortSignal): Promise<TaskArtifacts> {
    return this.get<TaskArtifacts>(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts`, signal);
  }

  /** The turns that share a work dir, read back as one picture. Pulled when the trace opens. */
  async taskTrace(taskId: string, signal?: AbortSignal): Promise<TaskTrace> {
    return this.get<TaskTrace>(`/v1/tasks/${encodeURIComponent(taskId)}/trace`, signal);
  }

  /** The jobs this session took part in, newest activity first. */
  async sessionTasks(sessionId: string, signal?: AbortSignal): Promise<SessionTaskSummary[]> {
    const page = await this.get<ListPage<SessionTaskSummary>>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`,
      signal,
    );
    return page.items;
  }

  /**
   * Dev-only bridge to the pairing side of the host's setup channel. A packaged window reaches it
   * over the inherited socketpair instead; this route 404s unless the daemon was started with the
   * development switch.
   */
  async remoteSetup(request: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>("POST", "/v1/remote/setup", request);
  }

  /** Follow a running command's output. The id is `<turn_id>:<tool_call_id>`. */
  async watchCommand(id: string, from: number): Promise<void> {
    await this.post<void>("/v1/streams/watch", { id, from });
  }

  async unwatchCommand(id: string): Promise<void> {
    await this.post<void>("/v1/streams/unwatch", { id });
  }

  async terminals(): Promise<Terminal[]> {
    return (await this.get<{ items: Terminal[] }>("/v1/terminals")).items;
  }

  async openTerminal(cwd: string, rows: number, cols: number): Promise<Terminal> {
    return this.post<Terminal>("/v1/terminals", { cwd, rows, cols });
  }

  async terminalInput(id: string, data: string): Promise<void> {
    await this.post<void>(`/v1/terminals/${id}/input`, { data });
  }

  async terminalResize(id: string, rows: number, cols: number): Promise<Terminal> {
    return this.post<Terminal>(`/v1/terminals/${id}/resize`, { rows, cols });
  }

  async terminalSignal(id: string, signal: TerminalSignal): Promise<void> {
    await this.post<void>(`/v1/terminals/${id}/signal`, { signal });
  }

  /** Start receiving this terminal's bytes on the event socket, from a byte offset. */
  async watchTerminal(id: string, from: number): Promise<Terminal> {
    return this.post<Terminal>(`/v1/terminals/${id}/watch`, { from });
  }

  async unwatchTerminal(id: string): Promise<void> {
    await this.post<void>(`/v1/terminals/${id}/unwatch`, {});
  }

  async terminalScrollback(id: string, from: number): Promise<TerminalScrollback> {
    return this.get<TerminalScrollback>(`/v1/terminals/${id}/scrollback?from=${from}`);
  }

  /** The screen as the daemon holds it, and the offset live bytes resume at. What a pane attaches to. */
  async terminalScreen(id: string): Promise<TerminalScreenSnapshot> {
    return this.get<TerminalScreenSnapshot>(`/v1/terminals/${id}/screen`);
  }

  /** ⌘K for the session, so a pane that attaches later does not bring the history back. */
  async clearTerminalScreen(id: string): Promise<void> {
    await this.post<void>(`/v1/terminals/${id}/clear`, {});
  }

  /** This pane's colours, which the daemon answers a program's colour requests with. */
  async terminalColors(id: string, colors: TerminalColors): Promise<void> {
    await this.post<void>(`/v1/terminals/${id}/colors`, colors);
  }

  async closeTerminal(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/terminals/${id}`);
  }

  async workspaceTree(path = ""): Promise<WorkspaceTreePage> {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.get<WorkspaceTreePage>(`/v1/workspace/tree${query}`);
  }

  async hostTree(_path = ""): Promise<WorkspaceTreePage & { parent?: string | null }> {
    throw new ApiError(404, "not_found", "host browse is remote-only");
  }

  async putWorkspaceFile(path: string, content: string, ifMatch?: string | null): Promise<string | null> {
    return this.request<string | null>("PUT", "/v1/workspace/file", { path, content }, undefined, ifMatch ? { "If-Match": ifMatch } : {}, true);
  }

  async getWorkspaceFileBlob(path: string, onProgress?: FileProgressHandler, options?: FileLoadOptions): Promise<Blob> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.endpoint.token}` };
    const res = await fetch(
      `${this.endpoint.origin}/v1/workspace/file?path=${encodeURIComponent(path)}${options?.size ? `&size=${options.size}` : ""}`,
      { method: "GET", headers, signal: options?.signal },
    );
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as ErrorBody | null;
      throw new ApiError(
        res.status,
        json?.error?.code ?? "failed",
        json?.error?.message ?? "failed to fetch workspace file",
      );
    }
    const blob = await readResponseBlob(res, onProgress);
    const etag = res.headers.get("ETag");
    rememberBlobEtag(blob, etag);
    rememberBlobOriginalSize(blob, res.headers.get("X-Original-Size"));
    return blob;
  }

  async getAttachmentBlob(id: string, onProgress?: FileProgressHandler, options?: FileLoadOptions): Promise<Blob> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.endpoint.token}` };
    const res = await fetch(`${this.endpoint.origin}/v1/attachments/${id}/content${options?.size ? `?size=${options.size}` : ""}`, {
      method: "GET",
      headers,
      signal: options?.signal,
    });
    if (!res.ok) {
      throw new ApiError(res.status, "not_found", "failed to fetch attachment");
    }
    const blob = await readResponseBlob(res, onProgress);
    const etag = res.headers.get("ETag");
    rememberBlobEtag(blob, etag);
    rememberBlobOriginalSize(blob, res.headers.get("X-Original-Size"));
    return blob;
  }

  async stop(turnId?: string): Promise<void> {
    await this.post("/v1/turns/stop", turnId ? { turn_id: turnId } : {});
  }

  async continueInterrupt(messageId: string): Promise<Turn> {
    return this.post<Turn>("/v1/turns/continue", { message_id: messageId });
  }

  async putReaction(messageId: string, emoji: string): Promise<void> {
    await this.request<void>("PUT", `/v1/messages/${messageId}/reactions`, { emoji });
  }

  async deleteReaction(messageId: string, emoji: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/messages/${messageId}/reactions`, { emoji });
  }

  async mcpServers(): Promise<McpServer[]> {
    const page = await this.get<ListPage<McpServer>>("/v1/mcp-servers");
    return page.items;
  }

  async skills(): Promise<Skill[]> {
    const page = await this.get<ListPage<Skill>>("/v1/skills");
    return page.items;
  }

  async createSkill(body: CreateSkillRequest): Promise<Skill> {
    return this.post<Skill>("/v1/skills", body);
  }

  async patchSkill(id: string, body: PatchSkillRequest): Promise<Skill> {
    return this.patch<Skill>(`/v1/skills/${id}`, body);
  }

  async deleteSkill(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/skills/${id}`);
  }

  async memories(): Promise<Memory[]> {
    const page = await this.get<ListPage<Memory>>("/v1/memories");
    return page.items;
  }

  /** No create: the Bot writes its own memories; you correct them. */
  async patchMemory(id: string, body: PatchMemoryRequest): Promise<Memory> {
    return this.patch<Memory>(`/v1/memories/${id}`, body);
  }

  async deleteMemory(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/memories/${id}`);
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
  }): Promise<McpServer> {
    return this.post<McpServer>("/v1/mcp-servers", body);
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
  ): Promise<McpServer> {
    return this.patch<McpServer>(`/v1/mcp-servers/${id}`, body);
  }

  async deleteMcpServer(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/mcp-servers/${id}`);
  }

  async approvals(status?: "pending"): Promise<Approval[]> {
    const path = status ? `/v1/approvals?status=${status}` : "/v1/approvals";
    const page = await this.get<ListPage<Approval>>(path);
    return page.items;
  }

  async resolveApproval(id: string, body: ResolveApprovalRequest): Promise<Approval> {
    return this.post<Approval>(`/v1/approvals/${id}/resolve`, body);
  }

  async listNotifications(opts: {
    filter: NotificationFilter;
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<NotificationListPage> {
    return listNotifications(this, opts);
  }

  async getNotification(id: string): Promise<NotificationItem> {
    return getNotification(this, id);
  }

  async markNotificationsRead(
    body: { ids: string[] } | { through_ordinal: number; filter: "all" },
  ): Promise<void> {
    return markNotificationsRead(this, body);
  }

  async acknowledgeNotification(id: string, ifRevision: number): Promise<void> {
    return acknowledgeNotification(this, id, ifRevision);
  }

  async markSessionReadThrough(sessionId: string, throughMessageId: string): Promise<SessionSummary> {
    return markSessionReadThrough(this, sessionId, throughMessageId);
  }

  async getNotificationPolicy(): Promise<NotificationPolicy> {
    return getNotificationPolicy(this);
  }

  async patchNotificationPolicy(patch: NotificationPolicyPatch): Promise<NotificationPolicy> {
    return patchNotificationPolicy(this, patch);
  }

  async putSessionNotificationPreference(
    sessionId: string,
    body: { muted: boolean; if_revision: number },
  ): Promise<SessionNotificationPreference> {
    return putSessionNotificationPreference(this, sessionId, body);
  }

  async getNotificationDevice(): Promise<NotificationDevice> {
    return getNotificationDevice(this);
  }

  async patchNotificationDevice(patch: NotificationDevicePatch): Promise<NotificationDevice> {
    return patchNotificationDevice(this, patch);
  }

  async postNotificationPresence(body: NotificationPresence): Promise<void> {
    return postNotificationPresence(this, body);
  }

  async getDesktopClickTarget(clickRef: string): Promise<DesktopClickResponse> {
    return this.get<DesktopClickResponse>(`/v1/notifications/desktop/click/${encodeURIComponent(clickRef)}`);
  }

  async testDesktopNotification(): Promise<NotificationTestResult> {
    const raw = await this.post<unknown>("/v1/notifications/desktop/test", {});
    if (!raw || typeof raw !== "object") return { ok: true, status: "queued" };
    const row = raw as { ok?: unknown; status?: unknown };
    const status = typeof row.status === "string" ? row.status : "queued";
    return { ok: row.ok !== false, status };
  }

  eventsUrl(): string {
    return this.endpoint.origin.replace(/^http/, "ws") + "/v1/events";
  }

  authFrame(): string {
    return JSON.stringify({ type: "auth", token: this.endpoint.token, protocol: "sync-v1" });
  }

  /** Ephemeral frames arrive as raw text here; the rule itself is shared with the remote link. */
  parseStreamFrame(raw: string): StreamFrame | null {
    try {
      return parseStreamFrame(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  parseToolFrame(raw: string): ToolFrame | null {
    try {
      return parseToolFrame(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  parseSyncFrame(raw: string): SyncFrame | null {
    try {
      const frame = JSON.parse(raw);
      if (!frame || typeof frame !== "object" || typeof frame.event_instance_id !== "string" || !/^[0-9a-f]{32}$/.test(frame.event_instance_id)) return null;
      if (frame.type === "event") {
        if (!Number.isSafeInteger(frame.seq) || frame.seq < 1 || !frame.payload || typeof frame.payload.event !== "string") return null;
        if (frame.payload.event === "turn.token" || frame.payload.event === "turn.tool") return null;
        return frame;
      }
      if ((frame.type === "ready" || frame.type === "resnapshot") && Number.isSafeInteger(frame.watermark_seq) && frame.watermark_seq >= 0) return frame;
      return null;
    } catch {
      return null;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    conditional: Record<string, string> = {},
    returnEtag = false,
    supersedes?: string | null,
    id?: string,
  ): Promise<T> {
    if (method === "GET" || isNonReceiptPath(path)) {
      return this.sendRequest({ id: "", method, path, payload: body === undefined ? undefined : JSON.stringify(body), fingerprint: "", pending: false }, signal) as Promise<T>;
    }
    const payload = body instanceof FormData ? cloneForm(body) : JSON.stringify(body ?? {});
    const fingerprint = JSON.stringify([payload instanceof FormData ? await formFingerprint(payload) : payload, conditional]);
    const slot = `${method} ${path}`;
    let row = this.pending.get(slot);
    if (row && row.fingerprint !== fingerprint) throw new ApiError(409, "request_pending", "resolve the pending request before changing its payload", row.id);
    if (!row) {
      row = { id: id ?? requestId(), method, path, payload, fingerprint, pending: false, headers: conditional, returnEtag, supersedes };
      this.pending.set(slot, row);
    }
    return this.sendRequest(row, signal) as Promise<T>;
  }

  private async sendRequest(row: PendingRequest, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.endpoint.token}`, ...row.headers };
    if (row.id) headers["X-Request-Id"] = row.id;
    if (row.payload !== undefined && !(row.payload instanceof FormData)) headers["Content-Type"] = "application/json";
    let res: Response;
    try { res = await fetch(`${this.endpoint.origin}${row.path}`, { method: row.method, headers, body: row.payload, signal }); }
    catch {
      row.pending = Boolean(row.id) && !row.terminal;
      throw new ApiError(503, "request_unknown", "result unknown; explicitly retry the original request", row.id);
    }
    let json: ErrorBody | undefined;
    try { json = res.status === 204 ? undefined : await res.json() as ErrorBody; }
    catch {
      row.pending = Boolean(row.id) && !row.terminal;
      throw new ApiError(503, "request_unknown", "response incomplete; explicitly retry the original request", row.id);
    }
    // A pending-key response proves the takeover transaction committed, unlike a lost response.
    if (row.supersedes && (res.ok || json?.error?.code === "key_write_pending")) {
      this.retireSuperseded(row.supersedes);
      row.supersedes = null;
    }
    if (!res.ok) {
      const error = json as ErrorBody;
      row.pending = !row.terminal && error.error?.code === "key_write_pending";
      if (!row.pending) this.forgetResolvedRequest(row.id);
      throw new ApiError(res.status, error.error?.code ?? "failed", error.error?.message ?? "request failed", row.id || res.headers.get("X-Request-Id") || undefined);
    }
    this.forgetResolvedRequest(row.id);
    return row.returnEtag ? res.headers.get("ETag") : json;
  }
}

function cloneForm(form: FormData): FormData {
  const cloned = new FormData();
  for (const [name, value] of form) cloned.append(name, value);
  return cloned;
}

async function formFingerprint(form: FormData): Promise<string> {
  const fields = [];
  for (const [name, value] of form) fields.push([name, typeof value === "string" ? value : [value.name, Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await value.arrayBuffer())))]]);
  return JSON.stringify(fields);
}
