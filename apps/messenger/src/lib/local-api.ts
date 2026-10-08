import type {
  RemoteScreenIceServer,
  RemoteScreenStatus,
  ClearSessionRequest,
  Approval,
  CredentialOperation,
  Routine,
  PatchRoutineRequest,
  RuntimeSnapshot,
  SessionSnapshot,
  SyncFrame,
  StreamFrame,
  ToolFrame,
  Bot,
  ErrorBody,
  Judgement,
  ListPage,
  McpServer,
  Memory,
  Message,
  PatchMemoryRequest,
  PatchProviderRequest,
  PatchSkillRequest,
  Provider,
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
  BotRunner,
  ClaudeEffort,
  ClaudeCodeStatus,
  TaskArtifacts,
  TaskDetail,
  TaskSpecRevision,
  TaskTrace,
  TurnCommand,
  TurnCommandsResponse,
  SessionTaskSummary,
  WorkspaceTreePage,
} from "@real-bot/protocol";
import {
  isNonReceiptPath,
  type Annotation,
  type AnnotationFilter,
  type CreateAnnotationRequest,
  type PatchAnnotationRequest,
  type SendAnnotationsRequest,
} from "@real-bot/protocol";
import { spendSearchParams } from "./spend/spend-query.ts";
import { createAnnotation, listAnnotations, patchAnnotation, sendAnnotations, type SendAnnotationsResult } from "./annotations/client.ts";
import { parseStreamFrame, parseToolFrame } from "./ephemeral-frames.ts";
import { validAttributionPayload } from "./attribution-wire.ts";
import { validDelegationPayload } from "./delegation-wire.ts";
import { validWorkQuestionPayload } from "./work-question-wire.ts";
import type { LocalEndpoint } from "./discovery.ts";
import { ApiBase } from "./api-base.ts";
import { ApiError, rememberBlobEtag, rememberBlobOriginalSize } from "./api.ts";
import { readResponseBlob, type FileLoadOptions, type FileProgressHandler } from "./file-progress.ts";
import type { DesktopClickResponse } from "./notifications/types.ts";
import type { NotificationTestResult } from "./notifications/client.ts";

type PendingRequest = {
  id: string; method: string; path: string; payload?: BodyInit; fingerprint: string; pending: boolean;
  headers?: Record<string, string>; returnEtag?: boolean; supersedes?: string | null;
  terminal?: boolean;
  credential?: { operationId: string; instance: string; seq: number };
};

/**
 * A clear's or a group delete's body. `erase_quotes` goes only when set, so the request reads the
 * same as before to a daemon older than kept words (ADR 0040).
 */
function clearBody(opts: { eraseQuotes?: boolean }): ClearSessionRequest {
  return opts.eraseQuotes ? { erase_quotes: true } : {};
}

function requestId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = BigInt(Date.now());
  let prefix = "";
  for (let i = 0; i < 10; i++) { prefix = alphabet[Number(time & 31n)] + prefix; time >>= 5n; }
  return prefix + Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => alphabet[byte & 31]).join("");
}

export class LocalApi extends ApiBase<PendingRequest> {
  readonly kind = "local" as const;
  protected readonly pending = new Map<string, PendingRequest>();

  credentialOperations(): Promise<{ items: CredentialOperation[] }> { return this.get("/v1/credential-operations"); }

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

  constructor(readonly endpoint: LocalEndpoint) {
    super();
  }

  headers(): HeadersInit {
    return { Authorization: `Bearer ${this.endpoint.token}` };
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    return this.get<RuntimeSnapshot>("/v1/snapshot");
  }

  async sessionSnapshot(id: string): Promise<SessionSnapshot> {
    return this.get<SessionSnapshot>(`/v1/sessions/${id}/snapshot`);
  }

  async patchRoutine(id: string, body: PatchRoutineRequest): Promise<Routine> {
    return this.patch<Routine>(`/v1/routines/${encodeURIComponent(id)}`, body);
  }

