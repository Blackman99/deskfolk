/** Small stand-ins for the runtime and its rows, so a component test says only what it is about. */
import type {
  Approval,
  Attachment,
  Bot,
  McpServer,
  Message,
  Provider,
  SessionSummary,
  Skill,
  Turn,
} from "@real-bot/protocol";
import { USER_MEMBER } from "@real-bot/protocol";
import { emptySnapshot, type Snapshot } from "./snapshot.ts";
import type { MessengerRuntime } from "./runtime.svelte.ts";

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

export function aSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    bot_id: "bot-1",
    name: "查证",
    description: "需要核实时",
    body: "先找一手来源",
    uses: [],
    enabled: true,
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
      return stubs[name] !== undefined
        ? (stubs[name] as (...a: unknown[]) => unknown)(...args)
        : Promise.resolve(result);
    };
  return {
    calls,
    snapshot: { ...emptySnapshot(), ...over },
    connection: "connected",
    selectedId: null,
    previewRelpath: null,
    profileBotId: null,
    draft: "",
    busy: false,
    composerSuggestions: [],
    searchHits: [],
    searchQuery: "",
    focusedTurnId: null,
    replyingToId: null,
    createBot: record("createBot"),
    createGroup: record("createGroup"),
    patchBot: record("patchBot"),
    patchSession: record("patchSession"),
    addMember: record("addMember"),
    removeMember: record("removeMember"),
    archiveBot: record("archiveBot"),
    restoreBot: record("restoreBot"),
    createSkill: record("createSkill"),
    patchSkill: record("patchSkill"),
    deleteSkill: record("deleteSkill"),
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
    openCreateBot: record("openCreateBot"),
    openCreateGroup: record("openCreateGroup"),
    toggleRouteLog: record("toggleRouteLog"),
    closeRouteLog: record("closeRouteLog"),
    settingsOpen: false,
    sessionSettingsOpen: false,
    createBotOpen: false,
    createGroupOpen: false,
    routeLogOpen: false,
    workspaceOpen: false,
    workspaceSelected: "",
    threadOpen: false,
    routesLoading: false,
    highlightedMessageId: null,
    searchHighlightToken: null,
    workspacePath: "/Users/you/real-bot-workspace",
    endpointUrl: "",
    endpointKey: "",
    endpointModelsText: "",
    endpointDefaultModel: "",
    client: null,
    ...stubs,
  } as unknown as FakeRuntime;
}
