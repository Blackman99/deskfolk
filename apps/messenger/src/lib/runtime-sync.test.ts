import { afterEach, expect, test } from "bun:test";
import type { RuntimeSnapshot, SessionSnapshot, SyncFrame } from "@real-bot/protocol";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { LocalApi } from "./api.ts";
import { emptySnapshot } from "./snapshot.ts";
import { aBot, aDirect, aMessage, aTurn } from "./test-fixtures.ts";

const instance = "a".repeat(32);
const cursor = { event_instance_id: instance, watermark_seq: 0 };
const originalFetch = globalThis.fetch;
const OriginalSocket = globalThis.WebSocket;
const runtimes: MessengerRuntime[] = [];
const fixtureCloses: Array<() => Promise<void>> = [];

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

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalSocket;
  while (fixtureCloses.length) await fixtureCloses.pop()!();
});

async function credentialFixture() {
  // Load the actual daemon at runtime across the packages' different TS library targets.
  const { Store } = await import(new URL("../../../daemon/src/store/index.ts", import.meta.url).href);
  const { createLocalApi } = await import(new URL("../../../daemon/src/local-api.ts", import.meta.url).href);
  let locked = false;
  const keys = new Map<string, string>();
  const store = new Store({ endpointKey: {
    async get(name: string) { return keys.get(name) ?? null; },
    async set(value: string, name: string) { if (locked) throw new Error("locked"); keys.set(name, value); },
    async delete(name: string) { if (locked) throw new Error("locked"); keys.delete(name); },
  } });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const frames: SyncFrame[] = [];
  let socket: FixtureSocket;
  class FixtureSocket extends EventTarget {
    data = { authed: false };
    constructor(_url: string) {
      super(); socket = this;
      api.websocket.open(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(raw: string) {
      const value = JSON.parse(raw);
      if (value.type === "auth") api.websocket.message(this, raw);
      else if (value.type === "ready") queueMicrotask(() => this.deliver(value));
      else frames.push(value);
      return raw.length;
    }
    deliver(frame: SyncFrame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
    close() { api.websocket.close(this); this.dispatchEvent(new Event("close")); }
  }
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  const requests: Array<{ id: string | null; method: string; path: string }> = [];
  let hold: ((response: Response) => Promise<Response>) | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/__local-api") return Response.json({ port: 17901, token: "fixture" });
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push({ id: request.headers.get("X-Request-Id"), method: request.method, path });
    const response = await api.fetch(request, {});
    return hold && path === "/v1/providers" && request.method === "POST" ? hold(response) : response;
  }) as typeof fetch;
  const runtime = new MessengerRuntime(); runtimes.push(runtime); runtime.start();
  await until(() => runtime.connection === "connected");
  let seq = 0;
  const snapshot = await runtime.client!.snapshot();
  seq = snapshot.watermark_seq;
  function drain() {
    const batch = frames.splice(0);
    for (const frame of batch) {
      expect(frame.type).toBe("event");
      if (frame.type !== "event") throw new Error("unexpected fixture reset");
      expect(frame.seq).toBe(++seq);
      expect(frame.event_instance_id).toBe(snapshot.event_instance_id);
      socket!.deliver(frame);
    }
    expect(runtime.connection).toBe("connected");
    return batch;
  }
  fixtureCloses.push(async () => { await api.engine.close(); store.close(); });
  return { runtime, store, requests, drain, frames,
    second: new LocalApi({ origin: "http://127.0.0.1:17901", token: "fixture" }),
    lock(value: boolean) { locked = value; },
    holdResponse(value: typeof hold) { hold = value; },
  };
}

const credentialBody = (name: string) => ({ name, base_url: "https://fixture.invalid", api_key: "memory-only" });

test("review: HTTP503 ahead of contiguous old empty lists retains the original create ID", async () => {
  const h = await credentialFixture();
  await h.runtime.createProvider(credentialBody("A"));
  h.lock(true);
  await h.runtime.createProvider(credentialBody("B"));
  const id = h.runtime.pendingMutation!.id;
  const frames = h.drain();
  expect(frames.filter((f) => f.type === "event" && f.payload.event === "credential_operations.changed").length).toBe(3);
  expect(h.runtime.snapshot.credentialOperations).toHaveLength(1);
  expect(h.runtime.pendingMutation!.id).toBe(id);
  expect(h.runtime.client!.pendingRequests().map((r) => r.id)).toEqual([id]);
  h.lock(false);
  await h.runtime.createProvider(credentialBody("B"));
  h.drain();
  expect(h.requests.filter((r) => r.method === "POST" && r.path === "/v1/providers").map((r) => r.id).slice(-2)).toEqual([id, id]);
  expect(h.store.providersCached().filter((p: { name: string }) => p.name === "B")).toHaveLength(1);
  expect(h.store.receipts.lookup({ deviceId: "local", requestId: id }).state).toBe("complete");
  expect(h.runtime.pendingMutation).toBeNull();
});

for (const result of ["503", "lost"] as const) test(`review: terminal stream prefix before delayed ${result} cannot resurrect pending`, async () => {
  const h = await credentialFixture();
  h.lock(true);
  const entered = deferred<void>(); const release = deferred<void>();
  h.holdResponse(async (response) => { entered.resolve(); await release.promise; if (result === "lost") throw new Error("lost response"); return response; });
  const work = h.runtime.createProvider(credentialBody("held"));
  await entered.promise;
  h.drain();
  const operation = h.store.listCredentialOperations()[0];
  h.lock(false);
  await h.second.resolveCredential(operation.id, "cancel");
  h.drain();
  expect(h.store.receipts.lookup({ deviceId: "local", requestId: operation.request_id }).status).toBe(409);
  release.resolve(); await work;
  expect(h.runtime.pendingMutation).toBeNull();
  expect(h.runtime.client!.pendingRequests()).toEqual([]);
  expect(h.runtime.snapshot.credentialOperations).toEqual([]);
});

for (const action of ["repair", "cancel"] as const) test(`review: local changed-payload409 retains provenance until second-client ${action}`, async () => {
  const h = await credentialFixture();
  h.lock(true);
  await h.runtime.createProvider(credentialBody("original"));
  h.drain();
  const original = h.runtime.pendingMutation!.id;
  const sent = h.requests.length;
  expect((await h.runtime.createProvider(credentialBody("edited")))?.code).toBe("request_pending");
  expect(h.requests).toHaveLength(sent);
  expect(h.runtime.pendingMutation).toEqual({ id: original, code: "request_pending" });
  const operation = h.store.listCredentialOperations()[0];
  h.lock(false);
  await h.second.resolveCredential(operation.id, action, "replacement");
  h.drain();
  expect(h.runtime.pendingMutation).toBeNull();
  expect(h.runtime.client!.pendingRequests()).toEqual([]);
  expect(await h.runtime.createProvider(credentialBody("edited"))).toBeNull();
  h.drain();
  expect(h.store.providersCached().filter((p: { name: string }) => p.name === "edited")).toHaveLength(1);
});

test("review: an unknown HTTP outcome survives unrelated empty prefixes and successful mutations", async () => {
  const h = await credentialFixture();
  await h.runtime.createProvider(credentialBody("older"));
  h.lock(true);
  h.holdResponse(async () => { throw new Error("lost pending response"); });
  await h.runtime.createProvider(credentialBody("unknown"));
  const id = h.runtime.pendingMutation!.id;
  expect(h.runtime.pendingMutation!.code).toBe("request_unknown");
  const before = h.requests.filter((r) => r.path === "/v1/providers" && r.method === "POST").length;
  await h.runtime.patchSettings({ theme: "dark" });
  h.drain();
  expect(h.runtime.pendingMutation!.id).toBe(id);
  expect(h.runtime.client!.pendingRequests().map((r) => r.id)).toEqual([id]);
  expect(h.requests.filter((r) => r.path === "/v1/providers" && r.method === "POST")).toHaveLength(before);
  h.holdResponse(null); h.lock(false);
  await h.runtime.retryPendingMutation(); h.drain();
  expect(h.runtime.pendingMutation).toBeNull();
  expect(h.store.providersCached().filter((p: { name: string }) => p.name === "unknown")).toHaveLength(1);
});

test("review: explicit terminal retry clears runtime and payload before its queued stream arrives", async () => {
  const h = await credentialFixture();
  h.lock(true);
  await h.runtime.createProvider(credentialBody("terminal"));
  h.drain();
  const operation = h.store.listCredentialOperations()[0];
  h.lock(false);
  await h.second.resolveCredential(operation.id, "cancel");
  await h.runtime.retryPendingMutation();
  expect(h.runtime.pendingMutation).toBeNull();
  expect(h.runtime.client!.pendingRequests()).toEqual([]);
  h.drain();
  expect(h.runtime.pendingMutation).toBeNull();
});

for (const action of ["retry", "repair", "cancel"] as const) for (const failed of [false, true]) {
  test(`integration: obsolete credential ${action} ${failed ? "failure" : "success"} cannot change replacement state`, async () => {
    const { runtime, initial } = await connected();
    await until(() => runtime.connection === "connected");
    const api = runtime.client!;
    const held = deferred<void>(); const entered = deferred<void>();
    const wait = async () => { entered.resolve(); await held.promise; };
    api.retryPending = wait;
    api.resolveCredential = wait;
    runtime.pendingMutation = { id: "original", code: "key_write_pending" };
    const work = action === "retry" ? runtime.retryPendingMutation() : runtime.resolveCredentialOperation("operation", action, "fake");
    await entered.promise;
    await reconnect(runtime, initial);
    runtime.pendingMutation = { id: "replacement", code: "request_unknown" };
    runtime.settingsOpen = true;
    if (failed) held.reject(new Error("old failure")); else held.resolve();
    await work;
    expect(runtime.connection).toBe("connected");
    expect(runtime.pendingMutation).toEqual({ id: "replacement", code: "request_unknown" });
    expect(runtime.settingsOpen).toBe(true);
  });
}

test("integration: second-client credential events clear confirmed pending memory without HTTP state backfill", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  const api = runtime.client!;
  const reads: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    reads.push(String(url));
    return Response.json({ error: { code: "key_write_pending", message: "fixture locked" } }, { status: 503 });
  }) as typeof fetch;
  const error = await runtime.createProvider({ name: "pending", base_url: "https://fixture.invalid", api_key: "fake" });
  expect(error?.code).toBe("key_write_pending");
  const id = runtime.pendingMutation!.id;
  const operation = { id: "op", entity_id: "provider", kind: "provider", request_id: id, can_repair: true };
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { event: "credential_operations.changed", occurred_at: "now", items: [operation] } });
  expect(runtime.snapshot.credentialOperations).toEqual([operation]);
  expect(api.pendingRequests()).toHaveLength(1);
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 2, payload: { event: "credential_operations.changed", occurred_at: "now", items: [] } });
  expect(runtime.snapshot.credentialOperations).toEqual([]);
  expect(api.pendingRequests()).toEqual([]);
  expect(runtime.pendingMutation).toBeNull();
  expect(reads).toHaveLength(1);
  globalThis.fetch = (async () => { throw new Error("unknown result"); }) as typeof fetch;
  await runtime.createProvider({ name: "unknown", base_url: "https://fixture.invalid", api_key: "fake" });
  const unknown = runtime.pendingMutation!.id;
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 3, payload: { event: "credential_operations.changed", occurred_at: "now", items: [] } });
  expect(runtime.pendingMutation).toEqual({ id: unknown, code: "request_unknown" });
  expect(api.pendingRequests()).toHaveLength(1);
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

