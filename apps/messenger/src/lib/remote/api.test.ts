import { expect, test } from "bun:test";
import type { Annotation, CreateAnnotationRequest } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import type { CropCodec } from "../annotations/region-box.ts";
import type { Snapshot } from "../snapshot.ts";
import { ANNOTATION_REQUEST_BUDGET, RemoteApi } from "./api.ts";
import type { StoredEnrollment } from "./idb.ts";
import {
  base64url,
  canonicalBytes,
  encodeFrame,
  generateIdentity,
  identityPublic,
  type RemoteRequest,
  type RemoteResponse,
} from "@real-bot/remote";

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

test("postMessage retries keep the original request id on the wire", async () => {
  const calls: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      throw new Error("socket closed");
    },
  });
  await expect(api.postMessage("01ARZ3NDEKTSV4RRFFQ69G5FAY", "answer", { askId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" }))
    .rejects.toMatchObject({ code: "request_unknown" });
  const originalId = api.pendingRequests()[0]!.id;
  await expect(api.postMessage("01ARZ3NDEKTSV4RRFFQ69G5FAY", "answer", {
    askId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    requestId: originalId,
  })).rejects.toMatchObject({ code: "request_unknown", requestId: originalId });
  const posts = calls.filter((row) => row.path.endsWith("/messages"));
  expect(posts).toHaveLength(2);
  expect(posts.every((row) => row.id === originalId)).toBe(true);
  expect(posts[0]!.body).toEqual(posts[1]!.body);
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

// Annotations -------------------------------------------------------------------------------

const deliverySession = "01ARZ3NDEKTSV4RRFFQ69G5FC0";
const deliveryMessage = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const annotationA = "01ARZ3NDEKTSV4RRFFQ69G5FC2";
const annotationB = "01ARZ3NDEKTSV4RRFFQ69G5FC3";

function annotationRow(id: string, updated_at: string, status: Annotation["status"] = "draft"): Annotation {
  return {
    id, status, relpath: "shot.png", anchor_kind: "image_region",
    anchor: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, natural_width: 1000, natural_height: 500 },
    content_sha256: "a".repeat(64), target_message_id: deliveryMessage, target_session_id: deliverySession, target_turn_id: null,
    bot_id: "01ARZ3NDEKTSV4RRFFQ69G5FC4", session_id: deliverySession, message_id: status === "draft" ? null : "01ARZ3NDEKTSV4RRFFQ69G5FC5",
    body: "tighten this", crop_mime: null, resolved_by: null, resolved_note: null, resolved_at: null,
    created_at: "2026-09-24T08:00:00.000Z", updated_at,
  };
}

/**
 * A Mac for annotations: lists `rows`, creates and edits with a fresh `updated_at` each time,
 * and keeps every request it was sent. Like the daemon it holds no revision check of its own —
 * the tests read the `if_revision` on the wire.
 */
function annotationMac(rows: Annotation[]) {
  const sent: RemoteRequest[] = [];
  const held = new Map(rows.map((row) => [row.id, row]));
  let tick = 0;
  const stamp = () => `2026-09-24T09:00:${String(++tick).padStart(2, "0")}.000Z`;
  const rpc = async (request: RemoteRequest): Promise<RemoteResponse> => {
    sent.push(request);
    const ok = (status: number, body?: unknown): RemoteResponse => ({ v: 1, id: request.id, status, body });
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (request.method === "GET" && request.path === "/v1/annotations") return ok(200, { items: [...held.values()] });
    if (request.method === "POST" && request.path === "/v1/annotations") {
      const row = { ...annotationRow(annotationB, stamp()), crop_mime: (body.crop as { mime?: string } | undefined)?.mime ?? null };
      held.set(row.id, row);
      return ok(201, row);
    }
    if (request.method === "POST" && request.path === "/v1/annotations/send") {
      const sentRows = (body.annotation_ids as string[]).map((id) => ({ ...held.get(id)!, status: "open" as const, updated_at: stamp() }));
      for (const row of sentRows) held.set(row.id, row);
      return ok(200, { message: { id: "01ARZ3NDEKTSV4RRFFQ69G5FC5", session_id: deliverySession }, annotations: sentRows });
    }
    const id = request.path.split("/").pop()!;
    if (request.method === "PATCH") {
      const { if_revision: _revision, ...patch } = body;
      const row = { ...held.get(id)!, ...(patch as Partial<Annotation>), updated_at: stamp() };
      held.set(id, row);
      return ok(200, row);
    }
    if (request.method === "DELETE") {
      held.delete(id);
      return ok(204);
    }
    return ok(404, { error: { code: "not_found", message: "no route" } });
  };
  return { sent, rpc, held };
}

test("rows the phone only listed are resolved, reopened and deleted with the revision they came with", async () => {
  // A quiet session: no sync event ever carried these rows, the list is all the phone has seen.
  const open = annotationRow(annotationA, "2026-09-24T08:30:00.000Z", "open");
  const draft = annotationRow(annotationB, "2026-09-24T08:31:00.000Z");
  const mac = annotationMac([open, draft]);
  const api = new RemoteApi(enrollment, { rpc: mac.rpc });
  await api.listAnnotations({ session_id: deliverySession });
  const resolved = await api.patchAnnotation(annotationA, { status: "resolved" });
  await api.patchAnnotation(annotationA, { status: "open" });
  await api.deleteAnnotation(annotationB);
  const patches = mac.sent.filter((request) => request.method === "PATCH");
  expect(patches.map((request) => request.body)).toEqual([
    { status: "resolved", if_revision: open.updated_at },
    // The reply to the first edit is what the second one builds on.
    { status: "open", if_revision: resolved.updated_at },
  ]);
  expect(mac.sent.find((request) => request.method === "DELETE")?.body).toEqual({ if_revision: draft.updated_at });
});

test("a draft just created, and annotations just sent, are edited with the revision their reply carried", async () => {
  const mac = annotationMac([]);
  const api = new RemoteApi(enrollment, { rpc: mac.rpc });
  const created = await api.createAnnotation({
    target_message_id: deliveryMessage, relpath: "shot.png", anchor_kind: "image_region",
    anchor: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, natural_width: 1000, natural_height: 500 }, content_sha256: "a".repeat(64), body: "tighten this",
  });
  const edited = await api.patchAnnotation(created.id, { body: "tighten this more" });
  const sent = await api.sendAnnotations({ session_id: deliverySession, body: "", annotation_ids: [created.id] });
  await api.patchAnnotation(created.id, { status: "resolved" });
  const patches = mac.sent.filter((request) => request.method === "PATCH").map((request) => request.body?.if_revision);
  expect(patches).toEqual([created.updated_at, sent.annotations[0]!.updated_at]);
  expect(edited.updated_at < sent.annotations[0]!.updated_at).toBe(true);
});

test("a list that was on its way does not take a row back past the revision an event already brought", async () => {
  const stale = annotationRow(annotationA, "2026-09-24T08:30:00.000Z", "open");
  const fresh = { ...stale, status: "resolved" as const, updated_at: "2026-09-24T08:45:00.000Z" };
  const mac = annotationMac([stale]);
  let answerList = (): void => {};
  const api = new RemoteApi(enrollment, {
    rpc: (request) => request.method === "GET"
      ? new Promise((resolve) => { answerList = () => void mac.rpc(request).then(resolve); })
      : mac.rpc(request),
  });
  const listing = api.listAnnotations({ session_id: deliverySession });
  // The event lands first: the runtime hands its snapshot over as it does after every ingest.
  api.observeSnapshot({
    settings: { settings_rev: 1 }, bots: [], sessions: [], providers: [], mcpServers: [], skills: [], memories: [],
    routines: [], allowRules: [], annotations: [fresh],
  } as unknown as Snapshot);
  answerList();
  await listing;
  await api.patchAnnotation(annotationA, { status: "open" });
  expect(mac.sent.find((request) => request.method === "PATCH")?.body).toEqual({ status: "open", if_revision: fresh.updated_at });
});

/** A crop of `bytes` bytes, base64 as it travels. */
const cropOf = (bytes: number) => ({ mime: "image/png" as const, base64: btoa(String.fromCharCode(...new Uint8Array(bytes).fill(7))) });

/** Canvas stand-in: output shrinks with the area and the JPEG quality, `perPixel` bytes a pixel at full quality. */
function codecOf(perPixel: number): { codec: CropCodec<string>; decoded: () => number } {
  let decoded = 0;
  return {
    decoded: () => decoded,
    codec: {
      decode: async () => ((decoded += 1), { image: "decoded", width: 1024, height: 768 }),
      encode: async (_image, size, type, quality) =>
        new Blob([new Uint8Array(Math.round(size.width * size.height * perPixel * (type === "image/png" ? 1 : quality!)))]),
    },
  };
}

const imageDraft = (crop: CreateAnnotationRequest["crop"]): CreateAnnotationRequest => ({
  target_message_id: deliveryMessage, relpath: "shot.png", anchor_kind: "image_region",
  anchor: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, natural_width: 1000, natural_height: 500 }, content_sha256: "a".repeat(64),
  body: "这里的对比度太低", crop,
});

