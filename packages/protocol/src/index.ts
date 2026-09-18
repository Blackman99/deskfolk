/** Local API types. This package only exports types and constants. */

export const LOCAL_API_BIND = "127.0.0.1:17890" as const;
export const LOCAL_API_HOST = "127.0.0.1" as const;
export const LOCAL_API_PORT = 17890 as const;
export const LOCAL_API_NAME = "real-bot" as const;
export const LOCAL_API_PREFIX = "/v1" as const;

export const KEYCHAIN_SERVICE = "com.real-bot.daemon" as const;
export const KEYCHAIN_NAME = "endpoint-api-key" as const;
export const KEYCHAIN_REF = "keychain:com.real-bot.daemon/endpoint-api-key" as const;

export function providerKeychainName(id: string): string {
  return `${KEYCHAIN_NAME}:${id}`;
}

export function providerKeychainRef(id: string): string {
  return `keychain:${KEYCHAIN_SERVICE}/${providerKeychainName(id)}`;
}

export const MCP_AUTH_KEYCHAIN_NAME = "mcp-auth" as const;

export function mcpAuthKeychainName(id: string): string {
  return `${MCP_AUTH_KEYCHAIN_NAME}:${id}`;
}

export type McpTransport = "stdio" | "http";

export type McpHeader = {
  name: string;
  value: string;
};

export const APP_SUPPORT_DIRNAME = "real-bot" as const;
export const LOCAL_API_DESCRIPTOR_NAME = "local-api.json" as const;
export const STATE_DB_NAME = "state.sqlite" as const;

/** Dev-only path on the messenger Vite origin. Returns `{ port, token }`. */
export const LOCAL_API_DISCOVERY_PATH = "/__local-api" as const;

export const USER_MEMBER = "user" as const;

/** Bot `update_profile` used to insert these; they are no longer shown. */
export function isHiddenTranscriptKind(kind: string): boolean {
  return kind === "profile_change";
}

/** Transcript body when a live turn is marked interrupted. Chinese in every locale. */
export const INTERRUPT_NOTE_BODY = "中断" as const;

export const REACTION_EMOJI = ["👍", "👀", "❤️", "❗"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export type HealthResponse = {
  ok: true;
  name: typeof LOCAL_API_NAME;
};

export type RuntimeResponse = {
  pid: number;
  bind: typeof LOCAL_API_BIND;
};

export type LocalApiDescriptor = {
  pid: number;
  port: number;
  token: string;
  started_at: string;
};

export type LocalApiDiscovery = {
  port: number;
  token: string;
};

export type ErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "not_found"
  | "conflict"
  | "invalid_args"
  | "not_a_member"
  | "ambiguous"
  | "denied"
  | "not_text"
  | "too_large"
  | "failed";

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
  };
};

export type ListPage<T> = {
  items: T[];
  next?: string | null;
};

export const THINKING_LEVELS = ["none", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** One configured completion name plus routing attributes. Price is routing input only. */
export type EndpointModel = {
  name: string;
  price: number | null;
  thinking_levels: ThinkingLevel[];
  strengths: string[];
};

export type EndpointModelInput = string | {
  name: string;
  price?: number | null;
  thinking_levels?: ThinkingLevel[];
  strengths?: string[];
};

export type Settings = {
  workspace_path: string | null;
  endpoint_base_url: string | null;
  endpoint_key_set: boolean;
  endpoint_models: string[];
  endpoint_model_catalog: EndpointModel[];
  endpoint_default_model: string | null;
  default_provider_id: string | null;
  launch_at_login: boolean;
  locale: Locale;
  theme: Theme;
  wizard_complete: boolean;
};

export type WorkspaceTreeEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
};

export type WorkspaceTreePage = {
  path: string;
  truncated: boolean;
  items: WorkspaceTreeEntry[];
};

export type SettingsPatch = {
  workspace_path?: string;
  endpoint_base_url?: string;
  endpoint_api_key?: string;
  endpoint_models?: EndpointModelInput[];
  endpoint_default_model?: string;
  default_provider_id?: string | null;
  launch_at_login?: boolean;
  locale?: Locale;
  theme?: Theme;
};

