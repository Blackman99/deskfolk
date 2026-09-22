/**
 * Shared ground for the store modules: the database context every module receives, the raw row
 * shapes, and the small primitives (settings map, row lookups, validators) that more than one
 * domain needs. Domain modules (`bots.ts`, `sessions.ts`, …) import from here and from each other
 * in one direction only; the `Store` facade in `index.ts` wires them together.
 */
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  USER_MEMBER,
  generateBoringAvatar,
  type Approval,
  type Bot,
  type Message,
  type SessionKind,
  type SessionParticipant,
  type Turn,
} from "@real-bot/protocol";
import { HttpError } from "../errors";
import { parseStoredThinkingLevel } from "../models";
import { Transactions } from "./transactions";
import { ulid } from "../ids";
import { sha256 } from "../request-digest";

export type StoreOptions = {
  filename?: string;
  endpointKey?: EndpointKeyStore;
};

export type EndpointKeyStore = {
  get(name?: string): Promise<string | null>;
  set(value: string, name?: string): Promise<void>;
  delete(name?: string): Promise<void>;
};

/** Keychain access with a per-process cache; `peek` is the synchronous cache read `auth_set` needs. */
export class KeyCache {
  private readonly cached = new Map<string, string | null>();
  private readonly versions = new Map<string, number>();
  private readonly writing = new Set<string>();

  constructor(private readonly keys: EndpointKeyStore, private readonly db: Database, private readonly changed: (name: string) => void = () => {}) {}

  async read(name: string): Promise<string | null> {
    if (this.pending(name)) return null;
    if (this.cached.has(name)) return this.cached.get(name) ?? null;
    const version = this.versions.get(name) ?? 0;
    const value = await this.keys.get(name);
    if (version !== (this.versions.get(name) ?? 0)) return this.read(name);
    if (this.cached.has(name)) return this.cached.get(name) ?? null;
    this.cached.set(name, value);
    if (value != null) this.changed(name);
    return value;
  }

  /** Empty value deletes the entry. */
  async write(name: string, value: string): Promise<void> {
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
    const before = this.peek(name) != null;
    if (value.length === 0) await this.keys.delete(name);
    else await this.keys.set(value, name);
    this.cached.set(name, value.length ? value : null);
    if (before !== (this.peek(name) != null)) this.changed(name);
  }

  pending(name: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM pending_keys WHERE name = ?").get(name));
  }

  markPending(name: string, value: string, owner?: { deviceId: string; requestId: string }): void {
    if (this.pending(name)) throw new HttpError(409, "conflict", "credential write is pending; retry its request id");
    this.db.run("INSERT INTO pending_keys(name, value_sha256, operation_id, device_id, request_id) VALUES (?, ?, ?, ?, ?)", [name, sha256(value), ulid(), owner?.deviceId ?? null, owner?.requestId ?? null]);
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
    if (name.startsWith("endpoint-api-key:")) this.db.run("UPDATE request_meta SET settings_rev = settings_rev + 1 WHERE singleton = 1");
  }

  async finishPending(name: string, value: string): Promise<void> {
    const row = this.db.query<{ value_sha256: string }, [string]>("SELECT value_sha256 FROM pending_keys WHERE name = ?").get(name);
    if (!row) return;
    if (row.value_sha256 !== sha256(value)) throw new HttpError(409, "conflict", "credential digest changed");
    if (this.writing.has(name)) throw new HttpError(409, "conflict", "credential write is in progress");
    this.writing.add(name);
    try { await this.write(name, value); } catch (error) { this.writing.delete(name); throw error; }
  }

  isWriting(name: string): boolean { return this.writing.has(name); }
  releaseWriting(name: string): void { this.writing.delete(name); }

  clearPending(name: string): void {
    this.writing.delete(name);
    const changed = this.db.query("DELETE FROM pending_keys WHERE name = ? RETURNING name").get(name);
    if (changed && name.startsWith("endpoint-api-key:")) this.db.run("UPDATE request_meta SET settings_rev = settings_rev + 1 WHERE singleton = 1");
  }

