import { expect, test } from "bun:test";
import { ApiError } from "../api.ts";
import { RemoteApi } from "./api.ts";
import type { StoredEnrollment } from "./idb.ts";
import { base64url, generateIdentity, identityPublic, type RemoteRequest, type RemoteResponse } from "@real-bot/remote";

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
const challenge = "A".repeat(43);

test("unknown remote results look up the same request id instead of minting a new one", async () => {
  const calls: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      if (request.path.startsWith("/v1/requests/")) {
        return { v: 1, id: request.id, status: 201, body: { id: "bot" } } satisfies RemoteResponse;
      }
      throw new Error("socket closed");
    },
  });
  await expect(api.createBot({ name: "Writer", duties: "d", boundaries: "b" })).rejects.toMatchObject({
    code: "request_unknown",
  });
  const pending = api.pendingRequests();
  expect(pending).toHaveLength(1);
  const originalId = pending[0]!.id;
  expect(await api.retryPending(originalId)).toEqual({ id: "bot" });
  expect(calls.filter((row) => row.method === "POST" && row.path === "/v1/bots")).toHaveLength(1);
  expect(calls.filter((row) => row.path === `/v1/requests/${originalId}`)).toHaveLength(1);
  expect(calls.every((row) => row.method !== "POST" || row.id === originalId)).toBe(true);
});

test("remote attachments are refused rather than inventing a second file machine", async () => {
  const api = new RemoteApi(enrollment);
  await expect(api.postMessage("01ARZ3NDEKTSV4RRFFQ69G5FAY", "hi", { attachments: [new File(["x"], "a.txt")] }))
    .rejects.toMatchObject({ code: "not_retryable" });
});

test("forged UV is denied without a click-to-confirm fallback", async () => {
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      if (request.path === "/remote/uv/register-challenge" || request.path === "/remote/uv/challenge") {
        return { v: 1, id: request.id, status: 200, body: { challenge } };
      }
      throw new Error("uv routes must not succeed without an assertion");
    },
    webauthn: {
      create: async () => { throw new Error("uv denied"); },
      get: async () => { throw new Error("uv denied"); },
    },
  });
  await expect(api.registerUv()).rejects.toThrow();
  expect(api.uvReady).toBe(false);
  await expect(api.privilegedAction({ action: "quiesce.force", targetId: "runtime" })).rejects.toThrow();
});

test("reconnect looks up the same request id and never mints a second mutation", async () => {
  const calls: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      if (request.path.startsWith("/v1/requests/")) {
        return { v: 1, id: request.id, status: 200, body: { locale: "en" } } satisfies RemoteResponse;
      }
      throw new Error("disconnected");
    },
  });
  await expect(api.patchSettings({ locale: "en" })).rejects.toMatchObject({ code: "request_unknown" });
  const originalId = api.pendingRequests()[0]!.id;
  api.close();
  expect(await api.retryPending(originalId)).toEqual({ locale: "en" });
  expect(calls.filter((row) => row.method === "PATCH" && row.path === "/v1/settings")).toHaveLength(1);
  expect(calls.filter((row) => row.path === `/v1/requests/${originalId}`)).toHaveLength(1);
});

test("createBot unknown survives a new RemoteApi and retries the same receipt", async () => {
  const calls: RemoteRequest[] = [];
  const rpc = async (request: RemoteRequest): Promise<RemoteResponse> => {
    calls.push(request);
    if (request.path.startsWith("/v1/requests/")) {
      return { v: 1, id: request.id, status: 201, body: { id: "bot" } };
    }
    throw new Error("socket closed");
  };
  const first = new RemoteApi(enrollment, { rpc });
  await expect(first.createBot({ name: "Writer", duties: "d", boundaries: "b" })).rejects.toMatchObject({
    code: "request_unknown",
  });
  const pending = first.durablePending();
  expect(pending).toHaveLength(1);
  const originalId = pending[0]!.id;
  first.close();
  const second = new RemoteApi(enrollment, { rpc }, pending);
  expect(await second.retryPending(originalId)).toEqual({ id: "bot" });
  expect(calls.filter((row) => row.method === "POST" && row.path === "/v1/bots")).toHaveLength(1);
  expect(calls.filter((row) => row.path === `/v1/requests/${originalId}`)).toHaveLength(1);
  expect(calls.some((row) => row.method === "POST" && row.id !== originalId)).toBe(false);
});

test("createBot production ApiError survives a new RemoteApi and retries the same receipt", async () => {
  const calls: RemoteRequest[] = [];
  const rpc = async (request: RemoteRequest): Promise<RemoteResponse> => {
    calls.push(request);
    if (request.path.startsWith("/v1/requests/")) {
      return { v: 1, id: request.id, status: 201, body: { id: "bot" } };
    }
    throw new ApiError(503, "request_unknown", "result unknown; explicitly retry the original request", request.id);
  };
  const first = new RemoteApi(enrollment, { rpc });
  await expect(first.createBot({ name: "Writer", duties: "d", boundaries: "b" })).rejects.toMatchObject({
    status: 503,
    code: "request_unknown",
  });
  const pending = first.durablePending();
  expect(pending).toHaveLength(1);
  expect(first.pendingRequests()).toHaveLength(1);
  const originalId = pending[0]!.id;
  expect(first.hasPendingRequest(originalId)).toBe(true);
  first.close();
  const second = new RemoteApi(enrollment, { rpc }, pending);
  expect(second.hasPendingRequest(originalId)).toBe(true);
  expect(await second.retryPending(originalId)).toEqual({ id: "bot" });
  expect(calls.filter((row) => row.method === "POST" && row.path === "/v1/bots")).toHaveLength(1);
  expect(calls.filter((row) => row.path === `/v1/requests/${originalId}`)).toHaveLength(1);
  expect(calls.some((row) => row.method === "POST" && row.id !== originalId)).toBe(false);
});

test("RemoteApi does not expose a local bearer", () => {
  const api = new RemoteApi(enrollment);
  expect(api.kind).toBe("remote");
  expect("headers" in api).toBe(false);
  expect("authFrame" in api).toBe(false);
  expect("eventsUrl" in api).toBe(false);
  expect("parseSyncFrame" in api).toBe(false);
  expect(JSON.stringify(api.endpoint)).not.toContain("Bearer");
  expect(api.endpoint.token).toBe("");
});
