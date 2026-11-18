import { afterEach, expect, test } from "bun:test";
import { ApiError, etagForBlob, originalSizeForBlob } from "./api";
import { LocalApi } from "./local-api.ts";

test("postMessage retries keep the original X-Request-Id and body", async () => {
  const sent: Array<{ id: string | null; body: unknown }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sent.push({ id: new Headers(init?.headers).get("X-Request-Id"), body: init?.body });
    throw new Error("offline");
  }) as typeof fetch;
  const api = new LocalApi({ origin: "http://fixture", token: "fixture" });
  const originalId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  await expect(api.postMessage("01ARZ3NDEKTSV4RRFFQ69G5FAY", "answer", {
    askId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    requestId: originalId,
  })).rejects.toMatchObject({ code: "request_unknown", requestId: originalId });
  await expect(api.postMessage("01ARZ3NDEKTSV4RRFFQ69G5FAY", "answer", {
    askId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    requestId: originalId,
  })).rejects.toMatchObject({ code: "request_unknown", requestId: originalId });
  expect(sent).toHaveLength(2);
  expect(sent[0]!.id).toBe(originalId);
  expect(sent[1]!.id).toBe(originalId);
  expect(sent[0]!.body).toEqual(sent[1]!.body);
});

test("pending mutation payload is immutable in memory and only explicit retries send it", async () => {
  const sent: Array<{ id: string | null; body: unknown }> = [];
  let fail = true;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sent.push({ id: new Headers(init?.headers).get("X-Request-Id"), body: init?.body });
    if (fail) return Response.json({ error: { code: "key_write_pending", message: "locked" } }, { status: 503 });
    return Response.json({ id: "provider", key_set: true });
  }) as typeof fetch;
  const api = new LocalApi({ origin: "http://fixture", token: "fixture" });
  const body = { name: "first", base_url: "https://example.invalid", api_key: "memory-only" };
  await expect(api.createProvider(body)).rejects.toMatchObject({ code: "key_write_pending" });
  const id = api.pendingRequests()[0]!.id;
  body.name = "changed";
  await expect(api.createProvider(body)).rejects.toMatchObject({ code: "request_pending", requestId: id });
  expect(sent).toHaveLength(1);
  fail = false;
  await api.retryPending(id);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(api.pendingRequests()).toHaveLength(0);
});

test("unknown takeover retains its predecessor until a later committed cancel retires the chain", async () => {
  let originalId = "";
  let takeoverId = "";
  let phase = "original";
  let sent = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "GET") return Response.json({ items: [{ id: phase === "lost" ? "second" : "first", kind: "provider", entity_id: "entity", request_id: phase === "lost" ? takeoverId : originalId, can_repair: true }] });
    sent++;
    const id = new Headers(init?.headers).get("X-Request-Id")!;
    if (path === "/v1/providers") {
      originalId = id;
      return Response.json({ error: { code: "key_write_pending", message: "locked" } }, { status: 503 });
    }
    if (path.includes("first")) { takeoverId = id; phase = "lost"; throw new Error("lost response after takeover"); }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const api = new LocalApi({ origin: "http://fixture", token: "fixture" });
  await expect(api.createProvider({ name: "test", base_url: "https://example.invalid", api_key: "old" })).rejects.toMatchObject({ code: "key_write_pending" });
  await expect(api.resolveCredential("first", "repair", "replacement")).rejects.toMatchObject({ code: "request_unknown" });
  expect(api.pendingRequests().map((row) => row.id).sort()).toEqual([originalId, takeoverId].sort());
  expect(sent).toBe(2);
  await api.resolveCredential("second", "cancel");
  expect(api.pendingRequests()).toHaveLength(0);
  expect(sent).toBe(3);
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("workspace file GET reports each chunk against Content-Length", async () => {
  const seen: Array<{ loaded: number; total: number | null }> = [];
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Length": "5", ETag: '"abc"' } });
  }) as typeof fetch;
  const api = new LocalApi({ origin: "http://fixture", token: "fixture" });
  const blob = await api.getWorkspaceFileBlob("note.txt", (progress) => seen.push({ ...progress }));
  expect(seen).toEqual([
    { loaded: 0, total: 5 },
    { loaded: 3, total: 5 },
    { loaded: 5, total: 5 },
  ]);
  expect(etagForBlob(blob)).toBe('"abc"');
});

test("file ETag belongs to the loaded blob, not a later fetch of the same path", async () => {
  let tag = '"first"';
  let matched: string | null = null;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      matched = new Headers(init.headers).get("If-Match");
      return Response.json({ error: { code: "conflict", message: "file changed" } }, { status: 409 });
    }
    return new Response("contents", { headers: { ETag: tag } });
  }) as typeof fetch;
  const api = new LocalApi({ origin: "http://fixture", token: "fixture" });
  const first = await api.getWorkspaceFileBlob("note.txt");
  tag = '"second"';
  const second = await api.getWorkspaceFileBlob("note.txt");
  expect(etagForBlob(first)).toBe('"first"');
  expect(etagForBlob(second)).toBe('"second"');
  try { await api.putWorkspaceFile("note.txt", "mine", etagForBlob(first)); }
  catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(409); }
  expect(matched).toBe('"first"');
});

test("successful save returns the new ETag and local omission remains optional", async () => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("If-Match")).toBe(false);
    return new Response(null, { status: 204, headers: { ETag: '"new"' } });
  }) as typeof fetch;
  const api = new LocalApi({ origin: "http://fixture", token: "fixture" });
  expect(await api.putWorkspaceFile("note.txt", "new")).toBe('"new"');
});

/** Locally too, a chip asks for the scaled copy, and the header says what the original weighs. */
test("a local picture GET asks for a size and remembers the original's", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return new Response(new Uint8Array([1, 2]), { headers: { "X-Original-Size": "3727854" } });
  }) as typeof fetch;
  const api = new LocalApi({ origin: "http://fixture", token: "fixture" });
  const chip = await api.getAttachmentBlob("pic", undefined, { size: "thumb" });
  const shot = await api.getWorkspaceFileBlob("shots/a.png", undefined, { size: "preview" });
  expect(urls).toEqual([
    "http://fixture/v1/attachments/pic/content?size=thumb",
    "http://fixture/v1/workspace/file?path=shots%2Fa.png&size=preview",
  ]);
  expect(originalSizeForBlob(chip)).toBe(3_727_854);
  expect(originalSizeForBlob(shot)).toBe(3_727_854);
});
