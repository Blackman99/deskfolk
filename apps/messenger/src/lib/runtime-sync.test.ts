import { afterEach, expect, test } from "bun:test";
import type {
  RuntimeSnapshot,
  SessionSnapshot,
  SyncFrame,
} from "@real-bot/protocol";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { LocalApi } from "./local-api.ts";
import { emptySnapshot } from "./snapshot.ts";
import { aBot, aDirect, aMessage, aRoutine, aTurn } from "./test-fixtures.ts";
import { flushSync } from "svelte";
import RoutineCard from "./panels/RoutineCard.svelte";
import { copyFor } from "./copy.ts";
import { buttonByText, click, fill, render } from "./test-render.ts";

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

async function credentialFixture(heldPath = "/v1/providers") {
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
  api.engine.fireRoutine = () => null;
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
  const requests: Array<{ id: string | null; method: string; path: string; body: string }> = [];
  let hold: ((response: Response) => Promise<Response>) | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/__local-api") return Response.json({ port: 17901, token: "fixture" });
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push({ id: request.headers.get("X-Request-Id"), method: request.method, path, body: await request.clone().text() });
    const response = await api.fetch(request, {});
    return hold && path.startsWith(heldPath) && ["POST", "PATCH", "DELETE"].includes(request.method) ? hold(response) : response;
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

for (const streamed of [false, true]) test(`mounted routine pending create preserves edited draft and retries exact receipt (${streamed ? 'event first' : 'HTTP first'})`, async () => {
  const h = await credentialFixture('/v1/routines');
  const { bot } = h.store.createBot({ name: 'Routine owner', duties: '', boundaries: '' });
  h.drain();
  const t = copyFor('en');
  const { host, close } = render(RoutineCard, { runtime: h.runtime, bot, t });
  const submit = () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); flushSync(); };
  try {
    h.holdResponse(async () => { throw new Error('committed response lost'); });
    click(buttonByText(host, t.routines.add));
    fill(host.querySelector('#routine-title'), 'Original'); submit();
    await until(() => h.runtime.pendingMutation?.code === 'request_unknown'); flushSync();
    expect(host.textContent).toContain(t.routines.unknown);
    expect(host.textContent).not.toContain(t.routines.conflict);
    expect(host.textContent).toContain(t.routines.retryHint);
    expect(h.store.listRoutines()).toHaveLength(1);
    expect(h.runtime.snapshot.routines).toHaveLength(0);
    if (streamed) { h.drain(); flushSync(); }
    fill(host.querySelector('#routine-title'), 'Edited'); submit();
    await until(() => h.runtime.pendingMutation?.code === 'request_pending'); flushSync();
    expect(host.textContent).toContain(t.routines.pending);
    expect(host.textContent).not.toContain(t.routines.conflict);
    expect(host.textContent).not.toContain(t.routines.reload);
    const requests = () => h.requests.filter((r) => r.path === '/v1/routines' && r.method === 'POST');
    expect(requests()).toHaveLength(1);
    const entered = deferred<void>(); const release = deferred<void>();
    h.holdResponse(async (response) => { entered.resolve(); await release.promise; return response; });
    click(buttonByText(host, t.routines.retry));
    await entered.promise; flushSync();
    expect(buttonByText(host, t.routines.retry).disabled).toBe(true);
    click(buttonByText(host, t.routines.retry));
    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toEqual(requests()[0]);
    release.resolve();
    await until(() => h.runtime.pendingMutation === null); await new Promise((r) => setTimeout(r, 0)); flushSync();
    expect(h.store.listRoutines()).toHaveLength(1);
    expect(h.store.listRoutines()[0].title).toBe('Original');
    expect((host.querySelector('#routine-title') as HTMLInputElement).value).toBe('Edited');
    expect(host.textContent).toContain(t.routines.retired);
    expect(host.textContent).not.toContain(t.routines.pending);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === t.routines.retry)).toBe(false);
    expect(buttonByText(host, t.routines.save).disabled).toBe(true);
    submit(); expect(requests()).toHaveLength(2);
    expect(h.runtime.snapshot.routines).toHaveLength(streamed ? 1 : 0);
    h.drain(); flushSync();
    click(host.querySelector('.routine-open'));
    expect((host.querySelector('#routine-title') as HTMLInputElement).value).toBe('Original');
    expect(buttonByText(host, t.routines.save).disabled).toBe(false);
  } finally { close(); }
});

