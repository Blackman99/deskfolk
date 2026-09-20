import { fromBase64url } from "@real-bot/remote";
import { WEB_PUSH_COPY, WEB_PUSH_PAYLOAD } from "@real-bot/protocol";
import type { RemoteApi } from "./api.ts";

export const PUSH_INBOX_MESSAGE = { type: "inbox" } as const;
export const PUSH_VISIBLE_COPY = WEB_PUSH_COPY;
export const PUSH_PAYLOAD = WEB_PUSH_PAYLOAD;

export type PushPermission = "default" | "granted" | "denied" | "unsupported";

export function pushPermission(): PushPermission {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "unsupported";
  }
  const value = Notification.permission;
  return value === "granted" || value === "denied" ? value : "default";
}

export function applicationServerKeyBytes(value: string): Uint8Array {
  return fromBase64url(value, 65);
}

function subscriptionKeys(subscription: PushSubscription): { endpoint: string; p256dh: string; auth: string; expires_at: number | null } {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new Error("push subscription incomplete");
  const expires = subscription.expirationTime;
  return {
    endpoint: json.endpoint,
    p256dh,
    auth,
    expires_at: typeof expires === "number" && Number.isFinite(expires) ? Math.trunc(expires) : null,
  };
}

export async function enablePush(api: RemoteApi): Promise<void> {
  if (pushPermission() === "unsupported") throw new Error("unsupported");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("denied");
  const registration = await navigator.serviceWorker.ready;
  const state = await api.pushState();
  const applicationServerKey = Uint8Array.from(applicationServerKeyBytes(state.applicationServerKey));
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  await api.subscribePush(subscriptionKeys(subscription));
}

export async function disablePush(api: RemoteApi): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // Local unsubscribe is best-effort; the Mac still drops the stored endpoint.
  }
  await api.unsubscribePush();
}

export function isInboxMessage(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === PUSH_INBOX_MESSAGE.type
    && Object.keys(data as object).join() === "type";
}

export function notificationMustNotAct(data: unknown): boolean {
  if (!data || typeof data !== "object") return true;
  const keys = Object.keys(data as object);
  return keys.length === 1 && keys[0] === "t" && (data as { t?: unknown }).t === "pending";
}
