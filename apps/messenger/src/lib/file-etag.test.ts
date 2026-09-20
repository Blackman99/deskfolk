import { afterEach, expect, test } from "bun:test";
import { ApiError, etagForBlob, LocalApi } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

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