test('mounted routine retry preserves a terminal revision409 and still offers streamed load-latest recovery', async () => {
  const h = await credentialFixture('/v1/routines');
  const { bot } = h.store.createBot({ name: 'Routine owner', duties: '', boundaries: '' });
  const row = h.store.createRoutine({ bot_id: bot.id, title: 'Original', instruction: '', enabled: false, schedule: { kind: 'daily', time: '09:00' } });
  h.drain();
  const t = copyFor('en');
  const { host, close } = render(RoutineCard, { runtime: h.runtime, bot, t });
  try {
    click(host.querySelector('.routine-open'));
    fill(host.querySelector('#routine-title'), 'My draft');
    h.store.patchRoutine(row.id, { title: 'Other client', if_revision: row.updated_at });
    h.holdResponse(async (response) => { expect(response.status).toBe(409); throw new Error('lost conflict response'); });
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); flushSync();
    await until(() => h.runtime.pendingMutation?.code === 'request_unknown'); flushSync();
    h.holdResponse(null);
    click(buttonByText(host, t.routines.retry));
    await until(() => h.runtime.pendingMutation === null); await new Promise((r) => setTimeout(r, 0)); flushSync();
    expect(host.textContent).toContain(t.routines.conflict);
    expect(host.textContent).not.toContain(t.routines.unknown);
    expect((host.querySelector('#routine-title') as HTMLInputElement).value).toBe('My draft');
    expect(buttonByText(host, t.routines.save).disabled).toBe(true);
    h.drain(); flushSync();
    click(buttonByText(host, t.routines.reload));
    expect((host.querySelector('#routine-title') as HTMLInputElement).value).toBe('Other client');
    expect(buttonByText(host, t.routines.save).disabled).toBe(false);
    expect(h.store.listRoutines()).toHaveLength(1);
    const writes = h.requests.filter((r) => r.method === 'PATCH');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  } finally { close(); }
});

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

for (const operation of ['create', 'patch', 'delete'] as const) test(`routine ${operation} retains unknown request for explicit retry without HTTP row ingestion`, async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === 'connected');
  const api = runtime.client!;
  const row = aRoutine();
  const calls: Array<{ id: string | null; body: unknown }> = [];
  let lost = true;
  globalThis.fetch = (async (_url, init) => {
    calls.push({ id: new Headers(init!.headers).get('X-Request-Id'), body: JSON.parse(init!.body as string) });
    if (lost) throw new Error('lost response');
    return operation === 'delete' ? new Response(null, { status: 204 }) : Response.json(row);
  }) as typeof fetch;
  const write = () => operation === 'create'
    ? runtime.createRoutine({ bot_id: row.bot_id, title: row.title, instruction: '', schedule: row.schedule })
    : operation === 'patch' ? runtime.patchRoutine(row.id, { title: 'Updated', if_revision: row.updated_at })
    : runtime.deleteRoutine(row.id, row.updated_at);
  expect((await write())?.code).toBe('request_unknown');
  expect(runtime.client).toBe(api);
  expect(runtime.connection).toBe('connected');
  expect(runtime.pendingMutation).toEqual({ id: calls[0]!.id!, code: 'request_unknown' });
  expect(api.pendingRequests()).toHaveLength(1);
  Socket.current.frame({ type: 'event', event_instance_id: instance, seq: 1, payload: { event: 'credential_operations.changed', occurred_at: 'now', items: [] } });
  expect(api.pendingRequests()).toHaveLength(1);
  if (operation !== 'delete') {
    const changed = operation === 'create'
      ? await runtime.createRoutine({ bot_id: row.bot_id, title: 'Changed', instruction: '', schedule: row.schedule })
      : await runtime.patchRoutine(row.id, { title: 'Changed', if_revision: row.updated_at });
    expect(changed?.code).toBe('request_pending');
    expect(calls).toHaveLength(1);
  }
  lost = false;
  expect(await write()).toBeNull();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(api.pendingRequests()).toEqual([]);
  expect(runtime.pendingMutation).toBeNull();
  expect(runtime.snapshot.routines).toEqual([]);
});