for (const sameSession of [false, true]) test(`obsolete pagination cannot highlight or mark read on a replacement connection (${sameSession ? "same-session search" : "normal selection"})`, async () => {
  const { runtime, initial } = await connected();
  await until(() => runtime.connection === "connected");
  if (sameSession) {
    globalThis.fetch = (async () => Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: "older" }, turns: [] }, judgements: [] })) as typeof fetch;
    await runtime.selectSession("direct-1");
  }
  const older = deferred<Response>();
  const requested = deferred<void>();
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/snapshot")) return Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: "older" }, turns: [] }, judgements: [] });
    if (String(url).includes("/messages")) { requested.resolve(); return older.promise; }
    return Response.json({ items: [] });
  }) as typeof fetch;
  const obsolete = runtime.selectSession("direct-1", { messageId: "obsolete-hit" });
  await requested.promise;
  const nextSession = aDirect({ id: "direct-2" });
  await reconnect(runtime, { ...initial, sessions: [...initial.sessions, nextSession] }, async () => ({ ...cursor, session: { ...aDirect(), messages: { items: [], next: null }, turns: [] }, judgements: [] }));
  const reads: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/read")) reads.push(String(url));
    return Response.json({ ...cursor, session: { ...nextSession, messages: { items: [], next: null }, turns: [] }, judgements: [] });
  }) as typeof fetch;
  await runtime.selectSession("direct-2");
  runtime.setHighlightedMessage("replacement-hit");
  const readCount = reads.length;
  expect(reads.some((path) => path.endsWith("/direct-2/read"))).toBe(true);
  older.resolve(Response.json({ items: [aMessage({ id: "obsolete-hit", session_id: "direct-1" })], next: null }));
  await obsolete;
  expect(runtime.selectedId).toBe("direct-2");
  expect(runtime.highlightedMessageId).toBe("replacement-hit");
  expect(reads).toHaveLength(readCount);
  expect(runtime.snapshot.messages.some((message) => message.id === "obsolete-hit")).toBe(false);
});

