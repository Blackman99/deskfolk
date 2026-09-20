/** Local API types, thinking-level helpers, mention parsing, and cited-path detection. */

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



export const USER_MEMBER = "user" as const;

/** Bot `update_profile` used to insert these; they are no longer shown. */
export function isHiddenTranscriptKind(kind: string): boolean {
  return kind === "profile_change";
}

/** Transcript body when a live turn is marked interrupted. Chinese in every locale. */
export const INTERRUPT_NOTE_BODY = "中断" as const;

/** Encrypted Web Push body. Visible copy is fixed; never titles, filenames or Bot names. */
export const WEB_PUSH_PAYLOAD = { t: "pending" } as const;
export const WEB_PUSH_COPY = {
  zh: "Real Bot 有待处理事项",
  en: "Real Bot has pending items",
} as const;

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
  | "key_write_pending"
  | "credential_superseded"
  | "receipt_expired"
  | "not_retryable"
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

/**
 * Fallback thinking levels when a catalog row does not list any. Endpoints may advertise others
 * (`xhigh`, `max`, `minimal`, …) as `reasoning_effort` values; those names are stored and sent as-is.
 */
export const THINKING_LEVELS = ["none", "low", "medium", "high"] as const;
/** A completion `reasoning_effort` name: the four fallbacks, or whatever the endpoint advertised. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number] | string;

const THINKING_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  min: 1,
  low: 2,
  medium: 3,
  default: 3,
  high: 4,
  xhigh: 5,
  extra_high: 5,
  max: 6,
  maximum: 6,
};

/** Token the completions API will accept as `reasoning_effort`. */
const THINKING_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export function isThinkingLevel(value: string): boolean {
  return THINKING_TOKEN.test(value.trim());
}

export function thinkingLevelRank(level: string): number {
  const key = level.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(THINKING_RANK, key)) return THINKING_RANK[key]!;
  return 3.5;
}

