/** Small stand-ins for the runtime and its rows, so a component test says only what it is about. */
import { CommandActivity } from "./chat/command-activity.ts";
import type {
  Approval,
  Attachment,
  Bot,
  McpServer,
  Memory,
  Message,
  Provider,
  SessionSummary,
  Skill,
  Routine,
  Turn,
} from "@real-bot/protocol";
import { USER_MEMBER } from "@real-bot/protocol";
import { emptySnapshot, type Snapshot } from "./snapshot.ts";
import type { MessengerRuntime } from "./runtime.svelte.ts";
import { SessionView } from "./session-view.svelte.ts";

export function aBot(over: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Researcher",
    duties: "收集资料",
    boundaries: "不乱改文件",
    avatar: "data:image/svg+xml;base64,PHN2Zy8+",
    model: null,
    provider_id: null,
    thinking_level: null,
    archived_at: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    ...over,
  } as Bot;
}

export function aGroup(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess-1",
    kind: "group",
    name: "视频组",
    archived_at: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    last_read_at: null,
    origin_session_id: null,
    origin_message_id: null,
    participants: [
      { member: USER_MEMBER, joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
      { member: "bot-1", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
      { member: "bot-2", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
    ],
    ...over,
  } as SessionSummary;
}

export function aDirect(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "direct-1",
    kind: "direct",
    name: null,
    archived_at: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    last_read_at: null,
    origin_session_id: null,
    origin_message_id: null,
    participants: [
      { member: USER_MEMBER, joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
      { member: "bot-1", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
    ],
    ...over,
  } as SessionSummary;
}

/** A Bot↔Bot direct: two bots, no user, and the message it was opened from. */
export function aBotDirect(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "botbot-1",
    kind: "direct",
    name: null,
    archived_at: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    last_read_at: null,
    origin_session_id: "sess-1",
    origin_message_id: "msg-1",
    participants: [
      { member: "bot-1", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
      { member: "bot-2", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
    ],
    ...over,
  } as SessionSummary;
}

/** A memory the Bot wrote, with the receipt pointing at the message that triggered it. */
export function aMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    bot_id: "bot-1",
    subject: "用户的回复偏好",
    body: "倾向简短直接，不要铺垫。",
    source_session_id: "sess-1",
    source_message_id: "msg-1",
    learning: null,
    enabled: true,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    ...over,
  } as Memory;
}

export function aRoutine(over: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1", bot_id: "bot-1", title: "Morning brief", instruction: "Summarize today's work",
    schedule: { kind: "daily", time: "09:00" }, enabled: true, last_fired_for_due_at: null,
    created_at: "2026-09-19T00:00:00.000Z", updated_at: "2026-09-19T00:00:00.000Z", ...over,
  };
}

export function aSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    bot_id: "bot-1",
    name: "查证",
    description: "需要核实时",
    body: "先找一手来源",
    uses: [],
    enabled: true,
    learning: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    ...over,
  } as Skill;
}

export function aMessage(over: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    session_id: "sess-1",
    turn_id: null,
    parent_id: null,
    kind: "user",
    author: USER_MEMBER,
    body: "帮我把这一集的选题定下来。",
    source_turn_id: null,
    created_at: "2026-09-19T02:00:00.000Z",
    attachments: [],
    reactions: [],
    ...over,
  } as Message;
}

export function anAttachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    message_id: "msg-1",
    workspace_relpath: "outline/ep-12.md",
    original_filename: "ep-12.md",
    created_at: "2026-09-19T02:00:00.000Z",
    exists: true,
    is_dir: false,
    size: 2048,
    mime: "text/markdown",
    ...over,
  } as Attachment;
}

export function aTurn(over: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    session_id: "sess-1",
    bot_id: "bot-1",
    status: "running",
    trigger_message_id: "msg-1",
    last_activity_at: "2026-09-19T02:00:01.000Z",
    created_at: "2026-09-19T02:00:00.000Z",
    updated_at: "2026-09-19T02:00:01.000Z",
    ...over,
  } as Turn;
}

