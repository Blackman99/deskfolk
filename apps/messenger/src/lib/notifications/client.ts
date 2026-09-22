import type { SessionDetail } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import {
  parseNotificationDevice,
  parseNotificationItem,
  parseNotificationList,
  parseNotificationPolicy,
  parsePushStateV2,
  parseSessionPreference,
} from "./parse.ts";
import type {
  NotificationDevice,
  NotificationDevicePatch,
  NotificationFilter,
  NotificationItem,
  NotificationListPage,
  NotificationPolicy,
  NotificationPolicyPatch,
  NotificationPresence,
  PushStateV2,
  PushSubscribeV2Request,
  PushUnsubscribeV2Request,
  SessionNotificationPreference,
} from "./types.ts";

export type NotificationHttp = {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
};

function query(filter: NotificationFilter, limit: number, cursor?: string | null): string {
  const params = new URLSearchParams();
  params.set("filter", filter);
  params.set("limit", String(Math.min(100, Math.max(1, limit))));
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export async function listNotifications(
  http: NotificationHttp,
  opts: { filter: NotificationFilter; limit?: number; cursor?: string | null; signal?: AbortSignal },
): Promise<NotificationListPage> {
  const path = `/v1/notifications?${query(opts.filter, opts.limit ?? 50, opts.cursor)}`;
  const raw = await http.get<unknown>(path, opts.signal);
  const page = parseNotificationList(raw);
  if (!page) throw new ApiError(422, "invalid_notification_list", "notification list did not match the contract");
  return page;
}

export async function getNotification(http: NotificationHttp, id: string): Promise<NotificationItem> {
  const raw = await http.get<unknown>(`/v1/notifications/${encodeURIComponent(id)}`);
  const item = parseNotificationItem(raw);
  if (!item) throw new ApiError(422, "invalid_notification", "notification did not match the contract");
  return item;
}

export async function markNotificationsRead(
  http: NotificationHttp,
  body: { ids: string[] } | { through_ordinal: number; filter: "all" },
): Promise<void> {
  await http.post<void>("/v1/notifications/read", body);
}

export async function acknowledgeNotification(http: NotificationHttp, id: string, ifRevision: number): Promise<void> {
  await http.post<void>(`/v1/notifications/${encodeURIComponent(id)}/acknowledge`, { if_revision: ifRevision });
}

export async function markSessionReadThrough(
  http: NotificationHttp,
  sessionId: string,
  throughMessageId: string,
): Promise<SessionDetail> {
  return http.post<SessionDetail>(`/v1/sessions/${encodeURIComponent(sessionId)}/read`, {
    through_message_id: throughMessageId,
  });
}

export async function getNotificationPolicy(http: NotificationHttp): Promise<NotificationPolicy> {
  const parsed = parseNotificationPolicy(await http.get<unknown>("/v1/notification-policy"));
  if (!parsed) throw new ApiError(422, "invalid_notification_policy", "notification policy did not match the contract");
  return parsed;
}

export async function patchNotificationPolicy(
  http: NotificationHttp,
  patch: NotificationPolicyPatch,
): Promise<NotificationPolicy> {
  const parsed = parseNotificationPolicy(await http.patch<unknown>("/v1/notification-policy", patch));
  if (!parsed) throw new ApiError(422, "invalid_notification_policy", "notification policy did not match the contract");
  return parsed;
}

export async function putSessionNotificationPreference(
  http: NotificationHttp,
  sessionId: string,
  body: { muted: boolean; if_revision: number },
): Promise<SessionNotificationPreference> {
  const parsed = parseSessionPreference(
    await http.put<unknown>(`/v1/sessions/${encodeURIComponent(sessionId)}/notification-preference`, body),
  );
  if (!parsed) throw new ApiError(422, "invalid_session_preference", "session preference did not match the contract");
  return parsed;
}

export async function getNotificationDevice(http: NotificationHttp): Promise<NotificationDevice> {
  const parsed = parseNotificationDevice(await http.get<unknown>("/v1/notification-device"));
  if (!parsed) throw new ApiError(422, "invalid_notification_device", "notification device did not match the contract");
  return parsed;
}

export async function patchNotificationDevice(
  http: NotificationHttp,
  patch: NotificationDevicePatch,
): Promise<NotificationDevice> {
  const parsed = parseNotificationDevice(await http.patch<unknown>("/v1/notification-device", patch));
  if (!parsed) throw new ApiError(422, "invalid_notification_device", "notification device did not match the contract");
  return parsed;
}

export async function postNotificationPresence(http: NotificationHttp, body: NotificationPresence): Promise<void> {
  await http.post<void>("/v1/notification-presence", body);
}

export async function getPushStateV2(http: NotificationHttp): Promise<PushStateV2> {
  const parsed = parsePushStateV2(await http.get<unknown>("/remote/push"));
  if (!parsed) throw new ApiError(422, "invalid_push_state", "push state did not match the contract");
  return parsed;
}

export async function subscribePushV2(http: NotificationHttp, body: PushSubscribeV2Request): Promise<void> {
  await http.post<void>("/remote/push/subscribe", body);
}

export async function unsubscribePushV2(http: NotificationHttp, body: PushUnsubscribeV2Request): Promise<void> {
  await http.post<void>("/remote/push/unsubscribe", body);
}

export type NotificationTestResult = { ok: boolean; status: string };

export async function testRemotePush(http: NotificationHttp): Promise<NotificationTestResult> {
  const raw = await http.post<unknown>("/remote/push/test", {});
  if (!raw || typeof raw !== "object") return { ok: true, status: "accepted" };
  const row = raw as { ok?: unknown; status?: unknown };
  const status = typeof row.status === "string" ? row.status : "accepted";
  return { ok: row.ok !== false, status };
}
