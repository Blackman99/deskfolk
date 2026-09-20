import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { discoverEndpoint } from "./local-discovery-stub.ts";
import { LocalApi } from "./local-api-stub.ts";
import { shouldCacheRequest } from "./sw-policy.ts";

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
  expect(shouldCacheRequest({ method: "GET", mode: "navigate", url: "https://relay.test/" })).toBe(false);
});

test("hosted layout registers the worker from the compile flag, not import.meta.env", () => {
  const layout = readFileSync(new URL("../../routes/+layout.svelte", import.meta.url), "utf8");
  expect(layout).toContain("HOSTED_MESSENGER");
  expect(layout).toContain("serviceWorker.register('/sw.js')");
  expect(layout).not.toContain("import.meta.env.REAL_BOT_HOSTED");
});
