import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { spendCopyFor } from "../spend/spend-copy.ts";
import { aBot, aProjectSession, aBotDirect, aDirect, aGroup, aMessage, aRoutine, aTurn, anApproval, fakeRuntime } from "../test-fixtures.ts";
import type { Snapshot } from "../snapshot.ts";
import { click, press, render } from "../test-render.ts";
import Sidebar from "./Sidebar.svelte";
import { updateChecker } from "../update-checker.svelte.ts";

import { flushSync } from 'svelte';
import { reactive } from '../test-reactive.svelte.ts';
import { focusMode } from '../chat/focus-mode.svelte.ts';

const t = copyFor("zh");

function botDms(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return aBotDirect({
      id: `d-${n}`,
      last_message: aMessage({ created_at: `2026-09-19T${n}:00:00.000Z` }),
    });
  });
}

/** `workbench` defaults to what the desktop app has: a workbench wherever the list is wider than a phone. */
function open(sessions: ReturnType<typeof aBotDirect>[], selectedId: string | null = null, live = false, created: string[] = [], pinnedSessionIds: string[] = [], workbench = !window.matchMedia("(max-width: 680px)").matches, extra: Record<string, unknown> = {}) {
  const stub = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "Writer" }), aBot({ id: "bot-2", name: "Researcher" })],
    sessions: [aGroup({ id: "sess-1", name: "视频组" }), ...sessions, ...((extra.projects as ReturnType<typeof aProjectSession>[] | undefined) ?? [])],
  });
  const runtime = live ? reactive(stub) : stub;
  if (live) {
    runtime.openRoutines = () => {
      runtime.routinesOpen = true;
    };
    runtime.closeRoutines = () => {
      runtime.routinesOpen = false;
    };
  }
  runtime.selectedId = selectedId;
  const view = render(Sidebar, {
    runtime,
    t,
    selected: null,
    pinnedSessionIds,
    workspaceOpen: false,
    contextMenuSessionId: null,
    onOpenContextMenu: () => {},
    onToggleWorkspace: () => created.push("workspace"),
    onOpenRoutines: () => created.push("routines"),
    onOpenSpend: () => created.push("spend"),
    workbench,
    onNewTerminal: () => created.push("terminal"),
    onOpenSettings: () => created.push("settings"),
    onCreateBot: () => created.push("bot"),
    onCreateGroup: () => created.push("group"),
    onOpenSearch: () => created.push("search"),
    ...(extra.phoneList ? { phoneList: extra.phoneList } : {}),
  });
  return { ...view, runtime, created };
}

test("the file drop is listed above the groups, on the desktop as well as a remote connection", () => {
  const drop = aDirect({
    id: FILE_DROP_SESSION_ID,
    participants: [{ member: "user", joined_at: "t", left_at: null }],
    last_message: aMessage({ body: "shot.png", session_id: FILE_DROP_SESSION_ID }),
  });
  const view = open([aBotDirect(), drop]);
  const row = [...view.host.querySelectorAll(".row")].find((el) => el.textContent?.includes(t.sidebar.fileDrop));
  expect(row).toBeTruthy();
  expect(view.host.querySelector(".ghead")?.textContent).toContain(t.sidebar.fileDrop);
  view.close();
});

test("a pinned file drop is listed with the pins only, under its own mark", () => {
  const drop = aDirect({
    id: FILE_DROP_SESSION_ID,
    participants: [{ member: "user", joined_at: "t", left_at: null }],
    last_message: aMessage({ body: "shot.png", session_id: FILE_DROP_SESSION_ID }),
  });
  const view = open([aBotDirect(), drop], null, false, [], [FILE_DROP_SESSION_ID]);
  const pin = view.host.querySelector(".pinned-session-btn");
  expect(pin?.textContent).toContain(t.sidebar.fileDrop);
  expect(pin?.querySelector(".file-drop-mark")).not.toBeNull();
  // Its section goes with it: no heading, no second row.
  expect([...view.host.querySelectorAll(".ghead")].some((el) => el.textContent?.includes(t.sidebar.fileDrop))).toBe(false);
  expect([...view.host.querySelectorAll(".row")].some((el) => el.textContent?.includes(t.sidebar.fileDrop))).toBe(false);
  view.close();
});

/** ADR 0091: a Bot↔Bot direct opens from the message it hangs under, in a popup; the list has none. */
test("Bot↔Bot directs are not listed, however many there are, and have no heading", () => {
  const { host, close } = open(botDms(7));
  expect(host.querySelectorAll(".row-stack, .row-source, .ghead-more")).toHaveLength(0);
  expect([...host.querySelectorAll(".ghead")].some((el) => el.textContent?.includes(t.sidebar.botBot))).toBe(false);
  expect([...host.querySelectorAll(".row .t")].map((el) => el.textContent?.trim())).toEqual(["视频组"]);
  close();
});