/** What the transport does with a request: one type-1 frame of its canonical bytes. */
const frameOf = (request: RemoteRequest) => encodeFrame({ sessionId: new Uint8Array(16), seq: 0n, type: 1, body: canonicalBytes(request) });

test("a crop too big for one frame is re-encoded until the whole request fits, on create and on edit", async () => {
  const mac = annotationMac([]);
  const { codec } = codecOf(0.2);
  const api = new RemoteApi(enrollment, { rpc: mac.rpc, cropCodec: codec });
  // 150 KB of PNG: the request it rides in is far past the 32 KiB frame the transport sends.
  const big = cropOf(150_000);
  const created = await api.createAnnotation(imageDraft(big));
  await api.patchAnnotation(created.id, { anchor: { x: 0.2, y: 0.2, w: 0.3, h: 0.3, natural_width: 1000, natural_height: 500 }, crop: big });
  const post = mac.sent.find((request) => request.method === "POST")!;
  const patch = mac.sent.find((request) => request.method === "PATCH")!;
  expect(() => frameOf({ ...post, body: { ...post.body, crop: big } })).toThrow("32 KiB");
  for (const request of [post, patch]) {
    const crop = request.body?.crop as { mime: string; base64: string };
    expect(crop.mime).toBe("image/jpeg");
    expect(crop.base64.length).toBeGreaterThan(0);
    expect(canonicalBytes(request).length).toBeLessThanOrEqual(ANNOTATION_REQUEST_BUDGET);
    expect(() => frameOf(request)).not.toThrow();
  }
  // The edit keeps its revision through the re-encode.
  expect(patch.body?.if_revision).toBe(created.updated_at);
  expect(created.crop_mime).toBe("image/jpeg");
});

