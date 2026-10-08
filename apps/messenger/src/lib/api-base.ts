import type {
  AcceptanceCheckInput,
  AllowRule,
  AnswerAskRequest,
  ApiFormat,
  Approval,
  ControlActionRequest,
  ControlActionResult,
  CreateBotRequest,
  CreateBotResponse,
  CreateGroupRequest,
  CreateHoldRequest,
  CreateProviderRequest,
  CreateRoutineRequest,
  CreateSkillRequest,
  CredentialOperation,
  DelegationView,
  EditMessageRequest,
  GroupLeadState,
  Hold,
  Lesson,
  LessonPatch,
  ListPage,
  Locale,
  McpServer,
  ModelSpeed,
  Message,
  MessageVersionsResponse,
  ModelLadderResponse,
  ModelLadderRung,
  NewJobFromLineRequest,
  PatchAcceptanceCheckRequest,
  PatchMessageAttributionRequest,
  PatchTaskSpecRequest,
  PatchTicketRequest,
  ProbeModelsResponse,
  PromptDetail,
  PromptRevisionRef,
  PromptSummary,
  Provider,
  PutPromptRequest,
  QualityReportRow,
  RenamePlanRequest,
  RequirementActionRequest,
  ResolveApprovalRequest,
  Routine,
  SequencedEvent,
  SessionDetail,
  SessionSummary,
  SetPlanScaleRequest,
  Settings,
  SharedSkill,
  SharedSkillsResponse,
  Skill,
  TaskDetail,
  Terminal,
  TerminalColors,
  TerminalScreenSnapshot,
  TerminalScrollback,
  TerminalSignal,
  Ticket,
  Turn,
  WorkAnswerResult,
  WorkspaceTrashResult,
  WorkspaceTreePage,
} from "@real-bot/protocol";
import type { RemoteRequest } from "@real-bot/remote";
import type { AttributionPlan } from "./chat/attribution.ts";
import type {
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
} from "./notifications/client.ts";

/** What the shared members read and write on a row of a client's pending map. */
type PendingRow = {
  id: string;
  method: string;
  path: string;
  pending: boolean;
  supersedes?: string | null;
  credential?: { operationId: string; instance: string; seq: number };
};

/**
 * What the loopback client and the relay client send the same way. Each keeps its own pending map
 * and its own `request`; everything here goes through those.
 */
export abstract class ApiBase<Row extends PendingRow> {
  protected abstract readonly pending: Map<string, Row>;

  abstract credentialOperations(): Promise<{ items: CredentialOperation[] }>;

  abstract forgetResolvedRequest(id: string): void;

  protected abstract request<T>(
    method: RemoteRequest["method"],
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    conditional?: Record<string, string>,
    returnEtag?: boolean,
    supersedes?: string | null,
    id?: string,
  ): Promise<T>;

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

  async resolveCredential(id: string, action: "repair" | "cancel", value?: string): Promise<void> {
    const predecessor = (await this.credentialOperations()).items.find((op) => op.id === id)?.request_id;
    await this.request("POST", `/v1/credential-operations/${id}/resolve`, { action, ...(action === "repair" ? { value } : {}) }, undefined, {}, false, predecessor);
  }

