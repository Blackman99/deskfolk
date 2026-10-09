import type {
  ApiFormat,
  BotRunner,
  ClaudeEffort,
  CreateBotRequest,
  CreateGroupRequest,
  CreateProviderRequest,
  CreateRoutineRequest,
  CreateSkillRequest,
  ModelSpeed,
  PatchMemoryRequest,
  PatchProviderRequest,
  PatchRoutineRequest,
  PatchSkillRequest,
  ProbeModelsResponse,
  PatchSpeechRequest,
  SettingsPatch,
  ThinkingLevel,
} from "@real-bot/protocol";
import { ApiError } from "./api.ts";
import type { MessengerApi } from "./messenger-api.ts";
import { RemoteApi, type DurablePendingRequest } from "./remote/api.ts";
import type { SessionView } from "./session-view.svelte.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client a write
 * rides on, the request a dropped link left unconfirmed (and the durable copy a phone keeps of
 * it), the settings form's key field, the conversation and profile a delete closes, the sheets a
 * create closes and the conversation it opens, and marking the link down when a write's failure
 * says it went.
 */
export interface AdminMutationsHost {
  readonly api: MessengerApi | null;
  pendingMutation: { id: string; code: string } | null;
  durablePending: DurablePendingRequest[];
  endpointKey: string;
  readonly views: Map<string, SessionView>;
  selectedId: string | null;
  readonly profileBotId: string | null;
  reconcilePendingMutation(api: MessengerApi): void;
  closeSheets(): void;
  selectSession(id: string, opts?: { messageId?: string; preservePage?: boolean }): Promise<void>;
  closeProfile(): void;
  closeSessionSettings(): void;
  clearHighlight(view: SessionView): void;
  markDisconnected(): void;
}

/**
 * Every write the settings, Bot, group, skill, routine, memory, provider and MCP sheets make, the
 * retry of a request a dropped link left unconfirmed, and the one mapping from a write's failure
 * to what a sheet shows (`sheetFailure`) that the chat's own writes share. `MessengerRuntime`
 * forwards every public method here under the same name, and reaches back in through
 * {@link AdminMutationsHost}.
 */
export class AdminMutations {
  constructor(private readonly host: AdminMutationsHost) {}

