import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { discoverEndpoint } from "./local-discovery-stub.ts";
import { LocalApi } from "./local-api-stub.ts";

test("hosted discovery stub never fetches __local-api", async () => {
  const fetchFn = (async () => {
    throw new Error("hosted messenger must not discover a local bearer");
  }) as typeof fetch;
  await expect(discoverEndpoint(fetchFn)).resolves.toBeNull();
});

test("hosted LocalApi stub refuses to construct a loopback client", () => {
  expect(() => new LocalApi({ origin: "http://127.0.0.1:17890", token: "secret-bearer" })).toThrow(/hosted messenger/);
});

test("local-only sources keep the discovery path that hosted stubs omit", () => {
  const local = readFileSync(new URL("../local-api.ts", import.meta.url), "utf8");
  const discovery = readFileSync(new URL("../local-discovery.ts", import.meta.url), "utf8");
  const stubApi = readFileSync(new URL("./local-api-stub.ts", import.meta.url), "utf8");
  const stubDiscovery = readFileSync(new URL("./local-discovery-stub.ts", import.meta.url), "utf8");
  expect(local).toContain("Bearer");
  expect(discovery).toContain("LOCAL_API_DISCOVERY_PATH");
  expect(discovery).toContain("@real-bot/protocol/local-discovery");
  expect(stubApi).not.toContain("Bearer");
  expect(stubApi).not.toContain("__local-api");
  expect(stubDiscovery).not.toContain("__local-api");
  expect(stubDiscovery).not.toContain("Bearer");
  expect(stubDiscovery).not.toContain("LOCAL_API_DISCOVERY_PATH");
});

test("service worker source caches immutable assets only", () => {
  const sw = readFileSync(new URL("../../../static/sw.js", import.meta.url), "utf8");
  expect(sw).toContain("/_app/immutable/");
  expect(sw).toContain('request.mode === "navigate"');
  expect(sw).toContain("if (request.method !== \"GET\") return");
  expect(sw).toContain("if (request.mode === \"navigate\" || !isImmutable(request.url)) return");
  expect(sw).toContain('addEventListener("push"');
  expect(sw).toContain('addEventListener("notificationclick"');
  expect(sw).toContain('postMessage({ type: "inbox" })');
  expect(sw).toContain('openWindow("/")');
  expect(sw).not.toContain("/approvals/");
  expect(sw).not.toContain("allow_once");
  expect(sw).not.toContain("resolveApproval");
  expect(sw).not.toContain("caches.open(\"chat");
});
