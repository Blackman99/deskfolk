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
  Message,
  PatchProviderRequest,
  PatchSkillRequest,
  ProbeModelsResponse,
  Provider,
  ResolveApprovalRequest,
  RouteRecord,
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
  ) {
    super(message);
  }
}

export class LocalApi {
  constructor(readonly endpoint: LocalEndpoint) {}

  headers(): HeadersInit {
    return { Authorization: `Bearer ${this.endpoint.token}` };
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
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

  async routes(sessionId: string): Promise<RouteRecord[]> {
    const page = await this.get<ListPage<RouteRecord>>(`/v1/sessions/${sessionId}/routes`);
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

  async putWorkspaceFile(path: string, content: string): Promise<void> {
    await this.request<void>("PUT", "/v1/workspace/file", { path, content });
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
    return await res.blob();
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
    return await res.blob();
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.endpoint.token}` };
    let payload: BodyInit | undefined;
    if (body !== undefined && method !== "GET") {
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        payload = body;
      } else {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }
    const res = await fetch(`${this.endpoint.origin}${path}`, { method, headers, body: payload });
    if (res.status === 204) return undefined as T;
    const json = (await res.json()) as T | ErrorBody;
    if (!res.ok) {
      const err = json as ErrorBody;
      throw new ApiError(res.status, err.error?.code ?? "failed", err.error?.message ?? "request failed");
    }
    return json as T;
  }
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