  async patchSettings(patch: SettingsPatch): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.patchSettings(patch);
      if (this.host.api !== api) return null;
      this.host.reconcilePendingMutation(api);
      if (patch.endpoint_api_key !== undefined) this.host.endpointKey = "";
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  /** The speech endpoint (ADR 0073); the key goes with it and is never read back. */
  async patchSpeech(patch: PatchSpeechRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.patchSpeech(patch);
      if (this.host.api !== api) return null;
      this.host.reconcilePendingMutation(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  /** `status` is the daemon's answer when it gave one: a 401 means the endpoint refused the key. */
  async probeModels(
    baseUrl?: string,
    apiKey?: string,
    providerId?: string,
    apiFormat?: ApiFormat,
    workspaceId?: string | null,
  ): Promise<{ ok: true } & ProbeModelsResponse | { ok: false; error: string; status?: number }> {
    const api = this.host.api;
    if (!api) return { ok: false, error: "Not connected" };
    try {
      const res = await api.probeModels({
        endpoint_base_url: baseUrl,
        endpoint_api_key: apiKey,
        ...(apiFormat ? { api_format: apiFormat } : {}),
        ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
        provider_id: providerId,
      });
      if (this.host.api !== api) return { ok: false, error: "Connection changed" };
      return { ok: true, models: res.models, catalog: res.catalog ?? [] };
    } catch (error) {
      if (this.host.api !== api) return { ok: false, error: "Connection changed" };
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: msg, ...(error instanceof ApiError ? { status: error.status } : {}) };
    }
  }

  /** Times a saved endpoint's model and checks it calls tools (ADR 0067); the error text when it could not run. */
  async speedTest(providerId: string, model: string): Promise<{ ok: true; speed: ModelSpeed } | { ok: false; error: string }> {
    const api = this.host.api;
    if (!api) return { ok: false, error: "Not connected" };
    try {
      const speed = await api.speedTest(providerId, model);
      if (this.host.api !== api) return { ok: false, error: "Connection changed" };
      return { ok: true, speed };
    } catch (error) {
      if (this.host.api !== api) return { ok: false, error: "Connection changed" };
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async createBot(body: CreateBotRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      const created = await api.createBot(body);
      if (this.host.api !== api) return null;
      this.host.closeSheets();
      await this.host.selectSession(created.direct_session.id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async createGroup(body: CreateGroupRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      const session = await api.createGroup(body);
      if (this.host.api !== api) return null;
      this.host.closeSheets();
      await this.host.selectSession(session.id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async createSkill(body: CreateSkillRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.createSkill(body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async patchSkill(id: string, body: PatchSkillRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.patchSkill(id, body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteSkill(id: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.deleteSkill(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async createRoutine(body: CreateRoutineRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return new ApiError(0, "disconnected", "Not connected");
    try {
      await api.createRoutine(body);
      this.host.reconcilePendingMutation(api);
      return this.host.api === api ? null : new ApiError(0, "disconnected", "Connection changed");
    } catch (error) {
      return this.routineFailure(error, api);
    }
  }

  async patchRoutine(id: string, body: PatchRoutineRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return new ApiError(0, "disconnected", "Not connected");
    try {
      await api.patchRoutine(id, body);
      this.host.reconcilePendingMutation(api);
      return this.host.api === api ? null : new ApiError(0, "disconnected", "Connection changed");
    } catch (error) {
      return this.routineFailure(error, api);
    }
  }

  async deleteRoutine(id: string, ifRevision: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return new ApiError(0, "disconnected", "Not connected");
    try {
      await api.deleteRoutine(id, ifRevision);
      this.host.reconcilePendingMutation(api);
      return this.host.api === api ? null : new ApiError(0, "disconnected", "Connection changed");
    } catch (error) {
      return this.routineFailure(error, api);
    }
  }

  private routineFailure(error: unknown, api: MessengerApi): ApiError {
    if (this.host.api !== api) return new ApiError(0, "disconnected", "Connection changed");
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && !error.requestId) return error;
    return this.sheetFailure(error, api) ?? new ApiError(0, "disconnected", "Save result unknown");
  }

  /** Correcting a memory, not creating one — the Bot is the only writer. */
  async patchMemory(id: string, body: PatchMemoryRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.patchMemory(id, body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteMemory(id: string): Promise<ApiError | null> {
    const api = this.host.api;
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
      runner?: BotRunner | null;
      agent_model?: string | null;
      agent_effort?: ClaudeEffort | null;
    },
  ): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.patchBot(id, body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async archiveBot(id: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.archiveBot(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async restoreBot(id: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.restoreBot(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteBot(id: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.deleteBot(id);
      if (this.host.api !== api) return null;
      if (this.host.profileBotId === id) this.host.closeProfile();
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async patchSession(id: string, body: { name: string }): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.patchSession(id, body);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async addMember(sessionId: string, botId: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.addMember(sessionId, botId);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async removeMember(sessionId: string, botId: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.removeMember(sessionId, botId);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async archiveSession(id: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.archiveSession(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async restoreSession(id: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.restoreSession(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  /** `eraseQuotes` erases what you said in the group as well; without it that is kept (ADR 0040). */
  async deleteSession(id: string, opts: { eraseQuotes?: boolean } = {}): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.deleteSession(id, opts);
      if (this.host.api !== api) return null;
      const view = this.host.views.get(id);
      if (view) view.focusedTurnId = null;
      if (this.host.selectedId === id) {
        this.host.selectedId = null;
        this.host.closeSessionSettings();
      }
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  /** `eraseQuotes` erases what you said here as well; without it that is kept (ADR 0040). */
  async clearSessionHistory(id: string, opts: { eraseQuotes?: boolean } = {}): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.clearSessionHistory(id, opts);
      if (this.host.api !== api) return null;
      // That conversation's own view, whether or not it is the one in front.
      const view = this.host.views.get(id);
      if (view) {
        view.focusedTurnId = null;
        view.messageNext = null;
        this.host.clearHighlight(view);
      }
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async retryPendingMutation(): Promise<ApiError | null> {
    const api = this.host.api;
    const pending = this.host.pendingMutation;
    if (!api || !pending) return new ApiError(0, "disconnected", "No pending request");
    try {
      await api.retryPending(pending.id);
      if (this.host.api !== api) return new ApiError(0, "disconnected", "Connection changed");
      if (this.host.pendingMutation?.id === pending.id) this.host.pendingMutation = null;
      this.rememberDurablePending(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api) ?? new ApiError(0, "disconnected", "Retry result unconfirmed");
    }
  }

  async resolveCredentialOperation(id: string, action: "repair" | "cancel", value?: string): Promise<boolean> {
    const api = this.host.api;
    if (!api) return false;
    try {
      await api.resolveCredential(id, action, value);
      if (this.host.api !== api) return false;
      this.host.reconcilePendingMutation(api);
      return true;
    } catch (error) { this.sheetFailure(error, api); return false; }
  }

  async createProvider(body: CreateProviderRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.createProvider(body);
      this.host.reconcilePendingMutation(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async patchProvider(id: string, body: PatchProviderRequest): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.patchProvider(id, body);
      this.host.reconcilePendingMutation(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteProvider(id: string): Promise<ApiError | null> {
    const api = this.host.api;
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
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.createMcpServer(body);
      this.host.reconcilePendingMutation(api);
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
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.patchMcpServer(id, body);
      this.host.reconcilePendingMutation(api);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  async deleteMcpServer(id: string): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api) return null;
    try {
      await api.deleteMcpServer(id);
      return null;
    } catch (error) {
      return this.sheetFailure(error, api);
    }
  }

  private rememberDurablePending(api: MessengerApi): void {
    if (api instanceof RemoteApi) this.host.durablePending = api.durablePending();
  }

  reconcilePendingMutation(api: MessengerApi): void {
    if (this.host.api !== api) return;
    if (this.host.pendingMutation && !api.hasPendingRequest(this.host.pendingMutation.id)) this.host.pendingMutation = null;
    this.rememberDurablePending(api);
  }

  keepUnknownRequest(error: unknown, api: MessengerApi): boolean {
    if (!(error instanceof ApiError) || !error.requestId) return false;
    const pending = api.hasPendingRequest(error.requestId);
    const resumable = ["key_write_pending", "request_pending", "request_unknown"].includes(error.code);
    if (pending && resumable) this.host.pendingMutation = { id: error.requestId, code: error.code };
    else if (this.host.pendingMutation?.id === error.requestId) this.host.pendingMutation = null;
    this.rememberDurablePending(api);
    return pending && resumable;
  }

  sheetFailure(error: unknown, api: MessengerApi): ApiError | null {
    if (this.host.api !== api) return null;
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
    this.host.markDisconnected();
    return null;
  }
}