  protected retireSuperseded(id: string): void {
    const row = [...this.pending.values()].find((item) => item.id === id);
    if (!row) return;
    this.forgetResolvedRequest(id);
    if (row.supersedes) this.retireSuperseded(row.supersedes);
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

  async routines(): Promise<Routine[]> {
    return (await this.get<ListPage<Routine>>("/v1/routines")).items;
  }

  async createRoutine(body: CreateRoutineRequest): Promise<Routine> {
    return this.post<Routine>("/v1/routines", body);
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

  async probeModels(body: {
    endpoint_base_url?: string;
    endpoint_api_key?: string;
    api_format?: ApiFormat;
    provider_id?: string;
  }): Promise<ProbeModelsResponse> {
    return this.post<ProbeModelsResponse>("/v1/models/probe", body);
  }

  /** Times one enabled model and checks it calls tools; the speed is recorded on the endpoint (ADR 0067). */
  async speedTest(providerId: string, model: string): Promise<ModelSpeed> {
    return this.post<ModelSpeed>(`/v1/providers/${providerId}/speed-test`, { model });
  }

  async createProvider(body: CreateProviderRequest): Promise<Provider> {
    return this.post<Provider>("/v1/providers", body);
  }

  async createBot(body: CreateBotRequest): Promise<CreateBotResponse> {
    return this.post<CreateBotResponse>("/v1/bots", body);
  }

  async createGroup(body: CreateGroupRequest): Promise<SessionDetail> {
    return this.post<SessionDetail>("/v1/sessions", body);
  }

  async addMember(sessionId: string, botId: string): Promise<SessionDetail> {
    return this.post<SessionDetail>(`/v1/sessions/${sessionId}/members`, { bot_id: botId });
  }

  async session(id: string): Promise<SessionDetail> {
    return this.get<SessionDetail>(`/v1/sessions/${id}`);
  }

  async markSessionRead(id: string): Promise<SessionSummary> {
    return this.post<SessionSummary>(`/v1/sessions/${id}/read`);
  }

  /** Your 「记为模型问题」 on a board card (ADR 0050), or taking it back. */
  async markTurnModel(turnId: string, marked: boolean): Promise<{ turn_id: string; marked: boolean }> {
    return this.request<{ turn_id: string; marked: boolean }>(marked ? "POST" : "DELETE", `/v1/turns/${encodeURIComponent(turnId)}/mark-model`);
  }

  /** The quality report (ADR 0050): per Bot × model × plan kind over the last `days`. */
  async qualityReport(days = 7): Promise<QualityReportRow[]> {
    return (await this.get<ListPage<QualityReportRow>>(`/v1/quality/report?days=${days}`)).items;
  }

  /** The model ladder you ordered (ADR 0054), and whether this engine level has one (level 7). */
  async modelLadder(): Promise<ModelLadderResponse> {
    return this.get<ModelLadderResponse>("/v1/model-ladder");
  }

  async setModelLadder(items: ModelLadderRung[]): Promise<ModelLadderResponse> {
    return this.request<ModelLadderResponse>("PUT", "/v1/model-ladder", { items });
  }

  /** The project skills (ADR 0052), and whether sharing is on (engine level 8). */
  async listSharedSkills(): Promise<SharedSkillsResponse> {
    return this.get<SharedSkillsResponse>("/v1/shared-skills");
  }

  /** Your 共享 on a Bot's skill: a copy every Bot reads, or the copy brought up to date. */
  async shareSkill(skillId: string): Promise<SharedSkill> {
    return this.request<SharedSkill>("POST", `/v1/skills/${encodeURIComponent(skillId)}/share`);
  }

  async setSharedSkillEnabled(id: string, enabled: boolean): Promise<SharedSkill> {
    return this.patch<SharedSkill>(`/v1/shared-skills/${encodeURIComponent(id)}`, { enabled });
  }

  async unshareSkill(id: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/shared-skills/${encodeURIComponent(id)}`);
  }

  /** What the app learned from failures and checks itself (ADR 0050), newest first. */
  async listLessons(): Promise<Lesson[]> {
    return (await this.get<ListPage<Lesson>>("/v1/lessons")).items;
  }

  /** Your edit of a lesson: retire it, bring it back, warn or block, reword it. */
  async patchLesson(id: string, patch: LessonPatch): Promise<Lesson> {
    return this.patch<Lesson>(`/v1/lessons/${encodeURIComponent(id)}`, patch);
  }

  /** Your new name for a job; its folder keeps its name. */
  async renamePlan(taskId: string, body: RenamePlanRequest): Promise<TaskDetail> {
    return this.patch<TaskDetail>(`/v1/tasks/${encodeURIComponent(taskId)}`, body);
  }

  /** Your word on a job's size (ADR 0060): a large one is laid out with a sample first; single, it is not. */
  async setPlanScale(taskId: string, body: SetPlanScaleRequest): Promise<TaskDetail> {
    return this.patch<TaskDetail>(`/v1/tasks/${encodeURIComponent(taskId)}`, body);
  }

  /** Takes back one change a retrospective made to its Bot's memories or skills (ADR 0062); the plan it is shown on comes back. */
  async undoRetrospectiveChange(retrospectiveId: string, index: number): Promise<TaskDetail> {
    return this.post<TaskDetail>(`/v1/retrospectives/${encodeURIComponent(retrospectiveId)}/changes/${index}/undo`, {});
  }

  /** Every built-in prompt and its state (ADR 0064). */
  async listPrompts(): Promise<PromptSummary[]> {
    return (await this.get<{ items: PromptSummary[] }>("/v1/prompts")).items;
  }

  /** One built-in prompt in one of its languages, in full: the text in force, the fixed format, the default, its history. */
  async getPrompt(id: string, locale: Locale): Promise<PromptDetail> {
    return this.get<PromptDetail>(`/v1/prompts/${encodeURIComponent(id)}/${locale}`);
  }

  /** Your version of a prompt, guarded by the latest change you saw (`if_revision`, null on one nobody changed). */
  async putPrompt(id: string, locale: Locale, body: PutPromptRequest): Promise<PromptDetail> {
    return this.put<PromptDetail>(`/v1/prompts/${encodeURIComponent(id)}/${locale}`, body);
  }

  async resetPrompt(id: string, locale: Locale, ifRevision: string | null): Promise<PromptDetail> {
    return this.post<PromptDetail>(`/v1/prompts/${encodeURIComponent(id)}/${locale}/reset`, { if_revision: ifRevision });
  }

  /** Your version against a newer default that did not merge: keep yours. */
  async keepMyPrompt(id: string, locale: Locale, ifRevision: string | null): Promise<PromptDetail> {
    return this.post<PromptDetail>(`/v1/prompts/${encodeURIComponent(id)}/${locale}/keep-mine`, { if_revision: ifRevision });
  }

  /** The change an approval card let through, for the card's own Undo; null when it made none. */
  async promptRevisionForApproval(approvalId: string): Promise<PromptRevisionRef | null> {
    return (await this.get<{ items: PromptRevisionRef[] }>(`/v1/prompt-revisions?approval_id=${encodeURIComponent(approvalId)}`)).items[0] ?? null;
  }

  async undoPromptRevision(revisionId: string): Promise<PromptDetail> {
    return this.post<PromptDetail>(`/v1/prompt-revisions/${encodeURIComponent(revisionId)}/undo`, {});
  }

  async restorePromptRevision(revisionId: string): Promise<PromptDetail> {
    return this.post<PromptDetail>(`/v1/prompt-revisions/${encodeURIComponent(revisionId)}/restore`, {});
  }

  /** Your edit of a plan's spec: the whole spec, guarded by the revision you edited from. */
  async patchTaskSpec(taskId: string, body: PatchTaskSpecRequest): Promise<TaskDetail> {
    return this.patch<TaskDetail>(`/v1/tasks/${encodeURIComponent(taskId)}/spec`, body);
  }

  /** Your edit of one ticket: only the fields sent change. */
  async patchTicket(ticketId: string, body: PatchTicketRequest): Promise<Ticket> {
    return this.patch<Ticket>(`/v1/tickets/${encodeURIComponent(ticketId)}`, body);
  }

  /** Adds an acceptance check that proves one line of the plan; the plan comes back whole with it. */
  async createCheck(taskId: string, body: AcceptanceCheckInput): Promise<TaskDetail> {
    return this.post<TaskDetail>(`/v1/tasks/${encodeURIComponent(taskId)}/checks`, body);
  }

  /** Your edit of one check: redefining it drops its past runs and starts a fresh one. */
  async patchCheck(checkId: string, body: PatchAcceptanceCheckRequest): Promise<TaskDetail> {
    return this.patch<TaskDetail>(`/v1/checks/${encodeURIComponent(checkId)}`, body);
  }

  /** Puts a check from your words in force (ADR 0040 P3); a replacement takes the place of the check it replaces. */
  async confirmCheck(checkId: string): Promise<TaskDetail> {
    return this.post<TaskDetail>(`/v1/checks/${encodeURIComponent(checkId)}/confirm`, {});
  }

  /**
   * Your choice on an entry of the requirements ledger, from the plan's board (ADR 0040 P3): take it
   * up, turn it down, let it go, set it not to hold for this plan (or back), or make it hold for the
   * whole conversation. The plan it was shown on comes back whole.
   */
  async requirementAction(requirementId: string, body: RequirementActionRequest): Promise<TaskDetail> {
    return this.post<TaskDetail>(`/v1/requirements/${encodeURIComponent(requirementId)}/action`, body);
  }

  /** Runs one check, or every active check of the plan when none is named. */
  async runChecks(taskId: string, checkId?: string): Promise<TaskDetail> {
    return this.post<TaskDetail>(
      `/v1/tasks/${encodeURIComponent(taskId)}/checks/run`,
      checkId ? { check_id: checkId } : {},
    );
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

  async putWorkspaceFile(path: string, content: string, ifMatch?: string | null): Promise<string | null> {
    return this.request<string | null>("PUT", "/v1/workspace/file", { path, content }, undefined, ifMatch ? { "If-Match": ifMatch } : {}, true);
  }
  /** Into the Mac's Trash; a path already gone comes back as trashed. */
  async trashWorkspacePaths(paths: string[]): Promise<WorkspaceTrashResult> {
    return this.post<WorkspaceTrashResult>("/v1/workspace/trash", { paths });
  }

  async stop(turnId?: string): Promise<void> {
    await this.post("/v1/turns/stop", turnId ? { turn_id: turnId } : {});
  }

  /** A stop you chose from a menu; with `session_id`, its receipt goes to that conversation. */
  async createHold(body: CreateHoldRequest): Promise<Hold> {
    return this.post<Hold>("/v1/holds", body);
  }

  /** Your lift of one stop; the work it ended opens again. */
  async liftHold(holdId: string): Promise<Hold> {
    return this.post<Hold>(`/v1/holds/${encodeURIComponent(holdId)}/lift`, {});
  }

  /** A button on a line about your stops: a receipt's undo, widen, narrow, or go on. */
  async controlAction(messageId: string, body: ControlActionRequest): Promise<ControlActionResult> {
    return this.post<ControlActionResult>(`/v1/messages/${encodeURIComponent(messageId)}/control`, body);
  }

  async continueInterrupt(messageId: string): Promise<Turn> {
    return this.post<Turn>("/v1/turns/continue", { message_id: messageId });
  }

  /** Your answer to a Bot's question, written onto the question; returns it as it now reads. */
  async answerAsk(messageId: string, answer: AnswerAskRequest, opts: { requestId?: string } = {}): Promise<Message> {
    return this.request<Message>("POST", `/v1/messages/${messageId}/answer`, answer, undefined, {}, false, null, opts.requestId);
  }

  async putReaction(messageId: string, emoji: string): Promise<void> {
    await this.request<void>("PUT", `/v1/messages/${messageId}/reactions`, { emoji });
  }

  async deleteReaction(messageId: string, emoji: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/messages/${messageId}/reactions`, { emoji });
  }

  async createSkill(body: CreateSkillRequest): Promise<Skill> {
    return this.post<Skill>("/v1/skills", body);
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

  delegations(sessionId: string): Promise<{ items: DelegationView[] }> {
    return this.get<{ items: DelegationView[] }>(`/v1/sessions/${encodeURIComponent(sessionId)}/delegations`);
  }

  groupLead(sessionId: string): Promise<GroupLeadState> {
    return this.get<GroupLeadState>(`/v1/sessions/${encodeURIComponent(sessionId)}/lead`);
  }

  confirmGroupLead(sessionId: string, botId: string | null): Promise<GroupLeadState> {
    return this.put<GroupLeadState>(`/v1/sessions/${encodeURIComponent(sessionId)}/lead`, { bot_id: botId, confirmed: true });
  }

  attributionPlans(messageId: string): Promise<{ items: AttributionPlan[] }> {
    return this.get<{ items: AttributionPlan[] }>(`/v1/messages/${encodeURIComponent(messageId)}/attribution`);
  }

  editMessage(id: string, body: string): Promise<Message> {
    return this.patch<Message>(`/v1/messages/${encodeURIComponent(id)}`, { body } satisfies EditMessageRequest);
  }

  messageVersions(id: string): Promise<MessageVersionsResponse> {
    return this.get<MessageVersionsResponse>(`/v1/messages/${encodeURIComponent(id)}/versions`);
  }

  patchMessageAttribution(id: string, filings: PatchMessageAttributionRequest["filings"]): Promise<Message> {
    return this.patch<Message>(`/v1/messages/${encodeURIComponent(id)}/attribution`, { filings });
  }

  newJobFromMessage(id: string): Promise<Message> {
    return this.patch<Message>(`/v1/messages/${encodeURIComponent(id)}/attribution`, { new_plan: {} } satisfies NewJobFromLineRequest);
  }

  answerWorkQuestion(id: string, body: string): Promise<WorkAnswerResult> {
    return this.post<WorkAnswerResult>(`/v1/messages/${encodeURIComponent(id)}/work-answer`, { body });
  }
}