for (const sameSession of [false, true]) test(`clear during pagination cancels highlight and read (${sameSession ? "same-session search" : "normal selection"})`, async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  if (sameSession) {
    globalThis.fetch = (async () => Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: "older" }, turns: [] }, judgements: [] })) as typeof fetch;
    await runtime.selectSession("direct-1");
  }
  const older = deferred<Response>();
  const requested = deferred<void>();
  let reads = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/snapshot")) return Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: "older" }, turns: [] }, judgements: [] });
    if (String(url).includes("/messages")) { requested.resolve(); return older.promise; }
    if (init?.method === "POST" && String(url).endsWith("/read")) reads++;
    return Response.json({ items: [] });
  }) as typeof fetch;
  const obsolete = runtime.selectSession("direct-1", { messageId: "obsolete-hit" });
  await requested.promise;
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { event: "session.cleared", id: "direct-1", occurred_at: "now" } });
  older.resolve(Response.json({ items: [aMessage({ id: "obsolete-hit", session_id: "direct-1" })], next: null }));
  await obsolete;
  expect(runtime.highlightedMessageId).toBeNull();
  expect(runtime.snapshot.messages).toEqual([]);
  expect(reads).toBe(0);
});

for (const searches of [1, 3]) for (const paginated of [false, true]) test(`search during initial detail loads history before highlighting (${searches} searches, ${paginated ? "older page" : "detail hit"})`, async () => {
  const latest = aMessage({ id: "latest", session_id: "direct-1", body: "latest message" });
  const hits = Array.from({ length: searches }, (_, i) => aMessage({ id: `older-${i}`, session_id: "direct-1", body: `older message ${i}` }));
  const { runtime } = await connected(async () => ({ ...emptySnapshot(), ...cursor, bots: [aBot()], sessions: [aDirect({ last_message: latest })] }));
  await until(() => runtime.connection === "connected");
  const requested = deferred<void>();
  const held = deferred<SessionSnapshot>();
  let details = 0;
  const pages: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/snapshot")) {
      details++;
      if (details === 1) { requested.resolve(); return Response.json(await held.promise); }
      return Response.json({ ...cursor, session: { ...aDirect(), messages: { items: paginated ? [latest] : [latest, ...hits], next: paginated ? "older-cursor" : null }, turns: [] }, judgements: [] });
    }
    if (String(url).includes("/messages")) {
      pages.push(new URL(String(url)).searchParams.get("cursor")!);
      return Response.json({ items: hits, next: null });
    }
    return Response.json({ items: [] });
  }) as typeof fetch;
  const initial = runtime.selectSession("direct-1");
  await requested.promise;
  const jumps = hits.map((hit) => runtime.selectSession("direct-1", { messageId: hit.id }));
  expect(runtime.snapshot.messages.map((message) => message.id)).toEqual([latest.id]);
  held.resolve({ ...cursor, session: { ...aDirect(), messages: { items: [latest, ...hits], next: null }, turns: [] }, judgements: [] });
  await Promise.all([initial, ...jumps]);
  expect(runtime.connection).toBe("connected");
  expect(runtime.snapshot.messages.map((message) => message.id).sort()).toEqual([latest.id, ...hits.map((hit) => hit.id)].sort());
  expect(runtime.highlightedMessageId).toBe(hits.at(-1)!.id);
  expect(runtime.snapshot.messages.some((message) => message.id === runtime.highlightedMessageId)).toBe(true);
  expect(pages).toEqual(paginated ? ["older-cursor"] : []);
});