test("a crop that already fits a frame goes out untouched, never decoded", async () => {
  const mac = annotationMac([]);
  const { codec, decoded } = codecOf(0.2);
  const api = new RemoteApi(enrollment, { rpc: mac.rpc, cropCodec: codec });
  const small = cropOf(12_000);
  await api.createAnnotation(imageDraft(small));
  expect(mac.sent[0]!.body?.crop).toEqual(small);
  expect(decoded()).toBe(0);
});

test("a crop nothing can squeeze into a frame is left behind: a new draft saves without one, an edit clears the old", async () => {
  const mac = annotationMac([annotationRow(annotationA, "2026-09-24T08:30:00.000Z")]);
  // So dense that even the smallest step is over: the annotation goes without its picture.
  const { codec } = codecOf(50);
  const api = new RemoteApi(enrollment, { rpc: mac.rpc, cropCodec: codec });
  const big = cropOf(150_000);
  await api.listAnnotations({});
  await api.createAnnotation(imageDraft(big));
  const anchor = { x: 0.2, y: 0.2, w: 0.3, h: 0.3, natural_width: 1000, natural_height: 500 };
  await api.patchAnnotation(annotationA, { anchor, crop: big });
  const post = mac.sent.find((request) => request.method === "POST")!;
  const patch = mac.sent.find((request) => request.method === "PATCH")!;
  expect("crop" in (post.body ?? {})).toBe(false);
  expect(post.body?.body).toBe("这里的对比度太低");
  // A new box with the old box's picture would mislead, so the edit clears it.
  expect(patch.body).toEqual({ anchor, crop: null, if_revision: "2026-09-24T08:30:00.000Z" });
  for (const request of [post, patch]) expect(() => frameOf(request)).not.toThrow();
});

test("with no canvas to re-encode on, an oversized crop is dropped rather than closing the link", async () => {
  const mac = annotationMac([]);
  // No codec handed in: the browser one, which happy-dom cannot draw with.
  const api = new RemoteApi(enrollment, { rpc: mac.rpc });
  await api.createAnnotation(imageDraft(cropOf(150_000)));
  expect("crop" in (mac.sent[0]!.body ?? {})).toBe(false);
  expect(() => frameOf(mac.sent[0]!)).not.toThrow();
});
