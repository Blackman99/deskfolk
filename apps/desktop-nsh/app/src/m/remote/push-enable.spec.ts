import { expect, test } from "bun:test";
import { base64url } from "@real-bot/remote";
import { ApiError } from "../api.ts";
import type { PushStateV2 } from "../notifications/types.ts";
import type { RemoteApi } from "./api.ts";
import { enablePush } from "./push.ts";

const key = new Uint8Array(65).fill(4);
const state: PushStateV2 = {
  applicationServerKey: base64url(key), subscribed: false, enabled: false,
  device_revision: 0, push_generation: 1, application_server_key_fingerprint: "fingerprint",
  recovery: "none", current_endpoint_hash: null, last_gone_endpoint_hash: null,
  last_error_code: null, contact_configured: true, push_transport: "policy_v2",
};

async function withBrowser(run: (calls: string[]) => Promise<void>, stale = false) {
  const names = ["window", "navigator", "Notification", "PushManager"] as const;
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const calls: string[] = [];
  const subscription = (bound: Uint8Array) => ({
    expirationTime: null, options: { applicationServerKey: bound },
    toJSON: () => ({ endpoint: "https://web.push.apple.com/test", keys: { p256dh: "key", auth: "auth" } }),
    unsubscribe: async () => { calls.push("unsubscribe"); return true; },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "PushManager", { configurable: true, value: function () {} });
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: {
    permission: "granted", requestPermission: async () => { calls.push("permission"); return "granted"; },
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    serviceWorker: { ready: Promise.resolve({ pushManager: {
      getSubscription: async () => stale ? subscription(new Uint8Array(65).fill(5)) : null,
      subscribe: async () => { calls.push("subscribe"); return subscription(key); },
    } }) },
  } });
  try { await run(calls); } finally {
    names.forEach((name, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

test("v2 subscribe failure preserves its cause and never retries a legacy mutation", async () => {
  await withBrowser(async calls => {
    const failure = new ApiError(409, "revision_conflict", "device revision changed");
    const api = {
      getPushStateV2: async () => state,
      subscribePushV2: async () => { calls.push("v2"); throw failure; },
      pushState: async () => { calls.push("legacy"); return state; },
      subscribePush: async () => { throw new Error("client_upgrade_required"); },
    } as unknown as RemoteApi;
    await expect(enablePush(api)).rejects.toBe(failure);
    expect(calls).toEqual(["permission", "subscribe", "v2"]);
  });
});

test("explicit enable replaces a browser subscription bound to an old host key", async () => {
  await withBrowser(async calls => {
    const api = {
      getPushStateV2: async () => state,
      subscribePushV2: async () => { calls.push("saved"); },
    } as unknown as RemoteApi;
    await enablePush(api);
    expect(calls).toEqual(["permission", "unsubscribe", "subscribe", "saved"]);
  }, true);
});