export function anApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: "appr-1",
    turn_id: "turn-1",
    message_id: "msg-3",
    status: "pending",
    kind_key: "fs.write",
    summary: "写 outline/ep-12.md",
    target: "outline/ep-12.md",
    created_at: "2026-09-19T02:00:02.000Z",
    resolved_at: null,
    requires_api_key: false,
    ...over,
  } as Approval;
}

export function aProvider(over: Partial<Provider> = {}): Provider {
  return {
    id: "prov-1",
    name: "Default",
    base_url: "https://api.example.com/v1",
    key_set: true,
    models: ["grok-4.6", "gemini-3.8-flash"],
    model_catalog: [
      { name: "grok-4.6", price: 3, thinking_levels: ["none", "low", "high"], strengths: ["推理"] },
      { name: "gemini-3.8-flash", price: 0.3, thinking_levels: ["none"], strengths: ["闲聊"] },
    ],
    available_models: ["grok-4.6", "gemini-3.8-flash", "claude-opus-5"],
    default_model: "grok-4.6",
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    ...over,
  } as unknown as Provider;
}

export function anMcpServer(over: Partial<McpServer> = {}): McpServer {
  return {
    id: "mcp-1",
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    url: null,
    headers: [],
    auth_set: false,
    enabled: true,
    instructions: "读写工作区文件。",
    usage_note: "只在需要落盘时用。",
    tool_catalog: [
      { name: "read_file", description: "读一个文件" },
      { name: "write_file", description: "写一个文件" },
    ],
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    ...over,
  } as unknown as McpServer;
}

export type FakeRuntime = MessengerRuntime & {
  calls: { name: string; args: unknown[] }[];
};

/**
 * Enough of `MessengerRuntime` for a pane to render and report what it asked for. Every stub
 * resolves to `null`, which is how the real methods say "that worked".
 */