test("search superseding a pending replacement detail still loads the latest hit", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  const first = deferred<SessionSnapshot>();
  const second = deferred<SessionSnapshot>();
  const firstRequested = deferred<void>();
  const secondRequested = deferred<void>();
  const finalHit = aMessage({ id: "final-hit", session_id: "direct-1" });
  const detail: SessionSnapshot = { ...cursor, session: { ...aDirect(), messages: { items: [finalHit], next: null }, turns: [] }, judgements: [] };
  let calls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/snapshot")) {
      calls++;
      if (calls === 1) { firstRequested.resolve(); return Response.json(await first.promise); }
      if (calls === 2) { secondRequested.resolve(); return Response.json(await second.promise); }
      return Response.json(detail);
    }
    return Response.json({ items: [] });
  }) as typeof fetch;
  const initial = runtime.selectSession("direct-1");
  await firstRequested.promise;
  const older = runtime.selectSession("direct-1", { messageId: "superseded-hit" });
  first.resolve(detail);
  await secondRequested.promise;
  const final = runtime.selectSession("direct-1", { messageId: finalHit.id });
  second.resolve(detail);
  await Promise.all([initial, older, final]);
  expect(runtime.snapshot.messages.map((message) => message.id)).toEqual([finalHit.id]);
  expect(runtime.highlightedMessageId).toBe(finalHit.id);
  expect(calls).toBe(3);
});