test("routine writes use revision bodies and only events or reconnect snapshots change state", async () => {
  const { runtime, initial } = await connected();
  await until(() => runtime.connection === 'connected');
  const row = aRoutine();
  const requests: { method: string; body: unknown }[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push({ method: init!.method!, body: JSON.parse(init!.body as string) });
    return init!.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(row);
  }) as typeof fetch;
  await runtime.createRoutine({ bot_id: row.bot_id, title: row.title, instruction: row.instruction, schedule: row.schedule });
  expect(runtime.snapshot.routines).toHaveLength(0);
  Socket.current.frame({ type: 'event', event_instance_id: instance, seq: 1, payload: { ...row, event: 'routine.upsert', occurred_at: 'now' } });
  await runtime.patchRoutine(row.id, { enabled: false, if_revision: row.updated_at });
  expect(runtime.snapshot.routines[0]!.enabled).toBe(true);
  await runtime.deleteRoutine(row.id, row.updated_at);
  expect(runtime.snapshot.routines).toHaveLength(1);
  expect(requests.map((r) => r.method)).toEqual(['POST', 'PATCH', 'DELETE']);
  expect(requests[1]!.body).toEqual({ enabled: false, if_revision: row.updated_at });
  expect(requests[2]!.body).toEqual({ if_revision: row.updated_at });
  await reconnect(runtime, { ...initial, routines: [aRoutine({ title: 'Reconnect', enabled: false })] });
  expect(runtime.snapshot.routines[0]!.title).toBe('Reconnect');
  Socket.current.frame({ type: 'event', event_instance_id: instance, seq: 1, payload: { event: 'routine.removed', id: row.id, occurred_at: 'now' } });
  expect(runtime.snapshot.routines).toHaveLength(0);
});

for (const operation of ['create', 'patch', 'delete'] as const) for (const reject of [false, true]) test(`obsolete routine ${operation} ${reject ? 'failure' : 'success'} cannot affect replacement connection`, async () => {
  const { runtime, initial } = await connected();
  await until(() => runtime.connection === 'connected');
  const pending = deferred<Response>();
  globalThis.fetch = (() => pending.promise) as typeof fetch;
  const row = aRoutine();
  const write = operation === 'create' ? runtime.createRoutine({ bot_id: row.bot_id, title: row.title, instruction: '', schedule: row.schedule }) : operation === 'patch' ? runtime.patchRoutine(row.id, { title: 'old', if_revision: row.updated_at }) : runtime.deleteRoutine(row.id, row.updated_at);
  await reconnect(runtime, { ...initial, routines: [aRoutine({ title: 'Current' })] });
  runtime.selectedId = 'direct-1';
  await runtime.openRoutine('bot-1', row.id);
  if (reject) pending.reject(new Error('old connection'));
  else pending.resolve(operation === 'delete' ? new Response(null, { status: 204 }) : Response.json(row));
  expect((await write)?.code).toBe('disconnected');
  expect(runtime.connection).toBe('connected');
  expect(runtime.profileRoutineId).toBe(row.id);
  expect(runtime.snapshot.routines[0]!.title).toBe('Current');
});

test("unsent in-memory drafts require confirm after reconnect and are not sent automatically", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  // A draft belongs to a conversation, so there has to be one open to have typed into.
  runtime.selectedId = "direct-1";
  runtime.draft = "keep this";
  Socket.current.close();
  // A dropped socket is not yet "unreachable": the page says it is reconnecting.
  await until(() => runtime.connection !== "connected");
  // Kept with the conversation it was typed in, so it goes back there and nowhere else.
  expect(runtime.draftReconnect).toEqual({ sessionId: "direct-1", draft: "keep this", confirm: false });
  runtime.confirmDraftReconnect();
  expect(runtime.draftReconnect?.confirm).toBe(true);
  runtime.discardDraftReconnect();
  expect(runtime.draft).toBe("");
  expect(runtime.draftReconnect).toBeNull();
});

