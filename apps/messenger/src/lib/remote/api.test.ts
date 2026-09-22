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

test("remote attachments declare hashes instead of inventing a second file machine", async () => {
  const calls: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      return { v: 1, id: request.id, status: 201, body: { id: "msg" } };
    },
  });
  const file = new File(["hello"], "a.txt");
  await expect(api.postMessage("01ARZ3NDEKTSV4RRFFQ69G5FAY", "hi", { attachments: [file] }))
    .resolves.toEqual({ id: "msg" });
  const posted = calls.find((row) => row.path.endsWith("/messages"));
  expect(posted?.body?.files).toEqual([
    expect.objectContaining({ filename: "a.txt", size: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
  ]);
});

test("remote file GET reports start then the completed blob size", async () => {
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => ({ v: 1, id: request.id, status: 200, body: new Blob(["hello"]) }),
  });
  const seen: Array<{ loaded: number; total: number | null }> = [];
  expect(await (await api.getWorkspaceFileBlob("a.txt", (progress) => seen.push({ ...progress }))).text()).toBe("hello");
  expect(seen).toEqual([
    { loaded: 0, total: null },
    { loaded: 5, total: 5 },
  ]);
});

test("remote attachments above 50 MiB are refused before RPC", async () => {
  const api = new RemoteApi(enrollment, {
    rpc: async () => { throw new Error("must not send oversize attachments"); },
  });
  const huge = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "big.bin");
  await expect(api.postMessage("01ARZ3NDEKTSV4RRFFQ69G5FAY", "hi", { attachments: [huge] }))
    .rejects.toMatchObject({ code: "file_limit" });
});

test("push subscribe never posts an approval resolve", async () => {
  const calls: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      return { v: 1, id: request.id, status: 204, body: null } satisfies RemoteResponse;
    },
  });
  await api.subscribePush({ endpoint: "https://web.push.apple.com/v1/push/isolated", p256dh: "B".repeat(87), auth: "C".repeat(22) });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.path).toBe("/remote/push/subscribe");
  expect(JSON.stringify(calls[0]!.body)).not.toContain("allow_once");
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
  await expect(api.privilegedAction({ action: "runtime.restart", targetId: "runtime", force: true })).rejects.toThrow();
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

test("a save the link dropped does not block the next one once the Mac says it never landed", async () => {
  let drop = true;
  const asked: string[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      asked.push(`${request.method} ${request.path}`);
      if (request.path.startsWith("/v1/requests/")) {
        return { v: 1, id: request.id, status: 404, body: { error: { code: "not_found", message: "request receipt not found" } } } satisfies RemoteResponse;
      }
      if (drop) throw new Error("socket closed");
      return { v: 1, id: request.id, status: 200, body: { id: "bot" } } satisfies RemoteResponse;
    },
  });
  const bot = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  await expect(api.patchBot(bot, { model: "one" })).rejects.toMatchObject({ code: "request_unknown" });
  const dropped = api.pendingRequests()[0]!.id;
  drop = false;
  // A different model: the receipt says nothing was committed, so the new payload takes the slot.
  await expect(api.patchBot(bot, { model: "two" })).resolves.toMatchObject({ id: "bot" });
  expect(asked).toContain(`GET /v1/requests/${dropped}`);
  expect(api.pendingRequests()).toHaveLength(0);
});

test("the dropped save is settled from its receipt before the next payload goes out", async () => {
  let drop = true;
  const sent: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      sent.push(request);
      if (request.path.startsWith("/v1/requests/")) {
        return { v: 1, id: request.id, status: 200, body: { id: "bot", model: "one" } } satisfies RemoteResponse;
      }
      if (drop) throw new Error("socket closed");
      return { v: 1, id: request.id, status: 200, body: { id: "bot", model: "two" } } satisfies RemoteResponse;
    },
  });
  const bot = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  await expect(api.patchBot(bot, { model: "one" })).rejects.toMatchObject({ code: "request_unknown" });
  drop = false;
  await expect(api.patchBot(bot, { model: "two" })).resolves.toMatchObject({ model: "two" });
  expect(api.pendingRequests()).toHaveLength(0);
  // The first one was never re-sent; its receipt spoke for it.
  expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(2);
});

test("a Mac that cannot be asked keeps the slot blocked rather than guessing", async () => {
  const api = new RemoteApi(enrollment, { rpc: async () => { throw new Error("socket closed"); } });
  const bot = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  await expect(api.patchBot(bot, { model: "one" })).rejects.toMatchObject({ code: "request_unknown" });
  await expect(api.patchBot(bot, { model: "two" })).rejects.toMatchObject({ code: "request_pending" });
  expect(api.pendingRequests()).toHaveLength(1);
});

test("a queued key write still needs the person before a different payload is accepted", async () => {
  let drop = true;
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      if (request.path.startsWith("/v1/requests/")) {
        return { v: 1, id: request.id, status: 503, body: { error: { code: "key_write_pending", message: "credential not saved; retry the same request id" } } } satisfies RemoteResponse;
      }
      if (drop) throw new Error("socket closed");
      return { v: 1, id: request.id, status: 200, body: { id: "p" } } satisfies RemoteResponse;
    },
  });
  const provider = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
  await expect(api.patchProvider(provider, { api_key: "one" })).rejects.toMatchObject({ code: "request_unknown" });
  drop = false;
  await expect(api.patchProvider(provider, { api_key: "two" })).rejects.toMatchObject({ code: "request_pending" });
  expect(api.pendingRequests()).toHaveLength(1);
});

test("a pending save restored after a reload is settled the same way", async () => {
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      if (request.path.startsWith("/v1/requests/")) {
        return { v: 1, id: request.id, status: 404, body: { error: { code: "not_found", message: "request receipt not found" } } } satisfies RemoteResponse;
      }
      return { v: 1, id: request.id, status: 200, body: { id: "bot" } } satisfies RemoteResponse;
    },
  }, [
    { id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", method: "PATCH", path: "/v1/bots/01ARZ3NDEKTSV4RRFFQ69G5FAX", fingerprint: "old", body: { model: "one" } },
  ]);
  await expect(api.patchBot("01ARZ3NDEKTSV4RRFFQ69G5FAX", { model: "two" })).resolves.toMatchObject({ id: "bot" });
  expect(api.pendingRequests()).toHaveLength(0);
});

test("a create whose receipt exists is never replaced by an edited payload", async () => {
  let drop = true;
  const posts: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      if (request.path.startsWith("/v1/requests/")) {
        return { v: 1, id: request.id, status: 201, body: { id: "bot", name: "Original" } } satisfies RemoteResponse;
      }
      posts.push(request);
      if (drop) throw new Error("socket closed");
      return { v: 1, id: request.id, status: 201, body: { id: "bot2" } } satisfies RemoteResponse;
    },
  });
  await expect(api.createBot({ name: "Original", duties: "d", boundaries: "b" })).rejects.toMatchObject({ code: "request_unknown" });
  drop = false;
  // The Mac did create it; sending the edited draft would make a second Bot.
  await expect(api.createBot({ name: "Edited", duties: "d", boundaries: "b" })).rejects.toMatchObject({ code: "request_pending" });
  expect(posts).toHaveLength(1);
  expect(api.pendingRequests()).toHaveLength(1);
});
