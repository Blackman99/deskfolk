import type {
  Approval,
  Bot,
  ClientEvent,
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
  RouteRecord,
  RouteReview,
  ComposerSuggestion,
  SearchHit,
  SessionDetail,
  SessionSummary,
  Settings,
  SettingsPatch,
  Skill,
  Spend,
  ThinkingLevel,
  Turn,
  WorkspaceTreePage,
} from "@real-bot/protocol";
import type { LocalEndpoint } from "./discovery.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

const blobEtags = new WeakMap<Blob, string>();

export function etagForBlob(blob: Blob): string | null {
  return blobEtags.get(blob) ?? null;
}

type PendingRequest = { id: string; method: string; path: string; payload?: BodyInit; fingerprint: string; pending: boolean; headers?: Record<string, string>; returnEtag?: boolean };
export type CredentialOperation = { id: string; kind: string; entity_id: string; request_id: string | null };

function requestId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = BigInt(Date.now());
  let prefix = "";
  for (let i = 0; i < 10; i++) { prefix = alphabet[Number(time & 31n)] + prefix; time >>= 5n; }
  return prefix + Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => alphabet[byte & 31]).join("");
}

export class LocalApi {
  private readonly pending = new Map<string, PendingRequest>();

  pendingRequests(): Array<{ id: string; method: string; path: string }> {
    return [...this.pending.values()].filter((row) => row.pending).map(({ id, method, path }) => ({ id, method, path }));
  }

  credentialOperations(): Promise<{ items: CredentialOperation[] }> { return this.get("/v1/credential-operations"); }

  resolveCredential(id: string, action: "repair" | "cancel", value?: string): Promise<void> {
    return this.post(`/v1/credential-operations/${id}/resolve`, { action, ...(action === "repair" ? { value } : {}) });
  }

  async retryPending(id: string): Promise<unknown> {
    const row = [...this.pending.values()].find((item) => item.id === id && item.pending);
    if (!row) throw new ApiError(404, "not_found", "pending request not found");
    return this.sendRequest(row);
  }

  forgetResolvedRequest(id: string): void {
    for (const [key, row] of this.pending) if (row.id === id) this.pending.delete(key);
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

  async markSessionRead(id: string): Promise<SessionDetail> {
    return this.post<SessionDetail>(`/v1/sessions/${id}/read`);
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
    const page = await this.get<ListPage<Spend>>("/v1/spend");
    return page.items;
  }

  async judgements(sessionId: string): Promise<Judgement[]> {
    const page = await this.get<ListPage<Judgement>>(`/v1/sessions/${sessionId}/judgements`);
    return page.items;
  }

  async routes(sessionId: string): Promise<{ items: RouteRecord[]; reviews: RouteReview[] }> {
    const page = await this.get<ListPage<RouteRecord> & { reviews?: RouteReview[] }>(
      `/v1/sessions/${sessionId}/routes`,
    );
    return { items: page.items, reviews: page.reviews ?? [] };
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
    } = {},
  ): Promise<Message> {
    const parentId = opts.parentId ?? null;
    if (opts.attachments && opts.attachments.length > 0) {
      const form = new FormData();
      form.append("body", body);
      if (opts.fork) form.append("fork", "true");
      if (opts.askId) form.append("ask_id", opts.askId);
      if (parentId) form.append("parent_id", parentId);
      for (const file of opts.attachments) {
        form.append("files", file, file.name);
      }
      return this.post<Message>(`/v1/sessions/${sessionId}/messages`, form);
    }
    return this.post<Message>(`/v1/sessions/${sessionId}/messages`, {
      body,
      parent_id: parentId,
      fork: opts.fork ?? false,
      ask_id: opts.askId ?? null,
    });
  }

  async workspaceTree(path = ""): Promise<WorkspaceTreePage> {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.get<WorkspaceTreePage>(`/v1/workspace/tree${query}`);
  }

  async putWorkspaceFile(path: string, content: string, ifMatch?: string | null): Promise<string | null> {
    return this.request<string | null>("PUT", "/v1/workspace/file", { path, content }, undefined, ifMatch ? { "If-Match": ifMatch } : {}, true);
  }

  async getWorkspaceFileBlob(path: string): Promise<Blob> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.endpoint.token}` };
    const res = await fetch(
      `${this.endpoint.origin}/v1/workspace/file?path=${encodeURIComponent(path)}`,
      { method: "GET", headers },
    );
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as ErrorBody | null;
      throw new ApiError(
        res.status,
        json?.error?.code ?? "failed",
        json?.error?.message ?? "failed to fetch workspace file",
      );
    }
    const blob = await res.blob();
    const etag = res.headers.get("ETag");
    if (etag) blobEtags.set(blob, etag);
    return blob;
  }

  async getAttachmentBlob(id: string): Promise<Blob> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.endpoint.token}` };
    const res = await fetch(`${this.endpoint.origin}/v1/attachments/${id}/content`, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      throw new ApiError(res.status, "not_found", "failed to fetch attachment");
    }
    const blob = await res.blob();
    const etag = res.headers.get("ETag");
    if (etag) blobEtags.set(blob, etag);
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

  eventsUrl(): string {
    return this.endpoint.origin.replace(/^http/, "ws") + "/v1/events";
  }

  authFrame(): string {
    return JSON.stringify({ type: "auth", token: this.endpoint.token });
  }

  parseEvent(raw: string): ClientEvent | null {
    try {
      const parsed = JSON.parse(raw) as ClientEvent;
      if (!parsed || typeof parsed !== "object" || typeof parsed.event !== "string") return null;
      return parsed;
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
  ): Promise<T> {
    if (method === "GET" || path === "/v1/models/probe") {
      return this.sendRequest({ id: "", method, path, payload: body === undefined ? undefined : JSON.stringify(body), fingerprint: "", pending: false }, signal) as Promise<T>;
    }
    const payload = body instanceof FormData ? cloneForm(body) : JSON.stringify(body ?? {});
    const fingerprint = JSON.stringify([payload instanceof FormData ? await formFingerprint(payload) : payload, conditional]);
    const slot = `${method} ${path}`;
    let row = this.pending.get(slot);
    if (row && row.fingerprint !== fingerprint) throw new ApiError(409, "request_pending", "resolve the pending request before changing its payload", row.id);
    if (!row) {
      row = { id: requestId(), method, path, payload, fingerprint, pending: false, headers: conditional, returnEtag };
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
      row.pending = Boolean(row.id);
      throw new ApiError(503, "request_unknown", "result unknown; explicitly retry the original request", row.id);
    }
    let json: ErrorBody | undefined;
    try { json = res.status === 204 ? undefined : await res.json() as ErrorBody; }
    catch {
      row.pending = Boolean(row.id);
      throw new ApiError(503, "request_unknown", "response incomplete; explicitly retry the original request", row.id);
    }
    if (!res.ok) {
      const error = json as ErrorBody;
      row.pending = error.error?.code === "key_write_pending";
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

export async function probeHealth(origin: string): Promise<{ status: number | null; body: unknown }> {
  try {
    const res = await fetch(`${origin}/v1/health`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return { status: null, body: null };
  }
}
