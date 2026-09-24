import { afterEach, expect, test } from "bun:test";
import type { RuntimeSnapshot } from "@real-bot/protocol";
import { base64url, generateIdentity, identityPublic, type RemoteRequest, type RemoteResponse } from "@real-bot/remote";
import { ApiError } from "../api.ts";
import { MessengerRuntime, nextRemoteRetry } from "../runtime.svelte.ts";
import { emptySnapshot } from "../snapshot.ts";
import { RemoteApi, type DurablePendingRequest } from "./api.ts";
import { useEnrollmentDriver, type StoredEnrollment } from "./idb.ts";
import { enrollment as liveEnrollment, serveRemote } from "./test-host.ts";
import { aBot } from "../test-fixtures.ts";

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

const runtimes: MessengerRuntime[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
  for (const restore of restores.splice(0)) restore();
  useEnrollmentDriver(null);
});

/** A Mac that answers the one read a connect needs, and nothing else it does not have. */
function hostAnswers(request: RemoteRequest): RemoteResponse {
  if (request.path === "/v1/snapshot") {
    const snapshot: RuntimeSnapshot = {
      ...emptySnapshot(),
      event_instance_id: "a".repeat(32),
      watermark_seq: 0,
    } as RuntimeSnapshot;
    return { v: 1, id: request.id, status: 200, body: snapshot };
  }
  return { v: 1, id: request.id, status: 404, body: { error: { code: "not_found", message: "no such route" } } };
}

/**
 * Clearing site data under a live page force-closes the IndexedDB connection, and every read
 * after that throws. The tick used to die on it: no enrollment left, no pairing screen either,
 * just "host unreachable" until the app was killed and reopened by hand.
 */
test("an enrollment read that throws leaves the page not enrolled and keeps the loop alive", async () => {
  useEnrollmentDriver({
    get: () => Promise.reject(new Error("InvalidStateError")),
    set: () => Promise.resolve(),
  });
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  await (runtime as unknown as { tickRemote(): Promise<void> }).tickRemote();
  expect(runtime.enrolled).toBe(false);
  expect(runtime.hostUnreachable).toBe("host");
});

test("a tick that throws still leaves a timer behind", async () => {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const internals = runtime as unknown as {
    tick(): Promise<void>;
    pump(): void;
    stopped: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  internals.stopped = false;
  internals.tick = () => Promise.reject(new Error("boom"));
  internals.pump();
  await Promise.resolve();
  await Promise.resolve();
  expect(internals.timer).toBeDefined();
});

test("chat send 503 request_unknown keeps the id across resetConnection/connectRemote", async () => {
  const calls: RemoteRequest[] = [];
  const rpc = async (request: RemoteRequest): Promise<RemoteResponse> => {
    calls.push(request);
    if (request.path.startsWith("/v1/requests/")) {
      return { v: 1, id: request.id, status: 201, body: { id: "msg" } };
    }
    throw new Error("socket closed");
  };
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const first = new RemoteApi(enrollment, { rpc });
  const bag = runtime as unknown as {
    api: RemoteApi | null;
    durablePending: DurablePendingRequest[];
  };
  bag.api = first;
  runtime.selectedId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
  runtime.draft = "hello";
  await runtime.send();
  expect(runtime.pendingMutation?.code).toBe("request_unknown");
  const originalId = runtime.pendingMutation!.id;
  expect(runtime.client).toBeNull();
  expect(bag.durablePending).toEqual([
    expect.objectContaining({ id: originalId, method: "POST", path: "/v1/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAY/messages" }),
  ]);
  const second = new RemoteApi(enrollment, { rpc }, bag.durablePending);
  bag.api = second;
  expect(second.hasPendingRequest(originalId)).toBe(true);
  expect(await runtime.retryPendingMutation()).toBeNull();
  expect(runtime.pendingMutation).toBeNull();
  expect(calls.filter((row) => row.method === "POST" && row.path.endsWith("/messages"))).toHaveLength(1);
  expect(calls.filter((row) => row.path === `/v1/requests/${originalId}`)).toHaveLength(1);
  expect(calls.some((row) => row.method === "POST" && row.id !== originalId)).toBe(false);
});

test("chat send production ApiError 503 keeps the id across resetConnection/connectRemote", async () => {
  const calls: RemoteRequest[] = [];
  const rpc = async (request: RemoteRequest): Promise<RemoteResponse> => {
    calls.push(request);
    if (request.path.startsWith("/v1/requests/")) {
      return { v: 1, id: request.id, status: 201, body: { id: "msg" } };
    }
    throw new ApiError(503, "request_unknown", "result unknown; explicitly retry the original request", request.id);
  };
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const first = new RemoteApi(enrollment, { rpc });
  const bag = runtime as unknown as {
    api: RemoteApi | null;
    durablePending: DurablePendingRequest[];
  };
  bag.api = first;
  runtime.selectedId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
  runtime.draft = "hello";
  await runtime.send();
  expect(runtime.pendingMutation?.code).toBe("request_unknown");
  const originalId = runtime.pendingMutation!.id;
  expect(runtime.client).toBeNull();
  expect(bag.durablePending).toEqual([
    expect.objectContaining({ id: originalId, method: "POST", path: "/v1/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAY/messages" }),
  ]);
  const second = new RemoteApi(enrollment, { rpc }, bag.durablePending);
  bag.api = second;
  expect(second.hasPendingRequest(originalId)).toBe(true);
  expect(runtime.pendingMutation).toEqual({ id: originalId, code: "request_unknown" });
  expect(await runtime.retryPendingMutation()).toBeNull();
  expect(runtime.pendingMutation).toBeNull();
  expect(calls.filter((row) => row.method === "POST" && row.path.endsWith("/messages"))).toHaveLength(1);
  expect(calls.filter((row) => row.path === `/v1/requests/${originalId}`)).toHaveLength(1);
  expect(calls.some((row) => row.method === "POST" && row.id !== originalId)).toBe(false);
});

test("reconnect attempts stay inside the relay's ten handshakes a minute", () => {
  // Worst case for the budget: every attempt fails, so the delay only grows.
  let delay = 1000;
  let elapsed = 0;
  let attempts = 0;
  while (elapsed < 60_000) {
    attempts += 1;
    elapsed += delay;
    delay = nextRemoteRetry(delay, () => 0); // shortest jitter: the most attempts possible
  }
  expect(attempts).toBeLessThanOrEqual(10);
});

test("the delay grows to a cap and jitter keeps devices from lining up", () => {
  expect(nextRemoteRetry(1000, () => 0.5)).toBe(2000);
  expect(nextRemoteRetry(16_000, () => 0.5)).toBe(20_000);
  expect(nextRemoteRetry(20_000, () => 0.5)).toBe(20_000);
  // Never over the cap, never a hot loop under it.
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    const value = nextRemoteRetry(8000, () => r);
    expect(value).toBeGreaterThanOrEqual(8000 * 1.6);
    expect(value).toBeLessThanOrEqual(20_000);
  }
});