  peek(name: string): string | null | undefined {
    if (this.pending(name)) return null;
    return this.cached.get(name);
  }
}

export type StoreContext = {
  readonly db: Database;
  readonly keys: KeyCache;
  commit<T>(write: () => T): T;
  readonly tx: Transactions;
  readonly inboxRoot: string;
  readonly activeStages: Set<string>;
  keyPlan: Array<{ name: string; value: string }> | null;
  /** Process-lifetime flags for one-shot legacy migrations. */
  readonly legacy: { copiedKey: boolean };
};

export type BotRow = {
  id: string;
  name: string;
  duties: string;
  boundaries: string;
  avatar: string | null;
  model: string | null;
  provider_id: string | null;
  thinking_level: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  id: string;
  kind: SessionKind;
  name: string | null;
  last_read_at: string | null;
  read_through_seq?: number;
  archived_at: string | null;
  origin_session_id: string | null;
  origin_message_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ParticipantRow = {
  session_id: string;
  member: string;
  joined_at: string;
  left_at: string | null;
};

/**
 * Whether a member is in a session right now. It lives here rather than in `sessions.ts`
 * because `messages.ts` needs it too, and the store modules import in one direction only.
 */
export function isPresent(ctx: StoreContext, sessionId: string, member: string): boolean {
  const row = ctx.db
    .query<ParticipantRow, [string, string]>(
      `SELECT * FROM session_participants WHERE session_id = ? AND member = ?`,
    )
    .get(sessionId, member);
  return Boolean(row && row.left_at === null);
}

export type AttachmentRow = {
  id: string;
  message_id: string;
  workspace_relpath: string;
  original_filename: string;
  created_at: string;
};

export type MessageRow = {
  id: string;
  session_id: string;
  turn_id: string | null;
  parent_id: string | null;
  kind: Message["kind"];
  author: string;
  body: string;
  source_turn_id: string | null;
  task_id: string | null;
  message_seq?: number;
  created_at: string;
};

export type TurnRow = {
  id: string;
  session_id: string;
  bot_id: string;
  status: Turn["status"];
  trigger_message_id: string;
  partial_text?: string | null;
  task_id: string | null;
  pending_ask_id?: string | null;
  routine_id?: string | null;
  routine_due_at?: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
};

export type SettingRow = { key: string; value: string };

export type ProviderRow = {
  id: string;
  name: string;
  base_url: string;
  models: string;
  available_models?: string | null;
  default_model: string | null;
  created_at: string;
  updated_at: string;
};

export type RoutineRow = {
  id: string;
  bot_id: string;
  title: string;
  instruction: string;
  schedule_kind: "daily" | "weekly";
  schedule_time: string;
  weekdays: string | null;
  enabled: number;
  last_fired_for_due_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SkillRow = {
  id: string;
  bot_id: string;
  name: string;
  description: string;
  body: string;
  uses?: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  learned_chain_id?: string | null;
};

export type MemoryRow = {
  id: string;
  bot_id: string;
  subject: string;
  body: string;
  source_session_id: string | null;
  source_message_id: string | null;
  learned_chain_id?: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type ApprovalRow = {
  id: string;
  turn_id: string;
  message_id: string | null;
  status: string;
  kind_key: string | null;
  summary: string | null;
  target: string | null;
  created_at: string;
  resolved_at: string | null;
  requires_api_key?: number | boolean | null;
};

export type McpRow = {
  id: string;
  name: string;
  transport?: string | null;
  command: string;
  args: string;
  url?: string | null;
  headers?: string | null;
  enabled: number;
  instructions?: string | null;
  usage_note?: string | null;
  tool_catalog?: string | null;
  created_at: string;
  updated_at: string;
};

export const KNOWN_SETTING_KEYS = [
  "workspace_path",
  "endpoint_base_url",
  "endpoint_key_ref",
  "endpoint_models",
  "endpoint_default_model",
  "default_provider_id",
  "launch_at_login",
  "locale",
  "theme",
] as const;

export const ALLOWED_KIND_KEYS = new Set([
  "outside-read",
  "outside-write",
  "unconstrained-shell",
  "outbound-http",
]);

// ---------------------------------------------------------------------------
// Settings primitives
// ---------------------------------------------------------------------------

export function settingsMap(ctx: StoreContext): Map<string, string> {
  const rows = ctx.db.query<SettingRow, []>(`SELECT key, value FROM settings`).all();
  const map = new Map<string, string>();
  for (const key of KNOWN_SETTING_KEYS) map.set(key, "");
  for (const row of rows) map.set(row.key, row.value);
  if (!map.get("locale")) map.set("locale", "zh");
  if (!map.get("theme")) map.set("theme", "system");
  if (!map.has("launch_at_login") || map.get("launch_at_login") === "") {
    map.set("launch_at_login", "1");
  }
  return map;
}

export function setSetting(ctx: StoreContext, key: string, value: string): void {
  ctx.db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value`,
    [key, value],
  );
}

export function workspacePath(ctx: StoreContext): string | null {
  return emptyToNull(settingsMap(ctx).get("workspace_path"));
}

export function defaultProviderId(ctx: StoreContext): string | null {
  return emptyToNull(settingsMap(ctx).get("default_provider_id"));
}

// ---------------------------------------------------------------------------
// Row lookups shared across domains
// ---------------------------------------------------------------------------

export function aliveBot(ctx: StoreContext, id: string): BotRow {
  const row = ctx.db.query<BotRow, [string]>(`SELECT * FROM bots WHERE id = ?`).get(id);
  if (!row || row.deleted_at) throw new HttpError(404, "not_found", "bot not found");
  return row;
}

export function assertNameFree(ctx: StoreContext, name: string): void {
  const taken = ctx.db
    .query<{ id: string }, [string]>(`SELECT id FROM bots WHERE name = ? LIMIT 1`)
    .get(name);
  if (taken) throw new HttpError(409, "conflict", "that name is already used");
}

export function sessionRow(ctx: StoreContext, id: string): SessionRow {
  const row = ctx.db.query<SessionRow, [string]>(`SELECT * FROM sessions WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "session not found");
  return row;
}

export function messageRow(ctx: StoreContext, id: string): MessageRow {
  const row = ctx.db.query<MessageRow, [string]>(`SELECT * FROM messages WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "message not found");
  return row;
}

export function providerRows(ctx: StoreContext): ProviderRow[] {
  return ctx.db
    .query<ProviderRow, []>(`SELECT * FROM providers ORDER BY created_at ASC, id`)
    .all();
}

export function requireProvider(ctx: StoreContext, id: string): ProviderRow {
  const row = ctx.db.query<ProviderRow, [string]>(`SELECT * FROM providers WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "not_found", "provider not found");
  return row;
}

export function touchSession(ctx: StoreContext, id: string, now: string): void {
  ctx.db.run(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [now, id]);
}

// ---------------------------------------------------------------------------
// Row → protocol mappers
// ---------------------------------------------------------------------------

export function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    turn_id: row.turn_id,
    message_id: row.message_id,
    status: row.status as Approval["status"],
    kind_key: row.kind_key,
    summary: row.summary,
    target: row.target,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    requires_api_key: Boolean(row.requires_api_key),
  };
}

