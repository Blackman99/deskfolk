import { afterEach, expect, test } from "bun:test";
import type { RuntimeSnapshot, SessionSnapshot, SyncFrame } from "@real-bot/protocol";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { emptySnapshot } from "./snapshot.ts";
import { aBot, aDirect, aMessage, aTurn } from "./test-fixtures.ts";

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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function reconnect(runtime: MessengerRuntime, initial: RuntimeSnapshot, detailRead?: () => Promise<SessionSnapshot>) {
  const old = runtime.client;
  Socket.current.close();
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path === "/__local-api") return Response.json({ port: 17891, token: "fixture" });
    if (path.endsWith("/v1/health")) return Response.json({ ok: true, name: "real-bot" });
    if (path.endsWith("/v1/snapshot")) return Response.json(initial);
    if (path.endsWith("/snapshot") && detailRead) return Response.json(await detailRead());
    return Response.json({ items: [] });
  }) as typeof fetch;
  // Drive the actual discovery/connect path without waiting for the retry timer.
  runtime.start();
  await until(() => runtime.connection === "connected" && runtime.client !== old);
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

for (const lateClear of [false, true]) test(`HTTP detail ahead of WebSocket waits through its watermark (${lateClear ? "clear" : "reaction"})`, async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  const message = aMessage({ session_id: "direct-1", id: lateClear ? "post-clear" : "msg-1", reactions: [{ message_id: "msg-1", actor: "user", emoji: "👍", created_at: "now" }] });
  const response = deferred<void>();
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/snapshot")) {
      response.resolve();
      return Response.json({ ...cursor, watermark_seq: 2, session: { ...aDirect(), messages: { items: [message], next: null }, turns: [] }, judgements: [] });
    }
    return Response.json({ items: [] });
  }) as typeof fetch;
  const selected = runtime.selectSession("direct-1");
  await response.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: lateClear
    ? { event: "session.cleared", id: "direct-1", occurred_at: "now" }
    : { ...message, reactions: [], event: "message.upsert", occurred_at: "now" } });
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 2, payload: { ...aBot({ name: "unrelated update" }), event: "bot.upsert", deleted_at: null, occurred_at: "now" } });
  await selected;
  expect(runtime.snapshot.messages.map((m) => m.id)).toEqual([message.id]);
  expect(runtime.snapshot.messages[0]!.reactions).toHaveLength(1);
  expect(runtime.snapshot.bots[0]!.name).toBe("unrelated update");
  expect(runtime.connection).toBe("connected");
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 3, payload: { ...message, body: "after watermark", event: "message.upsert", occurred_at: "now" } });
  expect(runtime.snapshot.messages[0]!.body).toBe("after watermark");
});

test("reconnect loads detail before an obsolete request finishes", async () => {
  const { runtime, initial } = await connected();
  await until(() => runtime.connection === "connected");
  const old = deferred<SessionSnapshot>();
  const requested = deferred<void>();
  globalThis.fetch = (async () => { requested.resolve(); return Response.json(await old.promise); }) as typeof fetch;
  const selection = runtime.selectSession("direct-1");
  await requested.promise;
  const replacement = aMessage({ id: "replacement", session_id: "direct-1" });
  await reconnect(runtime, initial, async () => ({ ...cursor, session: { ...aDirect(), messages: { items: [replacement], next: null }, turns: [] }, judgements: [] }));
  await until(() => runtime.snapshot.messages.some((m) => m.id === replacement.id));
  old.resolve({ ...cursor, session: { ...aDirect(), messages: { items: [aMessage()], next: null }, turns: [] }, judgements: [] });
  await selection;
  expect(runtime.snapshot.messages.map((m) => m.id)).toEqual([replacement.id]);
});

test("old mutation success after disconnect cannot revert stream state", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  const pending = deferred<Response>();
  globalThis.fetch = (() => pending.promise) as typeof fetch;
  const mutation = runtime.patchBot("bot-1", { name: "old" });
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { ...aBot({ name: "newest" }), event: "bot.upsert", deleted_at: null, occurred_at: "now" } });
  Socket.current.close();
  pending.resolve(Response.json(aBot({ name: "old" })));
  await mutation;
  expect(runtime.snapshot.bots[0]!.name).toBe("newest");
});

