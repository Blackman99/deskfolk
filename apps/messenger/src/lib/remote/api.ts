import type {
  Approval,
  AllowRule,
  Bot,
  ComposerSuggestion,
  CreateBotRequest,
  CreateBotResponse,
  CreateGroupRequest,
  CreateProviderRequest,
  CreateRoutineRequest,
  CreateSkillRequest,
  CredentialOperation,
  ErrorBody,
  Judgement,
  ListPage,
  McpServer,
  Memory,
  Message,
  PatchMemoryRequest,
  PatchProviderRequest,
  PatchRoutineRequest,
  PatchSkillRequest,
  ProbeModelsResponse,
  Provider,
  ResolveApprovalRequest,
  RouteLearning,
  RouteRecord,
  RouteReview,
  Routine,
  RuntimeSnapshot,
  SearchHit,
  SequencedEvent,
  SessionDetail,
  SessionSnapshot,
  SessionSummary,
  Settings,
  SettingsPatch,
  Skill,
  Spend,
  SyncFrame,
  ThinkingLevel,
  Turn,
  TaskArtifacts,
  WorkspaceTreePage,
} from "@real-bot/protocol";
import {
  fromBase64url,
  REMOTE_FILE_LIMIT,
  sha256Hex,
  type IdentitySecrets,
  type RemoteRequest,
  type RemoteResponse,
} from "@real-bot/remote";
import { ApiError, rememberBlobEtag } from "../api.ts";
import type { FileProgressHandler } from "../file-progress.ts";
import type { LocalEndpoint } from "../discovery.ts";
import type { Snapshot } from "../snapshot.ts";
import { ulid } from "./ids.ts";
import type { StoredEnrollment } from "./idb.ts";
import { RemoteTransport, type TransportHooks } from "./transport.ts";
import { createAssertion, createRegistration, type WebAuthnBridge } from "./webauthn.ts";

export type RemoteDeviceRow = { id: string; name: string; revoked: boolean; hasUv: boolean; lastActiveAt: number | null };
export type RemoteMaintenanceStatus = {
  version: string;
  mode: "window" | "standalone" | "none";
  reachability: string;
  restart: "available" | "unavailable";
  stopped: boolean;
  drain: { phase: "running" | "draining" | "drained"; remaining: number; forced: boolean };
  devices: RemoteDeviceRow[];
};
export type RemoteDiagnostics = {
  version: string;
  mode: "window" | "standalone" | "none";
  drain: RemoteMaintenanceStatus["drain"];
  counts: Record<string, number>;
  turns: Record<string, number>;
  approvals: Record<string, number>;
  errors: Record<string, number>;
};

export type DurablePendingRequest = {
  id: string;
  method: RemoteRequest["method"];
  path: string;
  fingerprint: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  ifMatch?: string;
  returnEtag?: boolean;
  supersedes?: string | null;
  /** The send itself failed: nobody knows whether the Mac ran it. Not the same as a queued key write. */
  unknown?: boolean;
};

type PendingRemote = DurablePendingRequest & {
  pending: boolean;
  terminal?: boolean;
  credential?: { operationId: string; instance: string; seq: number };
};

function durablePending(row: PendingRemote): DurablePendingRequest {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    fingerprint: row.fingerprint,
    ...(row.query ? { query: row.query } : {}),
    ...(row.body ? { body: row.body } : {}),
    ...(row.ifMatch ? { ifMatch: row.ifMatch } : {}),
    ...(row.returnEtag ? { returnEtag: true } : {}),
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
  };
}

function identityFrom(enrollment: StoredEnrollment): IdentitySecrets {
  return {
    dh: fromBase64url(enrollment.dh, 32),
    signing: fromBase64url(enrollment.signing, 32),
    enrollment: fromBase64url(enrollment.enrollment, 32),
  };
}

function split(path: string): { path: string; query?: Record<string, string> } {
  const i = path.indexOf("?");
  if (i < 0) return { path };
  const query: Record<string, string> = {};
  new URLSearchParams(path.slice(i + 1)).forEach((value, key) => {
    query[key] = value;
  });
  return { path: path.slice(0, i), query: Object.keys(query).length ? query : undefined };
}

