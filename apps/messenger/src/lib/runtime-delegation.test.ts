import { afterEach, expect, test } from "bun:test";
import type { DelegationView, RuntimeSnapshot, SyncFrame } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { ApiError } from "./api.ts";
import { emptySnapshot } from "./snapshot.ts";
import { aBot, aBotDirect } from "./test-fixtures.ts";
import { copyFor } from "./copy.ts";
import { render } from "./test-render.ts";
import ChatStage from "./chat/ChatStage.svelte";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { aDelegation } from "./test-delegations.ts";

const runtimes: MessengerRuntime[] = [];
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
  globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
});

const cursor = { event_instance_id: "d".repeat(32), watermark_seq: 0 };
class Socket extends EventTarget {
  static current: Socket;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  constructor(_url: string) { super(); Socket.current = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(_raw: string) { queueMicrotask(() => this.frame({ type: "ready", ...cursor })); }
  frame(value: SyncFrame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  close() { this.dispatchEvent(new Event("close")); }
}

async function settled(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await Promise.resolve(); }
  throw new Error("fixture did not settle");
}

async function connected() {
  const session = aBotDirect();
  const initial: RuntimeSnapshot = { ...emptySnapshot(), ...cursor, bots: [aBot({ name: "Director" }), aBot({ id: "bot-2", name: "Reviewer" })], sessions: [session] };
  let read: () => Promise<{ items: DelegationView[] }> = async () => ({ items: [] });
  const requests: Array<{ path: string; method: string }> = [];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); requests.push({ path, method: init?.method ?? "GET" });
    if (path === "/__local-api") return Response.json({ port: 17891, token: "synthetic-fixture" });
    if (path.endsWith("/v1/health")) return Response.json({ ok: true, name: "real-bot" });
    if (path.endsWith("/v1/snapshot")) return Response.json(initial);
    if (path.endsWith("/delegations")) return Response.json(await read());
    return Response.json({ items: [] });
  }) as typeof fetch;
  const runtime = new MessengerRuntime(); runtimes.push(runtime); runtime.start();
  await settled(() => runtime.connection === "connected");
  let seq = 0;
  return { runtime, session, requests, socket: Socket.current,
    read(next: typeof read) { read = next; },
    event(row: DelegationView) { Socket.current.frame({ type: "event", event_instance_id: cursor.event_instance_id, seq: ++seq,
      payload: { event: "delegation.changed", occurred_at: row.created_at, ...row } }); },
  };
}

test("visible thread GET hydrates persisted records independently of transcript messages", async () => {
  const runtime = new MessengerRuntime(); runtimes.push(runtime);
  const calls: string[] = [];
  const row = aDelegation({ thread_session_id: "peer/a" });
  Reflect.set(runtime, "api", { get: async (path: string) => { calls.push(path); return { items: [row] }; } });
  runtime.connection = "connected";
  await runtime.loadDelegations("peer/a");
  expect(calls).toEqual(["/v1/sessions/peer%2Fa/delegations"]);
  expect(runtime.snapshot.delegations).toEqual([row]);
  expect(runtime.snapshot.messages).toEqual([]);
});

