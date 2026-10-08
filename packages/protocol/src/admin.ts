import type { McpHeader, McpTransport } from "./constants.ts";
import type { RetrospectiveOrigin } from "./quality.ts";

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
  /**
   * Same-kind tasks after the learning hop last revised this skill, and how many of them were
   * shorter. Null when a turn wrote it, or no hop has revised it.
   */
  learning: { later: number; shorter: number } | null;
  /** The retrospective (ADR 0062) that last changed it, and its plan; absent when a turn or you did. */
  retrospective?: RetrospectiveOrigin | null;
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
  /**
   * Same-kind tasks after the learning hop wrote this memory, and how many of them were shorter.
   * Null when the Bot wrote it during a turn.
   */
  learning: { later: number; shorter: number } | null;
  /** The retrospective (ADR 0062) that wrote it as it now reads, and its plan; absent when a turn or you wrote it. */
  retrospective?: RetrospectiveOrigin | null;
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
