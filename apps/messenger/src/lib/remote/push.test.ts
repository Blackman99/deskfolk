import { expect, test } from "bun:test";
import { WEB_PUSH_COPY, WEB_PUSH_PAYLOAD } from "@real-bot/protocol";
import { RemoteApi } from "./api.ts";
import { disablePush, enablePush, isInboxMessage } from "./push.ts";
import type { StoredEnrollment } from "./idb.ts";
import { base64url, generateIdentity, identityPublic, type RemoteRequest, type RemoteResponse } from "@real-bot/remote";

const keys = generateIdentity();
const pub = identityPublic(keys);
const enrollment: StoredEnrollment = {
  v: 1,
  deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  relayOrigin: "https://relay.example.test",
  relayId: "fixture",
  trustEpoch: 1,
  hostDhPublic: base64url(pub.dh),
  hostSigningPublic: base64url(pub.signing),
  dh: base64url(keys.dh),
  signing: base64url(keys.signing),
  enrollment: base64url(keys.enrollment),
  name: "Fixture",
};

test("notification payload is only pending and click never carries an approval", () => {
  expect(WEB_PUSH_PAYLOAD).toEqual({ t: "pending" });
  expect(Object.keys(WEB_PUSH_PAYLOAD)).toEqual(["t"]);
  expect(WEB_PUSH_COPY.zh).toBe("Real Bot 有待处理事项");
  expect(WEB_PUSH_COPY.en).toBe("Real Bot has pending items");
  expect(isInboxMessage({ type: "inbox" })).toBe(true);
  expect(isInboxMessage({ type: "inbox", resolve: "allow_once" })).toBe(false);
});

test("permission deny never posts an approval resolve", async () => {
  const calls: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      return { v: 1, id: request.id, status: 204, body: null } satisfies RemoteResponse;
    },
  });
  const originalNotification = (globalThis as { Notification?: typeof Notification }).Notification;
  const originalSw = (globalThis as { navigator?: Navigator }).navigator;
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: class {
      static permission = "denied";
      static async requestPermission() { return "denied" as NotificationPermission; }
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null, subscribe: async () => { throw new Error("no"); } } }) },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "PushManager", { configurable: true, value: function PushManager() {} });
  await expect(enablePush(api)).rejects.toThrow(/denied/);
  expect(calls.some((row) => row.path.includes("/approvals/") && row.path.endsWith("/resolve"))).toBe(false);
  expect(calls.some((row) => row.path === "/remote/push/subscribe")).toBe(false);
  await disablePush(api);
  expect(calls.some((row) => row.path === "/remote/push/unsubscribe")).toBe(true);
  expect(calls.some((row) => row.path.includes("/approvals/"))).toBe(false);
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: originalNotification });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalSw });
});

test("RemoteApi subscribe posts endpoint keys and never an approval id", async () => {
  const calls: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      if (request.path === "/remote/push") return { v: 1, id: request.id, status: 200, body: { applicationServerKey: "A".repeat(87), subscribed: false } } satisfies RemoteResponse;
      return { v: 1, id: request.id, status: 204, body: null } satisfies RemoteResponse;
    },
  });
  expect(await api.pushState()).toEqual({ applicationServerKey: "A".repeat(87), subscribed: false });
  await api.subscribePush({
    endpoint: "https://web.push.apple.com/v1/push/isolated",
    p256dh: "B".repeat(87),
    auth: "C".repeat(22),
    expires_at: null,
  });
  await api.unsubscribePush();
  expect(calls.map((row) => row.path)).toEqual(["/remote/push", "/remote/push/subscribe", "/remote/push/unsubscribe"]);
  expect(JSON.stringify(calls)).not.toContain("/approvals/");
});