test("runtime subscribes before reading snapshot and preserves events arriving during HTTP", async () => {
  const pending = deferred<RuntimeSnapshot>();
  const { runtime, initial } = await connected(() => pending.promise);
  const message = aMessage({ session_id: "direct-1" });
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { ...message, event: "message.upsert", occurred_at: "now" } });
  // Still mid-connect: the snapshot has not landed, so this is "connecting", not unreachable.
  expect(runtime.connection).toBe("connecting");
  pending.resolve(initial);
  await until(() => runtime.connection === "connected");
  expect(runtime.snapshot.messages.map((m) => m.id)).toEqual([message.id]);
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 3, payload: { event: "routine.removed", id: "r", occurred_at: "now" } });
  expect(runtime.connection).not.toBe("connected");
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

test("the page behind the first one is appended once, and the cursor moves with it", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("/snapshot")) {
      return Response.json({
        ...cursor,
        session: { ...aDirect(), messages: { items: [aMessage({ id: "new-1", session_id: "direct-1" })], next: "older" }, turns: [] },
        judgements: [],
      });
    }
    if (path.includes("/messages")) {
      return Response.json({ items: [aMessage({ id: "old-1", session_id: "direct-1" })], next: null });
    }
    return Response.json({ ...aDirect(), messages: { items: [], next: null }, turns: [] });
  }) as typeof fetch;
  await runtime.selectSession("direct-1");
  expect(runtime.hasOlderMessages).toBe(true);
  await runtime.loadOlderMessages();
  expect(runtime.snapshot.messages.map((m) => m.id).sort()).toEqual(["new-1", "old-1"]);
  // The server said that was the end, so nothing offers another page.
  expect(runtime.hasOlderMessages).toBe(false);
  await runtime.loadOlderMessages();
  expect(runtime.snapshot.messages).toHaveLength(2);
});

test("a page that lands after the history was cleared is dropped", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  const page = deferred<{ items: ReturnType<typeof aMessage>[]; next: null }>();
  const requested = deferred<void>();
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("/snapshot")) {
      return Response.json({
        ...cursor,
        session: { ...aDirect(), messages: { items: [aMessage({ id: "new-1", session_id: "direct-1" })], next: "older" }, turns: [] },
        judgements: [],
      });
    }
    if (path.includes("/messages")) { requested.resolve(); return Response.json(await page.promise); }
    return Response.json({ ...aDirect(), messages: { items: [], next: null }, turns: [] });
  }) as typeof fetch;
  await runtime.selectSession("direct-1");
  const older = runtime.loadOlderMessages();
  await requested.promise;
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { event: "session.cleared", id: "direct-1", occurred_at: "now" } });
  page.resolve({ items: [aMessage({ id: "old-1", session_id: "direct-1" })], next: null });
  await older;
  expect(runtime.snapshot.messages.map((m) => m.id)).not.toContain("old-1");
});

test("terminal bytes on the event socket do not drop the connection", async () => {
  // A stream frame has no cursor, so handing one to the sequenced reader reads as a gap and the
  // page goes to "the host is unreachable". That is what opening a terminal used to do on a
  // phone, where the relay carries these on the same channel as events.
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");

  Socket.current.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "stream", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV:call_1", offset: 0, data: "aGVsbG8=" }),
  }));
  Socket.current.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "tool", turn_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", id: "call_1", name: "shell", phase: "started", command: "pnpm build" }),
  }));
  flushSync();

  expect(runtime.connection).toBe("connected");
  // And they landed where they belong rather than being thrown away.
  expect(runtime.activity.forTurn("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toHaveLength(1);
});

test("a board shown in a pane reloads on its own job's turns and messages, and nobody else's", async () => {
  // A workbench board is a pane, not the overlay whose flags used to decide this, so it never
  // reloaded: a model choice finished on screen and its card kept saying the turn was live.
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  const turn = (id: string, taskId: string, seq: number) =>
    Socket.current.frame({ type: "event", event_instance_id: instance, seq, payload: { ...aTurn({ id, task_id: taskId }), event: "turn.upsert", occurred_at: "now" } });
  const stop = runtime.watchTrace("task-1");
  const before = runtime.traceReload;
  turn("turn-1", "task-1", 1);
  expect(runtime.traceReload).toBe(before + 1);
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 2, payload: { ...aMessage({ id: "m-2", task_id: "task-1" }), event: "message.created", occurred_at: "now" } });
  expect(runtime.traceReload).toBe(before + 2);
  turn("turn-2", "task-2", 3);
  expect(runtime.traceReload).toBe(before + 2);
  stop();
  turn("turn-1", "task-1", 4);
  expect(runtime.traceReload).toBe(before + 2);
});

