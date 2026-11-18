import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../../../assets/phone/sw.js", import.meta.url), "utf8");

/** The worker's top-level functions, evaluated as the browser would, at https://relay.test. */
function workerScope() {
  const scope: Record<string, any> = {
    URL, Headers, Response,
    importScripts: () => {},
    self: { location: { origin: "https://relay.test" }, addEventListener: () => {} },
  };
  runInNewContext(source, scope);
  return scope;
}

test("service worker source caches immutable assets only", () => {
  expect(source).toContain('request.mode === "navigate"');
  expect(source).toContain("if (request.method !== \"GET\") return");
  expect(source).toContain("if (request.mode === \"navigate\" || !isImmutable(request.url)) return");
  expect(source).toContain('addEventListener("push"');
  expect(source).toContain('addEventListener("notificationclick"');
  expect(source).toContain('postMessage({ type: "inbox" })');
  expect(source).toContain('openWindow("/")');
  expect(source).not.toContain("/approvals/");
  expect(source).not.toContain("allow_once");
  expect(source).not.toContain("resolveApproval");
  expect(source).not.toContain("caches.open(\"chat");
});

test("the worker keeps exactly the files the relay marks immutable: those named by their content", () => {
  const { isImmutable } = workerScope();
  for (const path of [
    "/nsh.e75c59e7da.wasm",
    "/nsh-rich-editor~text-view.964773d56a.wasm",
    "/Main.ab7ce2ebb9.js",
    "/browser.bb691213db/dom.js",
    "/facades/nsh-base.5a0e445ec4.js",
    "/nsh-giallo.ef6301510b.bin",
    "/nsh-page.6c2c70f7ae.css",
  ]) expect(isImmutable(`https://relay.test${path}`), path).toBe(true);
  for (const path of [
    "/",
    "/?s=01ARZ3NDEKTSV4RRFFQ69G5FAV&o=settings",
    "/index.html",
    "/sw.js",
    "/media-stream.js",
    "/manifest.webmanifest",
    "/_app/version.json",
    "/v1/relay/device",
    "/__remote_media/abc",
    "/nsh.e75c59e7d.wasm",
    "/nsh.E75C59E7DA.wasm",
  ]) expect(isImmutable(`https://relay.test${path}`), path).toBe(false);
  // Another origin's file is never kept, even one named like ours.
  expect(isImmutable("https://outside.test/nsh.e75c59e7da.wasm")).toBe(false);
});

test("a kept copy describes the decoded body it holds, and its size is that body's", async () => {
  const { stampedClone, byteSizeOf, usedAtOf } = workerScope();
  // What `fetch` hands the worker for a `.br` the relay sent: the body decoded, the wire's headers kept.
  const body = new Uint8Array(12_000);
  const fetched = new Response(body, { status: 200, headers: { "content-type": "application/wasm", "content-encoding": "br", "content-length": "3600" } });
  const kept = await stampedClone(fetched, 1234);
  expect(kept.status).toBe(200);
  expect(kept.headers.get("content-type")).toBe("application/wasm");
  expect(kept.headers.get("content-encoding")).toBeNull();
  expect(kept.headers.get("content-length")).toBeNull();
  expect(usedAtOf(kept)).toBe(1234);
  expect(byteSizeOf(kept)).toBe(12_000);
  expect((await kept.arrayBuffer()).byteLength).toBe(12_000);
});