test("cross-client sequenced reply wins over an older GET while untouched siblings still hydrate in actual ChatStage", async () => {
  const h = await connected();
  const stale = aDelegation();
  const sibling = aDelegation({ id: "delegation-2", ask: "继续做 Shot 12", wait: null });
  const read = Promise.withResolvers<{ items: DelegationView[] }>();
  h.read(async () => read.promise);
  const loading = h.runtime.loadDelegations(h.session.id);
  const replied = { ...stale, status: "replied" as const, wait: null,
    reply: { body: "2 通过 1 不通过", created_at: "2026-09-19T03:00:00.000Z", ref: null } };
  h.event(replied);
  expect(h.runtime.connection).toBe("connected");
  expect(h.runtime.snapshot.delegations).toEqual([replied]);
  read.resolve({ items: [stale, sibling] }); await loading;
  expect(h.runtime.snapshot.delegations.find((row) => row.id === stale.id)).toEqual(replied);
  expect(h.runtime.snapshot.delegations.find((row) => row.id === sibling.id)).toEqual(sibling);
  h.read(async () => ({ items: [replied, sibling] }));
  const { host, close } = render(ChatStage, { runtime: h.runtime, t: copyFor("en"), selected: h.session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    await settled(() => !h.runtime.delegationLoading[h.session.id]); flushSync();
    expect(host.textContent).toContain("Returned: 2 通过 1 不通过");
    expect(host.querySelectorAll(".delegation-wait")).toHaveLength(0);
    expect(host.querySelector('[role="textbox"]')?.getAttribute("contenteditable")).toBe("false");
    expect(h.requests.every((request) => request.method === "GET")).toBe(true);
  } finally { close(); }
});

for (const locale of ["zh", "en"] as const) test(`actual ${locale} peer thread follows wait/held/reply/continue states via cross-client socket only`, async () => {
  const h = await connected();
  const row = aDelegation({ wait: { state: "waiting", since: "2026-09-19T02:00:00.000Z", due_at: null } });
  h.read(async () => ({ items: [row] }));
  const { host, close } = render(ChatStage, { runtime: h.runtime, t: copyFor(locale), selected: h.session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    await settled(() => !h.runtime.delegationLoading[h.session.id]); flushSync();
    expect(host.querySelectorAll(".delegation-wait")).toHaveLength(1);
    expect(host.textContent).not.toContain(copyFor(locale).delegation.due);
    const held = { ...row, wait: { ...row.wait!, state: "held" as const } };
    h.event(held); flushSync();
    expect(host.textContent).toContain(copyFor(locale).delegation.held);
    expect(host.textContent).not.toContain(copyFor(locale).delegation.waitingSuffix);
    h.event({ ...row, wait: null }); flushSync();
    expect(host.querySelectorAll(".delegation-wait")).toHaveLength(0);
    expect(host.textContent).not.toContain(copyFor(locale).delegation.waitingSuffix);
    h.event({ ...row, status: "cancelled", wait: null, reply: { body: "Delegation cancelled:审 Shot 11", created_at: row.created_at, ref: null } }); flushSync();
    expect(host.textContent).toContain(copyFor(locale).delegation.cancelled);
    expect(host.textContent).toContain("Delegation cancelled:审 Shot 11");
    expect(h.runtime.snapshot.turns).toEqual([]);
    expect(h.runtime.snapshot.messages).toEqual([]);
    expect(h.requests.filter((request) => request.path.endsWith("/delegations"))).toHaveLength(1);
  } finally { close(); }
});

test("newer same-thread GET wins; older failures, other threads and replacement clients cannot disturb it", async () => {
  const runtime = new MessengerRuntime(); runtimes.push(runtime);
  runtime.connection = "connected";
  const first = Promise.withResolvers<{ items: DelegationView[] }>();
  const second = Promise.withResolvers<{ items: DelegationView[] }>();
  const third = Promise.withResolvers<{ items: DelegationView[] }>();
  let reads = 0;
  Reflect.set(runtime, "api", { get: () => [first.promise, second.promise, third.promise][reads++] });
  const old = runtime.loadDelegations("botbot-1");
  const fresh = runtime.loadDelegations("botbot-1");
  const peer = runtime.loadDelegations("other-thread");
  const newest = aDelegation({ status: "replied", wait: null });
  second.resolve({ items: [newest] }); await fresh;
  first.reject(new ApiError(404, "not_found", "old daemon")); await old;
  expect(runtime.snapshot.delegations).toEqual([newest]);
  expect(runtime.delegationUnsupported["botbot-1"]).toBe(false);
  expect(runtime.delegationLoadError["botbot-1"]).toBe(false);
  Reflect.set(runtime, "api", { get: async () => ({ items: [] }) });
  third.resolve({ items: [aDelegation({ id: "other", thread_session_id: "other-thread" })] }); await peer;
  expect(runtime.snapshot.delegations).toEqual([newest]);
});

test("a live cross-client record proves support even if an older in-flight GET later returns 404", async () => {
  const h = await connected();
  const read = Promise.withResolvers<{ items: DelegationView[] }>();
  h.read(async () => read.promise);
  const loading = h.runtime.loadDelegations(h.session.id);
  h.event(aDelegation());
  read.reject(new ApiError(404, "not_found", "old route")); await loading;
  expect(h.runtime.delegationUnsupported[h.session.id]).toBe(false);
  expect(h.runtime.delegationLoadError[h.session.id]).toBe(false);
});

test("a fresh GET after an event can update linked IDs; only events during that read are protected", async () => {
  const h = await connected();
  const row = aDelegation({ status: "replied", wait: null }); h.event(row);
  const linked = { ...row, request_message_id: "materialized-request", result_message_id: "materialized-result" };
  h.read(async () => ({ items: [linked] }));
  await h.runtime.loadDelegations(h.session.id);
  expect(h.runtime.snapshot.delegations).toEqual([linked]);
});

test("full snapshot reconnect rehydrates unchanged visible peer and rejects the old in-flight GET", async () => {
  const h = await connected();
  const old = aDelegation();
  h.read(async () => ({ items: [old] }));
  const { host, close } = render(ChatStage, { runtime: h.runtime, t: copyFor("en"), selected: h.session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {} });
  try {
    await settled(() => !h.runtime.delegationLoading[h.session.id]); flushSync();
    const deferred = Promise.withResolvers<{ items: DelegationView[] }>();
    h.read(async () => deferred.promise);
    const loading = h.runtime.loadDelegations(h.session.id);
    const oldApi = h.runtime.client;
    h.socket.close();
    const fresh = aDelegation({ status: "replied", wait: null, reply: { body: "Latest persisted reply", created_at: old.created_at, ref: null } });
    h.read(async () => ({ items: [fresh] }));
    h.runtime.start();
    await settled(() => h.runtime.connection === "connected" && h.runtime.client !== oldApi); flushSync();
    await settled(() => !h.runtime.delegationLoading[h.session.id]); flushSync();
    expect(host.textContent).toContain("Returned: Latest persisted reply");
    expect(host.querySelectorAll(".delegation-wait")).toHaveLength(0);
    deferred.resolve({ items: [old] }); await loading; flushSync();
    expect(h.runtime.snapshot.delegations).toEqual([fresh]);
    expect(host.textContent).toContain("Latest persisted reply");
  } finally { close(); }
});

test("older daemon 404 is hidden without persistent error; a network failure preserves cached records", async () => {
  const runtime = new MessengerRuntime(); runtimes.push(runtime); runtime.connection = "connected";
  runtime.snapshot = { ...runtime.snapshot, delegations: [aDelegation()] };
  Reflect.set(runtime, "api", { get: async () => { throw new ApiError(404, "not_found", "unsupported"); } });
  await runtime.loadDelegations("botbot-1");
  expect(runtime.delegationUnsupported["botbot-1"]).toBe(true);
  expect(runtime.delegationLoadError["botbot-1"]).toBe(false);
  Reflect.set(runtime, "api", { get: async () => { throw new Error("network"); } });
  await runtime.loadDelegations("botbot-1");
  expect(runtime.delegationUnsupported["botbot-1"]).toBe(false);
  expect(runtime.delegationLoadError["botbot-1"]).toBe(true);
  expect(runtime.snapshot.delegations).toHaveLength(1);
});