function jsonBody(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  if (body instanceof FormData) throw new ApiError(422, "not_retryable", "remote attachments use Noise streams");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(422, "invalid_args", "body must be an object");
  return body as Record<string, unknown>;
}

async function attachmentManifest(files: File[]): Promise<Array<{ filename: string; size: number; sha256: string; bytes: Uint8Array }>> {
  const out: Array<{ filename: string; size: number; sha256: string; bytes: Uint8Array }> = [];
  for (const file of files) {
    if (file.size > REMOTE_FILE_LIMIT) throw new ApiError(413, "file_limit", "remote attachments are limited to 50 MiB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    out.push({ filename: file.name || "attachment", size: bytes.length, sha256: sha256Hex(bytes), bytes });
  }
  return out;
}

export class RemoteApi {
  readonly kind = "remote" as const;
  readonly endpoint: LocalEndpoint;
  private readonly pending = new Map<string, PendingRemote>();
  private transport: RemoteTransport | null = null;
  private readonly identity: IdentitySecrets;
  private revisions = new Map<string, string>();
  private settingsRev: number | undefined;
  uvReady = false;
  constructor(
    readonly enrollment: StoredEnrollment,
    private readonly hooks: TransportHooks & {
      webauthn?: WebAuthnBridge;
      rpc?: (request: RemoteRequest) => Promise<RemoteResponse>;
    } = {},
    restore: DurablePendingRequest[] = [],
  ) {
    this.identity = identityFrom(enrollment);
    this.endpoint = { origin: enrollment.relayOrigin, token: "" };
    this.restorePending(restore);
  }

  restorePending(rows: DurablePendingRequest[]): void {
    for (const row of rows) {
      this.pending.set(`${row.method} ${row.path}`, {
        ...row,
        pending: true,
        // A row that outlived the page never had its answer read here, so its result is unknown
        // until the Mac says otherwise — which is what lets a later edit settle it.
        unknown: true,
      });
    }
  }

  durablePending(): DurablePendingRequest[] {
    return [...this.pending.values()].filter((row) => row.pending && !row.terminal).map(durablePending);
  }

  pendingRequests(): Array<{ id: string; method: string; path: string }> {
    return [...this.pending.values()].filter((row) => row.pending).map(({ id, method, path }) => ({ id, method, path }));
  }
  hasPendingRequest(id: string): boolean {
    return [...this.pending.values()].some((row) => row.id === id);
  }
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
  observeSnapshot(snapshot: RuntimeSnapshot | Snapshot): void {
    this.settingsRev = snapshot.settings.settings_rev;
    const note = (kind: string, id: string, rev: string) => this.revisions.set(`${kind}/${id}`, rev);
    for (const row of snapshot.bots) note("bots", row.id, row.updated_at);
    for (const row of snapshot.sessions) note("sessions", row.id, row.updated_at);
    for (const row of snapshot.providers) note("providers", row.id, row.updated_at);
    for (const row of snapshot.mcpServers) note("mcp-servers", row.id, row.updated_at);
    for (const row of snapshot.skills) note("skills", row.id, row.updated_at);
    for (const row of snapshot.memories) note("memories", row.id, row.updated_at);
    for (const row of snapshot.routines) note("routines", row.id, row.updated_at);
    for (const row of snapshot.allowRules) note("allow-rules", row.id, row.created_at);
  }
  forgetResolvedRequest(id: string): void {
    for (const [key, row] of this.pending) if (row.id === id) {
      row.terminal = true;
      row.pending = false;
      this.pending.delete(key);
    }
  }
  private retireSuperseded(id: string): void {
    const row = [...this.pending.values()].find((item) => item.id === id);
    if (!row) return;
    this.forgetResolvedRequest(id);
    if (row.supersedes) this.retireSuperseded(row.supersedes);
  }

  async connect(onEvent: (frame: SyncFrame) => void): Promise<SyncFrame> {
    this.close();
    const transport = new RemoteTransport(this.enrollment, this.identity, this.hooks);
    transport.subscribe(onEvent);
    const ready = await transport.connect();
    this.transport = transport;
    return { type: "ready", event_instance_id: ready.event_instance_id, watermark_seq: ready.watermark_seq };
  }
  close(): void {
    this.transport?.close();
    this.transport = null;
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

  async snapshot(): Promise<RuntimeSnapshot> {
    const snapshot = await this.get<RuntimeSnapshot>("/v1/snapshot");
    this.observeSnapshot(snapshot);
    return snapshot;
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
    return this.patch<Routine>(`/v1/routines/${encodeURIComponent(id)}`, this.withRevision("routines", id, body));
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
    const body = { ...patch } as SettingsPatch & { if_revision?: number };
    if (body.if_revision === undefined && this.settingsRev !== undefined) body.if_revision = this.settingsRev;
    return this.patch<Settings>("/v1/settings", body);
  }
  async probeModels(body: {
    endpoint_base_url?: string;
    endpoint_api_key?: string;
    provider_id?: string;
  }): Promise<ProbeModelsResponse> {
    return this.post<ProbeModelsResponse>("/v1/models/probe", body);
  }
  async providers(): Promise<Provider[]> {
    return (await this.get<ListPage<Provider>>("/v1/providers")).items;
  }
  async createProvider(body: CreateProviderRequest): Promise<Provider> {
    return this.post<Provider>("/v1/providers", body);
  }
  async patchProvider(id: string, body: PatchProviderRequest): Promise<Provider> {
    return this.patch<Provider>(`/v1/providers/${id}`, this.withRevision("providers", id, body));
  }
  async deleteProvider(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/providers/${id}`, this.revisionBody("providers", id));
  }
  async bots(): Promise<Bot[]> {
    return (await this.get<ListPage<Bot>>("/v1/bots")).items;
  }
  async createBot(body: CreateBotRequest): Promise<CreateBotResponse> {
    return this.post<CreateBotResponse>("/v1/bots", body);
  }
  async patchBot(id: string, body: {
    name?: string; duties?: string; boundaries?: string; avatar?: string | null;
    model?: string | null; provider_id?: string | null; thinking_level?: ThinkingLevel | null;
  }): Promise<Bot> {
    return this.patch<Bot>(`/v1/bots/${id}`, this.withRevision("bots", id, body));
  }
  async archiveBot(id: string): Promise<Bot> {
    return this.post<Bot>(`/v1/bots/${id}/archive`, this.revisionBody("bots", id));
  }
  async restoreBot(id: string): Promise<Bot> {
    return this.post<Bot>(`/v1/bots/${id}/restore`, this.revisionBody("bots", id));
  }
  async deleteBot(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/bots/${id}`, this.revisionBody("bots", id));
  }
  async sessions(): Promise<SessionSummary[]> {
    return (await this.get<ListPage<SessionSummary>>("/v1/sessions")).items;
  }
  async createGroup(body: CreateGroupRequest): Promise<SessionDetail> {
    return this.post<SessionDetail>("/v1/sessions", body);
  }
  async patchSession(id: string, body: { name: string }): Promise<SessionDetail> {
    return this.patch<SessionDetail>(`/v1/sessions/${id}`, this.withRevision("sessions", id, body));
  }
  async addMember(sessionId: string, botId: string): Promise<SessionDetail> {
    return this.post<SessionDetail>(`/v1/sessions/${sessionId}/members`, { bot_id: botId });
  }
  async removeMember(sessionId: string, botId: string): Promise<SessionDetail> {
    return this.request<SessionDetail>("DELETE", `/v1/sessions/${sessionId}/members`, {
      ...this.revisionBody("sessions", sessionId),
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
    return this.post<SessionDetail>(`/v1/sessions/${id}/archive`, this.revisionBody("sessions", id));
  }
  async restoreSession(id: string): Promise<SessionDetail> {
    return this.post<SessionDetail>(`/v1/sessions/${id}/restore`, this.revisionBody("sessions", id));
  }
  async deleteSession(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/sessions/${id}`, this.revisionBody("sessions", id));
  }
  async clearSessionHistory(id: string): Promise<void> {
    await this.post<void>(`/v1/sessions/${id}/clear`, this.revisionBody("sessions", id));
  }
  async messages(sessionId: string, opts: { cursor?: string | null; limit?: number } = {}): Promise<ListPage<Message>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const query = params.toString();
    return this.get<ListPage<Message>>(`/v1/sessions/${sessionId}/messages${query ? `?${query}` : ""}`);
  }
  async spend(): Promise<Spend[]> {
    return (await this.get<ListPage<Spend>>("/v1/spend")).items;
  }
  async judgements(sessionId: string): Promise<Judgement[]> {
    return (await this.get<ListPage<Judgement>>(`/v1/sessions/${sessionId}/judgements`)).items;
  }
  async routes(
    sessionId: string,
  ): Promise<{ items: RouteRecord[]; reviews: RouteReview[]; learnings: RouteLearning[] }> {
    const page = await this.get<
      ListPage<RouteRecord> & { reviews?: RouteReview[]; learnings?: RouteLearning[] }
    >(`/v1/sessions/${sessionId}/routes`);
    return { items: page.items, reviews: page.reviews ?? [], learnings: page.learnings ?? [] };
  }
  async composerSuggestions(sessionId: string, signal?: AbortSignal): Promise<ComposerSuggestion[]> {
    return (await this.get<ListPage<ComposerSuggestion>>(`/v1/sessions/${sessionId}/composer-suggestions`, signal)).items;
  }
  async search(q: string): Promise<SearchHit[]> {
    return (await this.get<ListPage<SearchHit>>(`/v1/search?q=${encodeURIComponent(q)}`)).items;
  }
  async postMessage(sessionId: string, body: string, opts: {
    fork?: boolean; askId?: string | null; attachments?: File[]; parentId?: string | null;
  } = {}): Promise<Message> {
    const files = opts.attachments?.length ? await attachmentManifest(opts.attachments) : [];
    return this.request<Message>("POST", `/v1/sessions/${sessionId}/messages`, {
      body,
      parent_id: opts.parentId ?? null,
      fork: opts.fork ?? false,
      ask_id: opts.askId ?? null,
      ...(files.length ? { files: files.map(({ filename, size, sha256 }) => ({ filename, size, sha256 })) } : {}),
    }, undefined, {}, false, null, undefined, files);
  }
  /** What this job cited, pulled once when its entry is opened. There is no push event for it. */
  async taskArtifacts(taskId: string): Promise<TaskArtifacts> {
    return this.get<TaskArtifacts>(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts`);
  }
  async workspaceTree(path = ""): Promise<WorkspaceTreePage> {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.get<WorkspaceTreePage>(`/v1/workspace/tree${query}`);
  }
  async hostTree(path = ""): Promise<WorkspaceTreePage & { parent?: string | null }> {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.get(`/v1/host/tree${query}`);
  }
  async putWorkspaceFile(path: string, content: string, ifMatch?: string | null): Promise<string | null> {
    return this.request<string | null>("PUT", "/v1/workspace/file", { path, content }, undefined, ifMatch ? { "If-Match": ifMatch } : {}, true);
  }
  async getWorkspaceFileBlob(path: string, onProgress?: FileProgressHandler): Promise<Blob> {
    return this.fileBlob("/v1/workspace/file", { path }, onProgress);
  }
  async getAttachmentBlob(id: string, onProgress?: FileProgressHandler): Promise<Blob> {
    return this.fileBlob(`/v1/attachments/${id}/content`, undefined, onProgress);
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
    return (await this.get<ListPage<McpServer>>("/v1/mcp-servers")).items;
  }
  async skills(): Promise<Skill[]> {
    return (await this.get<ListPage<Skill>>("/v1/skills")).items;
  }
  async createSkill(body: CreateSkillRequest): Promise<Skill> {
    return this.post<Skill>("/v1/skills", body);
  }
  async patchSkill(id: string, body: PatchSkillRequest): Promise<Skill> {
    return this.patch<Skill>(`/v1/skills/${id}`, this.withRevision("skills", id, body));
  }
  async deleteSkill(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/skills/${id}`, this.revisionBody("skills", id));
  }
  async memories(): Promise<Memory[]> {
    return (await this.get<ListPage<Memory>>("/v1/memories")).items;
  }
  async patchMemory(id: string, body: PatchMemoryRequest): Promise<Memory> {
    return this.patch<Memory>(`/v1/memories/${id}`, this.withRevision("memories", id, body));
  }
  async deleteMemory(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/memories/${id}`, this.revisionBody("memories", id));
  }
  async createMcpServer(body: {
    name: string; transport?: "stdio" | "http"; command?: string; args?: string[]; url?: string;
    headers?: Array<{ name: string; value: string }>; auth?: string; enabled: boolean; usage_note?: string;
  }): Promise<McpServer> {
    return this.post<McpServer>("/v1/mcp-servers", body);
  }
  async patchMcpServer(id: string, body: {
    name?: string; transport?: "stdio" | "http"; command?: string; args?: string[]; url?: string;
    headers?: Array<{ name: string; value: string }>; auth?: string; enabled?: boolean; usage_note?: string | null;
  }): Promise<McpServer> {
    return this.patch<McpServer>(`/v1/mcp-servers/${id}`, this.withRevision("mcp-servers", id, body));
  }
  async deleteMcpServer(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/mcp-servers/${id}`, this.revisionBody("mcp-servers", id));
  }
  async approvals(status?: "pending"): Promise<Approval[]> {
    const path = status ? `/v1/approvals?status=${status}` : "/v1/approvals";
    return (await this.get<ListPage<Approval>>(path)).items;
  }
  async resolveApproval(id: string, body: ResolveApprovalRequest): Promise<Approval> {
    return this.post<Approval>(`/v1/approvals/${id}/resolve`, body);
  }
  async credentialOperations(): Promise<{ items: CredentialOperation[] }> {
    return this.get("/v1/credential-operations");
  }
  async resolveCredential(id: string, action: "repair" | "cancel", value?: string): Promise<void> {
    const predecessor = (await this.credentialOperations()).items.find((op) => op.id === id)?.request_id;
    await this.request("POST", `/v1/credential-operations/${id}/resolve`, { action, ...(action === "repair" ? { value } : {}) }, undefined, {}, false, predecessor);
  }
  async retryPending(id: string): Promise<unknown> {
    const row = [...this.pending.values()].find((item) => item.id === id && item.pending);
    if (!row) throw new ApiError(404, "not_found", "pending request not found", id);
    const receipt = await this.lookupReceipt(row.id);
    if (receipt) return this.applyResponse(row, receipt);
    return this.send(row);
  }

  async pushState(): Promise<{ applicationServerKey: string; subscribed: boolean }> {
    return this.get("/remote/push");
  }
  async subscribePush(body: { endpoint: string; p256dh: string; auth: string; expires_at?: number | null }): Promise<void> {
    await this.post("/remote/push/subscribe", body);
  }
  async unsubscribePush(): Promise<void> {
    await this.post("/remote/push/unsubscribe", {});
  }

  async registerUv(): Promise<void> {
    const challenge = await this.post<{ challenge: string }>("/remote/uv/register-challenge", {});
    const response = await createRegistration(challenge.challenge, this.enrollment.relayOrigin, {
      id: this.enrollment.deviceId,
      name: this.enrollment.name,
    }, this.hooks.webauthn);
    await this.post("/remote/uv/register", { challenge: challenge.challenge, response });
    this.uvReady = true;
  }
  async remoteStatus(): Promise<RemoteMaintenanceStatus> {
    return this.get("/remote/status");
  }
  async privilegedAction(operation: {
    action: "device.revoke" | "quiesce.begin" | "quiesce.cancel" | "quiesce.force" | "runtime.restart" | "runtime.stop" | "diagnostics.download";
    targetId: string; requestId?: string; force?: boolean;
  }): Promise<unknown> {
    const requestId = operation.requestId ?? ulid();
    const body = { action: operation.action, targetId: operation.targetId, requestId };
    const force = operation.action === "runtime.restart" ? { force: operation.force === true } : {};
    const challenge = await this.post<{ challenge: string }>("/remote/uv/challenge", { operation: body, ...force });
    const assertion = await createAssertion(challenge.challenge, this.enrollment.relayOrigin, this.hooks.webauthn);
    const path = operation.action === "runtime.restart" ? "/remote/runtime/restart"
      : operation.action === "runtime.stop" ? "/remote/runtime/stop" : "/remote/action";
    return this.request("POST", path, { operation: body, challenge: challenge.challenge, assertion, ...force }, undefined, {}, false, null, requestId);
  }

  private withRevision(kind: string, id: string, body: object): object {
    if (body && typeof body === "object" && "if_revision" in body && (body as { if_revision?: unknown }).if_revision !== undefined) return body;
    const revision = this.revisions.get(`${kind}/${id}`);
    return revision ? { ...body, if_revision: revision } : body;
  }
  private revisionBody(kind: string, id: string): { if_revision?: string } {
    const revision = this.revisions.get(`${kind}/${id}`);
    return revision ? { if_revision: revision } : {};
  }

  private async fileBlob(
    path: string,
    query?: Record<string, string>,
    onProgress?: FileProgressHandler,
  ): Promise<Blob> {
    onProgress?.({ loaded: 0, total: null });
    const response = await this.dispatch({
      v: 1, id: ulid(), method: "GET", path, query, body: undefined,
    }, undefined, onProgress);
    if (response.status >= 400) {
      const error = response.body as ErrorBody;
      throw new ApiError(response.status, error?.error?.code ?? "failed", error?.error?.message ?? "failed to fetch file");
    }
    const blob = response.body instanceof Blob ? response.body : new Blob([new Uint8Array()]);
    rememberBlobEtag(blob, response.headers?.etag);
    if (onProgress) onProgress({ loaded: blob.size, total: blob.size });
    return blob;
  }

  private async request<T>(
    method: RemoteRequest["method"],
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    conditional: Record<string, string> = {},
    returnEtag = false,
    supersedes?: string | null,
    id?: string,
    uploads?: Array<{ filename: string; size: number; sha256: string; bytes: Uint8Array }>,
  ): Promise<T> {
    void signal;
    const splitPath = split(path);
    if (method === "GET" || path === "/v1/models/probe") {
      return this.send({
        id: id ?? ulid(), method, path: splitPath.path, query: splitPath.query,
        body: method === "GET" ? undefined : jsonBody(body), fingerprint: "", pending: false, returnEtag,
      }) as Promise<T>;
    }
    const payload = jsonBody(body) ?? {};
    const fingerprint = JSON.stringify([payload, conditional]);
    const slot = `${method} ${splitPath.path}`;
    let row = this.pending.get(slot);
    if (row && row.fingerprint !== fingerprint) {
      // A new payload cannot silently take the place of a request whose result is unknown — so
      // ask the Mac what became of that one first. Its receipt is written in the same
      // transaction as the effect, so an answer settles the slot either way, and a phone that
      // lost the link mid-save is not stuck refusing every later edit. Only a Mac that cannot
      // be asked, or a key write still queued, keeps the slot blocked.
      if (row.pending && row.unknown) await this.settleOrphan(row);
      row = this.pending.get(slot);
      if (row) throw new ApiError(409, "request_pending", "resolve the pending request before changing its payload", row.id);
    }
    if (!row) {
      row = {
        id: id ?? ulid(), method, path: splitPath.path, query: splitPath.query, body: payload,
        ifMatch: conditional["If-Match"], fingerprint, pending: false, returnEtag, supersedes,
      };
      this.pending.set(slot, row);
    }
    return this.send(row, uploads) as Promise<T>;
  }

  private async send(row: PendingRemote, uploads?: Array<{ filename: string; size: number; sha256: string; bytes: Uint8Array }>): Promise<unknown> {
    try {
      const response = await this.dispatch({
        v: 1, id: row.id, method: row.method, path: row.path, query: row.query,
        body: row.method === "GET" ? undefined : row.body, ifMatch: row.ifMatch,
      }, uploads);
      return this.applyResponse(row, response);
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status === 503 && error.code === "request_unknown")) {
        row.pending = Boolean(row.id) && !row.terminal;
        row.unknown = row.pending;
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "request_unknown", "result unknown; explicitly retry the original request", row.id);
    }
  }

  private async lookupReceipt(id: string): Promise<RemoteResponse | null> {
    const receipt = await this.readReceipt(id);
    return receipt.state === "answered" ? receipt.response : null;
  }

  /**
   * What the Mac says became of a request id. `missing` is a real answer: the receipt shares the
   * effect's transaction, so no receipt means nothing was committed. `unreachable` is not an
   * answer and must never be read as one.
   */
  private async readReceipt(id: string): Promise<
    { state: "answered"; response: RemoteResponse } | { state: "missing" } | { state: "unreachable" }
  > {
    let response: RemoteResponse;
    try {
      response = await this.dispatch({ v: 1, id: ulid(), method: "GET", path: `/v1/requests/${id}` });
    } catch {
      return { state: "unreachable" };
    }
    const code = (response.body as ErrorBody | undefined)?.error?.code;
    // An expired receipt says the same thing a missing one does: start over with a new id.
    if (response.status === 404 || code === "receipt_expired") return { state: "missing" };
    return { state: "answered", response: { ...response, id } };
  }

  /**
   * Clears the slot of a request that is over, so a fresh payload can take it.
   *
   * No receipt means the Mac committed nothing, whatever the method: the slot is free. If it did
   * run, only an edit of the same entity may go on top — a second PATCH cannot duplicate
   * anything, while a create could, so that one stays for the person to retire explicitly.
   */
  private async settleOrphan(row: PendingRemote): Promise<void> {
    const receipt = await this.readReceipt(row.id);
    if (receipt.state === "unreachable") return;
    if (receipt.state === "missing") {
      this.forgetResolvedRequest(row.id);
      return;
    }
    if (row.method !== "PATCH") {
      row.unknown = false;
      return;
    }
    // A queued key write is the one answer that still needs the person: it leaves the row pending.
    try {
      this.applyResponse(row, receipt.response);
    } catch {
      // Whatever the Mac answered, the request is no longer outstanding unless it said so.
    }
  }

  private applyResponse(row: PendingRemote, response: RemoteResponse): unknown {
    // The Mac answered, so its result is no longer unknown, whatever it says.
    row.unknown = false;
    const json = response.body as ErrorBody | undefined;
    if (row.supersedes && (response.status < 400 || json?.error?.code === "key_write_pending")) {
      this.retireSuperseded(row.supersedes);
      row.supersedes = null;
    }
    if (response.status >= 400) {
      const error = json as ErrorBody;
      row.pending = !row.terminal && error.error?.code === "key_write_pending";
      if (!row.pending) this.forgetResolvedRequest(row.id);
      throw new ApiError(response.status, error.error?.code ?? "failed", error.error?.message ?? "request failed", row.id);
    }
    this.forgetResolvedRequest(row.id);
    return row.returnEtag ? response.headers?.etag ?? null : (response.status === 204 ? undefined : response.body);
  }

  private async dispatch(
    request: RemoteRequest,
    uploads?: Array<{ filename: string; size: number; sha256: string; bytes: Uint8Array }>,
    onProgress?: FileProgressHandler,
  ): Promise<RemoteResponse> {
    const full: RemoteRequest = {
      v: 1, id: request.id, method: request.method, path: request.path,
      ...(request.query ? { query: request.query } : {}),
      ...(request.body ? { body: request.body } : {}),
      ...(request.ifMatch ? { ifMatch: request.ifMatch } : {}),
    };
    if (this.hooks.rpc) return this.hooks.rpc(full);
    const transport = this.transport;
    if (!transport) throw new ApiError(503, "request_unknown", "result unknown; explicitly retry the original request", request.id);
    return transport.rpc(full, uploads, onProgress);
  }
}
