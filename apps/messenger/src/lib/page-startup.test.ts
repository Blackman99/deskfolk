import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { flushSync } from "svelte";
import type { RuntimeSnapshot } from "@real-bot/protocol";
import type { MessengerRuntime } from "./runtime.svelte.ts";
import { reactive } from "./test-reactive.svelte.ts";
import { fill, render } from "./test-render.ts";
import RoutineCard from './panels/RoutineCard.svelte';
import { copyFor } from './copy.ts';
import { aBot, aDirect, aGroup, aRoutine } from "./test-fixtures.ts";
import { emptySnapshot } from "./snapshot.ts";
import { overlayFromFlags, overlayFromUrl } from "./session-url.ts";

const page = reactive({ url: new URL("http://localhost/") });
const navigations: string[] = [];
/** How each navigation was made, and the history entries they left behind. */
const navigationModes: Array<"push" | "replace"> = [];
const entries: string[] = ["/"];
let beforeNavigation: (navigation: { type: string; delta?: number; cancel: () => void }) => void;
let settingsBackHandled = false;
let settingsBackCalls = 0;
let mountRealShell = false;
mock.module("$app/state", () => ({ page }));
mock.module("$app/navigation", () => ({
  beforeNavigate(callback: typeof beforeNavigation) { beforeNavigation = callback; },
  async goto(target: string, opts?: { replaceState?: boolean }) {
    navigations.push(target);
    navigationModes.push(opts?.replaceState ? "replace" : "push");
    if (opts?.replaceState) entries[entries.length - 1] = target;
    else entries.push(target);
    page.url = new URL(target, page.url);
  },
}));
// Keep the actual page effects and runtime; the Shell's own effects are outside this startup test.
// Bun keeps a module mock for the rest of the run, so the real Shell goes back afterwards: a file
// that runs after this one (Shell.test.ts, on Linux) would otherwise mount the stub and find nothing.
const { default: RealShell } = await import("$lib/Shell.svelte");
afterAll(() => {
  mock.module("$lib/Shell.svelte", () => ({ default: RealShell }));
});
mock.module("$lib/Shell.svelte", () => ({ default: (...args: Parameters<typeof RealShell>) => mountRealShell ? RealShell(...args) : ({
  backMobileLayer() { settingsBackCalls++; return settingsBackHandled; },
}) }));
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
  navigationModes.length = 0;
  entries.length = 0;
  entries.push("/");
  settingsBackHandled = false;
  settingsBackCalls = 0;
  mountRealShell = false;
});

test('page cancels browser Back only when a layer above the URL consumes the step', async () => {
  page.url = new URL('http://localhost/?o=settings');
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path === '/__local-api') return Response.json({ port: 17893, token: 'fixture' });
    if (path.endsWith('/v1/health')) return Response.json({ ok: true, name: 'real-bot' });
    if (path.endsWith('/v1/snapshot')) return Response.json({ ...emptySnapshot(), ...cursor });
    return Response.json({ items: [] });
  }) as typeof fetch;
  close = render(Page, {}).close;
  const runtime = (window as unknown as { __runtime: MessengerRuntime }).__runtime;
  await until(() => runtime.connection === 'connected');
  settingsBackHandled = true;
  let cancelled = 0;
  const cancel = () => { cancelled++; };
  beforeNavigation({ type: 'popstate', delta: -1, cancel });
  expect(cancelled).toBe(1);
  expect(settingsBackCalls).toBe(1);
  expect(runtime.settingsOpen).toBe(true);
  beforeNavigation({ type: 'popstate', delta: 1, cancel });
  beforeNavigation({ type: 'goto', cancel });
  expect(settingsBackCalls).toBe(1);
  settingsBackHandled = false;
  beforeNavigation({ type: 'popstate', delta: -1, cancel });
  expect(settingsBackCalls).toBe(2);
  expect(cancelled).toBe(1);
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
  "?s=direct-1&o=trace&k=task-1",
  "?o=routines",
  "?o=spend",
  "?s=direct-1&o=spend",
  "?o=terminal",
  "?s=direct-1&o=terminal",
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

