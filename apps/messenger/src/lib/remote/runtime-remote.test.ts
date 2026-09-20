import { afterEach, expect, test } from "bun:test";
import { base64url, generateIdentity, identityPublic, type RemoteRequest, type RemoteResponse } from "@real-bot/remote";
import { MessengerRuntime } from "../runtime.svelte.ts";
import { RemoteApi, type DurablePendingRequest } from "./api.ts";
import type { StoredEnrollment } from "./idb.ts";

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
