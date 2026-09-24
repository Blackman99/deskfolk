import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSnapshot, SequencedEvent, SessionSnapshot, SyncFrame } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { EVENT_RING_BYTES, EVENT_RING_COUNT, EventStream } from "./session-events";
import { Store, type EndpointKeyStore } from "./store";
import { ulid } from "./ids";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(endpointKey?: EndpointKeyStore) {
  const store = new Store({ endpointKey });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const origin = `http://127.0.0.1:${server.port}`;
  closes.push(async () => { await api.engine.close(); await server.stop(true); store.close(); });
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${origin}${path}`, { headers: { Authorization: "Bearer fixture" } });
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  };
  async function subscribe() {
    const frames: SyncFrame[] = [];
    const ready = deferred<void>();
    const ws = new WebSocket(`${origin.replace("http", "ws")}/v1/events`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: "fixture", protocol: "sync-v1" }));
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as SyncFrame;
      frames.push(frame);
      if (frame.type === "ready") ready.resolve();
    };
    await ready.promise;
    return { ws, frames };
  }
  return { store, api, get, subscribe, origin };
}

const removed = (id: string) => ({ event: "routine.removed" as const, occurred_at: "now", id });

function replayProviderSettings(before: RuntimeSnapshot, events: SequencedEvent[]) {
  let settings = before.settings;
  const providers = new Map(before.providers.map((provider) => [provider.id, provider]));
  for (const { payload } of events) {
    if (payload.event === "settings.changed") {
      const { event: _event, occurred_at: _at, ...row } = payload;
      settings = row;
    } else if (payload.event === "provider.upsert") {
      const { event: _event, occurred_at: _at, ...row } = payload;
      providers.set(row.id, row);
    } else if (payload.event === "provider.removed") {
      providers.delete(payload.id);
    }
  }
  return { settings, providers: [...providers.values()] };
}

describe("event ring", () => {
  test("new instances use independent 16-byte random cursors; duplicates replay with the same seq", () => {
    const stream = new EventStream();
    const start = stream.cursor();
    expect(start.event_instance_id).toMatch(/^[0-9a-f]{32}$/);
    expect(new EventStream().cursor().event_instance_id).not.toBe(start.event_instance_id);
    stream.publish(removed("a"));
    expect(stream.catchup(start).events.map((e) => e.seq)).toEqual([1]);
    expect(stream.catchup(start)).toEqual(stream.catchup(start));
    expect(stream.catchup({ ...start, watermark_seq: 2 }).resnapshot).toBe(true);
    expect(new EventStream().catchup(start).resnapshot).toBe(true);
  });

  test("2000 events or 16 MiB reset the instance and require a snapshot, including oversize rows", () => {
    const stream = new EventStream();
    const before = stream.cursor();
    const frames: SyncFrame[] = [];
    stream.subscribe((frame) => frames.push(frame));
    for (let i = 0; i < EVENT_RING_COUNT; i++) stream.publish(removed(String(i)));
    expect(stream.catchup(before).events).toHaveLength(EVENT_RING_COUNT);
    stream.publish(removed("overflow"));
    expect(stream.catchup(before).resnapshot).toBe(true);
    expect(frames.at(-2)?.type).toBe("resnapshot");
    const cursor = stream.cursor();
    stream.publish(removed("x".repeat(EVENT_RING_BYTES)));
    expect(stream.cursor().event_instance_id).not.toBe(cursor.event_instance_id);
    expect(stream.cursor().watermark_seq).toBe(0);
    expect(stream.catchup(stream.cursor()).events).toEqual([]);
    const small = new EventStream({ count: 2000, bytes: 500 });
    const smallStart = small.cursor();
    small.publish(removed("a".repeat(120)));
    small.publish(removed("b".repeat(120)));
    expect(small.catchup(smallStart).resnapshot).toBe(true);
  });

  test("token and local tool frames never enter catchup", () => {
    const stream = new EventStream();
    stream.publish({ event: "turn.token", occurred_at: "now", turn_id: "t", session_id: "s", text: "secret" });
    stream.publish({ event: "turn.tool", occurred_at: "now", turn_id: "t", id: "tool", arguments: "secret" });
    expect(stream.cursor().watermark_seq).toBe(0);
  });
});

describe("commit / subscribe / snapshot barrier", () => {
  test("integration: injected business reads share local snapshot, detail and catchup barriers", async () => {
    const h = await harness();
    const bot = h.store.createBot({ name: "shared reads", duties: "", boundaries: "" });
    const scope = { deviceId: "fixture", requestId: ulid() };
    const snapshot = await h.get<RuntimeSnapshot>("/v1/snapshot");
    for (const path of ["/v1/snapshot", `/v1/sessions/${bot.direct_session.id}/snapshot`, `/v1/events/catchup?event_instance_id=${snapshot.event_instance_id}&after_seq=${snapshot.watermark_seq}`]) {
      const injected = await h.api.dispatchBusiness(new Request(`http://fixture${path}`), scope);
      expect(injected.status).toBe(200);
      expect(await injected.json()).toEqual(await h.get(path));
    }
  });

  test("integration: receipt commits publish once before effects, rollback and replay publish nothing", async () => {
    const h = await harness();
    const scope = { deviceId: "fixture", requestId: ulid() };
    const seen: string[] = [];
    h.store.onCommit((event) => {
      expect(h.store.db.inTransaction).toBe(false);
      expect(h.store.receipts.lookup(scope)?.state).toBe("complete");
      seen.push(event.event);
    });
    await h.store.receipts.execute(scope, "fixture", "POST", "/fixture", {}, async () => () => {
      h.store.transaction(() => h.store.createAllowRule("outside-read", "/fixture"));
      h.store.afterCommit(() => { expect(seen).toEqual(["allow_rule.upsert"]); seen.push("effect"); });
      return { status: 204, body: null };
    }, []);
    expect(seen).toEqual(["allow_rule.upsert", "effect"]);
    await h.store.receipts.execute(scope, "fixture", "POST", "/fixture", {}, async () => { throw new Error("replayed business"); }, []);
    expect(() => h.store.transaction(() => {
      h.store.createAllowRule("outside-read", "/rolled-back");
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(seen).toEqual(["allow_rule.upsert", "effect"]);
    expect(h.store.db.query("SELECT * FROM event_changes").all()).toEqual([]);
  });

  test("integration: rolled-back pending keys preserve cached credentials and emit no events", async () => {
    const h = await harness();
    const provider = await h.store.createProvider({ name: "cached", base_url: "https://fixture.invalid", api_key: "fake" });
    const before = await h.get<RuntimeSnapshot>("/v1/snapshot");
    h.store.db.exec("CREATE TEMP TRIGGER reject_fixture_receipt BEFORE INSERT ON request_receipts BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
    const scope = { deviceId: "fixture", requestId: ulid() };
    await expect(h.api.dispatchBusiness(new Request(`http://fixture/v1/providers/${provider.id}`, { method: "PATCH", body: JSON.stringify({ api_key: "replacement" }) }), scope)).rejects.toThrow();
    h.store.db.exec("DROP TRIGGER reject_fixture_receipt");
    expect(h.store.providersCached()[0]!.key_set).toBe(true);
    expect(h.store.listCredentialOperations()).toEqual([]);
    expect(await h.get<RuntimeSnapshot>("/v1/snapshot")).toEqual(before);
  });

  test("integration: credential receipt phases replay to the exact snapshot across unrelated commits", async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    let h: Awaited<ReturnType<typeof harness>>;
    h = await harness({ async get() { return null; }, async delete() {}, async set() {
      expect(h.store.db.inTransaction).toBe(false); entered.resolve(); await release.promise;
    } });
    const before = await h.get<RuntimeSnapshot>("/v1/snapshot");
    const id = ulid();
    const body = { name: "held", base_url: "https://fixture.invalid", api_key: "fake" };
    const request = () => new Request("http://fixture/v1/providers", { method: "POST", body: JSON.stringify(body) });
    const scope = { deviceId: "fixture", requestId: id };
    const pending = h.api.dispatchBusiness(request(), scope);
    await entered.promise;
    const middle = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(middle.providers[0]!.key_set).toBe(false);
    expect(middle.credentialOperations).toHaveLength(1);
    expect(h.store.receipts.read(scope).status).toBe(503);
    await h.store.patchSettings({ theme: "dark" });
    release.resolve();
    expect((await pending).status).toBe(201);
    const after = await h.get<RuntimeSnapshot>("/v1/snapshot");
    const caught = await h.get<{ events: SequencedEvent[] }>(`/v1/events/catchup?event_instance_id=${before.event_instance_id}&after_seq=${before.watermark_seq}`);
    expect(replayProviderSettings(before, caught.events)).toEqual({ settings: after.settings, providers: after.providers });
    expect(after.credentialOperations).toEqual([]);
    const keys = caught.events.filter((e) => e.payload.event === "provider.upsert").map((e) => e.payload.event === "provider.upsert" && e.payload.key_set);
    expect(keys).toEqual([false, true]);
    const operations = caught.events.filter((e) => e.payload.event === "credential_operations.changed");
    expect(operations.map((e) => e.payload.event === "credential_operations.changed" && e.payload.items.length)).toEqual([1, 0]);
    await h.store.patchProvider(after.providers[0]!.id, { name: "newer" });
    const watermark = (await h.get<RuntimeSnapshot>("/v1/snapshot")).watermark_seq;
    const replay = await h.api.dispatchBusiness(request(), scope);
    expect((await replay.json() as { name: string }).name).toBe("held");
    const final = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(final.providers[0]!.name).toBe("newer");
    expect(final.watermark_seq).toBe(watermark);
  });

  test("integration: attachment events precede rename and engine effects; replay leaves no orphan stages", async () => {
    const h = await harness();
    const root = mkdtempSync(join(tmpdir(), "rc-int-files-"));
    closes.push(async () => rmSync(root, { recursive: true, force: true }));
    await h.store.patchSettings({ workspace_path: root });
    const bot = h.store.createBot({ name: "attachments", duties: "", boundaries: "" });
    const scope = { deviceId: "fixture", requestId: ulid() };
    const attachments = [{ originalFilename: "one.txt", buffer: Buffer.from("fixture bytes") }];
    const order: string[] = [];
    h.store.onCommit((event) => {
      if (event.event !== "message.created") return;
      expect(h.store.receipts.lookup(scope)?.state).toBe("complete");
      expect(event.attachments[0]!.exists).toBe(true);
      expect(existsSync(join(root, event.attachments[0]!.workspace_relpath))).toBe(false);
      order.push("event");
    });
    await h.store.receipts.execute(scope, "upload", "POST", "/fixture", {}, async () => {
      h.store.prepareAttachments(attachments);
      return () => {
        const message = h.store.postMessage(bot.direct_session.id, { body: "upload", attachments });
        h.store.afterCommit(() => {
          expect(readFileSync(join(root, message.attachments[0]!.workspace_relpath), "utf8")).toBe("fixture bytes");
          order.push("engine");
        });
        return { status: 201, body: JSON.stringify(message) };
      };
    }, []);
    expect(order).toEqual(["event", "engine"]);
    await h.store.receipts.execute(scope, "upload", "POST", "/fixture", {}, async () => { throw new Error("replayed"); }, []);
    expect(readdirSync(join(root, "inbox"))).toEqual(["one.txt"]);
    expect(h.store.db.query("SELECT * FROM file_stages UNION ALL SELECT * FROM file_commits").all()).toEqual([]);
  });

  test("a keychain wait cannot delay SQLite events behind later commits or snapshots", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const h = await harness({
      async get() { return null; },
      async set() { entered.resolve(); await release.promise; },
      async delete() {},
    });
    const client = await h.subscribe();
    const pending = h.store.createProvider({ name: "first", base_url: "https://fixture.invalid", api_key: "fixture" });
    await entered.promise;
    const baseline = await h.get<RuntimeSnapshot>("/v1/snapshot");
    const provider = baseline.providers[0]!;
    expect(provider.name).toBe("first");
    expect(provider.key_set).toBe(false);
    await expect(h.store.patchProvider(provider.id, { name: "blocked" })).rejects.toMatchObject({ status: 409 });
    await h.store.patchSettings({ theme: "dark" });
    const latest = await h.get<RuntimeSnapshot>("/v1/snapshot");
    release.resolve();
    await pending;
    const caught = await h.get<{ events: SequencedEvent[] }>(`/v1/events/catchup?event_instance_id=${baseline.event_instance_id}&after_seq=${baseline.watermark_seq}`);
    const providers = caught.events.filter((e) => e.payload.event === "provider.upsert");
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.every((e) => e.payload.event === "provider.upsert" && e.payload.name === "first")).toBe(true);
    expect(latest.settings.theme).toBe("dark");
    expect(caught.events.filter((e) => e.payload.event === "settings.changed").every((e) => e.payload.event === "settings.changed" && e.payload.theme === "dark")).toBe(true);
    expect(caught.events.every((e, i, all) => i === 0 || e.seq === all[i - 1]!.seq + 1)).toBe(true);
    client.ws.close();
  });

  test("snapshot hydration can interleave writes but the final read and watermark cannot", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let block = false;
    const h = await harness({
      async get() { if (block) { entered.resolve(); await release.promise; } return null; },
      async set() {}, async delete() {},
    });
    const bot = h.store.createBot({ name: "Snapshot", duties: "fixture", boundaries: "fixture" }).bot;
    await h.store.createMcpServer({ name: "fixture", command: "not-executed", enabled: false });
    block = true;
    const client = await h.subscribe();
    const pending = h.get<RuntimeSnapshot>("/v1/snapshot");
    await entered.promise;
    const routine = h.store.createRoutine({ bot_id: bot.id, title: "during read", instruction: "fixture", schedule: { kind: "daily", time: "09:00" } });
    const rule = h.store.createAllowRule("outside-read", "/fixture");
    release.resolve();
    const snapshot = await pending;
    expect(snapshot.routines.map((r) => r.id)).toContain(routine.id);
    expect(snapshot.allowRules.map((r) => r.id)).toContain(rule.id);
    h.store.patchRoutine(routine.id, { title: "after watermark" });
    h.store.deleteAllowRule(rule.id);
    const caught = await h.get<{ events: SequencedEvent[] }>(`/v1/events/catchup?event_instance_id=${snapshot.event_instance_id}&after_seq=${snapshot.watermark_seq}`);
    expect(caught.events.map((e) => e.payload.event)).toEqual(["routine.upsert", "allow_rule.removed"]);
    expect(caught.events[0]!.seq).toBe(snapshot.watermark_seq + 1);
    client.ws.close();
  });

  test("nested engine writes, rollback, reactions, memories and deletes are journalled without caller publishes", async () => {
    const h = await harness();
    const created = h.store.createBot({ name: "Writer", duties: "fixture", boundaries: "fixture" });
    const start = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(() => h.store.patchBot(created.bot.id, { name: "" })).toThrow();
    const message = h.store.postMessage(created.direct_session.id, { body: "fixture" });
    const turn = h.store.createTurn({ sessionId: created.direct_session.id, botId: created.bot.id, triggerMessageId: message.id });
    h.store.setTurnPartial(turn.id, "partial once");
    const approval = h.store.insertApproval({ turnId: turn.id, messageId: null, kind_key: "outside-read", summary: "fixture", target: "/fixture" });
    h.store.resolveApproval(approval.id, "always_allow");
    h.store.putReaction(message.id, "👍");
    const detail = await h.get<SessionSnapshot>(`/v1/sessions/${created.direct_session.id}/snapshot`);
    expect(detail.session.turns[0]!.partial_text).toBe("partial once");
    expect(detail.session.messages.items[0]!.reactions).toHaveLength(1);
    const snapshot = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(snapshot.sessions[0]!.live_turns![0]!.partial_text).toBe("partial once");
    expect(snapshot.allowRules).toHaveLength(1);
    const caught = await h.get<{ events: SequencedEvent[] }>(`/v1/events/catchup?event_instance_id=${start.event_instance_id}&after_seq=${start.watermark_seq}`);
    expect(caught.events.some((e) => e.payload.event === "bot.upsert")).toBe(false);
    expect(caught.events.some((e) => e.payload.event === "allow_rule.upsert")).toBe(true);
    expect(caught.events.some((e) => e.payload.event === "turn.upsert" && e.payload.partial_text === "partial once")).toBe(true);
    h.store.stopTurn(turn.id);
    expect((await h.get<SessionSnapshot>(`/v1/sessions/${created.direct_session.id}/snapshot`)).session.turns).toEqual([]);
  });

  test("committed deletion cascades remove approvals, spend and memory references", async () => {
    const h = await harness();
    const a = h.store.createBot({ name: "A", duties: "fixture", boundaries: "fixture" }).bot;
    const b = h.store.createBot({ name: "B", duties: "fixture", boundaries: "fixture" }).bot;
    const group = h.store.createGroup({ name: "fixture", members: [a.id, b.id] });
    const message = h.store.postMessage(group.id, { body: "fixture" });
    const turn = h.store.createTurn({ sessionId: group.id, botId: a.id, triggerMessageId: message.id });
    const approval = h.store.insertApproval({ turnId: turn.id, messageId: message.id, kind_key: "outside-read", summary: "fixture", target: "/fixture" });
    const spend = h.store.insertSpend({ kind: "turn", sessionId: group.id, botId: a.id, turnId: turn.id });
    const memory = h.store.rememberMemory({ bot_id: a.id, subject: "fixture", body: "remember", source_session_id: group.id, source_message_id: message.id });
    const before = await h.get<RuntimeSnapshot>("/v1/snapshot");
    h.store.deleteSession(group.id);
    const caught = await h.get<{ events: SequencedEvent[] }>(`/v1/events/catchup?event_instance_id=${before.event_instance_id}&after_seq=${before.watermark_seq}`);
    expect(caught.events.some((e) => e.payload.event === "approval.removed" && e.payload.id === approval.id)).toBe(true);
    // Spend is a ledger: deleting the session does not remove the row or publish spend.removed.
    expect(caught.events.some((e) => e.payload.event === "spend.removed")).toBe(false);
    expect(caught.events.some((e) => e.payload.event === "memory.upsert" && e.payload.id === memory.id && e.payload.source_session_id === null)).toBe(true);
    const after = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(after.approvals).toEqual([]);
    expect(h.store.listSpend({}).map((row) => row.id)).toEqual([spend.id]);
    expect("spend" in after).toBe(false);
    expect(after.sessions.some((s) => s.id === group.id)).toBe(false);
  });

  test("validation rolls back writes and journal rows; credential failure still publishes committed rows", async () => {
    const h = await harness({ async get() { return null; }, async set() { throw new Error("fixture keychain locked"); }, async delete() {} });
    const before = await h.get<RuntimeSnapshot>("/v1/snapshot");
    await expect(h.store.patchSettings({ locale: "en", theme: "invalid" })).rejects.toThrow();
    const unchanged = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(unchanged.settings.locale).toBe(before.settings.locale);
    expect(unchanged.watermark_seq).toBe(before.watermark_seq);
    await expect(h.store.createProvider({ name: "committed", base_url: "https://fixture.invalid", api_key: "fixture" })).rejects.toThrow();
    const after = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(after.providers[0]!.name).toBe("committed");
    expect(after.providers[0]!.key_set).toBe(false);
    expect(after.watermark_seq).toBeGreaterThan(before.watermark_seq);
  });

  test("provider-only HTTP commits publish derived settings equal to a fresh snapshot", async () => {
    const keys = new Map<string | undefined, string>();
    const h = await harness({
      async get(name) { return keys.get(name) ?? null; },
      async set(value, name) { keys.set(name, value); },
      async delete(name) { keys.delete(name); },
    });
    const workspace = mkdtempSync(join(tmpdir(), "rc01-derived-"));
    closes.push(async () => rmSync(workspace, { recursive: true, force: true }));
    await h.store.patchSettings({ workspace_path: workspace });
    await h.store.createProvider({ name: "default", base_url: "" });
    const secondary = await h.store.createProvider({ name: "secondary", base_url: "", api_key: "fixture" });
    const before = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(before.settings.wizard_complete).toBe(false);
    const response = await fetch(`${h.origin}/v1/providers/${secondary.id}`, {
      method: "PATCH", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: "https://fixture.invalid" }),
    });
    expect(response.status).toBe(200);
    const catchup = await h.get<{ events: SequencedEvent[] }>(`/v1/events/catchup?event_instance_id=${before.event_instance_id}&after_seq=${before.watermark_seq}`);
    const replica = replayProviderSettings(before, catchup.events);
    const after = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(replica.settings).toEqual(after.settings);
    expect(replica.settings.wizard_complete).toBe(true);
    expect(replica.providers).toEqual(after.providers);
  });

  test("provider commit before keychain failure still converges derived default settings", async () => {
    const h = await harness({ async get() { return null; }, async set() { throw new Error("locked"); }, async delete() {} });
    const before = await h.get<RuntimeSnapshot>("/v1/snapshot");
    await expect(h.store.createProvider({ name: "committed", base_url: "https://fixture.invalid", api_key: "fixture", models: ["model-a"] })).rejects.toThrow("locked");
    const catchup = await h.get<{ events: SequencedEvent[] }>(`/v1/events/catchup?event_instance_id=${before.event_instance_id}&after_seq=${before.watermark_seq}`);
    const replica = replayProviderSettings(before, catchup.events);
    const after = await h.get<RuntimeSnapshot>("/v1/snapshot");
    expect(replica.settings).toEqual(after.settings);
    expect(replica.settings.endpoint_models).toEqual(["model-a"]);
    expect(replica.providers).toEqual(after.providers);
  });

  test("runtime snapshot hydrates session rows only once inside the barrier", async () => {
    const h = await harness();
    h.store.createBot({ name: "fixture", duties: "fixture", boundaries: "fixture" });
    const read = spyOn(h.store, "listSessions");
    try {
      expect((await h.get<RuntimeSnapshot>("/v1/snapshot")).sessions).toHaveLength(2);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
  });

  test("auth fails closed, legacy frames remain raw, and two sync clients receive identical events", async () => {
    const h = await harness();
    const a = await h.subscribe();
    const b = await h.subscribe();
    const legacy = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    const legacyFrame = deferred<unknown>();
    legacy.onmessage = (event) => legacyFrame.resolve(JSON.parse(String(event.data)));
    await new Promise<void>((resolve) => { legacy.onopen = () => { legacy.send(JSON.stringify({ type: "auth", token: "fixture" })); resolve(); }; });
    // The HTTP request runs after authentication on the same event loop.
    await h.get("/v1/snapshot");
    const event = removed("legacy");
    h.api.publish(event);
    expect(await legacyFrame.promise).toEqual(event);
    h.store.createAllowRule("outside-read", "/fixture");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(a.frames.filter((f) => f.type === "event")).toEqual(b.frames.filter((f) => f.type === "event"));
    expect(a.frames.filter((f) => f.type === "event")).toHaveLength(1);
    for (const body of [null, { type: "auth", token: "fixture", protocol: "unknown" }, { type: "auth", token: "wrong" }]) {
      const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
      const closed = new Promise<number>((resolve) => { ws.onclose = (ev) => resolve(ev.code); });
      ws.onopen = () => ws.send(JSON.stringify(body));
      expect(await closed).toBe(4001);
    }
    const invalid = await fetch(`${h.origin}/v1/events/catchup?after_seq=-1`, { headers: { Authorization: "Bearer fixture" } });
    expect(invalid.status).toBe(422);
    expect((await fetch(`${h.origin}/v1/snapshot`)).status).toBe(401);
    a.ws.close(); b.ws.close(); legacy.close();
  });
});