test("each conversation keeps its own read on record", async () => {
  // One slot for the whole app meant the second conversation's read overwrote the first's, so
  // coming back to the first re-sent a read the daemon already had — the loop 938d714 removed,
  // reintroduced by switching. Two panes will make this constant rather than occasional.
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");

  const reads: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/read") && init?.method === "POST") {
      reads.push(path.slice(path.indexOf("/v1/")));
      return Response.json({ unread_count: 0, last_read_at: "2026-01-01T00:00:00Z" });
    }
    return Response.json({ items: [] });
  }) as typeof fetch;

  runtime.selectedId = "sess-a";
  await runtime.submitBoundedRead("sess-a", "m-1");
  runtime.selectedId = "sess-b";
  await runtime.submitBoundedRead("sess-b", "m-1");
  expect(reads).toHaveLength(2);

  // Back where we were: the same message is already on record for this conversation.
  runtime.selectedId = "sess-a";
  await runtime.submitBoundedRead("sess-a", "m-1");
  expect(reads).toHaveLength(2);

  // A message that really is newer still goes.
  await runtime.submitBoundedRead("sess-a", "m-2");
  expect(reads).toHaveLength(3);
});

test("two readers of one stream both get the bytes", async () => {
  // One sink per stream id meant the second reader replaced the first without a word. Two panes
  // showing the same terminal, or two session panes watching the same command, need both.
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");

  const first: string[] = [];
  const second: string[] = [];
  const dropFirst = runtime.onStream("term-1", (frame) => first.push(frame.data));
  const dropSecond = runtime.onStream("term-1", (frame) => second.push(frame.data));

  const send = (data: string, offset: number) =>
    Socket.current.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "stream", id: "term-1", offset, data }),
    }));

  send("aGk=", 0);
  expect(first).toEqual(["aGk="]);
  expect(second).toEqual(["aGk="]);

  // Letting one go leaves the other listening rather than tearing the id down.
  dropFirst();
  send("dGhlcmU=", 2);
  expect(first).toEqual(["aGk="]);
  expect(second).toEqual(["aGk=", "dGhlcmU="]);

  dropSecond();
  send("Z29uZQ==", 7);
  expect(second).toHaveLength(2);
});

test("each conversation keeps its own draft and reply target", async () => {
  // Draft, reply-to and the rest used to be one slot on the runtime, which is what made a second
  // open conversation impossible. They live on the conversation now; the old names still work.
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");

  runtime.selectedId = "sess-a";
  runtime.draft = "for A";
  runtime.replyingToId = "m-a";

  runtime.selectedId = "sess-b";
  expect(runtime.draft).toBe("");
  expect(runtime.replyingToId).toBeNull();
  runtime.draft = "for B";

  runtime.selectedId = "sess-a";
  expect(runtime.draft).toBe("for A");
  expect(runtime.replyingToId).toBe("m-a");

  runtime.selectedId = "sess-b";
  expect(runtime.draft).toBe("for B");

  // And the view is reachable directly, which is how a pane will read it.
  expect(runtime.sessionView("sess-a").draft).toBe("for A");
  expect(runtime.sessionView("sess-b").draft).toBe("for B");

  // Nothing is selected: a write has nowhere to land rather than landing somewhere arbitrary.
  runtime.selectedId = null;
  expect(runtime.draft).toBe("");
  runtime.draft = "nowhere";
  expect(runtime.sessionView("sess-a").draft).toBe("for A");
});