export function toTurn(row: TurnRow): Turn {
  return {
    ...row,
    partial_text: isLive(row.status) ? (row.partial_text ?? null) : null,
    pending_ask_id: row.pending_ask_id ?? null,
    routine_id: row.routine_id ?? null,
    routine_due_at: row.routine_due_at ?? null,
  };
}

export function toBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    duties: row.duties,
    boundaries: row.boundaries,
    avatar: row.avatar ?? generateBoringAvatar({ name: row.name }),
    model: row.model,
    provider_id: row.provider_id,
    thinking_level: parseStoredThinkingLevel(row.thinking_level),
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function isLive(status: Turn["status"]): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_ask";
}

export function statOrMissing(abs: string): { abs: string; isDir: boolean } | null {
  try {
    const st = statSync(abs);
    return { abs, isDir: st.isDirectory() };
  } catch {
    return { abs, isDir: false };
  }
}

export function sessionSearchTitle(
  session: { kind: SessionKind; name: string | null },
  participants: readonly SessionParticipant[],
  botNames: ReadonlyMap<string, string>,
): string {
  if (session.kind === "group") return session.name ?? "";
  const names = participants
    .filter((p) => p.left_at === null && p.member !== USER_MEMBER)
    .map((p) => botNames.get(p.member) ?? p.member);
  const hasYou = participants.some((p) => p.left_at === null && p.member === USER_MEMBER);
  if (hasYou) return names[0] ?? "";
  return names.join(" ↔ ");
}