for (const kind of ['routines', 'spend', 'terminal'] as const) for (const selectedId of [null, 'direct-1', 'direct-2']) test(`selecting a conversation leaves ${kind} opened over ${selectedId ?? 'the roster'}`, async () => {
  const query = selectedId ? `?s=${selectedId}&o=${kind}` : `?o=${kind}`;
  const isOpen = (runtime: MessengerRuntime) => kind === 'spend' ? runtime.spendOpen : kind === 'terminal' ? runtime.terminalOpen : runtime.routinesOpen;
  page.url = new URL(query, 'http://localhost/');
  entries[0] = `/${query}`;
  const sessions = [aDirect(), aDirect({ id: 'direct-2' })];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path === '/__local-api') return Response.json({ port: 17893, token: 'fixture' });
    if (path.endsWith('/v1/health')) return Response.json({ ok: true, name: 'real-bot' });
    if (path.endsWith('/v1/snapshot')) return Response.json({ ...emptySnapshot(), ...cursor, bots: [aBot()], sessions });
    if (path.endsWith('/snapshot')) {
      const session = sessions.find((item) => path.includes(item.id))!;
      return Response.json({ ...cursor, session: { ...session, messages: { items: [], next: null }, turns: [] }, judgements: [] });
    }
    return Response.json({ items: [] });
  }) as typeof fetch;
  close = render(Page, {}).close;
  const runtime = (window as unknown as { __runtime: MessengerRuntime }).__runtime;
  await until(() => runtime.connection === 'connected');
  expect(isOpen(runtime)).toBe(true);
  await runtime.selectSession('direct-1');
  await until(() => page.url.search === '?s=direct-1');
  expect(isOpen(runtime)).toBe(false);
  expect(runtime.selectedId).toBe('direct-1');

  // History restores the page even after switching conversations.
  page.url = new URL(query, page.url);
  await until(() => isOpen(runtime) && runtime.selectedId === selectedId);
  page.url = new URL('?s=direct-1', page.url);
  await until(() => !isOpen(runtime) && runtime.selectedId === 'direct-1');
});

test('opening a screen pushes, closing it walks back, and a deep link rewrites its own entry', async () => {
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
  const previousBack = window.history.back;
  // The real Back lands on the entry underneath, which is what the page's plan counts on.
  window.history.back = () => {
    entries.pop();
    page.url = new URL(entries[entries.length - 1]!, page.url);
    flushSync();
  };
  try {
    close = render(Page, {}).close;
    const runtime = (window as unknown as { __runtime: MessengerRuntime }).__runtime;
    await until(() => runtime.connection === 'connected');

    await runtime.selectSession('direct-1');
    await until(() => page.url.searchParams.get('s') === 'direct-1');
    runtime.openSessionSettings();
    await until(() => page.url.searchParams.get('o') === 'session');
    expect(navigationModes).toEqual(['push', 'push']);
    expect(entries).toEqual(['/', '/?s=direct-1', '/?s=direct-1&o=session']);

    // Closing the drawer must not leave another entry in front of the one that opened it.
    runtime.closeSessionSettings();
    await until(() => page.url.searchParams.get('o') === null);
    expect(navigationModes).toEqual(['push', 'push']);
    expect(entries).toEqual(['/', '/?s=direct-1']);
    expect(runtime.sessionSettingsOpen).toBe(false);

    // And once more, back to the roster.
    runtime.selectedId = null;
    await until(() => page.url.search === '');
    expect(entries).toEqual(['/']);

    // A screen opened with nothing of ours underneath rewrites its entry instead.
    entries.length = 0;
    entries.push('/?s=direct-1&o=session');
    page.url = new URL('http://localhost/?s=direct-1&o=session');
    flushSync();
    navigationModes.length = 0;
    await until(() => runtime.sessionSettingsOpen);
    runtime.closeSessionSettings();
    await until(() => page.url.searchParams.get('o') === null);
    expect(navigationModes).toEqual(['replace']);
    expect(entries).toEqual(['/?s=direct-1']);
  } finally {
    window.history.back = previousBack;
  }
});

test('a Bot opened from group settings leaves the conversation underneath, so Back returns there', async () => {
  page.url = new URL('http://localhost/');
  entries.length = 0;
  entries.push('/');
  navigationModes.length = 0;
  const group = aGroup({ id: 'g1' });
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path === '/__local-api') return Response.json({ port: 17893, token: 'fixture' });
    if (path.endsWith('/v1/health')) return Response.json({ ok: true, name: 'real-bot' });
    if (path.endsWith('/v1/snapshot')) return Response.json({ ...emptySnapshot(), ...cursor, bots: [aBot(), aBot({ id: 'bot-2', name: 'Beta' })], sessions: [group] });
    if (path.endsWith('/snapshot')) return Response.json({ ...cursor, session: { ...group, messages: { items: [], next: null }, turns: [] }, judgements: [] });
    return Response.json({ items: [] });
  }) as typeof fetch;
  const previousBack = window.history.back;
  window.history.back = () => {
    entries.pop();
    page.url = new URL(entries[entries.length - 1]!, page.url);
    flushSync();
  };
  try {
    close = render(Page, {}).close;
    const runtime = (window as unknown as { __runtime: MessengerRuntime }).__runtime;
    await until(() => runtime.connection === 'connected');
    await runtime.selectSession('g1');
    await until(() => page.url.searchParams.get('s') === 'g1');
    runtime.openSessionSettings();
    await until(() => page.url.searchParams.get('o') === 'session');
    runtime.openProfile('bot-1');
    await until(() => page.url.searchParams.get('o') === 'bot');
    expect(entries).toEqual(['/', '/?s=g1', '/?s=g1&o=bot&b=bot-1']);
    runtime.closeSessionSettings();
    await until(() => page.url.searchParams.get('o') === null);
    expect(entries).toEqual(['/', '/?s=g1']);
    expect(runtime.sessionSettingsOpen).toBe(false);
    expect(runtime.profileBotId).toBeNull();
  } finally {
    window.history.back = previousBack;
  }
});