test("a Bot↔Bot direct pinned before stays out of the pins too", () => {
  const { host, close } = open(botDms(1), null, false, [], ["d-01"]);
  expect(host.textContent).not.toContain("Writer ↔ Researcher");
  close();
});

/** You cannot reply one away, so a permanent badge would just be noise. */
test("the session list has no notification bell or inbox entry", () => {
  const { host, close } = open([]);
  expect(host.querySelector(".notification-bell-btn, .mobile-bell-btn")).toBeNull();
  expect(host.textContent).not.toContain(t.sidebar.notifications);
  close();
});

test("a failed conversation shows that state on its row", () => {
  const session = aDirect({
    id: "sess-failed",
    last_message: aMessage({
      id: "msg-fail",
      session_id: "sess-failed",
      kind: "system",
      author: "bot-1",
      body: "这一轮没写完：连不上端点",
    }),
  });
  const { host, close } = open([session]);
  const row = [...host.querySelectorAll(".row")].find((el) => el.textContent?.includes("Writer"));
  expect(row?.querySelector(".row-status")?.className).toContain("is-failed");
  expect(row?.textContent).toContain(t.sidebar.statusFailed);
  close();
});

/**
 * Phone width, with the media listener kept so a window that grows back can be tested too. The
 * 680px query is the one the stylesheet uses; reduced motion keeps the page slide out of the way,
 * since a running animation has nothing to say about what the screen holds.
 */