test("queued searches during initial detail cannot affect replacement connection", async () => {
  const { runtime, initial } = await connected();
  await until(() => runtime.connection === "connected");
  const held = deferred<SessionSnapshot>();
  const requested = deferred<void>();
  globalThis.fetch = (async () => { requested.resolve(); return Response.json(await held.promise); }) as typeof fetch;
  const loading = runtime.selectSession("direct-1");
  await requested.promise;
  const searches = ["old-a", "old-b"].map((messageId) => runtime.selectSession("direct-1", { messageId }));
  const replacement = aMessage({ id: "replacement", session_id: "direct-1" });
  await reconnect(runtime, initial, async () => ({ ...cursor, session: { ...aDirect(), messages: { items: [replacement], next: null }, turns: [] }, judgements: [] }));
  await until(() => runtime.snapshot.messages.some((message) => message.id === replacement.id));
  runtime.setHighlightedMessage(replacement.id);
  const api = runtime.client;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => { calls.push(String(url)); return Response.json({ items: [] }); }) as typeof fetch;
  held.resolve({ ...cursor, session: { ...aDirect(), messages: { items: [aMessage({ id: "old-a", session_id: "direct-1" })], next: null }, turns: [] }, judgements: [] });
  await Promise.all([loading, ...searches]);
  expect(runtime.client).toBe(api);
  expect(runtime.snapshot.messages.map((message) => message.id)).toEqual([replacement.id]);
  expect(runtime.highlightedMessageId).toBe(replacement.id);
  expect(calls).toEqual([]);
});

test("a newer same-session search supersedes an older pending page", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  globalThis.fetch = (async () => Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: "older" }, turns: [] }, judgements: [] })) as typeof fetch;
  await runtime.selectSession("direct-1");
  const older = deferred<Response>();
  const requested = deferred<void>();
  globalThis.fetch = (async () => { requested.resolve(); return older.promise; }) as typeof fetch;
  const obsolete = runtime.selectSession("direct-1", { messageId: "obsolete-hit" });
  await requested.promise;
  runtime.snapshot.messages = [aMessage({ id: "replacement-hit", session_id: "direct-1" })];
  await runtime.selectSession("direct-1", { messageId: "replacement-hit" });
  older.resolve(Response.json({ items: [aMessage({ id: "obsolete-hit", session_id: "direct-1" })], next: null }));
  await obsolete;
  expect(runtime.highlightedMessageId).toBe("replacement-hit");
  expect(runtime.snapshot.messages.map((message) => message.id)).toEqual(["replacement-hit"]);
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