test("clearing one conversation's history does not invalidate another's read", async () => {
  // The revision counter was global: any session.cleared threw away a page that was in flight for
  // a different conversation. Per conversation now, so two panes cannot spoil each other's reads.
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");

  const a = runtime.sessionView("sess-a");
  const b = runtime.sessionView("sess-b");
  const before = b.revision;

  Socket.current.frame({
    type: "event", event_instance_id: instance, seq: 1,
    payload: { event: "session.cleared", id: "sess-a", occurred_at: "now" },
  });
  await until(() => a.revision > 0);

  expect(a.revision).toBe(1);
  expect(b.revision).toBe(before);
});

test("a dead socket invalidates every conversation's read at once", async () => {
  // What the one global counter used to do for connection loss is now its own counter, so it
  // still cancels everything in flight without also cancelling unrelated conversations.
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  runtime.selectedId = "sess-a";
  const a = runtime.sessionView("sess-a");
  const seqBefore = a.loadSeq;

  Socket.current.close();
  await until(() => runtime.connection !== "connected");

  // The conversation's own counter is untouched; the connection's moved.
  expect(a.loadSeq).toBe(seqBefore);
});

/** A session read the runtime accepts, so selecting or reconnecting does not look like a dropped link. */
function sessionRead(path: string) {
  const id = path.match(/\/v1\/sessions\/([^/]+)\/snapshot/)?.[1] ?? "direct-1";
  return Response.json({ ...cursor, session: { ...aDirect({ id }), messages: { items: [], next: null }, turns: [] }, judgements: [] });
}

test("a send from one conversation goes to it and holds up only it, whichever is selected", async () => {
  // Two panes, one keyboard: the selected conversation is whichever pane was clicked last, so
  // sending by "the selected one" sent the other pane's draft, and one flag held up both.
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  const posted: string[] = [];
  const pending = deferred<Response>();
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "POST" && path.includes("/messages")) {
      posted.push(path.slice(path.indexOf("/v1/")));
      return pending.promise;
    }
    return Response.json({ items: [] });
  }) as typeof fetch;
  runtime.selectedId = "direct-1";
  runtime.sessionView("direct-1").draft = "to the direct";
  runtime.sessionView("group-1").draft = "to the group";
  const sending = runtime.send({ sessionId: "group-1" });
  expect(runtime.sessionView("group-1").sending).toBe(true);
  expect(runtime.sessionView("direct-1").sending).toBe(false);
  expect(runtime.busy).toBe(false);
  await until(() => posted.length === 1);
  expect(posted).toEqual(["/v1/sessions/group-1/messages"]);
  pending.resolve(Response.json(aMessage({ id: "sent-1", session_id: "group-1" })));
  await sending;
  expect(runtime.sessionView("group-1").draft).toBe("");
  expect(runtime.sessionView("direct-1").draft).toBe("to the direct");
});

test("clicking into a conversation keeps the reply aimed there and its chips", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("/snapshot")) return sessionRead(path);
    return Response.json({ items: [] });
  }) as typeof fetch;
  const view = runtime.sessionView("direct-1");
  view.replyingToId = "m-quoted";
  view.composerSuggestions = [{ id: "s-1", label: "继续", prompt: "继续" }];
  await runtime.selectSession("direct-1", { preservePage: true });
  expect(runtime.connection).toBe("connected");
  expect(view.replyingToId).toBe("m-quoted");
  expect(view.composerSuggestions.map((row) => row.id)).toEqual(["s-1"]);
});

test("a new message in a conversation not in front drops the chips drafted for what came before", async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === "connected");
  runtime.selectedId = "direct-1";
  const front = runtime.sessionView("direct-1");
  const behind = runtime.sessionView("group-1");
  front.composerSuggestions = [{ id: "s-front", label: "a", prompt: "a" }];
  behind.composerSuggestions = [{ id: "s-behind", label: "b", prompt: "b" }];
  Socket.current.frame({ type: "event", event_instance_id: instance, seq: 1, payload: { ...aMessage({ id: "m-new", session_id: "group-1" }), event: "message.created", occurred_at: "now" } });
  expect(behind.composerSuggestions).toEqual([]);
  expect(front.composerSuggestions.map((row) => row.id)).toEqual(["s-front"]);
});

