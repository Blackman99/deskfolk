import {
  DEFAULT_POLICY_CATEGORIES,
  EMPTY_NOTIFICATION_CAPABILITIES,
  EMPTY_NOTIFICATION_SUMMARY,
  NOTIFICATION_ACTION_STATES,
  NOTIFICATION_FILTERS,
  NOTIFICATION_KINDS,
  type NotificationActionState,
  type NotificationCapabilities,
  type NotificationCursor,
  type NotificationDevice,
  type NotificationFilter,
  type NotificationItem,
  type NotificationKind,
  type NotificationListPage,
  type NotificationPolicy,
  type NotificationSummary,
  type PushRecovery,
  type PushStateV2,
  type PushTransport,
  type SessionNotificationPreference,
} from "./types.ts";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_TITLE = 80;
const MAX_SUMMARY = 160;
const MAX_CURSOR_BYTES = 256;

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID.test(value);
}

export function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isIsoUtc(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

export function isNotificationFilter(value: unknown): value is NotificationFilter {
  return typeof value === "string" && (NOTIFICATION_FILTERS as readonly string[]).includes(value);
}

export function isActionState(value: unknown): value is NotificationActionState {
  return typeof value === "string" && (NOTIFICATION_ACTION_STATES as readonly string[]).includes(value);
}

export function clipCodes(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

export function isIanaTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value.length > 0 && !value.includes("\0");
  } catch {
    return false;
  }
}

export function isHourMinute(value: unknown): value is string {
  return typeof value === "string" && HH_MM.test(value);
}