test("a connection that comes back resets the delay", async () => {
  useEnrollmentDriver({ get: () => Promise.resolve(null), set: () => Promise.resolve() });
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const internals = runtime as unknown as { remoteRetryMs: number; tickRemote(): Promise<void> };
  internals.remoteRetryMs = 16_000;
  await internals.tickRemote();
  expect(internals.remoteRetryMs).toBe(1000);
});

/**
 * The regression this file is named for. A phone loses the link — the relay closes it, the Mac
 * goes away, the radio changes network — and nothing was typed afterwards. The page used to go
 * on showing a live conversation until the next tap failed, and only then start reconnecting.
 */
test("a link that ends with nobody touching the page brings the page back by itself", async () => {
  const remote = serveRemote({ answer: hostAnswers });
  restores.push(remote.restore);
  useEnrollmentDriver({ get: () => Promise.resolve(liveEnrollment), set: () => Promise.resolve() });
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const internals = runtime as unknown as { tickRemote(): Promise<void>; timer: ReturnType<typeof setTimeout> | null };

  await internals.tickRemote();
  expect(runtime.connection).toBe("connected");
  const first = runtime.client;

  // Nothing here is a user: the socket ends the way a network ends one.
  remote.sockets[0]!.drop();
  expect(runtime.connection).not.toBe("connected");
  expect(runtime.client).toBeNull();
  expect(internals.timer).not.toBeNull();

  // What that timer runs. The old page short-circuited here — it still believed it was connected.
  await internals.tickRemote();
  expect(runtime.connection).toBe("connected");
  expect(runtime.client).not.toBe(first);
  expect(remote.sockets).toHaveLength(2);
});

/**
 * Coming back — from a locked screen, a tunnel, a frozen tab — is worth an attempt, but the relay
 * allows ten handshakes a minute and refuses the rest of them. So a wake-up takes the delay the
 * loop already owes, and only a page that has been away longer than that tries at once.
 */
test("a wake-up brings the next attempt forward but never past the delay the loop owes", () => {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const internals = runtime as unknown as { nextAttemptAt: number; reconnectNow(): void };
  runtime.connection = "disconnected";

  internals.nextAttemptAt = Date.now() + 20_000;
  internals.reconnectNow();
  expect(internals.nextAttemptAt - Date.now()).toBeGreaterThan(19_000);

  // Frozen for an hour: it owes nothing, so it goes now.
  internals.nextAttemptAt = Date.now() - 3_600_000;
  internals.reconnectNow();
  expect(internals.nextAttemptAt - Date.now()).toBeLessThanOrEqual(0);
  runtime.destroy();
});

