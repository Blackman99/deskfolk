import { afterEach, expect, test } from "bun:test";
import { base64url, generateIdentity, identityPublic, type RemoteRequest, type RemoteResponse } from "@real-bot/remote";
import { ApiError } from "../api.ts";
import { MessengerRuntime, nextRemoteRetry } from "../runtime.svelte.ts";
import { RemoteApi, type DurablePendingRequest } from "./api.ts";
import { useEnrollmentDriver, type StoredEnrollment } from "./idb.ts";

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
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
  useEnrollmentDriver(null);
});

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