export function validateQuietHours(start: string, end: string, timeZone: string): string | null {
  if (!isHourMinute(start) || !isHourMinute(end)) return "invalid_time";
  if (start === end) return "equal_range";
  if (!isIanaTimeZone(timeZone)) return "invalid_time_zone";
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseNotificationItem(value: unknown): NotificationItem | null {
  const row = asObject(value);
  if (!row || !isUlid(row.id) || !isNonNegInt(row.ordinal) || !isNotificationKind(row.kind)) return null;
  if (!isActionState(row.action_state) || !isNonNegInt(row.revision) || !isIsoUtc(row.created_at)) return null;
  if (row.read_at != null && !isIsoUtc(row.read_at)) return null;
  const display = asObject(row.display);
  const target = asObject(row.target);
  if (!display || typeof display.title !== "string" || typeof display.summary !== "string") return null;
  if (!target) return null;
  const sessionId = row.session_id == null ? null : isUlid(row.session_id) ? row.session_id : null;
  if (row.session_id != null && sessionId == null) return null;
  const messageId = row.message_id == null ? null : isUlid(row.message_id) ? row.message_id : null;
  if (row.message_id != null && messageId == null) return null;
  const turnId = row.turn_id == null ? null : isUlid(row.turn_id) ? row.turn_id : null;
  if (row.turn_id != null && turnId == null) return null;
  const approvalId = row.approval_id == null ? null : isUlid(row.approval_id) ? row.approval_id : null;
  if (row.approval_id != null && approvalId == null) return null;
  const routineId = row.routine_id == null ? null : isUlid(row.routine_id) ? row.routine_id : null;
  if (row.routine_id != null && routineId == null) return null;
  const targetSession = target.session_id == null ? null : isUlid(target.session_id) ? target.session_id : null;
  if (target.session_id != null && targetSession == null) return null;
  const targetMessage = target.message_id == null ? null : isUlid(target.message_id) ? target.message_id : null;
  if (target.message_id != null && targetMessage == null) return null;
  const targetApproval = target.approval_id == null ? null : isUlid(target.approval_id) ? target.approval_id : null;
  if (target.approval_id != null && targetApproval == null) return null;
  const targetTurn = target.turn_id == null ? null : isUlid(target.turn_id) ? target.turn_id : null;
  if (target.turn_id != null && targetTurn == null) return null;
  return {
    id: row.id,
    ordinal: row.ordinal,
    semantic_key: typeof row.semantic_key === "string" ? row.semantic_key : `${row.kind}:${row.id}`,
    kind: row.kind,
    session_id: sessionId,
    message_id: messageId,
    turn_id: turnId,
    approval_id: approvalId,
    routine_id: routineId,
    routine_due_at: typeof row.routine_due_at === "string" ? row.routine_due_at : null,
    created_at: row.created_at,
    read_at: row.read_at == null ? null : row.read_at,
    terminal_at: typeof row.terminal_at === "string" ? row.terminal_at : null,
    action_state: row.action_state,
    resolution_reason: typeof row.resolution_reason === "string" ? row.resolution_reason : null,
    fail_kind: typeof row.fail_kind === "string" ? row.fail_kind : null,
    revision: row.revision,
    display: {
      title: clipCodes(display.title, MAX_TITLE),
      summary: clipCodes(display.summary, MAX_SUMMARY),
    },
    target: { session_id: targetSession, message_id: targetMessage, approval_id: targetApproval, turn_id: targetTurn },
  };
}

export function parseNotificationSummary(value: unknown): NotificationSummary {
  const row = asObject(value);
  if (!row) return EMPTY_NOTIFICATION_SUMMARY;
  const unread = isNonNegInt(row.unread_count) ? row.unread_count : 0;
  const open = isNonNegInt(row.open_count) ? row.open_count : 0;
  const attention = isNonNegInt(row.attention_count) ? row.attention_count : Math.max(unread, open);
  return { unread_count: unread, open_count: open, attention_count: attention };
}

export function parseNotificationList(value: unknown): NotificationListPage | null {
  const row = asObject(value);
  if (!row || !Array.isArray(row.items) || !isNonNegInt(row.upper_ordinal)) return null;
  if (typeof row.event_instance_id !== "string" || !isNonNegInt(row.watermark_seq)) return null;
  const items: NotificationItem[] = [];
  for (const item of row.items) {
    const parsed = parseNotificationItem(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  const next = row.next == null ? null : typeof row.next === "string" ? row.next : null;
  if (row.next != null && next == null) return null;
  return {
    items,
    next,
    summary: parseNotificationSummary(row.summary),
    upper_ordinal: row.upper_ordinal,
    event_instance_id: row.event_instance_id,
    watermark_seq: row.watermark_seq,
  };
}

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  const json = JSON.stringify(cursor);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_CURSOR_BYTES) throw new Error("cursor too long");
  return btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function parseNotificationCursor(raw: string, filter: NotificationFilter, upper: number): NotificationCursor | null {
  if (!raw || raw.length > MAX_CURSOR_BYTES) return null;
  try {
    const padded = raw.replaceAll("-", "+").replaceAll("_", "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const parsed = JSON.parse(atob(padded + pad)) as unknown;
    const row = asObject(parsed);
    if (!row || row.v !== 1 || !isNotificationFilter(row.filter) || row.filter !== filter) return null;
    if (!isNonNegInt(row.upper_ordinal) || row.upper_ordinal !== upper) return null;
    if (!isNonNegInt(row.before_ordinal)) return null;
    return { v: 1, filter: row.filter, upper_ordinal: row.upper_ordinal, before_ordinal: row.before_ordinal };
  } catch {
    return null;
  }
}

export function parseNotificationCapabilities(value: unknown): NotificationCapabilities {
  const row = asObject(value);
  if (!row) return EMPTY_NOTIFICATION_CAPABILITIES;
  const flag = (key: keyof NotificationCapabilities) => row[key] === true;
  return {
    inbox_v1: flag("inbox_v1"),
    bounded_read_v1: flag("bounded_read_v1"),
    pending_ask_v1: flag("pending_ask_v1"),
    policy_v1: flag("policy_v1"),
    push_settings_v2: flag("push_settings_v2"),
  };
}

export function parsePushTransport(value: unknown): PushTransport | null {
  return value === "legacy" || value === "paused_upgrade" || value === "policy_v2" ? value : null;
}

export function parseNotificationPolicy(value: unknown): NotificationPolicy | null {
  const row = asObject(value);
  if (!row || !isNonNegInt(row.revision)) return null;
  const categories = asObject(row.categories) ?? {};
  const quiet = asObject(row.quiet_hours) ?? {};
  const start = typeof quiet.start === "string" ? quiet.start : "22:00";
  const end = typeof quiet.end === "string" ? quiet.end : "08:00";
  const timeZone = typeof quiet.time_zone === "string" ? quiet.time_zone : "UTC";
  if (validateQuietHours(start, end, timeZone)) return null;
  return {
    revision: row.revision,
    categories: {
      approval: typeof categories.approval === "boolean" ? categories.approval : DEFAULT_POLICY_CATEGORIES.approval,
      ask: typeof categories.ask === "boolean" ? categories.ask : DEFAULT_POLICY_CATEGORIES.ask,
      failure: typeof categories.failure === "boolean" ? categories.failure : DEFAULT_POLICY_CATEGORIES.failure,
      interrupted: typeof categories.interrupted === "boolean" ? categories.interrupted : DEFAULT_POLICY_CATEGORIES.interrupted,
      reply: typeof categories.reply === "boolean" ? categories.reply : DEFAULT_POLICY_CATEGORIES.reply,
      routine_result: typeof categories.routine_result === "boolean" ? categories.routine_result : DEFAULT_POLICY_CATEGORIES.routine_result,
    },
    quiet_hours: { enabled: quiet.enabled === true, start, end, time_zone: timeZone },
  };
}

export function parseNotificationDevice(value: unknown): NotificationDevice | null {
  const row = asObject(value);
  if (!row || !isNonNegInt(row.revision)) return null;
  const sound = row.sound === "off" || row.sound === "default" || row.sound === "system" ? row.sound : "off";
  const preview = row.preview === "reply_excerpt" || row.preview === "generic" ? row.preview : "generic";
  return {
    revision: row.revision,
    enabled: row.enabled === true,
    badge: row.badge !== false,
    sound,
    preview,
  };
}

export function parseSessionPreference(value: unknown): SessionNotificationPreference | null {
  const row = asObject(value);
  if (!row || typeof row.muted !== "boolean" || !isNonNegInt(row.revision)) return null;
  return { muted: row.muted, revision: row.revision };
}

export function parsePushStateV2(value: unknown): PushStateV2 | null {
  const row = asObject(value);
  if (!row || typeof row.applicationServerKey !== "string") return null;
  const recovery: PushRecovery =
    row.recovery === "registration_missing" || row.recovery === "gone" || row.recovery === "expired" || row.recovery === "key_mismatch"
      ? row.recovery
      : "none";
  const fingerprint =
    typeof row.vapid_key_fingerprint === "string" && row.vapid_key_fingerprint.length > 0
      ? row.vapid_key_fingerprint
      : typeof row.application_server_key_fingerprint === "string"
        ? row.application_server_key_fingerprint
        : "";
  const hashField = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  return {
    applicationServerKey: row.applicationServerKey,
    subscribed: row.subscribed === true,
    enabled: row.enabled === true,
    device_revision: isNonNegInt(row.device_revision) ? row.device_revision : 0,
    push_generation: isNonNegInt(row.push_generation) ? row.push_generation : 0,
    application_server_key_fingerprint: fingerprint,
    recovery,
    current_endpoint_hash: hashField(row.current_endpoint_hash),
    last_gone_endpoint_hash: hashField(row.last_gone_endpoint_hash),
    last_error_code: hashField(row.last_error_code),
    contact_configured: row.contact_configured === true,
    push_transport: parsePushTransport(row.push_transport) ?? "legacy",
  };
}

export function defaultFilter(summary: NotificationSummary): NotificationFilter {
  return summary.open_count > 0 ? "actionable" : "unread";
}

export function attentionLabel(summary: NotificationSummary): { attention: number; open: number } {
  return { attention: summary.attention_count, open: summary.open_count };
}

export function isOpenAction(item: Pick<NotificationItem, "action_state">): boolean {
  return item.action_state === "open";
}

export function isUnreadItem(item: Pick<NotificationItem, "read_at">): boolean {
  return item.read_at == null;
}

export function matchesFilter(item: NotificationItem, filter: NotificationFilter): boolean {
  if (filter === "actionable") return isOpenAction(item);
  if (filter === "unread") return isUnreadItem(item);
  return true;
}