/** A connected page has nothing to reconnect to, and a relay handshake is not free. */
test("a wake-up on a live link costs nothing", () => {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const internals = runtime as unknown as { nextAttemptAt: number; reconnectNow(): void };
  runtime.connection = "connected";
  internals.nextAttemptAt = Date.now() + 999_000;
  internals.reconnectNow();
  expect(internals.nextAttemptAt - Date.now()).toBeGreaterThan(900_000);
});

const INSTANCE = "a".repeat(32);
const botEvent = (seq: number, id: string, name: string, instance = INSTANCE) => ({
  type: "event" as const,
  event_instance_id: instance,
  seq,
  payload: { event: "bot.upsert" as const, occurred_at: "2026-09-23T00:00:00.000Z", ...aBot({ id, name }), deleted_at: null },
});
const snapshotAt = (request: RemoteRequest, instance: string, watermark: number): RemoteResponse => ({
  v: 1, id: request.id, status: 200,
  body: { ...emptySnapshot(), event_instance_id: instance, watermark_seq: watermark } as unknown as RuntimeSnapshot,
});

/**
 * A phone that slept comes back to the Mac it left. It used to pull the whole snapshot again —
 * 1.6 MB on a real roster — plus every open transcript; the events it missed are a few KB.
 */
test("a phone back on the same Mac replays what it missed instead of the snapshot", async () => {
  const asked: Array<{ link: number; path: string; query?: Record<string, string> }> = [];
  const remote: ReturnType<typeof serveRemote> = serveRemote({
    ready: (link) => ({ event_instance_id: INSTANCE, watermark_seq: link === 0 ? 0 : 2 }),
    answer: (request) => {
      asked.push({ link: remote.sockets.length - 1, path: request.path, query: request.query });
      if (request.path === "/v1/snapshot") return snapshotAt(request, INSTANCE, 0);
      if (request.path === "/v1/events/catchup") {
        return { v: 1, id: request.id, status: 200, body: {
          event_instance_id: INSTANCE, watermark_seq: 2, resnapshot: false, events: [botEvent(2, "bot-c", "C")],
        } };
      }
      return hostAnswers(request);
    },
  });
  restores.push(remote.restore);
  useEnrollmentDriver({ get: () => Promise.resolve(liveEnrollment), set: () => Promise.resolve() });
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const internals = runtime as unknown as { tickRemote(): Promise<void> };

  await internals.tickRemote();
  expect(runtime.connection).toBe("connected");
  remote.hosts[0]!.event(botEvent(1, "bot-b", "B"));
  expect(runtime.snapshot.bots.map((bot) => bot.name)).toEqual(["B"]);

  remote.sockets[0]!.drop();
  await internals.tickRemote();
  expect(runtime.connection).toBe("connected");
  const second = asked.filter((row) => row.link === 1);
  expect(second.map((row) => row.path)).toContain("/v1/events/catchup");
  expect(second.map((row) => row.path)).not.toContain("/v1/snapshot");
  expect(second.find((row) => row.path === "/v1/events/catchup")?.query).toEqual({ event_instance_id: INSTANCE, after_seq: "1" });
  expect(runtime.snapshot.bots.map((bot) => bot.name).sort()).toEqual(["B", "C"]);
});

/** A restarted Mac is another event instance: there is nothing to replay, so the snapshot it is. */
test("a Mac that restarted is read again from its snapshot", async () => {
  const other = "b".repeat(32);
  const asked: Array<{ link: number; path: string }> = [];
  const remote: ReturnType<typeof serveRemote> = serveRemote({
    ready: (link) => ({ event_instance_id: link === 0 ? INSTANCE : other, watermark_seq: 0 }),
    answer: (request) => {
      const link = remote.sockets.length - 1;
      asked.push({ link, path: request.path });
      if (request.path === "/v1/snapshot") return snapshotAt(request, link === 0 ? INSTANCE : other, 0);
      return hostAnswers(request);
    },
  });
  restores.push(remote.restore);
  useEnrollmentDriver({ get: () => Promise.resolve(liveEnrollment), set: () => Promise.resolve() });
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const internals = runtime as unknown as { tickRemote(): Promise<void> };

  await internals.tickRemote();
  remote.hosts[0]!.event(botEvent(1, "bot-b", "B"));
  remote.sockets[0]!.drop();
  await internals.tickRemote();
  expect(runtime.connection).toBe("connected");
  const second = asked.filter((row) => row.link === 1).map((row) => row.path);
  expect(second).toContain("/v1/snapshot");
  expect(second).not.toContain("/v1/events/catchup");
  // The restarted Mac's snapshot is the truth now, not what the page held before.
  expect(runtime.snapshot.bots).toEqual([]);
});
