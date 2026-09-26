import type {
  AcknowledgeNotificationRequest,
  DesktopClaimRequest,
  DesktopClaimResponse,
  DesktopReconcileRequest,
  DesktopReconcileResponse,
  DesktopReportRequest,
  DesktopRevalidateRequest,
  DesktopRevalidateResponse,
  DesktopStateResponse,
  ListNotificationsResponse,
  NotificationActionState,
  NotificationCapabilities,
  NotificationCategories,
  NotificationCursorPayload,
  NotificationDisplay,
  NotificationItem,
  NotificationKind,
  NotificationPolicy,
  NotificationPresence,
  NotificationResolutionReason,
  NotificationRetentionNotice,
  NotificationSummary,
  NotificationTarget,
  NotificationFilter,
  ReadNotificationsRequest,
  ReadSessionRequest,
  SessionNotificationPreference,
  UpdateNotificationPolicyRequest,
  UpdateSessionNotificationPreferenceRequest,
} from "@real-bot/protocol";
import type { ApiError } from "../api.ts";

export type {
  AcknowledgeNotificationRequest,
  DesktopClaimRequest,
  DesktopClaimResponse,
  DesktopReconcileRequest,
  DesktopReconcileResponse,
  DesktopReportRequest,
  DesktopRevalidateRequest,
  DesktopRevalidateResponse,
  DesktopStateResponse,
  ListNotificationsResponse,
  NotificationActionState,
  NotificationCapabilities,
  NotificationCategories,
  NotificationCursorPayload,
  NotificationDisplay,
  NotificationItem,
  NotificationKind,
  NotificationPolicy,
  NotificationPresence,
  NotificationResolutionReason,
  NotificationRetentionNotice,
  NotificationSummary,
  NotificationTarget,
  NotificationFilter,
  ReadNotificationsRequest,
  ReadSessionRequest,
  SessionNotificationPreference,
  UpdateNotificationPolicyRequest,
  UpdateSessionNotificationPreferenceRequest,
};

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  "approval",
  "ask",
  "failure",
  "interrupted",
  "reply",
  "routine_result",
] as const;

export const NOTIFICATION_FILTERS: readonly NotificationFilter[] = ["actionable", "unread", "all"] as const;

export const NOTIFICATION_ACTION_STATES: readonly NotificationActionState[] = [
  "none",
  "open",
  "resolved",
  "voided",
] as const;

export type NotificationListPage = ListNotificationsResponse;

export type NotificationCursor = NotificationCursorPayload;

export type NotificationPolicyPatch = UpdateNotificationPolicyRequest;

export type NotificationPolicyCategories = NotificationCategories;

export type NotificationDevice = {
  receiver_id?: string;
  revision: number;
  enabled: boolean;
  badge: boolean;
  sound: "off" | "default" | "system";
  preview: "generic" | "reply_excerpt";
};

export type NotificationDevicePatch = {
  if_revision: number;
  enabled?: boolean;
  badge?: boolean;
  sound?: NotificationDevice["sound"];
  preview?: NotificationDevice["preview"];
};

export type NativeNotificationCapabilities = {
  native_reading_v1: boolean;
  native_delivery_v1: boolean;
};

export type NotificationPermissionStateDto = {
  permission: string;
  nativeReadingV1: boolean;
  nativeDeliveryV1: boolean;
  /** Cold-start click from a signed installed package. Posting does not wait on this. */
  coldClickQualified?: boolean;
  operational: boolean;
  gatedReason?: string | null;
  attentionCount: number;
};

export type NotificationIntent = {
  clickRef: string;
};

export type NotificationViewReport = {
  sessionId?: string | null;
  atLatest?: boolean | null;
  visible?: boolean | null;
  focused?: boolean | null;
};

export type NativeFocusFacts = {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  effectiveFocused: boolean;
};

export type DesktopClickResponse = {
  target?: NotificationTarget | null;
  open_inbox: boolean;
};

export type PushTransport = "legacy" | "paused_upgrade" | "policy_v2";

export type PushRecovery = "none" | "registration_missing" | "gone" | "expired" | "key_mismatch";

export type PushStateV2 = {
  applicationServerKey: string;
  subscribed: boolean;
  enabled: boolean;
  device_revision: number;
  push_generation: number;
  application_server_key_fingerprint: string;
  recovery: PushRecovery;
  current_endpoint_hash: string | null;
  last_gone_endpoint_hash: string | null;
  last_error_code: string | null;
  contact_configured?: boolean;
  push_transport: PushTransport;
};

export type PushSubscribeMode = "enable" | "refresh";

export type PushSubscribeV2Request = {
  mode: PushSubscribeMode;
  if_device_revision: number;
  application_server_key_fingerprint: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expires_at?: number | null;
};

export type PushUnsubscribeV2Request = { if_device_revision: number };

export type SendAskNotSubmittedReason =
  | "busy"
  | "disconnected"
  | "empty"
  | "stale_connection"
  | "stale_ask";

export type SendAskResult =
  | { status: "accepted"; request_id?: string; message_id?: string }
  | { status: "rejected"; error: ApiError }
  | { status: "unknown"; request_id?: string; error: ApiError }
  | { status: "not_submitted"; reason: SendAskNotSubmittedReason };

export type AskDraftRecord = {
  askId: string;
  /** What you wrote yourself. */
  body: string;
  /** The choices ticked so far, as labels. */
  selected: string[];
  version: number;
  error: string | null;
  ended: boolean;
  requestId?: string;
};

export type NativeReadingFacts = {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
};

export const EMPTY_NOTIFICATION_SUMMARY: NotificationSummary = {
  unread_count: 0,
  open_count: 0,
  attention_count: 0,
};

export const EMPTY_NOTIFICATION_CAPABILITIES: NotificationCapabilities = {
  inbox_v1: false,
  bounded_read_v1: false,
  pending_ask_v1: false,
  policy_v1: false,
  push_settings_v2: false,
};

export const EMPTY_NATIVE_CAPABILITIES: NativeNotificationCapabilities = {
  native_reading_v1: false,
  native_delivery_v1: false,
};

export const DEFAULT_POLICY_CATEGORIES: NotificationPolicyCategories = {
  approval: true,
  ask: true,
  failure: true,
  interrupted: true,
  reply: true,
  routine_result: true,
};