test('a back step this page asked for is not mistaken for a Back press', async () => {
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
  const previousBack = window.history.back;
  window.history.back = () => {
    entries.pop();
    page.url = new URL(entries[entries.length - 1]!, page.url);
    flushSync();
  };
  try {
    close = render(Page, {}).close;
    const runtime = (window as unknown as { __runtime: MessengerRuntime }).__runtime;
    await until(() => runtime.connection === 'connected');
    await runtime.selectSession('direct-1');
    await until(() => page.url.searchParams.get('s') === 'direct-1');
    runtime.openSessionSettings();
    await until(() => page.url.searchParams.get('o') === 'session');

    // The Shell would happily close another layer; closing the drawer here is not its business.
    settingsBackHandled = true;
    settingsBackCalls = 0;
    let cancelled = 0;
    runtime.closeSessionSettings();
    await until(() => page.url.searchParams.get('o') === null);
    beforeNavigation({ type: 'popstate', delta: -1, cancel: () => { cancelled++; } });
    expect(cancelled).toBe(0);
    expect(settingsBackCalls).toBe(0);
    // The next real Back is the person's again.
    beforeNavigation({ type: 'popstate', delta: -1, cancel: () => { cancelled++; } });
    expect(settingsBackCalls).toBe(1);
    expect(cancelled).toBe(1);
  } finally {
    window.history.back = previousBack;
  }
});

for (const restored of [false, true]) test(`real page and Shell keep desktop Spend and URL aligned (${restored ? 'saved tab' : 'deep link'})`, async () => {
  mountRealShell = true;
  localStorage.removeItem('real-bot-workbench-layout');
  if (restored) localStorage.setItem('real-bot-workbench-layout', JSON.stringify({
    version: 1, root: { type: 'leaf', id: 'root', tabs: [
      { id: 'chat', kind: 'chat', params: { sessionId: 'direct-1' } },
      { id: 'spend', kind: 'spend', params: {} },
    ], activeTabId: 'spend' }, floating: [], focus: { zone: 'tiled', leafId: 'root' },
  }));
  page.url = new URL(`http://localhost/?s=direct-1${restored ? '' : '&o=spend'}`);
  entries[0] = `${page.url.pathname}${page.url.search}`;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path === '/__local-api') return Response.json({ port: 17893, token: 'fixture' });
    if (path.endsWith('/v1/health')) return Response.json({ ok: true, name: 'real-bot' });
    if (path.endsWith('/v1/snapshot')) return Response.json({ ...emptySnapshot(), ...cursor,
      settings: { ...emptySnapshot().settings, wizard_complete: true, locale: 'en' }, bots: [aBot()], sessions: [aDirect()] });
    if (path.endsWith('/snapshot')) return Response.json({ ...cursor, session: { ...aDirect(), messages: { items: [], next: null }, turns: [] }, judgements: [] });
    return Response.json({ items: [] });
  }) as typeof fetch;
  const previousBack = window.history.back;
  window.history.back = () => {
    beforeNavigation({ type: 'popstate', delta: -1, cancel() {} });
    entries.pop(); page.url = new URL(entries.at(-1)!, page.url);
  };
  try {
    const rendered = render(Page, {}); close = rendered.close;
    const runtime = (window as unknown as { __runtime: MessengerRuntime }).__runtime;
    await until(() => runtime.connection === 'connected' && !!rendered.host.querySelector('[data-spend-view]'));
    expect(page.url.search).toBe('?s=direct-1&o=spend');
    expect(runtime.spendOpen).toBe(true);
    runtime.openSpend(); runtime.openSpend(); flushSync();
    expect(rendered.host.querySelectorAll('.wb-tab-button')).toHaveLength(2);
    await runtime.openChat('direct-1');
    await until(() => page.url.search === '?s=direct-1' && !!rendered.host.querySelector('.pane-conversation'));
    runtime.openSpend();
    await until(() => page.url.searchParams.get('o') === 'spend');
    let cancelled = false;
    beforeNavigation({ type: 'popstate', delta: -1, cancel() { cancelled = true; } });
    expect(cancelled).toBe(false);
    entries.pop(); page.url = new URL(entries.at(-1)!, page.url);
    await until(() => !runtime.spendOpen && !!rendered.host.querySelector('.pane-conversation'));
    expect(page.url.search).toBe('?s=direct-1');
  } finally {
    window.history.back = previousBack;
    localStorage.removeItem('real-bot-workbench-layout');
  }
});