export type Provider = {
  id: string;
  name: string;
  base_url: string | null;
  key_set: boolean;
  models: string[];
  model_catalog: EndpointModel[];
  default_model: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateProviderRequest = {
  name: string;
  base_url: string;
  api_key?: string;
  models?: EndpointModelInput[];
  default_model?: string | null;
};

export type PatchProviderRequest = {
  name?: string;
  base_url?: string;
  api_key?: string;
  models?: EndpointModelInput[];
  default_model?: string | null;
};

export type Bot = {
  id: string;
  name: string;
  duties: string;
  boundaries: string;
  avatar: string | null;
  model: string | null;
  provider_id: string | null;
  /**
   * Pinned thinking level. `null` lets the app pick per message. A pinned level applies whenever the
   * resolved model supports it; otherwise the app picks as if unpinned.
   */
  thinking_level: ThinkingLevel | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProfileRevision = {
  id: string;
  bot_id: string;
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  actor: typeof USER_MEMBER | string;
  message_id: string | null;
  created_at: string;
};

export type CreateBotRequest = {
  name: string;
  duties: string;
  boundaries: string;
  avatar?: string | null;
  model?: string | null;
  provider_id?: string | null;
  thinking_level?: ThinkingLevel | null;
};

export type PatchBotRequest = {
  name?: string;
  duties?: string;
  boundaries?: string;
  avatar?: string | null;
  model?: string | null;
  provider_id?: string | null;
  thinking_level?: ThinkingLevel | null;
};

export type CreateBotResponse = {
  bot: Bot;
  direct_session: SessionDetail;
};

export type SessionKind = "direct" | "group";

export type SessionParticipant = {
  member: typeof USER_MEMBER | string;
  joined_at: string;
  left_at: string | null;
};

export type Session = {
  id: string;
  kind: SessionKind;
  name: string | null;
  last_read_at?: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type PendingJudgement = {
  id: string;
  session_id: string;
  message_id: string;
  bot_id: string;
  created_at: string;
};

export type SessionSummary = Session & {
  participants: SessionParticipant[];
  last_message?: Message | null;
  live_turns?: Turn[];
  pending_judgements?: PendingJudgement[];
  unread_count?: number;
};

export type TurnStatus =
  | "running"
  | "waiting_approval"
  | "waiting_ask"
  | "completed"
  | "redirected"
  | "interrupted"
  | "stopped";

export type Turn = {
  id: string;
  session_id: string;
  bot_id: string;
  status: TurnStatus;
  trigger_message_id: string;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  partial_text?: string | null;
};

export type MessageKind = "user" | "bot" | "ask" | "approval" | "profile_change" | "system";

export type Attachment = {
  id: string;
  message_id: string;
  workspace_relpath: string;
  original_filename: string;
  created_at: string;
  exists?: boolean;
  is_dir?: boolean;
  size?: number | null;
  mime?: string | null;
};

export type Reaction = {
  message_id: string;
  actor: typeof USER_MEMBER | string;
  emoji: string;
  created_at: string;
};

export type Message = {
  id: string;
  session_id: string;
  turn_id: string | null;
  parent_id: string | null;
  kind: MessageKind;
  author: typeof USER_MEMBER | string;
  body: string;
  source_turn_id: string | null;
  created_at: string;
  attachments: Attachment[];
  reactions: Reaction[];
};

export type SessionDetail = Session & {
  participants: SessionParticipant[];
  messages: ListPage<Message>;
  turns: Turn[];
  pending_judgements?: PendingJudgement[];
  unread_count?: number;
};

export type CreateGroupRequest = {
  name: string;
  members: string[];
};

export type PostMessageRequest = {
  body: string;
  parent_id?: string | null;
  fork?: boolean;
  ask_id?: string | null;
};

export type MemberRequest = {
  bot_id: string;
};

export type ReactionRequest = {
  emoji: string;
};

export type StopRequest = {
  turn_id?: string;
};

export type ContinueRequest = {
  message_id: string;
};

export type ApprovalStatus = "pending" | "allowed_once" | "denied" | "voided";

export type Approval = {
  id: string;
  turn_id: string;
  message_id: string | null;
  status: ApprovalStatus;
  kind_key: string | null;
  summary: string | null;
  target: string | null;
  created_at: string;
  resolved_at: string | null;
  /** True when allow_once must include api_key (endpoint-add, HTTP mcp-add, or an edit with no key yet). */
  requires_api_key: boolean;
};

export type ResolveApprovalRequest = {
  action: "allow_once" | "deny" | "always_allow";
  scope?: string;
  /** Written only to the keychain for endpoint-add / endpoint-edit / HTTP MCP auth. Never echoed. */
  api_key?: string;
};

export type AllowRule = {
  id: string;
  kind_key: string;
  scope: string;
  created_at: string;
};

export type McpToolCatalogEntry = {
  name: string;
  description: string;
};

export type McpServer = {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string | null;
  headers: McpHeader[];
  /** True when an Authorization secret is in the keychain. The secret itself is never echoed. */
  auth_set: boolean;
  enabled: boolean;
  /** Handshake `instructions` from the server; used to pick tools for a turn. */
  instructions: string | null;
  /**
   * Roster-level usage note written by you or a Bot: what this server is for, when to use it,
   * when not to. Goes into every hop's MCP block next to the server's own instructions.
   * Editing it is not a dangerous action and survives connection changes.
   */
  usage_note: string | null;
  /** Last `tools/list` snapshot (server-native names). */
  tool_catalog: McpToolCatalogEntry[];
  created_at: string;
  updated_at: string;
};

export type RoutineSchedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekdays: string[] };

export type Routine = {
  id: string;
  bot_id: string;
  title: string;
  instruction: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  last_fired_for_due_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Skill = {
  id: string;
  bot_id: string;
  name: string;
  description: string;
  body: string;
  /**
   * MCP server names the body relies on (matched case-insensitively against connected servers).
   * The skill catalog marks the ones not connected this turn so the Bot does not force the body.
   */
  uses: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type CreateSkillRequest = {
  bot_id: string;
  name: string;
  description: string;
  body: string;
  uses?: string[];
  enabled?: boolean;
};

export type PatchSkillRequest = {
  name?: string;
  description?: string;
  body?: string;
  uses?: string[];
  enabled?: boolean;
};

export type Spend = {
  id: string;
  session_id: string;
  bot_id: string;
  turn_id: string | null;
  judgement_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd_ticks: number | null;
  missing_reason: "stream_interrupted" | "endpoint_omitted" | null;
  created_at: string;
};

export type Judgement = {
  id: string;
  session_id: string;
  message_id: string;
  bot_id: string;
  decision: "join" | "pass";
  reason: string | null;
  error: "timeout" | "invalid_output" | "endpoint_error" | null;
  created_at: string;
};

export type SearchKind = "bot" | "session" | "message" | "routine" | "file";

export type SearchHit = {
  kind: SearchKind;
  id?: string;
  path?: string;
  snippet?: string;
  session_id?: string;
  session_title?: string;
  parent_id?: string | null;
};

export type WsAuthMessage = {
  type: "auth";
  token: string;
};

export type ClientEvent =
  | ({ event: "settings.changed"; occurred_at: string } & Settings)
  | ({ event: "bot.upsert"; occurred_at: string } & Bot & { deleted_at: string | null })
  | ({ event: "session.upsert"; occurred_at: string } & SessionSummary)
  | { event: "session.removed"; occurred_at: string; id: string }
  | { event: "session.cleared"; occurred_at: string; id: string }
  | ({ event: "message.created"; occurred_at: string } & Message)
  | ({ event: "turn.upsert"; occurred_at: string } & Turn)
  | { event: "turn.token"; occurred_at: string; turn_id: string; session_id: string; text: string }
  | {
      event: "turn.tool";
      occurred_at: string;
      turn_id: string;
      id: string;
      name?: string;
      arguments?: string;
    }
  | ({ event: "approval.upsert"; occurred_at: string } & Approval)
  | {
      event: "reaction.changed";
      occurred_at: string;
      message_id: string;
      actor: typeof USER_MEMBER | string;
      emoji: string;
      op: "add" | "remove";
    }
  | ({ event: "judgement.started"; occurred_at: string } & PendingJudgement)
  | ({ event: "judgement.created"; occurred_at: string } & Judgement)
  | {
      event: "judgement.ended";
      occurred_at: string;
      id: string;
      session_id: string;
      message_id: string;
      bot_id: string;
    }
  | ({ event: "spend.created"; occurred_at: string } & Spend)
  | ({ event: "routine.upsert"; occurred_at: string } & Routine)
  | { event: "routine.removed"; occurred_at: string; id: string }
  | ({ event: "skill.upsert"; occurred_at: string } & Skill)
  | { event: "skill.removed"; occurred_at: string; id: string }
  | ({ event: "mcp.upsert"; occurred_at: string } & McpServer)
  | { event: "mcp.removed"; occurred_at: string; id: string }
  | ({ event: "provider.upsert"; occurred_at: string } & Provider)
  | { event: "provider.removed"; occurred_at: string; id: string }
  | ({ event: "allow_rule.upsert"; occurred_at: string } & AllowRule)
  | { event: "allow_rule.removed"; occurred_at: string; id: string };

export * from "./boring-avatars.ts";
