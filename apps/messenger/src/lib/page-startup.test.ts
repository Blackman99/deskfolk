import { afterEach, expect, mock, test } from "bun:test";
import { flushSync } from "svelte";
import type { RuntimeSnapshot } from "@real-bot/protocol";
import type { MessengerRuntime } from "./runtime.svelte.ts";
import { reactive } from "./test-reactive.svelte.ts";
import { fill, render } from "./test-render.ts";
import RoutineCard from './panels/RoutineCard.svelte';
import { copyFor } from './copy.ts';
import { aBot, aDirect, aRoutine } from "./test-fixtures.ts";
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

test('routine search from the empty stage selects its Bot conversation before opening the profile URL', async () => {
  page.url = new URL('http://localhost/');
  const initial = emptySnapshot();
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path === '/__local-api') return Response.json({ port: 17893, token: 'fixture' });
    if (path.endsWith('/v1/health')) return Response.json({ ok: true, name: 'real-bot' });
    if (path.endsWith('/v1/snapshot')) return Response.json({ ...initial, ...cursor, bots: [aBot()], sessions: [aDirect()] });
    if (path.endsWith('/snapshot')) return Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: null }, turns: [] }, judgements: [] });
    return Response.json({ items: [] });
  }) as typeof fetch;
  close = render(Page, {}).close;
  const runtime = (window as unknown as { __runtime: MessengerRuntime }).__runtime;
  await until(() => runtime.connection === 'connected');
  runtime.openRoutine('bot-1', 'routine-1');
  await until(() => page.url.searchParams.get('b') === 'bot-1');
  expect(runtime.selectedId).toBe('direct-1');
  expect(runtime.profileBotId).toBe('bot-1');
  expect(runtime.profileRoutineId).toBe('routine-1');
  expect(runtime.sessionSettingsOpen).toBe(true);
});

for (const newer of ['routine', 'profile', 'dismiss', 'nested-back', 'settings', 'session-settings', 'url-dismiss'] as const) test(`pending routine A cannot replace newer ${newer} navigation or a dirty B draft`, async () => {
  page.url = new URL('http://localhost/');
  const initial = emptySnapshot();
  const routines = [aRoutine({ id: 'a', title: 'A' }), aRoutine({ id: 'b', title: 'B' })];
  let release!: () => void;
  let requested = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path === '/__local-api') return Response.json({ port: 17893, token: 'fixture' });
    if (path.endsWith('/v1/health')) return Response.json({ ok: true, name: 'real-bot' });
    if (path.endsWith('/v1/snapshot')) return Response.json({ ...initial, ...cursor, bots: [aBot(), aBot({ id: 'bot-2' })], sessions: [aDirect()], routines });
    if (path.endsWith('/snapshot')) {
      requested = true;
      await held;
      return Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: null }, turns: [] }, judgements: [] });
    }
    return Response.json({ items: [] });
  }) as typeof fetch;
  close = render(Page, {}).close;
  const runtime = (window as unknown as { __runtime: MessengerRuntime }).__runtime;
  await until(() => runtime.connection === 'connected');
  const pending = runtime.openRoutine('bot-1', 'a');
  await until(() => requested);
  let card: ReturnType<typeof render> | undefined;
  if (newer === 'routine') {
    await runtime.openRoutine('bot-1', 'b');
    card = render(RoutineCard, { runtime, bot: aBot(), t: copyFor('en') });
    fill(card.host.querySelector('#routine-title'), 'Unsaved B draft');
  } else if (newer === 'profile') runtime.openProfile('bot-2');
  else if (newer === 'dismiss') runtime.closeSessionSettings();
  else if (newer === 'nested-back') runtime.closeProfile();
  else if (newer === 'settings') runtime.openSettings();
  else if (newer === 'session-settings') runtime.openSessionSettings();
  else runtime.applyOverlay({ kind: 'none' });
  flushSync();
  const expected = overlayFromFlags(runtime);
  release();
  await pending;
  flushSync();
  expect(overlayFromFlags(runtime)).toEqual(expected);
  expect(runtime.profileRoutineId).not.toBe('a');
  if (card) {
    expect((card.host.querySelector('#routine-title') as HTMLInputElement).value).toBe('Unsaved B draft');
    expect(card.host.querySelector('.routine-row.is-open')?.getAttribute('data-routine-id')).toBe('b');
    card.close();
  }
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
  // The snapshot is in flight, so the page is connecting rather than declaring the host gone.
  expect(runtime.connection).toBe("connecting");
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
