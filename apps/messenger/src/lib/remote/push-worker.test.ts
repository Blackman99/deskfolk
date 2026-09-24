import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const staticDir = new URL("../../../static/", import.meta.url);

type ShownNotification = { title: string; options: NotificationOptions };
type WindowClient = { url: string; focused?: boolean; focus(): Promise<void>; postMessage(data: unknown): void };

function worker(clients: WindowClient[] = []) {
  const handlers = new Map<string, (event: any) => void>();
  const shown: ShownNotification[] = [];
  const opened: string[] = [];
  const context: Record<string, unknown> = {
    URL,
    importScripts: () => {},
    self: {
      location: { origin: "https://push.test" },
      registration: {
        scope: "https://push.test/",
        showNotification: async (title: string, options: NotificationOptions) => { shown.push({ title, options }); },
      },
      clients: { matchAll: async () => clients, openWindow: async (url: string) => { opened.push(url); } },
      addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    },
  };
  runInNewContext(readFileSync(new URL("sw.js", staticDir), "utf8"), context);
  return {
    shown, opened,
    async dispatch(name: string, event: object) {
      const waiting: Promise<unknown>[] = [];
      handlers.get(name)!({ ...event, waitUntil: (promise: Promise<unknown>) => waiting.push(promise) });
      await Promise.all(waiting);
    },
  };
}

function pngSize(path: string) {
  const bytes = readFileSync(new URL(path.replace(/^\//, ""), staticDir));
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("a pending push supplies the PWA icon and a dedicated notification badge", async () => {
  const w = worker();
  await w.dispatch("push", { data: { json: () => ({ t: "pending" }) } });
  expect(w.shown).toHaveLength(1);
  const { title, options } = w.shown[0]!;
  expect(title).toBe("Deskfolk 有待处理事项");
  expect(options).toMatchObject({ icon: "/icon-192.png", badge: "/notification-badge.png", tag: "real-bot-pending", data: { t: "pending" } });
  expect(pngSize(options.icon!)).toEqual([192, 192]);
  expect(pngSize(options.badge!)).toEqual([96, 96]);
  const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", staticDir), "utf8"));
  expect(manifest.icons.some((icon: { src: string }) => `/${icon.src}` === options.icon)).toBe(true);
});

test("malformed push payloads cannot override notification assets or show content", async () => {
  const w = worker();
  for (const value of [null, {}, { t: "other" }, { t: "pending", icon: "https://outside.test/track" }, { t: "pending", body: "private" }]) {
    await w.dispatch("push", { data: { json: () => value } });
  }
  await w.dispatch("push", { data: { json: () => { throw new Error("invalid json"); } } });
  expect(w.shown).toEqual([]);
});

test("clicking the branded notification focuses an in-scope client and opens the inbox", async () => {
  const calls: unknown[] = [];
  const w = worker([
    { url: "https://outside.test/", focused: true, focus: async () => { calls.push("outside"); }, postMessage: () => {} },
    { url: "https://push.test/?s=fixture", focused: true, focus: async () => { calls.push("focus"); }, postMessage: (data) => { calls.push(data); } },
  ]);
  await w.dispatch("notificationclick", { notification: { close: () => calls.push("close") } });
  expect(calls).toEqual(["close", "focus", { type: "inbox" }]);
  expect(w.opened).toEqual([]);
});

test("clicking a notification with no open app opens the chat list", async () => {
  const w = worker();
  await w.dispatch("notificationclick", { notification: { close: () => {} } });
  expect(w.opened).toEqual(["/"]);
});