export function fakeRuntime(over: Partial<Snapshot> = {}, stubs: Record<string, unknown> = {}): FakeRuntime {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    (name: string, result: unknown = null) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      const override = stubs[name];
      return typeof override === "function"
        ? (override as (...a: unknown[]) => unknown)(...args)
        : Promise.resolve(result);
    };
  const runtime = {} as FakeRuntime;
  const base = {
    calls,
    snapshot: { ...emptySnapshot(), ...over },
    connection: "connected",
    selectedId: null,
    previewRelpath: null,
    previewMessageId: null,
    forceArtifactTree: false,
    previewAttachmentId: null,
    hosted: false,
    enrolled: false,
    pairing: { phase: "scan" },
    pairingBusy: false,
    hostPairing: null,
    hostPairingBusy: false,
    loadOlderMessages: record("loadOlderMessages"),
    hostDevices: [],
    hostDevicesBusy: false,
    hostDevicesError: null,
    hostRemoveDeviceId: null,
    refreshHostDevices: record("refreshHostDevices"),
    removeHostDevice: record("removeHostDevice", true),
    startHostPairing: record("startHostPairing"),
    confirmHostPairing: record("confirmHostPairing"),
    closeHostPairing: record("closeHostPairing"),
    hostUnreachable: "runtime",
    draftReconnect: null,
    remoteStatus: null,
    uvReady: false,
    uvError: null,
    pushEnabled: false,
    pushBusy: false,
    pushError: null,
    pushPermission: "default",
    remote: false,
    notificationSummary: { unread_count: 0, open_count: 0, attention_count: 0 },
    notificationPolicy: null,
    notificationDevice: null,
    notificationCapabilities: { inbox_v1: false, bounded_read_v1: false, pending_ask_v1: false, policy_v1: false, push_settings_v2: false },
    nativeCapabilities: { native_reading_v1: false, native_delivery_v1: false },
    nativeFocusFacts: { visible: false, focused: false, minimized: false, effectiveFocused: false },
    notificationInboxState: { filter: "actionable", generation: 0, instanceId: null, watermark: 0, upperOrdinal: 0, items: [], next: null, summary: { unread_count: 0, open_count: 0, attention_count: 0 }, loading: false, loadingMore: false, error: null, retentionNotice: false },
    pushTransport: "legacy",
    pushSubscribed: false,
    pushRecovery: "none",
    remoteGated: false,
    isDesktopShell: false,
    isSessionMuted: () => false,
    setSessionMuted: record("setSessionMuted"),
    pollDesktopNativeState: record("pollDesktopNativeState"),
    handleDesktopNotificationIntent: record("handleDesktopNotificationIntent"),
    reportDesktopNotificationView: record("reportDesktopNotificationView"),
    requestDesktopNotificationPermission: record("requestDesktopNotificationPermission"),
    sendPresenceHeartbeat: record("sendPresenceHeartbeat"),
    loadMoreNotifications: record("loadMoreNotifications"),
    markNotificationsRead: record("markNotificationsRead"),
    loadNotificationPolicy: record("loadNotificationPolicy"),
    patchNotificationPolicy: record("patchNotificationPolicy"),
    loadNotificationDevice: record("loadNotificationDevice"),
    patchNotificationDevice: record("patchNotificationDevice"),
    loadNotificationInbox: record("loadNotificationInbox"),
    markNotificationRead: record("markNotificationRead"),
    markAllNotificationsRead: record("markAllNotificationsRead"),
    acknowledgeNotification: record("acknowledgeNotification"),
    sendTestNotification: record("sendTestNotification"),
    enableDeviceNotifications: record("enableDeviceNotifications", true),
    disableDeviceNotifications: record("disableDeviceNotifications", true),
    submitBoundedRead: record("submitBoundedRead"),
    getAskDraft: () => undefined,
    setAskDraft: record("setAskDraft"),
    clearAskDraft: record("clearAskDraft"),
    setAskError: record("setAskError"),
    registerUv: record("registerUv"),
    setPushEnabled: record("setPushEnabled", true),
    prefetchPushState: record("prefetchPushState", null),
    loadPushState: record("loadPushState"),
    setNotificationIntentHandler: record("setNotificationIntentHandler"),
    applyNotificationIntent: record("applyNotificationIntent"),
    confirmDraftReconnect: record("confirmDraftReconnect"),
    discardDraftReconnect: record("discardDraftReconnect"),
    maintenance: null,
    maintenanceBusy: false,
    maintenanceError: null,
    maintenanceForceConfirm: false,
    maintenanceStopConfirm: false,
    maintenanceRevokeId: null,
    refreshMaintenance: record("refreshMaintenance"),
    downloadDiagnostics: record("downloadDiagnostics"),
    restartRuntime: record("restartRuntime"),
    stopRuntime: record("stopRuntime"),
    revokeRemoteDevice: record("revokeRemoteDevice"),
    otherRemoteDevices: () => [],
    profileBotId: null,
    searchHits: [],
    searchQuery: "",
    createBot: record("createBot"),
    createGroup: record("createGroup"),
    patchBot: record("patchBot"),
    patchSession: record("patchSession"),
    addMember: record("addMember"),
    removeMember: record("removeMember"),
    archiveBot: record("archiveBot"),
    restoreBot: record("restoreBot"),
    profileRoutineId: null,
    openRoutine: record("openRoutine"),
    createRoutine: record("createRoutine"),
    patchRoutine: record("patchRoutine"),
    deleteRoutine: record("deleteRoutine"),
    createSkill: record("createSkill"),
    patchSkill: record("patchSkill"),
    deleteSkill: record("deleteSkill"),
    patchMemory: record("patchMemory"),
    deleteMemory: record("deleteMemory"),
    patchSettings: record("patchSettings"),
    createProvider: record("createProvider"),
    patchProvider: record("patchProvider"),
    deleteProvider: record("deleteProvider"),
    probeModels: record("probeModels", { models: [], catalog: [] }),
    createMcpServer: record("createMcpServer"),
    patchMcpServer: record("patchMcpServer"),
    deleteMcpServer: record("deleteMcpServer"),
    deleteBot: record("deleteBot"),
    deleteSession: record("deleteSession"),
    archiveSession: record("archiveSession"),
    restoreSession: record("restoreSession"),
    clearSessionHistory: record("clearSessionHistory"),
    selectSession: record("selectSession"),
    send: record("send"),
    sendAsk: record("sendAsk"),
    stopTurn: record("stopTurn"),
    continueInterrupt: record("continueInterrupt"),
    resolveApproval: record("resolveApproval"),
    toggleReaction: record("toggleReaction"),
    runSearch: record("runSearch"),
    closeSearch: record("closeSearch"),
    setHighlightedMessage: record("setHighlightedMessage"),
    openProfile: record("openProfile"),
    openSettings: record("openSettings"),
    openSessionSettings: record("openSessionSettings"),
    closeSessionSettings: record("closeSessionSettings"),
    closeProfile: record("closeProfile"),
    openCreateBot: record("openCreateBot"),
    openCreateGroup: record("openCreateGroup"),
    startTerminal: async (...args: unknown[]) => {
      calls.push({ name: "startTerminal", args });
      return null;
    },
    watchTrace: (...args: unknown[]) => {
      calls.push({ name: "watchTrace", args });
      return () => {};
    },
    openTrace: record("openTrace"),
    closeTrace: record("closeTrace"),
    openTerminal: record("openTerminal"),
    closeTerminal: record("closeTerminal"),
    refreshTerminals: record("refreshTerminals"),
    terminalsLoaded: true,
    openRoutines: () => {
      calls.push({ name: "openRoutines", args: [] });
      runtime.routinesOpen = true;
    },
    closeRoutines: () => {
      calls.push({ name: "closeRoutines", args: [] });
      runtime.routinesOpen = false;
    },
    settingsOpen: false,
    sessionSettingsOpen: false,
    createBotOpen: false,
    createGroupOpen: false,
    // The real runtime always has one; a stub without it would hide a broken wiring rather than
    // fail on it, and the transcript reads `runtime.activity` while a turn is live.
    activity: new CommandActivity(),
    activityRevision: 0,
    traceOpen: false,
    traceTaskId: null,
    traceSessionId: null,
    routinesOpen: false,
    terminalOpen: false,
    terminals: [],
    traceReload: 0,
    workspaceOpen: false,
    workspaceSelected: "",
    threadOpen: false,
    workspacePath: "/Users/you/real-bot-workspace",
    endpointUrl: "",
    endpointKey: "",
    endpointModelsText: "",
    endpointDefaultModel: "",
    client: null,
  };
  // Each conversation's own state, the way the real runtime keeps it: a pane reads its view, and
  // the old field names forward to whichever conversation is selected.
  const views = new Map<string, SessionView>();
  const sessionView = (id: string): SessionView => {
    let view = views.get(id);
    if (!view) {
      view = new SessionView(id);
      views.set(id, view);
    }
    return view;
  };
  const selectedView = (self: { selectedId: string | null }) => (self.selectedId ? sessionView(self.selectedId) : null);
  const forward = <K extends keyof SessionView>(name: string, field: K, empty: SessionView[K]) => {
    Object.defineProperty(runtime, name, {
      configurable: true,
      enumerable: true,
      get(this: { selectedId: string | null }) {
        return selectedView(this)?.[field] ?? empty;
      },
      set(this: { selectedId: string | null }, value: SessionView[K]) {
        const view = selectedView(this);
        if (view) view[field] = value;
      },
    });
  };
  forward("draft", "draft", "");
  forward("replyingToId", "replyingToId", null);
  forward("focusedTurnId", "focusedTurnId", null);
  forward("highlightedMessageId", "highlightedMessageId", null);
  forward("searchHighlightToken", "searchHighlightToken", 0);
  forward("composerSuggestions", "composerSuggestions", []);
  forward("historyLoading", "historyLoading", false);
  forward("olderLoading", "olderLoading", false);
  forward("busy", "sending", false);
  Object.defineProperty(runtime, "hasOlderMessages", {
    configurable: true,
    enumerable: true,
    get(this: { selectedId: string | null }) {
      return selectedView(this)?.hasOlderMessages ?? false;
    },
    set(this: { selectedId: string | null }, value: boolean) {
      const view = selectedView(this);
      if (view) view.messageNext = value ? (view.messageNext ?? "fixture-cursor") : null;
    },
  });
  Object.assign(runtime, base, { sessionView, calls });
  // The selection first, so a stub's draft or busy lands on the conversation it is for.
  if ("selectedId" in stubs) runtime.selectedId = stubs.selectedId as string | null;
  return Object.assign(runtime, stubs, { calls });
}
