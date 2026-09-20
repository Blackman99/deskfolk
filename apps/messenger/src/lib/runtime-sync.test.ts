import { afterEach, expect, test } from "bun:test";
import type { RuntimeSnapshot, SessionSnapshot, SyncFrame } from "@real-bot/protocol";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { emptySnapshot } from "./snapshot.ts";
import { aBot, aDirect, aMessage } from "./test-fixtures.ts";

const instance = "a".repeat(32);
const cursor = { event_instance_id: instance, watermark_seq: 0 };
const originalFetch = globalThis.fetch;
const OriginalSocket = globalThis.WebSocket;
const runtimes: MessengerRuntime[] = [];

class Socket extends EventTarget {
  static current: Socket;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  constructor(_url: string) {
    super(); Socket.current = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(raw: string) {
    expect(JSON.parse(raw).protocol).toBe("sync-v1");
    queueMicrotask(() => this.frame({ type: "ready", ...cursor }));
  }
  frame(frame: SyncFrame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
  close() { this.dispatchEvent(new Event("close")); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function connected(snapshotRead?: () => Promise<RuntimeSnapshot>) {
  const initial: RuntimeSnapshot = { ...emptySnapshot(), ...cursor, bots: [aBot()], sessions: [aDirect()] };
  const requested = deferred<void>();
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("/__local-api") || path === "/__local-api") return Response.json({ port: 17891, token: "fixture" });
    if (path.endsWith("/v1/health")) return Response.json({ ok: true, name: "real-bot" });
    if (path.endsWith("/v1/snapshot")) {
      requested.resolve();
      return Response.json(snapshotRead ? await snapshotRead() : initial);
    }
    return Response.json({ items: [] });
  }) as typeof fetch;
  const runtime = new MessengerRuntime(); runtimes.push(runtime); runtime.start();
  await requested.promise;
  return { runtime, initial };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("runtime did not reach expected state");
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalSocket;
});

test("runtime subscribes before reading snapshot and preserves events arriving during HTTP", async () => {
  const pending = deferred<RuntimeSnapshot>();
  const { runtime, initial } = await connected(() => pending.promise);
  const message = aMessage({ session_id: "direct-1" });
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { ...message, event: "message.upsert", occurred_at: "now" } });
  expect(runtime.connection).toBe("disconnected");
  pending.resolve(initial);
  await until(() => runtime.connection === "connected");
  expect(runtime.snapshot.messages.map((m) => m.id)).toEqual([message.id]);
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 3, payload: { event: "routine.removed", id: "r", occurred_at: "now" } });
  expect(runtime.connection).toBe("disconnected");
});

test("late session detail cannot erase events or changes in other sessions", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  const requested = deferred<void>();
  const pending = deferred<SessionSnapshot>();
  const message = aMessage({ session_id: "direct-1", body: "arrived during read" });
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/snapshot")) { requested.resolve(); return Response.json(await pending.promise); }
    return Response.json({ ...aDirect(), messages: { items: [], next: null }, turns: [] });
  }) as typeof fetch;
  const selected = runtime.selectSession("direct-1");
  await requested.promise;
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { ...message, event: "message.upsert", occurred_at: "now" } });
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 2, payload: { ...aBot({ name: "changed elsewhere" }), event: "bot.upsert", deleted_at: null, occurred_at: "now" } });
  pending.resolve({ ...cursor, session: { ...aDirect(), messages: { items: [], next: null }, turns: [] }, judgements: [] });
  await selected;
  expect(runtime.snapshot.messages.map((m) => m.body)).toEqual([message.body]);
  expect(runtime.snapshot.bots[0]!.name).toBe("changed elsewhere");
  expect(runtime.connection).toBe("connected");
});

test("clear history during a paginated search never resurrects deleted messages", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  const page = deferred<{ items: ReturnType<typeof aMessage>[]; next: null }>();
  const requested = deferred<void>();
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/snapshot")) return Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: "older" }, turns: [] }, judgements: [] });
    if (String(url).includes("/messages")) { requested.resolve(); return Response.json(await page.promise); }
    return Response.json({ ...aDirect(), messages: { items: [], next: null }, turns: [] });
  }) as typeof fetch;
  const selected = runtime.selectSession("direct-1", { messageId: "deleted" });
  await requested.promise;
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { event: "session.cleared", id: "direct-1", occurred_at: "now" } });
  page.resolve({ items: [aMessage({ id: "deleted", session_id: "direct-1" })], next: null });
  await selected;
  expect(runtime.snapshot.messages).toEqual([]);
});

test("stale HTTP mutation response does not overwrite a newer sequenced update", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  globalThis.fetch = (async () => {
    Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { ...aBot({ name: "latest" }), event: "bot.upsert", deleted_at: null, occurred_at: "now" } });
    return Response.json(aBot({ name: "old response" }));
  }) as typeof fetch;
  await runtime.patchBot("bot-1", { name: "old response" });
  expect(runtime.snapshot.bots[0]!.name).toBe("latest");
});