  async patchSettings(patch: SettingsPatch): Promise<Settings> {
    return this.patch<Settings>("/v1/settings", patch);
  }

  async providers(): Promise<Provider[]> {
    const page = await this.get<ListPage<Provider>>("/v1/providers");
    return page.items;
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
      runner?: BotRunner | null;
      agent_model?: string | null;
      agent_effort?: ClaudeEffort | null;
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

  async patchSession(id: string, body: { name: string }): Promise<SessionDetail> {
    return this.patch<SessionDetail>(`/v1/sessions/${id}`, body);
  }

  async removeMember(sessionId: string, botId: string): Promise<SessionDetail> {
    return this.request<SessionDetail>("DELETE", `/v1/sessions/${sessionId}/members`, {
      bot_id: botId,
    });
  }

  async archiveSession(id: string): Promise<SessionDetail> {
    return this.post<SessionDetail>(`/v1/sessions/${id}/archive`);
  }

  async restoreSession(id: string): Promise<SessionDetail> {
    return this.post<SessionDetail>(`/v1/sessions/${id}/restore`);
  }

  /** `eraseQuotes` erases what you said in the group as well (`ClearSessionRequest`). */
  async deleteSession(id: string, opts: { eraseQuotes?: boolean } = {}): Promise<void> {
    await this.request<void>("DELETE", `/v1/sessions/${id}`, clearBody(opts));
  }

  /** `eraseQuotes` erases what you said here as well (`ClearSessionRequest`). */
  async clearSessionHistory(id: string, opts: { eraseQuotes?: boolean } = {}): Promise<void> {
    await this.post<void>(`/v1/sessions/${id}/clear`, clearBody(opts));
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
      /** Files already in the workspace, attached by path. */
      paths?: string[];
      parentId?: string | null;
      requestId?: string;
      /** Not heard here: fetch reports no upload progress, and loopback takes a file at once. */
      onUploadProgress?: FileProgressHandler;
    } = {},
  ): Promise<Message> {
    const parentId = opts.parentId ?? null;
    const path = `/v1/sessions/${sessionId}/messages`;
    const paths = opts.paths?.length ? opts.paths : null;
    if (opts.attachments && opts.attachments.length > 0) {
      const form = new FormData();
      form.append("body", body);
      if (opts.fork) form.append("fork", "true");
      if (opts.askId) form.append("ask_id", opts.askId);
      if (parentId) form.append("parent_id", parentId);
      // One field: the daemon refuses a multipart field that repeats.
      if (paths) form.append("paths", JSON.stringify(paths));
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
      ...(paths ? { paths } : {}),
    }, undefined, {}, false, null, opts.requestId);
  }

  /** What this job cited, pulled once when its entry is opened. There is no push event for it. */
  async taskArtifacts(taskId: string, signal?: AbortSignal): Promise<TaskArtifacts> {
    return this.get<TaskArtifacts>(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts`, signal);
  }

  /** The turns that share a work dir, read back as one picture. Pulled when the trace opens. */
  /** What a finished turn ran, for the command card under its reply. */
  async turnCommands(turnId: string, signal?: AbortSignal): Promise<TurnCommand[]> {
    return (await this.get<TurnCommandsResponse>(`/v1/turns/${encodeURIComponent(turnId)}/commands`, signal)).items;
  }

  async taskTrace(taskId: string, signal?: AbortSignal): Promise<TaskTrace> {
    return this.get<TaskTrace>(`/v1/tasks/${encodeURIComponent(taskId)}/trace`, signal);
  }

  /** Your own Claude Code as the daemon finds it (ADR 0061); on this Mac only, never over the relay. */
  async claudeCode(): Promise<ClaudeCodeStatus> {
    return this.get<ClaudeCodeStatus>("/v1/runtime/claude-code");
  }

  async detectClaudeCode(): Promise<ClaudeCodeStatus> {
    return this.post<ClaudeCodeStatus>("/v1/runtime/claude-code/detect");
  }

  /** Points the daemon at a `claude` executable; null lets it look for one again. */
  async setClaudeCodePath(path: string | null): Promise<ClaudeCodeStatus> {
    return this.put<ClaudeCodeStatus>("/v1/runtime/claude-code/path", { path });
  }

  /** One plan whole: the switcher row plus its spec, revision and tickets with their artifacts. */
  async taskDetail(taskId: string, signal?: AbortSignal): Promise<TaskDetail> {
    return this.get<TaskDetail>(`/v1/tasks/${encodeURIComponent(taskId)}`, signal);
  }

  /** Every version the plan's spec has had, newest first. */
  async taskSpecRevisions(taskId: string, signal?: AbortSignal): Promise<TaskSpecRevision[]> {
    const page = await this.get<ListPage<TaskSpecRevision>>(`/v1/tasks/${encodeURIComponent(taskId)}/spec-revisions`, signal);
    return page.items;
  }

  /** Tombstones a check; its past runs stay so their history still reads. */
  async deleteCheck(checkId: string, revision?: string): Promise<TaskDetail> {
    return this.request<TaskDetail>(
      "DELETE",
      `/v1/checks/${encodeURIComponent(checkId)}`,
      revision === undefined ? undefined : { if_revision: revision },
    );
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

  /** The remote screen's switch, ICE servers and who is connected: the Mac's own, over loopback only. */
  remoteScreen(): Promise<RemoteScreenStatus> {
    return this.get<RemoteScreenStatus>("/v1/remote/screen");
  }

  setRemoteScreen(body: { enabled?: boolean; iceServers?: RemoteScreenIceServer[] }): Promise<RemoteScreenStatus> {
    return this.put<RemoteScreenStatus>("/v1/remote/screen", body);
  }

  disconnectRemoteScreen(): Promise<RemoteScreenStatus> {
    return this.post<RemoteScreenStatus>("/v1/remote/screen/disconnect");
  }

  async hostTree(_path = ""): Promise<WorkspaceTreePage & { parent?: string | null }> {
    throw new ApiError(404, "not_found", "host browse is remote-only");
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

  async mcpServers(): Promise<McpServer[]> {
    const page = await this.get<ListPage<McpServer>>("/v1/mcp-servers");
    return page.items;
  }

  async skills(): Promise<Skill[]> {
    const page = await this.get<ListPage<Skill>>("/v1/skills");
    return page.items;
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

  // Annotations ----------------------------------------------------------------------------
  listAnnotations(filter: AnnotationFilter & { target_session_id?: string } = {}, signal?: AbortSignal): Promise<Annotation[]> {
    return listAnnotations(this, filter, signal);
  }
  createAnnotation(body: CreateAnnotationRequest): Promise<Annotation> {
    return createAnnotation(this, body);
  }
  patchAnnotation(id: string, patch: PatchAnnotationRequest): Promise<Annotation> {
    return patchAnnotation(this, id, patch);
  }
  async deleteAnnotation(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/annotations/${encodeURIComponent(id)}`);
  }
  sendAnnotations(body: SendAnnotationsRequest): Promise<SendAnnotationsResult> {
    return sendAnnotations(this, body);
  }
  async getAnnotationCropBlob(id: string): Promise<Blob> {
    const res = await fetch(`${this.endpoint.origin}/v1/annotations/${encodeURIComponent(id)}/crop`, {
      headers: { Authorization: `Bearer ${this.endpoint.token}` },
    });
    if (!res.ok) throw new ApiError(res.status, "failed", "failed to fetch crop");
    return res.blob();
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
        if (frame.payload.event === "turn.token" || frame.payload.event === "turn.tool" || !validAttributionPayload(frame.payload) || !validDelegationPayload(frame.payload) || !validWorkQuestionPayload(frame.payload)) return null;
        return frame;
      }
      if ((frame.type === "ready" || frame.type === "resnapshot") && Number.isSafeInteger(frame.watermark_seq) && frame.watermark_seq >= 0) return frame;
      return null;
    } catch {
      return null;
    }
  }

  protected async request<T>(
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
