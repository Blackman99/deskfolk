import { afterEach, expect, mock, test } from "bun:test";
import { flushSync } from "svelte";
import type { RuntimeSnapshot } from "@real-bot/protocol";
import type { MessengerRuntime } from "./runtime.svelte.ts";
import { reactive } from "./test-reactive.svelte.ts";
import { render } from "./test-render.ts";
import { aBot, aDirect } from "./test-fixtures.ts";
import { emptySnapshot } from "./snapshot.ts";
import { overlayFromFlags, overlayFromUrl } from "./session-url.ts";

const page = reactive({ url: new URL("http://localhost/") });
const navigations: string[] = [];
mock.module("$app/state", () => ({ page }));
mock.module("$app/navigation", () => ({
  async goto(target: string) {
    navigations.push(target);
    page.url = new URL(target, page.url);
  },
}));
// Keep the actual page effects and runtime; the Shell's own effects are outside this startup test.
mock.module("$lib/Shell.svelte", () => ({ default: () => {} }));
const { default: Page } = await import("../routes/+page.svelte");

const originalFetch = globalThis.fetch;
const OriginalSocket = globalThis.WebSocket;
let close: (() => void) | null = null;
const cursor = { event_instance_id: "a".repeat(32), watermark_seq: 0 };
class Socket extends EventTarget {
  constructor(_url: string) {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send() {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ready", ...cursor }) })));
  }
  close() { this.dispatchEvent(new Event("close")); }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    flushSync();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("page did not reach expected state");
}

afterEach(() => {
  close?.(); close = null;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalSocket;
  navigations.length = 0;
});

for (const query of [
  "?o=settings",
  "?s=direct-1&o=session",
  "?s=direct-1&o=bot&b=bot-1",
  "?o=workspace&w=notes.txt",
]) test(`real page preserves ${query} while initial snapshot is delayed`, async () => {
  page.url = new URL(query, "http://localhost/");
  const wanted = overlayFromUrl(page.url);
  let release!: (snapshot: RuntimeSnapshot) => void;
  const snapshot = new Promise<RuntimeSnapshot>((resolve) => { release = resolve; });
  let snapshotRequested = false;
  let detailLoaded = false;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path === "/__local-api") return Response.json({ port: 17891, token: "fixture" });
    if (path.endsWith("/v1/health")) return Response.json({ ok: true, name: "real-bot" });
    if (path.endsWith("/v1/snapshot")) { snapshotRequested = true; return Response.json(await snapshot); }
    if (path.endsWith("/snapshot")) {
      detailLoaded = true;
      return Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: null }, turns: [] }, judgements: [] });
    }
    return Response.json({ items: [] });
  }) as typeof fetch;
  const view = render(Page, {});
  close = view.close;
  const runtime = (window as unknown as { __runtime: MessengerRuntime }).__runtime;
  await until(() => snapshotRequested);
  expect(runtime.connection).toBe("disconnected");
  expect(overlayFromUrl(page.url)).toEqual(wanted);
  expect(overlayFromFlags(runtime)).toEqual(wanted);
  expect(navigations).toEqual([]);
  const initial = emptySnapshot();
  release({ ...initial, ...cursor, settings: { ...initial.settings, workspace_path: "/fixture", wizard_complete: true }, bots: [aBot()], sessions: [aDirect()] });
  await until(() => runtime.connection === "connected" && (!query.includes("?s=") || detailLoaded));
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  expect(overlayFromUrl(page.url)).toEqual(wanted);
  expect(overlayFromFlags(runtime)).toEqual(wanted);
  expect(navigations).toEqual([]);
});
