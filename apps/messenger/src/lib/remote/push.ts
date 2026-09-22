import { fromBase64url } from "@real-bot/remote";
import type { RemoteApi } from "./api.ts";

export const PUSH_INBOX_MESSAGE = { type: "inbox" } as const;

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

import type { PushStateV2, PushSubscribeMode } from "../notifications/types.ts";

export type RefreshPushResult = "refreshed" | "needs_repair";

function boundApplicationServerKey(subscription: PushSubscription): Uint8Array | null {
  const raw = (subscription.options as { applicationServerKey?: BufferSource | null } | undefined)?.applicationServerKey;
  if (!raw) return null;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return null;
}

function sameApplicationServerKey(bound: Uint8Array | null, expected: Uint8Array): boolean {
  if (!bound || bound.byteLength !== expected.byteLength) return false;
  for (let i = 0; i < bound.byteLength; i++) if (bound[i] !== expected[i]) return false;
  return true;
}

async function postSubscribeV2(
  api: RemoteApi,
  state: PushStateV2,
  mode: PushSubscribeMode,
  subscription: PushSubscription,
): Promise<void> {
  const keys = subscriptionKeys(subscription);
  await api.subscribePushV2({
    mode,
    if_device_revision: state.device_revision,
    application_server_key_fingerprint: state.application_server_key_fingerprint,
    endpoint: keys.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    expires_at: keys.expires_at,
  });
}

/** Background reconnect only. Never prompts and never tears down a healthy subscription. */
export async function refreshPush(api: RemoteApi, prefetchedState?: PushStateV2): Promise<RefreshPushResult> {
  if (pushPermission() !== "granted") return "needs_repair";
  if (!("getPushStateV2" in api) || typeof api.getPushStateV2 !== "function") return "needs_repair";
  const state = prefetchedState ?? await api.getPushStateV2();
  if (!state.enabled || state.recovery !== "none" || state.push_transport !== "policy_v2") return "needs_repair";
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (!existing) return "needs_repair";
  const expected = Uint8Array.from(applicationServerKeyBytes(state.applicationServerKey));
  if (!sameApplicationServerKey(boundApplicationServerKey(existing), expected)) return "needs_repair";
  await postSubscribeV2(api, state, "refresh", existing);
  return "refreshed";
}

export async function enablePush(api: RemoteApi, mode: PushSubscribeMode = "enable", prefetchedState?: PushStateV2): Promise<void> {
  if (mode === "refresh") {
    const result = await refreshPush(api, prefetchedState);
    if (result === "needs_repair") throw new Error("needs_repair");
    return;
  }
  if (pushPermission() === "unsupported") throw new Error("unsupported");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("denied");
  const registration = await navigator.serviceWorker.ready;
  if ("getPushStateV2" in api && typeof api.getPushStateV2 === "function") {
    try {
      const state = prefetchedState ?? await api.getPushStateV2();
      const applicationServerKey = Uint8Array.from(applicationServerKeyBytes(state.applicationServerKey));
      let existing = await registration.pushManager.getSubscription();
      if (existing && state.recovery !== "none") {
        await existing.unsubscribe();
        existing = null;
      }
      const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      await postSubscribeV2(api, state, "enable", subscription);
      return;
    } catch (e) {
      if (e instanceof Error && (e.message === "denied" || e.message === "unsupported")) throw e;
    }
  }
  const state = await api.pushState();
  const applicationServerKey = Uint8Array.from(applicationServerKeyBytes(state.applicationServerKey));
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  await api.subscribePush(subscriptionKeys(subscription));
}

export type DisablePushResult = {
  localRemoved: boolean;
  hostDisabled: boolean;
  hostConfirmed: boolean;
};

export async function disablePush(api: RemoteApi): Promise<DisablePushResult> {
  let localRemoved = false;
  let hostDisabled = false;
  let hostConfirmed = false;
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }
    const check = await registration?.pushManager.getSubscription();
    localRemoved = (check === null || check === undefined);
  } catch {
    localRemoved = false;
  }

  try {
    if ("getPushStateV2" in api && typeof api.getPushStateV2 === "function") {
      try {
        const state = await api.getPushStateV2();
        if ("unsubscribePushV2" in api && typeof api.unsubscribePushV2 === "function") {
          await api.unsubscribePushV2({ if_device_revision: state.device_revision });
        } else {
          await api.unsubscribePush();
        }
        hostDisabled = true;
        hostConfirmed = true;
      } catch {
        await api.unsubscribePush();
        hostDisabled = true;
        hostConfirmed = true;
      }
    } else {
      await api.unsubscribePush();
      hostDisabled = true;
      hostConfirmed = true;
    }
  } catch {
    hostDisabled = false;
    hostConfirmed = false;
  }

  return { localRemoved, hostDisabled, hostConfirmed };
}

export function isInboxMessage(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === PUSH_INBOX_MESSAGE.type
    && Object.keys(data as object).join() === "type";
}
