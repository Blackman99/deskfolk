import type { EventCursor } from "./index.ts";

export type NotificationKind =
  | "approval"
  | "ask"
  | "failure"
  | "interrupted"
  | "reply"
  | "routine_result";

export type NotificationActionState = "none" | "open" | "resolved" | "voided";

export type NotificationResolutionReason =
  | "acknowledged"
  | "continued"
  | "resolved"
  | "voided"
  | (string & {});

export type NotificationDisplay = {
  title: string;
  summary: string;
};

export type NotificationTarget = {
  session_id?: string | null;
  message_id?: string | null;
  approval_id?: string | null;
  turn_id?: string | null;
};

export type NotificationItem = {
  id: string;
  ordinal: number;
  semantic_key: string;
  kind: NotificationKind;
  session_id?: string | null;
  message_id?: string | null;
  turn_id?: string | null;
  approval_id?: string | null;
  routine_id?: string | null;
  routine_due_at?: string | null;
  created_at: string;
  read_at?: string | null;
  terminal_at?: string | null;
  action_state: NotificationActionState;
  resolution_reason?: NotificationResolutionReason | null;
  fail_kind?: string | null;
  revision: number;
  display: NotificationDisplay;
  target: NotificationTarget;
};

export type NotificationRetentionNotice = {
  pruned_at: string;
  read_at: string | null;
};

export type NotificationSummary = {
  unread_count: number;
  open_count: number;
  attention_count: number;
  retention_notice?: NotificationRetentionNotice | null;
};

export type NotificationCategories = {
  approval: boolean;
  ask: boolean;
  failure: boolean;
  interrupted: boolean;
  reply: boolean;
  routine_result: boolean;
};

export type QuietHours = {
  enabled: boolean;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  time_zone: string; // IANA
};

export type NotificationPolicy = {
  revision: number;
  categories: NotificationCategories;
  quiet_hours: QuietHours;
};

export type UpdateNotificationPolicyRequest = {
  if_revision: number;
  categories?: Partial<NotificationCategories>;
  quiet_hours?: Partial<QuietHours>;
};

export type NotificationDevice = {
  receiver_id: string;
  revision: number;
  enabled: boolean;
  badge: boolean;
  sound: "off" | "default" | "system";
  preview: "generic" | "reply_excerpt";
};

export type NotificationPushConfig = {
  contact_uri: string | null;
  revision: number;
  contact_configured: boolean;
};

export type UpdateNotificationPushConfigRequest = {
  contact_uri: string | null;
  if_revision: number;
};

export type PushSubscribeRequestV2 = {
  mode: "enable" | "refresh";
  if_device_revision: number;
  application_server_key_fingerprint: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expires_at?: number | null;
};

export type PushUnsubscribeRequestV2 = {
  if_device_revision?: number;
};

export type PushRecoveryReason =
  | "none"
  | "registration_missing"
  | "gone"
  | "expired"
  | "key_mismatch";

export type PushPublicState = {
  applicationServerKey: string;
  subscribed: boolean;
  enabled: boolean;
  device_revision: number;
  push_generation: number;
  vapid_key_fingerprint: string;
  recovery: PushRecoveryReason;
  current_endpoint_hash: string | null;
  last_gone_endpoint_hash: string | null;
  last_error_code: string | null;
  contact_configured: boolean;
  push_transport: "legacy" | "paused_upgrade" | "policy_v2";
};

export type NotificationCapabilities = {
  inbox_v1: boolean;
  bounded_read_v1: boolean;
  pending_ask_v1: boolean;
  policy_v1: boolean;
  push_settings_v2: boolean;
};

export type NotificationFilter = "actionable" | "unread" | "all";

export type ListNotificationsResponse = EventCursor & {
  items: NotificationItem[];
  next: string | null;
  summary: NotificationSummary;
  upper_ordinal: number;
};

export type ReadNotificationsRequest =
  | { ids: string[] }
  | { through_ordinal: number; filter: "all" };

export type AcknowledgeNotificationRequest = {
  if_revision: number;
};

export type ReadSessionRequest = {
  through_message_id?: string;
};

export type SessionNotificationPreference = {
  muted: boolean;
  revision: number;
};

export type UpdateSessionNotificationPreferenceRequest = {
  muted: boolean;
  if_revision: number;
};

export type NotificationPresence = {
  instance_id: string;
  visible: boolean;
  focused: boolean;
  session_id: string | null;
  at_latest: boolean;
};

export type DesktopClaimRequest = {
  owner_id: string;
  permission: "granted" | "denied" | "default";
};

export type DesktopClaimResponse = {
  delivery_id: string;
  claim_token: string;
  lease_expires_at: number;
  click_ref: string;
  title: string;
  body: string;
  sound: "default" | "off";
  identifier: string;
};

export type DesktopReportRequest = {
  delivery_id: string;
  claim_token: string;
  result: "accepted" | "failed" | "unknown";
  code?: string;
};

export type DesktopRevalidateRequest = {
  delivery_id: string;
  claim_token: string;
};

export type DesktopRevalidateResponse = {
  action: "deliver" | "cancel" | "retry_later";
  permit?: string;
  title?: string;
  body?: string;
  sound?: "default" | "off";
  retry_after_ms?: number;
};

export type DesktopStateResponse = {
  attention_count: number;
  cleanup_revision: number;
};

export type DesktopReconcileRequest = {
  identifiers: string[];
};

export type DesktopReconcileResponse = {
  remove_identifiers: string[];
};

export type NotificationCursorPayload = {
  v: 1;
  filter: NotificationFilter;
  upper_ordinal: number;
  before_ordinal: number;
};

declare const Buffer:
  | {
      from(str: string, encoding?: string): {
        toString(encoding?: string): string;
      };
    }
  | undefined;

function getGlobalFn(name: "btoa" | "atob"): ((str: string) => string) | undefined {
  if (typeof globalThis !== "undefined" && typeof (globalThis as Record<string, unknown>)[name] === "function") {
    return (globalThis as Record<string, unknown>)[name] as (str: string) => string;
  }
  return undefined;
}

export function encodeNotificationCursor(payload: NotificationCursorPayload): string {
  const json = JSON.stringify(payload);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf-8").toString("base64url");
  }
  const btoaFn = getGlobalFn("btoa");
  if (!btoaFn) {
    throw new Error("No base64 encoder available");
  }
  return btoaFn(unescape(encodeURIComponent(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeNotificationCursor(cursor: string): NotificationCursorPayload | null {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 256) {
    return null;
  }
  try {
    let raw = "";
    if (typeof Buffer !== "undefined") {
      raw = Buffer.from(cursor, "base64url").toString("utf-8");
    } else {
      const atobFn = getGlobalFn("atob");
      if (!atobFn) {
        throw new Error("No base64 decoder available");
      }
      let base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
      while (base64.length % 4 !== 0) {
        base64 += "=";
      }
      raw = decodeURIComponent(escape(atobFn(base64)));
    }
    const data = JSON.parse(raw) as Partial<NotificationCursorPayload>;
    if (
      data.v === 1 &&
      (data.filter === "actionable" || data.filter === "unread" || data.filter === "all") &&
      typeof data.upper_ordinal === "number" &&
      Number.isInteger(data.upper_ordinal) &&
      data.upper_ordinal >= 0 &&
      typeof data.before_ordinal === "number" &&
      Number.isInteger(data.before_ordinal) &&
      data.before_ordinal >= 0
    ) {
      return data as NotificationCursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}