test("a draft kept across a dropped link goes back to the conversation it was typed in", async () => {
  const { runtime, initial } = await connected();
  await until(() => runtime.connection === "connected");
  runtime.selectedId = "direct-1";
  runtime.draft = "keep this";
  Socket.current.close();
  await until(() => runtime.connection !== "connected");
  runtime.sessionView("direct-1").draft = "";
  // The keyboard moved to another conversation while the link was down.
  runtime.selectedId = "group-1";
  await reconnect(runtime, initial, async () => ({ ...cursor, session: { ...aDirect(), messages: { items: [], next: null }, turns: [] }, judgements: [] }));
  expect(runtime.sessionView("direct-1").draft).toBe("keep this");
  expect(runtime.sessionView("group-1").draft).toBe("");
  runtime.discardDraftReconnect();
  expect(runtime.sessionView("direct-1").draft).toBe("");
});

for (const removed of [false, true]) test(`Spend chat navigation ignores ${removed ? 'deleted' : 'unknown'} sessions without disturbing the live connection`, async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === 'connected');
  runtime.selectedId = 'direct-1';
  runtime.openSpend();
  if (removed) Socket.current.frame({ type: 'event', event_instance_id: instance, seq: 1, payload: { event: 'session.removed', id: 'direct-1', occurred_at: 'now' } });
  const selected = runtime.selectedId;
  const api = runtime.client;
  let reads = 0;
  globalThis.fetch = (async () => { reads++; throw new Error('must not request a missing session'); }) as typeof fetch;
  await runtime.openChat(removed ? 'direct-1' : 'missing', { messageId: 'stale-trigger' });
  expect(reads).toBe(0);
  expect(runtime.selectedId).toBe(selected);
  expect(runtime.spendOpen).toBe(true);
  expect(runtime.client).toBe(api);
  expect(runtime.connection).toBe('connected');
});

for (const removedDuringRead of [false, true]) test(`missing session detail resumes buffered events rather than disconnecting (${removedDuringRead ? 'deleted during read' : 'stale id'})`, async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === 'connected');
  runtime.selectedId = 'direct-1';
  runtime.openSpend();
  const api = runtime.client;
  const missing = removedDuringRead ? 'direct-1' : 'missing';
  globalThis.fetch = (async () => {
    Socket.current.frame({ type: 'event', event_instance_id: instance, seq: 1, payload: { ...aBot({ name: 'Buffered change' }), event: 'bot.upsert', deleted_at: null, occurred_at: 'now' } });
    if (removedDuringRead) Socket.current.frame({ type: 'event', event_instance_id: instance, seq: 2, payload: { event: 'session.removed', id: missing, occurred_at: 'now' } });
    return Response.json({ error: { code: 'not_found', message: 'session not found' } }, { status: 404 });
  }) as typeof fetch;
  await runtime.selectSession(missing);
  expect(runtime.client).toBe(api);
  expect(runtime.connection).toBe('connected');
  expect(runtime.snapshot.bots[0]!.name).toBe('Buffered change');
  expect(runtime.selectedId).toBe(removedDuringRead ? null : 'direct-1');
  expect(runtime.spendOpen).toBe(true);
  Socket.current.frame({ type: 'event', event_instance_id: instance, seq: removedDuringRead ? 3 : 2, payload: { ...aBot({ name: 'Still streaming' }), event: 'bot.upsert', deleted_at: null, occurred_at: 'now' } });
  expect(runtime.snapshot.bots[0]!.name).toBe('Still streaming');
});

for (const failure of ['network', 'server', 'gap'] as const) test(`session detail ${failure} still triggers connection recovery`, async () => {
  const { runtime } = await connected();
  await until(() => runtime.connection === 'connected');
  globalThis.fetch = (async () => {
    if (failure === 'network') throw new Error('connection lost');
    if (failure === 'gap') Socket.current.frame({ type: 'event', event_instance_id: instance, seq: 2, payload: { event: 'session.removed', id: 'direct-1', occurred_at: 'now' } });
    return Response.json({ error: { code: failure === 'gap' ? 'not_found' : 'internal', message: 'fixture' } }, { status: failure === 'gap' ? 404 : 500 });
  }) as typeof fetch;
  await runtime.selectSession('direct-1');
  expect(runtime.connection).not.toBe('connected');
});