test("old mutation failure after reconnect cannot disconnect the replacement", async () => {
  const { runtime, initial } = await connected();
  await until(() => runtime.connection === "connected");
  const pending = deferred<Response>();
  globalThis.fetch = (() => pending.promise) as typeof fetch;
  const mutation = runtime.patchBot("bot-1", { name: "old" });
  await reconnect(runtime, initial);
  const replacement = runtime.client;
  pending.reject(new Error("old transport failed"));
  await mutation;
  expect(runtime.connection).toBe("connected");
  expect(runtime.client).toBe(replacement);
});

for (const operation of ["create", "settings", "clear", "continue", "send"] as const) test(`obsolete ${operation} success leaves replacement UI state untouched`, async () => {
  const { runtime, initial } = await connected();
  await until(() => runtime.connection === "connected");
  runtime.selectedId = "direct-1";
  runtime.draft = "original draft";
  const pending = deferred<Response>();
  globalThis.fetch = (() => pending.promise) as typeof fetch;
  const mutation = operation === "create" ? runtime.createBot({ name: "old", duties: "fixture", boundaries: "fixture" })
    : operation === "settings" ? runtime.patchSettings({ endpoint_api_key: "old" })
    : operation === "clear" ? runtime.clearSessionHistory("direct-1")
    : operation === "continue" ? runtime.continueInterrupt("message-1") : runtime.send();
  await reconnect(runtime, initial, async () => ({ ...cursor, session: { ...aDirect(), messages: { items: [], next: null }, turns: [] }, judgements: [] }));
  runtime.draft = "replacement draft";
  runtime.endpointKey = "replacement key";
  runtime.focusedTurnId = "replacement turn";
  runtime.highlightedMessageId = "replacement highlight";
  runtime.settingsOpen = true;
  runtime.busy = true;
  const replacement = runtime.client;
  const body = operation === "create" ? { bot: aBot(), direct_session: { ...aDirect(), id: "old-created" } }
    : operation === "continue" ? aTurn({ id: "old-turn" })
    : operation === "send" ? aMessage() : initial.settings;
  pending.resolve(Response.json(body));
  await mutation;
  expect(runtime.client).toBe(replacement);
  expect(runtime.connection).toBe("connected");
  expect(runtime.selectedId).toBe("direct-1");
  expect(runtime.draft).toBe("replacement draft");
  expect(runtime.endpointKey).toBe("replacement key");
  expect(runtime.focusedTurnId).toBe("replacement turn");
  expect(runtime.highlightedMessageId).toBe("replacement highlight");
  expect(runtime.settingsOpen).toBe(true);
  expect(runtime.busy).toBe(true);
});

for (const operation of ["settings", "stop", "continue", "approval", "ask", "send"] as const) test(`obsolete ${operation} failure does not disconnect or unlock replacement work`, async () => {
  const { runtime, initial } = await connected();
  await until(() => runtime.connection === "connected");
  runtime.selectedId = "direct-1";
  runtime.draft = "original draft";
  runtime.snapshot.turns = [aTurn({ session_id: "direct-1", status: "running" })];
  const pending = deferred<Response>();
  globalThis.fetch = (() => pending.promise) as typeof fetch;
  const mutation = operation === "settings" ? runtime.patchSettings({ theme: "dark" })
    : operation === "stop" ? runtime.stopTurn()
    : operation === "continue" ? runtime.continueInterrupt("message-1")
    : operation === "approval" ? runtime.resolveApproval("approval-1", "allow_once")
    : operation === "ask" ? runtime.sendAsk("ask-1", "answer") : runtime.send();
  await reconnect(runtime, initial, async () => ({ ...cursor, session: { ...aDirect(), messages: { items: [], next: null }, turns: [] }, judgements: [] }));
  const replacement = runtime.client;
  runtime.busy = true;
  pending.reject(new Error("obsolete transport"));
  await mutation;
  expect(runtime.connection).toBe("connected");
  expect(runtime.client).toBe(replacement);
  expect(runtime.busy).toBe(true);
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