// ---------------------------------------------------------------------------
// Validators and small value helpers
// ---------------------------------------------------------------------------

export function memoryKeyStore(): EndpointKeyStore {
  const values = new Map<string, string>();
  return {
    async get(name = "") { return values.get(name) ?? null; },
    async set(value, name = "") { values.set(name, value); },
    async delete(name = "") { values.delete(name); },
  };
}

export function planKey(ctx: StoreContext, name: string, value: string): void {
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "credential must be a string");
  if (!ctx.keyPlan) throw new Error("credential mutation needs a key plan");
  ctx.keyPlan.push({ name, value });
}

export async function keyMutation<T>(ctx: StoreContext, work: () => T): Promise<T> {
  const plan: Array<{ name: string; value: string }> = [];
  const result = ctx.tx.run(() => {
    ctx.keyPlan = plan;
    try {
      const value = work();
      for (const op of plan) ctx.keys.markPending(op.name, op.value);
      return value;
    } finally { ctx.keyPlan = null; }
  });
  try {
    for (const op of plan) await ctx.keys.finishPending(op.name, op.value);
    ctx.tx.run(() => { for (const op of plan) ctx.keys.clearPending(op.name); });
  } finally { for (const op of plan) ctx.keys.releaseWriting(op.name); }
  return result;
}

export function emptyToNull(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export function requireNonEmpty(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(422, "invalid_args", `${field} is required`);
  }
  return value.trim();
}

export function requireString(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", `${field} must be a string`);
  }
  return value;
}

export function normalizeOptionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveWorkspacePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "workspace_path must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HttpError(422, "invalid_args", "workspace_path cannot be empty");
  }
  const expanded = expandHome(trimmed);
  if (!isAbsolute(expanded)) {
    throw new HttpError(422, "invalid_args", "workspace_path must be an absolute directory");
  }
  try {
    if (!existsSync(expanded)) {
      mkdirSync(expanded, { recursive: true });
    }
    const resolved = realpathSync(expanded);
    if (!statSync(resolved).isDirectory()) {
      throw new HttpError(422, "invalid_args", "workspace_path must be a directory");
    }
    return resolved;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "invalid_args", "workspace_path could not be created");
  }
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveEndpointUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "endpoint_base_url must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HttpError(422, "invalid_args", "endpoint_base_url cannot be empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(422, "invalid_args", "endpoint_base_url must be an http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(422, "invalid_args", "endpoint_base_url must be an http or https URL");
  }
  return parsed.href;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new HttpError(422, "invalid_args", "limit must be 1..200");
  }
  return limit;
}

export function cursorTime(cursor: string): string {
  const i = cursor.indexOf("|");
  if (i < 0) throw new HttpError(422, "invalid_args", "bad cursor");
  return cursor.slice(0, i);
}

export function cursorId(cursor: string): string {
  const i = cursor.indexOf("|");
  if (i < 0) throw new HttpError(422, "invalid_args", "bad cursor");
  return cursor.slice(i + 1);
}