/** Dedupes (case-insensitive, first spelling wins) and orders from lightest to heaviest. */
export function sortThinkingLevels(levels: readonly string[]): ThinkingLevel[] {
  const out: ThinkingLevel[] = [];
  const seen = new Set<string>();
  for (const raw of levels) {
    const level = raw.trim();
    if (!level) continue;
    const key = level.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(level as ThinkingLevel);
  }
  out.sort((a, b) => {
    const delta = thinkingLevelRank(a) - thinkingLevelRank(b);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  return out;
}

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

/** One name from an endpoint `GET /models`, plus thinking levels that object advertised. */
export type ProbedModel = {
  name: string;
  thinking_levels: ThinkingLevel[];
};

export type ProbeModelsResponse = {
  models: string[];
  catalog: ProbedModel[];
};

export type Settings = {
  settings_rev?: number;
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
  /** Enabled completion names; a subset of what the endpoint offers. */
  models: string[];
  model_catalog: EndpointModel[];
  /** Last list the endpoint's `/models` returned, kept so the picker survives reopening. */
  available_models: string[];
  default_model: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateProviderRequest = {
  name: string;
  base_url: string;
  api_key?: string;
  models?: EndpointModelInput[];
  available_models?: string[];
  default_model?: string | null;
};

export type PatchProviderRequest = {
  name?: string;
  base_url?: string;
  api_key?: string;
  models?: EndpointModelInput[];
  available_models?: string[];
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
  /** The session whose message opened this one. Only a Bot↔Bot direct has one. */
  origin_session_id: string | null;
  /** The message that opened this session; the entry point to it hangs under that message. */
  origin_message_id: string | null;
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

export type CreateRoutineRequest = {
  bot_id: string;
  title: string;
  instruction: string;
  schedule: RoutineSchedule;
  enabled?: boolean;
};

export type PatchRoutineRequest = Partial<Omit<CreateRoutineRequest, "bot_id">> & {
  /** The routine's updated_at from the snapshot being edited. Optional for legacy local clients. */
  if_revision?: string;
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

/**
 * One fact a Bot wrote down about the user or the work, kept across sessions.
 *
 * A memory is the Bot's earlier conclusion, not a source of truth: when it disagrees with this
 * turn's transcript, the transcript wins. Only the Bot writes them; you can read, correct,
 * disable and delete.
 */
export type Memory = {
  id: string;
  bot_id: string;
  /** What the memory is about. Unique per Bot, case-insensitively: writing it again replaces. */
  subject: string;
  body: string;
  /** Where it was formed. Null once that session is gone. */
  source_session_id: string | null;
  /** The message that woke the turn it was formed in. Null once that history is cleared. */
  source_message_id: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

/** The user corrects a memory; they never create one. */
export type PatchMemoryRequest = {
  subject?: string;
  body?: string;
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

/** How the turn a model choice ran on ended; `null` while it is still live. */
export type RouteOutcome = "completed" | "failed" | "stopped" | "redirected" | "interrupted";

/** A user follow-up about the model itself, attributed to one decision. */
export type RouteFeedback = {
  message_id: string;
  body: string;
  created_at: string;
};

/**
 * The model and thinking level a turn ran on, who it was for, and how it went. One per turn; a
 * Bot's own records are the only ones that shape its later choices.
 */
export type RouteRecord = {
  turn_id: string;
  session_id: string;
  bot_id: string;
  trigger_message_id: string;
  provider_id: string | null;
  model: string;
  thinking_level: ThinkingLevel;
  /** The message kind the choice was made for (coding / writing / reasoning / simple / general). */
  signature: string;
  outcome: RouteOutcome | null;
  /** Completion failure kind when `outcome` is `failed`. */
  fail_kind: string | null;
  /** One line from the agent that picked this model, when an agent picked it. */
  reason: string | null;
  /** Turns the user kept pushing back on share one; the chain is reviewed as a whole. */
  chain_id: string | null;
  created_at: string;
  finished_at: string | null;
  feedback: RouteFeedback[];
};

/** What the review made of one closed correction chain. */
export type RouteReview = {
  chain_id: string;
  turn_id: string;
  bot_id: string;
  signature: string;
  model: string;
  thinking_level: ThinkingLevel;
  /** `model` when the pick was the problem; `task` / `prompt` / `none` when it was not. */
  fault: "model" | "task" | "prompt" | "none";
  direction: "stronger" | "lighter" | "faster" | "cheaper" | "same";
  /** How many rounds the user spent correcting before moving on. */
  rounds: number;
  confidence: number;
  reason: string;
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
  avatar?: string | null;
};

/** One composer draft the user can send next, suggested from the current transcript. */
export type ComposerSuggestion = {
  id: string;
  /** Chip text shown above the composer. */
  label: string;
  /** Full draft inserted into the composer; may include `@Name` / `@everyone`. */
  prompt: string;
};

export type ComposerSuggestionsPage = ListPage<ComposerSuggestion>;

export type EventCursor = {
  event_instance_id: string;
  watermark_seq: number;
};

export type CredentialOperation = { id: string; kind: string; entity_id: string; request_id: string | null; can_repair: boolean };

export type RuntimeSnapshot = EventCursor & {
  remoteStatus?: { state: "off" | "native_unavailable" | "activation_gated" | "connecting" | "online" | "disconnected" | "trust_mismatch"; diagnostic: string | null; devices: number };
  credentialOperations?: CredentialOperation[];
  settings: Settings;
  bots: Bot[];
  sessions: SessionSummary[];
  spend: Spend[];
  approvals: Approval[];
  mcpServers: McpServer[];
  providers: Provider[];
  skills: Skill[];
  memories: Memory[];
  routines: Routine[];
  allowRules: AllowRule[];
};

export type SessionSnapshot = EventCursor & {
  session: SessionDetail;
  judgements: Judgement[];
};

export type DurableEvent = Exclude<ClientEvent, { event: "turn.token" | "turn.tool" }>;
export type SequencedEvent = {
  type: "event";
  event_instance_id: string;
  seq: number;
  payload: DurableEvent;
};
export type SyncFrame = SequencedEvent
  | ({ type: "ready" } & EventCursor)
  | ({ type: "resnapshot" } & EventCursor);
export type CatchupResponse = EventCursor & { events: SequencedEvent[]; resnapshot: boolean };

export type WsAuthMessage = {
  type: "auth";
  token: string;
  /** Omit for the original, unsequenced local event stream. */
  protocol?: "sync-v1";
};

export type ClientEvent =
  | { event: "credential_operations.changed"; occurred_at: string; items: CredentialOperation[] }
  | ({ event: "settings.changed"; occurred_at: string } & Settings)
  | ({ event: "bot.upsert"; occurred_at: string } & Bot & { deleted_at: string | null })
  | ({ event: "session.upsert"; occurred_at: string } & SessionSummary)
  | { event: "session.removed"; occurred_at: string; id: string }
  | { event: "session.cleared"; occurred_at: string; id: string }
  | ({ event: "message.created" | "message.upsert"; occurred_at: string } & Message)
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
  | { event: "approval.removed"; occurred_at: string; id: string }
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
  | { event: "spend.removed"; occurred_at: string; id: string }
  | ({ event: "routine.upsert"; occurred_at: string } & Routine)
  | { event: "routine.removed"; occurred_at: string; id: string }
  | ({ event: "skill.upsert"; occurred_at: string } & Skill)
  | { event: "skill.removed"; occurred_at: string; id: string }
  | ({ event: "memory.upsert"; occurred_at: string } & Memory)
  | { event: "memory.removed"; occurred_at: string; id: string }
  | ({ event: "mcp.upsert"; occurred_at: string } & McpServer)
  | { event: "mcp.removed"; occurred_at: string; id: string }
  | ({ event: "provider.upsert"; occurred_at: string } & Provider)
  | { event: "provider.removed"; occurred_at: string; id: string }
  | ({ event: "allow_rule.upsert"; occurred_at: string } & AllowRule)
  | { event: "allow_rule.removed"; occurred_at: string; id: string };

export * from "./boring-avatars.ts";
export * from "./cited-path.ts";
export * from "./mentions.ts";