async function withPhone(run: (grow: () => void) => void | Promise<void>): Promise<void> {
  const previous = window.matchMedia;
  const listeners = new Set<(ev: MediaQueryListEvent) => void>();
  let narrow = true;
  window.matchMedia = ((query: string) => ({
    get matches() {
      if (query === "(prefers-reduced-motion: reduce)") return true;
      return query === "(max-width: 680px)" ? narrow : false;
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    // Only the width the sidebar switches at changes here; other queries (a sheet's) stay put.
    addEventListener: (_: string, fn: (ev: MediaQueryListEvent) => void) => void (query === "(max-width: 680px)" && listeners.add(fn)),
    removeEventListener: (_: string, fn: (ev: MediaQueryListEvent) => void) => void listeners.delete(fn),
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    return await run(() => {
      narrow = false;
      for (const fn of listeners) fn({} as MediaQueryListEvent);
      flushSync();
    });
  } finally {
    window.matchMedia = previous;
  }
}

test('mobile archive entry opens an empty archive and returns to active sessions', () => {
  withPhone(() => {
    const { host, close } = open([], null, true);
    click(host.querySelector('.tools-entry'));
    click(host.querySelector('.tools-menu-archived'));
    expect(host.querySelector('.archived-empty-hint')?.textContent).toContain(t.sidebar.archivedEmpty);
    expect(host.querySelector('.mobile-archived-title')?.textContent).toContain(t.sidebar.archivedSessions);
    click(host.querySelector('.mobile-archived-back'));
    expect(host.querySelector('.archived-empty-hint')).toBeNull();
    expect(host.querySelector('.groups')?.textContent).toContain('视频组');
    close();
  });
});

test("both widths open global search from a button", async () => {
  const check = () => {
    const { host, created, close } = open([], null, true);
    expect(host.querySelector('input.search, .search-drop, .search-page')).toBeNull();
    click(host.querySelector('.search-trigger'));
    expect(created).toContain('search');
    close();
  };
  check();
  await withPhone(check);
});

test("creating on a phone is one floating button, asking which once", () => {
  withPhone(() => {
    const created: string[] = [];
    const { host, close } = open([], null, true, created);
    // The 22px + in each group header is a poor target at the top of a phone screen, and there
    // were two of them; neither is on the phone's list any more.
    const fab = host.querySelector('.fab');
    expect(fab).not.toBeNull();
    expect(host.querySelector('.fab-menu')).toBeNull();

    click(fab);
    const items = [...host.querySelectorAll('.fab-menu-item')].map((b) => b.textContent?.trim());
    // The Bots' page makes Bots and groups; the projects have a page and a + of their own.
    expect(items).toEqual([t.sidebar.addBot, t.sidebar.addGroup]);
    expect(fab?.getAttribute('aria-expanded')).toBe('true');

    click(host.querySelectorAll('.fab-menu-item')[1]);
    expect(created).toEqual(['group']);
    expect(host.querySelector('.fab-menu')).toBeNull();

    click(host.querySelector('.fab'));
    click(host.querySelectorAll('.fab-menu-item')[0]);
    expect(created).toEqual(['group', 'bot']);
    close();
  });
});

test("a phone's projects page lists only the projects, and its + makes only project sessions", () => {
  withPhone(() => {
    const projects = [aProjectSession({ id: "p1", name: "Fix login", project_dir: "/Users/a/proj" })];
    const bots = open([aBotDirect()], null, true, [], [], false, { phoneList: "bots", projects });
    expect(bots.host.querySelector("[data-project-dir]")).toBeNull();
    expect(bots.host.textContent).toContain(t.sidebar.youBot);
    bots.close();
    const { host, runtime, close } = open([aBotDirect()], null, true, [], [], false, { phoneList: "projects", projects });
    expect(host.querySelector('[data-project-dir="/Users/a/proj"]')).not.toBeNull();
    expect(host.textContent).not.toContain(t.sidebar.youBot);
    expect(host.textContent).not.toContain(t.sidebar.groups);
    click(host.querySelector(".fab"));
    expect([...host.querySelectorAll(".fab-menu-item")].map((b) => b.textContent?.trim())).toEqual([t.project.newInFolder, t.project.importSession]);
    click(host.querySelector('.fab-menu-item[data-project-add="import"]'));
    expect(runtime.calls.filter((c) => c.name === "openCreateProject").map((c) => c.args)).toEqual([["import"]]);
    close();
  });
});

test("an empty projects page says how to start one", () => {
  withPhone(() => {
    const { host, close } = open([aBotDirect()], null, true, [], [], false, { phoneList: "projects" });
    expect(host.textContent).toContain(t.project.emptyList);
    expect(host.querySelector('.roster-empty-btn[data-project-add="new"]')?.textContent?.trim()).toBe(t.project.newInFolder);
    close();
  });
});

test("the create button leaves the archived list", () => {
  withPhone(() => {
    const { host, close } = open([], null, true);
    click(host.querySelector('.tools-entry'));
    click(host.querySelector('.tools-menu-archived'));
    expect(host.querySelector('.fab')).toBeNull();
    click(host.querySelector('.mobile-archived-back'));
    expect(host.querySelector('.fab')).not.toBeNull();
    close();
  });
});

test("the floating create button steps aside while the routine calendar is open", () => {
  withPhone(() => {
    const { host, runtime, close } = open([], null, true);
    flushSync();
    expect(host.querySelector('.fab')).not.toBeNull();
    runtime.openRoutines();
    flushSync();
    expect(host.querySelector('.fab')).toBeNull();
    close();
  });
});

/** Wider windows keep the + in each group header, where the pointer can reach it. */
test("the group headers keep their own + on a wider window, and there is no floating one", () => {
  const { host, created, close } = open([], null, true, []);
  expect(host.querySelector('.fab')).toBeNull();
  const adds = [...host.querySelectorAll<HTMLButtonElement>('.ghead .add')];
  expect(adds.map((b) => b.title)).toEqual([t.sidebar.addGroup, t.sidebar.addBot, t.project.add]);
  click(adds[0]);
  click(adds[1]);
  expect(created).toEqual(['group', 'bot']);
  close();
});

test("a narrow desktop footer keeps the icons and drops the words", () => {
  const OriginalObserver = globalThis.ResizeObserver;
  const observers: Array<{ el: HTMLElement; callback: ResizeObserverCallback }> = [];
  let width = 180;
  const widthOf = (el: HTMLElement) => (el.classList.contains("foot") ? width : 0);
  const realClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return widthOf(this as HTMLElement) || realClient?.get?.call(this) || 0; } });
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(el: Element) { observers.push({ el: el as HTMLElement, callback: this.callback }); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const { host, close } = open([], null, true);
  const foot = host.querySelector<HTMLElement>(".foot")!;
  // Written out, the row is 3 × 80 + 2 × 4 gaps + 2 × 8 padding = 264px.
  foot.style.padding = "6px 8px";
  foot.style.columnGap = "4px";
  const labels = () => [...foot.querySelectorAll<HTMLElement>(".foot-label")];
  const buttons = () => [...foot.querySelectorAll<HTMLButtonElement>(".foot-action")];
  // A button is 80px wide with its word and 34px without.
  for (const button of buttons()) {
    button.getBoundingClientRect = () => {
      const width = foot.classList.contains("is-compact") ? 34 : 80;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 36, width, height: 36, toJSON() {} } as DOMRect;
    };
  }
  try {
    const measure = () => observers.find((observer) => observer.el === foot)?.callback([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    measure();
    flushSync();
    expect(foot.classList.contains("is-compact")).toBe(true);
    const sheets = [...document.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
    expect(sheets).toContain(".foot.is-compact");
    expect(sheets).toContain(".foot-label");
    expect(sheets).toMatch(/\.foot\.is-compact[^{]*\.foot-label[^{]*\{\s*display:\s*none/);
    expect(buttons().every((button) => button.querySelector("svg"))).toBe(true);
    expect(buttons().map((button) => button.getAttribute("aria-label"))).toEqual([
      t.sidebar.workspace, t.sidebar.tools, t.sidebar.settings,
    ]);
    // Still narrow, and measuring again must not bring the words back just because they now fit.
    measure();
    flushSync();
    expect(foot.classList.contains("is-compact")).toBe(true);
    width = 300;
    measure();
    flushSync();
    expect(foot.classList.contains("is-compact")).toBe(false);
    width = 180;
    measure();
    flushSync();
    expect(foot.classList.contains("is-compact")).toBe(true);
    // The buttons would clear the edge here, but only by eating the padding at the end.
    width = 260;
    measure();
    flushSync();
    expect(foot.classList.contains("is-compact")).toBe(true);
    width = 264;
    measure();
    flushSync();
    expect(foot.classList.contains("is-compact")).toBe(false);
    expect(labels()).toHaveLength(3);
  } finally {
    if (realClient) Object.defineProperty(HTMLElement.prototype, "clientWidth", realClient);
    globalThis.ResizeObserver = OriginalObserver;
    close();
  }
});

test('desktop footer exposes three labelled entries and dispatches each tool', () => {
  const { host, runtime, created, close } = open([], null, true);
  flushSync(() => { runtime.snapshot.settings.workspace_path = '/fixture'; });
  const footer = [...host.querySelectorAll<HTMLButtonElement>('.foot button')];
  expect(footer.map((button) => button.textContent?.trim())).toEqual([
    t.sidebar.workspace, t.sidebar.tools, t.sidebar.settings,
  ]);
  expect(host.querySelector('.theme-toggle-btn')).toBeNull();
  expect(footer[0].title).toContain('⌘O');
  click(footer[0]); click(footer[2]);
  expect(created).toEqual(['workspace', 'settings']);
  for (const [index, name] of [[0, 'routines'], [1, 'spend'], [3, 'terminal']] as const) {
    click(footer[1]);
    const items = [...host.querySelectorAll('.tools-menu-item')];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      t.routines.title, spendCopyFor('zh').open, t.usage.open, t.terminal.newTab, t.routing.tab, t.sidebar.archivedSessions,
    ]);
    expect(host.querySelector('[role="separator"]')).not.toBeNull();
    click(items[index]);
    expect(created.at(-1)).toBe(name);
    expect(host.querySelector('.tools-menu')).toBeNull();
    expect(footer[1].getAttribute('aria-expanded')).toBe('false');
  }
  expect(runtime.calls.some((call) => call.name === 'openTerminal')).toBe(false);
  close();
});

test("a tablet on the remote app is wider than a phone but has no workbench, so the terminal opens as a page", () => {
  // A new tab there would start a shell on the Mac in a layout nothing draws: the tap does nothing.
  const { host, runtime, created, close } = open([], null, true, [], [], false);
  const tools = [...host.querySelectorAll<HTMLButtonElement>('.foot button')][1];
  click(tools);
  // Named as a phone names them: the page that opens, not a tab.
  const items = [...host.querySelectorAll<HTMLButtonElement>('.tools-menu-item')];
  expect(items.slice(0, 4).map((item) => item.textContent?.trim())).toEqual([t.calendar.open, spendCopyFor('zh').open, t.usage.open, t.terminal.title]);
  click(items[3]);
  expect(runtime.calls.some((call) => call.name === 'openTerminal')).toBe(true);
  expect(created).not.toContain('terminal');
  // Its pages are marked in the menu the way a phone's are.
  flushSync(() => { runtime.spendOpen = true; });
  click(tools);
  expect(host.querySelector('.tools-menu-item[aria-current="true"]')?.textContent?.trim()).toBe(spendCopyFor('zh').open);
  close();
});

test('desktop tools support arrows, Home, End, Escape, Tab and outside dismissal', () => {
  const { host, close } = open([]);
  const toggle = host.querySelector<HTMLButtonElement>('.tools-entry')!;
  click(toggle);
  const items = [...host.querySelectorAll<HTMLButtonElement>('.tools-menu-item')];
  expect(document.activeElement).toBe(items[0]);
  press(items[0], 'ArrowUp');
  expect(document.activeElement).toBe(items[5]);
  press(items[5], 'ArrowDown');
  expect(document.activeElement).toBe(items[0]);
  press(items[0], 'End');
  expect(document.activeElement).toBe(items[5]);
  press(items[5], 'Home');
  expect(document.activeElement).toBe(items[0]);
  press(items[0], 'Escape');
  expect(host.querySelector('.tools-menu')).toBeNull();
  expect(document.activeElement).toBe(toggle);
  press(toggle, 'ArrowUp');
  expect(document.activeElement).toBe(host.querySelector('.tools-menu-archived'));
  press(document.activeElement, 'Tab');
  expect(host.querySelector('.tools-menu')).toBeNull();
  click(toggle);
  click(host.querySelector('.groups'));
  expect(host.querySelector('.tools-menu')).toBeNull();
  close();
});

for (const hasArchive of [false, true]) test(`desktop archive is a list destination with a return path (${hasArchive})`, () => {
  const { host, runtime, close } = open([], null, true);
  if (hasArchive) flushSync(() => {
    runtime.snapshot.sessions.push(aGroup({ id: 'archived-1', name: 'Old group', archived_at: 'now' }));
  });
  expect(host.querySelector('.tools-entry-dot')).toBeNull();
  click(host.querySelector('.tools-entry'));
  expect(host.querySelector('.tools-menu-badge')?.textContent).toBe(hasArchive ? '1' : undefined);
  click(host.querySelector('.tools-menu-archived'));
  if (hasArchive) {
    expect(host.querySelector('.is-archived-row')?.textContent).toContain('Old group');
    click(host.querySelector('.is-archived-row'));
    expect(runtime.calls.at(-1)?.args).toEqual(['archived-1']);
  } else expect(host.querySelector('.archived-empty-hint')).not.toBeNull();
  click(host.querySelector('.btn-back-sessions'));
  expect(host.querySelector('.archived-empty-hint')).toBeNull();
  expect(host.querySelector('.groups')?.textContent).toContain('视频组');
  close();
});

test('an open tools menu follows sidebar width changes', () => {
  const OriginalObserver = globalThis.ResizeObserver;
  let onResize: ResizeObserverCallback | null = null;
  let disconnected = false;
  const observed: Element[] = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { onResize = callback; }
    observe(element: Element) { observed.push(element); }
    unobserve() {}
    disconnect() { disconnected = true; }
  } as unknown as typeof ResizeObserver;
  try {
    const { host, close } = open([]);
    const toggle = host.querySelector<HTMLButtonElement>('.tools-entry')!;
    let left = 85;
    toggle.getBoundingClientRect = () => ({ left, top: 500, bottom: 536, width: 72, height: 36 } as DOMRect);
    click(toggle);
    expect(observed).toContain(toggle.parentElement!);
    const menu = host.querySelector<HTMLElement>('.tools-menu')!;
    expect(menu.style.left).toBe('85px');
    left = 68;
    (onResize as unknown as () => void)();
    expect(menu.style.left).toBe('68px');
    press(menu, 'Escape');
    expect(disconnected).toBe(true);
    close();
  } finally {
    globalThis.ResizeObserver = OriginalObserver;
  }
});

test('unconfigured workspace stays labelled and settings retains the update indicator', () => {
  const { host, runtime, close } = open([], null, true);
  const previous = updateChecker.result;
  const ignored = updateChecker.ignoredVersion;
  try {
    flushSync(() => {
      runtime.snapshot.settings.workspace_path = '';
      updateChecker.result = { current: '0.1.0', latest: '0.2.0', updateAvailable: true, releaseUrl: 'https://github.com/Blackman99/deskfolk/releases', downloadUrl: null, publishedAt: null, notes: null };
      updateChecker.ignoredVersion = null;
    });
    const workspace = host.querySelector<HTMLButtonElement>('.foot-action')!;
    expect(workspace.disabled).toBe(true);
    expect(workspace.title).toBe(t.sidebar.workspaceUnset);
    expect(host.querySelector('.foot-settings .foot-badge')).not.toBeNull();
    expect(host.querySelector('.foot-settings')?.getAttribute('aria-label')).toContain(t.sidebar.updateAvailable);
    expect(host.querySelector('.tools-entry .foot-badge')).toBeNull();
  } finally {
    flushSync(() => { updateChecker.result = previous; updateChecker.ignoredVersion = ignored; });
    close();
  }
});

test('resizing a phone closes its menu before moving the trigger to the desktop footer', () => {
  withPhone((grow) => {
    const { host, close } = open([], null, true);
    expect(host.querySelector('.foot')).toBeNull();
    click(host.querySelector('.tools-entry'));
    grow();
    expect(host.querySelector('.tools-menu')).toBeNull();
    expect(host.querySelectorAll('.foot button')).toHaveLength(3);
    click(host.querySelector('.tools-entry'));
    press(host.querySelector('.tools-menu-item'), 'Escape');
    expect(document.activeElement).toBe(host.querySelector('.foot .tools-entry'));
    close();
  });
});

test("on a phone the calendar and the terminal live behind one button", () => {
  withPhone(() => {
    const { host, runtime, close } = open([], null, true);
    // The footer that carries these on a desktop is not on screen here, and the line the search
    // field shares with the archive entry has no room for one icon per tool.
    expect(host.querySelector('.calendar-entry')).toBeNull();
    const entry = host.querySelector<HTMLButtonElement>('.tools-entry');
    expect(entry).not.toBeNull();
    expect(entry?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.tools-menu')).toBeNull();

    click(entry);
    // Tools live here; the menu is free to grow, so this checks membership and order, not the list.
    const items = Array.from(host.querySelectorAll('.tools-menu-item')).map((el) => el.textContent?.trim());
    // The workspace left the bottom bar for here.
    expect(items.indexOf(t.sidebar.workspace)).toBe(0);
    expect(items.indexOf(t.calendar.open)).toBe(1);
    expect(items.indexOf(spendCopyFor("zh").open)).toBe(2);
    expect(items.indexOf(t.usage.open)).toBe(3);
    expect(items.indexOf(t.terminal.title)).toBe(4);
    expect(items.indexOf(t.routing.tab)).toBe(5);
    expect(items.indexOf(t.sidebar.archivedSessions)).toBe(6);

    const terminalItem = [...host.querySelectorAll<HTMLButtonElement>('.tools-menu-item')].find((item) => item.textContent?.includes(t.terminal.title));
    click(terminalItem);
    expect(runtime.calls.some((call) => call.name === 'openTerminal')).toBe(true);
    // Picking one closes the menu rather than leaving it hanging over the list.
    expect(host.querySelector('.tools-menu')).toBeNull();
    close();
  });
});

const WORKING_ONLY_KEY = "real-bot-sidebar-working-only";

/** A list with work in some rows: Writer thinking, Researcher idle, the group waiting on an approval. */
function openWorking(over: Partial<Snapshot> = {}, pinnedSessionIds: string[] = []) {
  window.localStorage.removeItem(WORKING_ONLY_KEY);
  const drop = aDirect({
    id: FILE_DROP_SESSION_ID,
    participants: [{ member: "user", joined_at: "t", left_at: null }],
  });
  const runtime = reactive(
    fakeRuntime({
      bots: [aBot({ id: "bot-1", name: "Writer" }), aBot({ id: "bot-2", name: "Researcher" })],
      sessions: [
        drop,
        aGroup({ id: "sess-1", name: "视频组" }),
        aGroup({ id: "sess-2", name: "文案组" }),
        aDirect({ id: "direct-1" }),
        aDirect({
          id: "direct-2",
          participants: [
            { member: "user", joined_at: "t", left_at: null },
            { member: "bot-2", joined_at: "t", left_at: null },
          ],
        }),
        ...botDms(7),
      ],
      turns: [
        aTurn({ id: "turn-w", session_id: "direct-1", status: "running" }),
        aTurn({ id: "turn-g", session_id: "sess-1", status: "waiting_approval" }),
        aTurn({ id: "turn-d", session_id: "d-01", status: "running" }),
        aTurn({ id: "turn-old", session_id: "sess-2", status: "completed" }),
      ],
      approvals: [anApproval({ turn_id: "turn-g" })],
      ...over,
    }),
  );
  const view = render(Sidebar, {
    runtime,
    t,
    selected: null,
    pinnedSessionIds,
    workspaceOpen: false,
    contextMenuSessionId: null,
    onOpenContextMenu: () => {},
    onToggleWorkspace: () => {},
    onOpenRoutines: () => {},
    onOpenSpend: () => {},
    workbench: true,
    onNewTerminal: () => {},
    onOpenSettings: () => {},
    onCreateBot: () => {},
    onCreateGroup: () => {},
    onOpenSearch: () => {},
  });
  const titles = () => [...view.host.querySelectorAll(".groups .row .t")].map((el) => el.textContent?.trim());
  const heads = () => [...view.host.querySelectorAll(".groups .ghead > span:first-child")].map((el) => el.textContent?.trim());
  const toggle = () => view.host.querySelector<HTMLButtonElement>(".working-filter")!;
  return { ...view, runtime, titles, heads, toggle };
}

test("the working filter lists only the rows a Bot is at work in, and remembers it", () => {
  const { host, titles, heads, toggle, close } = openWorking();
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(titles()).toContain("文案组");
  expect(titles()).toContain("Researcher");
  expect(host.querySelectorAll(".row-stack")).toHaveLength(0);

  click(toggle());
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  expect(toggle().title).toBe(t.sidebar.workingOnlyOff);
  // Thinking counts, and so does a turn stopped on your approval; a finished turn does not. A
  // Bot↔Bot direct at work is not listed either: its card under the message shows it (ADR 0091).
  expect(titles()).toEqual(["视频组", "Writer"]);
  // The file drop never has a Bot at work, so its section goes; the rest keep their headings.
  expect(heads()).toEqual([t.sidebar.groups, t.sidebar.youBot]);
  expect(host.querySelector(".ghead-more")).toBeNull();
  expect(host.querySelector(".working-empty-hint")).toBeNull();
  expect(window.localStorage.getItem(WORKING_ONLY_KEY)).toBe("1");

  click(toggle());
  expect(titles()).toContain("文案组");
  expect(heads()[0]).toBe(t.sidebar.fileDrop);
  expect(host.querySelectorAll(".row-stack")).toHaveLength(0);
  expect(window.localStorage.getItem(WORKING_ONLY_KEY)).toBeNull();
  close();
});

test("a row leaves the filtered list when its turn ends, and the list says when nothing is left", () => {
  const { host, runtime, titles, toggle, close } = openWorking({
    turns: [aTurn({ id: "turn-w", session_id: "direct-1", status: "running" })],
    approvals: [],
  });
  click(toggle());
  expect(titles()).toEqual(["Writer"]);
  flushSync(() => {
    runtime.snapshot.turns[0].status = "completed";
  });
  expect(titles()).toEqual([]);
  expect(host.querySelectorAll(".groups .ghead")).toHaveLength(0);
  expect(host.querySelector(".working-empty-hint")?.textContent).toBe(t.sidebar.workingEmpty);
  close();
  window.localStorage.removeItem(WORKING_ONLY_KEY);
});

/** Unread counts where the row shows it: a Bot↔Bot direct has no unread dot, so there only work does. */
test("the filter also lists what you have not read, outside Bot↔Bot directs", () => {
  const { host, runtime, titles, heads, toggle, close } = openWorking({ turns: [], approvals: [] });
  click(toggle());
  expect(titles()).toEqual([]);
  flushSync(() => {
    for (const session of runtime.snapshot.sessions) {
      if ([FILE_DROP_SESSION_ID, "sess-2", "direct-2", "d-03"].includes(session.id)) session.unread_count = 2;
    }
  });
  expect(heads()).toEqual([t.sidebar.fileDrop, t.sidebar.groups, t.sidebar.youBot]);
  expect(titles()).toEqual([t.sidebar.fileDrop, "文案组", "Researcher"]);
  expect(host.querySelector(".working-empty-hint")).toBeNull();
  close();
  window.localStorage.removeItem(WORKING_ONLY_KEY);
});

/** Opening an unread row reads it; it stays put until you open another. */
test("the conversation on screen stays in the filtered list once it is read", () => {
  const { runtime, titles, toggle, close } = openWorking({ turns: [], approvals: [] });
  const session = (id: string) => runtime.snapshot.sessions.find((s) => s.id === id)!;
  flushSync(() => {
    session("sess-2").unread_count = 1;
  });
  click(toggle());
  expect(titles()).toEqual(["文案组"]);
  flushSync(() => {
    runtime.selectedId = "sess-2";
    session("sess-2").unread_count = 0;
  });
  expect(titles()).toEqual(["文案组"]);
  flushSync(() => {
    runtime.selectedId = "direct-1";
  });
  expect(titles()).toEqual(["Writer"]);
  flushSync(() => {
    runtime.selectedId = null;
  });
  expect(titles()).toEqual([]);
  close();
  window.localStorage.removeItem(WORKING_ONLY_KEY);
});

/** The pins stay as they are, so a working pin is on screen even when no row below is. */
test("with only a pinned conversation working, the empty list says the work is in the pins", () => {
  const { host, titles, toggle, close } = openWorking(
    { turns: [aTurn({ id: "turn-w", session_id: "direct-1", status: "running" })], approvals: [] },
    ["direct-1", "direct-2"],
  );
  click(toggle());
  expect(titles()).toEqual([]);
  expect(host.querySelectorAll(".pinned-session-btn")).toHaveLength(2);
  expect(host.querySelector(".working-empty-hint")?.textContent).toBe(t.sidebar.workingEmptyPinned);
  close();
  window.localStorage.removeItem(WORKING_ONLY_KEY);
});

test("the list opens already filtered when it was left that way", () => {
  window.localStorage.setItem(WORKING_ONLY_KEY, "1");
  const runtime = fakeRuntime({ sessions: [aGroup({ id: "sess-1", name: "视频组" })] });
  const { host, close } = render(Sidebar, {
    runtime,
    t,
    selected: null,
    pinnedSessionIds: [],
    workspaceOpen: false,
    contextMenuSessionId: null,
    onOpenContextMenu: () => {},
    onToggleWorkspace: () => {},
    onOpenRoutines: () => {},
    onOpenSpend: () => {},
    workbench: true,
    onNewTerminal: () => {},
    onOpenSettings: () => {},
    onCreateBot: () => {},
    onCreateGroup: () => {},
    onOpenSearch: () => {},
  });
  expect(host.querySelector(".working-filter")?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".groups .row")).toBeNull();
  close();
  window.localStorage.removeItem(WORKING_ONLY_KEY);
});

/** The archived list is its own view; the filter is for the live list and waits outside it. */
test("the archived list has no working filter", () => {
  const { host, toggle, close } = openWorking();
  click(host.querySelector(".tools-entry"));
  click(host.querySelector(".tools-menu-archived"));
  expect(host.querySelector(".working-filter")).toBeNull();
  click(host.querySelector(".btn-back-sessions"));
  expect(toggle()).not.toBeNull();
  close();
});

test("Tools opens Roles (ADR 0083); with no workbench to hold its tab, it is a page in place of the list", () => {
  const { host, runtime, close } = open([], null, true);
  click(host.querySelector('.tools-entry'));
  click(host.querySelector('[data-tools-roles]'));
  flushSync(() => { runtime.listPage = 'roles'; });
  expect(host.querySelector('[data-roles-page]')).not.toBeNull();
  click(host.querySelector('.roles-page-back'));
  // Read once, at the end: the fixture's call list is a copy taken when first read.
  expect(runtime.calls.map((call) => call.name).filter((name) => name === 'openRoles' || name === 'closeListPage')).toEqual(['openRoles', 'closeListPage']);
  close();
});

test("a press on any conversation, pins included, is handed on so it can be dragged into the workbench", () => {
  const presses: string[] = [];
  const runtime = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "Writer" }), aBot({ id: "bot-2", name: "Researcher" })],
    sessions: [aGroup({ id: "sess-1", name: "视频组" }), aGroup({ id: "sess-2", name: "剪辑组" }), aBotDirect()],
  });
  const props = {
    runtime,
    t,
    selected: null,
    pinnedSessionIds: ["sess-2"],
    workspaceOpen: false,
    contextMenuSessionId: null,
    onOpenContextMenu: () => {},
    onToggleWorkspace: () => {},
    onOpenRoutines: () => {},
    onOpenSpend: () => {},
    workbench: true,
    onNewTerminal: () => {},
    onOpenSettings: () => {},
    onCreateBot: () => {},
    onCreateGroup: () => {},
    onOpenSearch: () => {},
  };
  const view = render(Sidebar, {
    ...props,
    onDragSession: (event: PointerEvent, session: { id: string }) => {
      expect(event.type).toBe("pointerdown");
      presses.push(session.id);
    },
  });
  const pressOn = (el: Element | null) => el?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  pressOn(view.host.querySelector(".pinned-session-btn"));
  for (const row of view.host.querySelectorAll(".row")) pressOn(row);
  // A Bot↔Bot direct has no row to press (ADR 0091).
  expect(presses).toEqual(["sess-2", "sess-1"]);
  // A press is all it hands on: picking the row is still its click.
  expect(runtime.calls.filter((call) => call.name === "selectSession")).toHaveLength(0);
  view.close();

  // Without a workbench to drop into, nobody is asked.
  const plain = render(Sidebar, props);
  for (const row of plain.host.querySelectorAll(".row")) pressOn(row);
  expect(presses).toHaveLength(2);
  plain.close();
});

test("the focus switch beside the mark turns focus mode on and off for every conversation", () => {
  const view = open([aBotDirect()]);
  try {
    const button = () => view.host.querySelector<HTMLButtonElement>(".brand-row .focus-toggle");
    expect(button()?.getAttribute("aria-pressed")).toBe("false");
    click(button());
    flushSync();
    expect(focusMode.on).toBe(true);
    expect(button()?.getAttribute("aria-pressed")).toBe("true");
    expect(button()?.title).toBe(t.sidebar.focusModeOff);
    click(button());
    flushSync();
    expect(focusMode.on).toBe(false);
  } finally {
    focusMode.set(false);
    view.close();
  }
});
