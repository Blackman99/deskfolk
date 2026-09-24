import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { spendCopyFor } from "../spend/spend-copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aMessage, aRoutine, fakeRuntime } from "../test-fixtures.ts";
import { click, press, render } from "../test-render.ts";
import Sidebar from "./Sidebar.svelte";
import { BOT_DM_VISIBLE } from "./bot-dm-source.ts";
import { updateChecker } from "../update-checker.svelte.ts";

import { flushSync } from 'svelte';
import { reactive } from '../test-reactive.svelte.ts';

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

function open(sessions: ReturnType<typeof aBotDirect>[], selectedId: string | null = null, live = false, created: string[] = []) {
  const stub = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "Writer" }), aBot({ id: "bot-2", name: "Researcher" })],
    sessions: [aGroup({ id: "sess-1", name: "视频组" }), ...sessions],
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
    pinnedSessionIds: [],
    workspaceOpen: false,
    contextMenuSessionId: null,
    onOpenContextMenu: () => {},
    onToggleWorkspace: () => created.push("workspace"),
    onOpenRoutines: () => created.push("routines"),
    onOpenSpend: () => created.push("spend"),
    onNewTerminal: () => created.push("terminal"),
    onOpenSettings: () => created.push("settings"),
    onCreateBot: () => created.push("bot"),
    onCreateGroup: () => created.push("group"),
    onOpenArtifact: () => {},
  });
  return { ...view, runtime, created };
}

for (const selected of [null, 'sess-1']) for (const deletedAfterResult of [false, true]) test(`retained routine with unavailable owner is explained and inert (${selected}, ${deletedAfterResult})`, () => {
  const { host, runtime, close } = open([], selected, true);
  flushSync(() => {
    runtime.snapshot.routines = [aRoutine()];
    runtime.searchQuery = 'Morning';
    runtime.searchHits = [{ kind: 'routine', id: 'routine-1', snippet: 'Morning brief' }];
    if (!deletedAfterResult) runtime.snapshot.bots = [];
  });
  const input = host.querySelector('input.search') as HTMLInputElement;
  input.focus(); flushSync();
  if (deletedAfterResult) flushSync(() => { runtime.snapshot.bots = []; });
  const result = host.querySelector('[role=option]')!;
  expect(result.getAttribute('aria-disabled')).toBe('true');
  expect(result.textContent).toContain(t.sidebar.routineUnavailable);
  click(result); press(input, 'Enter');
  expect(runtime.calls.some((call) => ['openRoutine', 'closeSearch'].includes(call.name))).toBe(false);
  expect(runtime.snapshot.routines).toHaveLength(1);
  expect(host.querySelector('[role=listbox]')).not.toBeNull();
  close();
});

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

test("only the most recent directs are listed, with the rest behind a toggle", () => {
  const { host, close } = open(botDms(7));
  expect(host.querySelectorAll(".row-stack")).toHaveLength(BOT_DM_VISIBLE);
  const more = host.querySelector(".ghead-more") as HTMLButtonElement;
  expect(more.textContent?.trim()).toBe(t.sidebar.botBotMore(2));
  click(more);
  expect(host.querySelectorAll(".row-stack")).toHaveLength(7);
  close();
});

test("a handful of directs need no toggle", () => {
  const { host, close } = open(botDms(3));
  expect(host.querySelector(".ghead-more")).toBeNull();
  close();
});

/** The row and its source line are two separate targets; neither should fire the other. */
test("the source line jumps to the triggering message, the row opens the direct", () => {
  const { host, runtime, close } = open(botDms(1));
  click(host.querySelector(".row-source"));
  expect(runtime.calls.filter((c) => c.name === "selectSession")).toHaveLength(1);
  expect(runtime.calls[0].args).toEqual(["sess-1", { messageId: "msg-1" }]);

  click(host.querySelector(".row-stack .row"));
  const selects = runtime.calls.filter((c) => c.name === "selectSession");
  expect(selects).toHaveLength(2);
  expect(selects[1].args).toEqual(["d-01"]);
  close();
});

test("the source line names where the direct came from", () => {
  const { host, close } = open(botDms(1));
  expect(host.querySelector(".row-source-text")?.textContent).toBe(
    t.sidebar.botBotSource("视频组"),
  );
  close();
});

test("a direct opened before sources were recorded says so instead of offering a dead link", () => {
  const { host, close } = open([
    aBotDirect({ id: "d-legacy", origin_session_id: null, origin_message_id: null }),
  ]);
  const source = host.querySelector(".row-source") as HTMLElement;
  expect(source.tagName).toBe("SPAN");
  expect(source.textContent?.trim()).toBe(t.sidebar.botBotSourceUnknown);
  close();
});

test("a direct whose source session is gone says so", () => {
  const { host, close } = open([aBotDirect({ id: "d-orphan", origin_session_id: "deleted" })]);
  const source = host.querySelector(".row-source") as HTMLElement;
  expect(source.tagName).toBe("SPAN");
  expect(source.textContent?.trim()).toBe(t.sidebar.botBotSourceMissing);
  close();
});

/** Otherwise the one you are reading disappears from the sidebar while you read it. */
test("the open direct stays listed even when it falls past the cap", () => {
  const { host, close } = open(botDms(7), "d-01");
  const ids = [...host.querySelectorAll(".row-stack")].map((el) =>
    el.querySelector(".t")?.textContent,
  );
  expect(ids).toHaveLength(BOT_DM_VISIBLE + 1);
  expect(host.querySelector(".row-stack.is-on")).toBeTruthy();
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

test("Bot to Bot rows carry no unread badge", () => {
  const { host, close } = open([
    aBotDirect({ id: "d-01", last_message: aMessage({ author: "bot-1" }) }),
  ]);
  expect(host.querySelector(".row-stack .unread-dot")).toBeNull();
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
    addEventListener: (_: string, fn: (ev: MediaQueryListEvent) => void) => void listeners.add(fn),
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

function hits(runtime: ReturnType<typeof open>["runtime"], query = '视频') {
  flushSync(() => {
    runtime.searchQuery = query;
    runtime.searchHits = [{ kind: 'session', id: 'sess-1', snippet: '视频组' }];
  });
}

test("on a phone the search field is a way in, not a place to type", () => {
  withPhone(() => {
    const { host, app, close } = open([], null, true);
    // Nothing to type into on the list: a dropdown under a field this narrow is a desktop idea.
    expect(host.querySelector('input.search')).toBeNull();
    const trigger = host.querySelector('.search-trigger');
    expect(trigger?.textContent?.trim()).toBe(t.sidebar.searchShort);
    expect(host.querySelector('.search-page')).toBeNull();

    click(trigger);
    const field = host.querySelector<HTMLInputElement>('.search-page input.search');
    expect(field).not.toBeNull();
    // The page exists to be typed into, so the caret is already there.
    expect(document.activeElement).toBe(field);
    expect(field?.placeholder).toBe(t.sidebar.search);
    // Nothing typed yet, so no list of hits and no empty-search verdict.
    expect(host.querySelector('.search-drop.is-page')).toBeNull();
    expect((app as { closeSearchPage(): boolean }).closeSearchPage()).toBe(true);
    close();
  });
});

test("the hits fill the page, and picking one ends the search", async () => {
  await withPhone(async () => {
    const { host, runtime, app, close } = open([], null, true);
    click(host.querySelector('.search-trigger'));
    hits(runtime);
    const hit = host.querySelector('.search-drop.is-page [role=option]');
    expect(hit?.textContent).toContain('视频组');
    click(hit);
    expect(runtime.calls.some((call) => call.name === 'selectSession')).toBe(true);
    // The field is cleared straight away. The page stays until the conversation it opened is
    // the one covering the list, which the stub's resolved selectSession has already done.
    expect(runtime.calls.some((call) => call.name === 'closeSearch')).toBe(true);
    await Promise.resolve();
    expect((app as { closeSearchPage(): boolean }).closeSearchPage()).toBe(false);
    close();
  });
});

test("Enter on the page opens the first hit, the way it does in the dropdown", () => {
  withPhone(() => {
    const { host, runtime, close } = open([], null, true);
    click(host.querySelector('.search-trigger'));
    hits(runtime);
    press(host.querySelector('.search-page input.search'), 'Enter');
    expect(runtime.calls.some((call) => call.name === 'selectSession')).toBe(true);
    close();
  });
});

test("leaving the page clears what was typed, and Escape leaves it too", () => {
  withPhone(() => {
    const { host, runtime, app, close } = open([], null, true);
    const page = app as { closeSearchPage(): boolean };
    click(host.querySelector('.search-trigger'));
    hits(runtime);
    click(host.querySelector('.search-page-back'));
    expect(runtime.calls.some((call) => call.name === 'closeSearch')).toBe(true);
    expect(page.closeSearchPage()).toBe(false);

    click(host.querySelector('.search-trigger'));
    press(host.querySelector('.search-page input.search'), 'Escape');
    expect(page.closeSearchPage()).toBe(false);
    close();
  });
});

test("a window that grew back has the dropdown again, so the page goes", () => {
  withPhone((grow) => {
    const { host, app, close } = open([], null, true);
    click(host.querySelector('.search-trigger'));
    expect((app as { closeSearchPage(): boolean }).closeSearchPage()).toBe(true);
    click(host.querySelector('.search-trigger'));
    grow();
    expect((app as { closeSearchPage(): boolean }).closeSearchPage()).toBe(false);
    expect(host.querySelector('input.search')).not.toBeNull();
    close();
  });
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

test("the button belongs to the list of chats: not the archive, not the search page", () => {
  withPhone(() => {
    const { host, close } = open([], null, true);
    click(host.querySelector('.tools-entry'));
    click(host.querySelector('.tools-menu-archived'));
    expect(host.querySelector('.fab')).toBeNull();
    click(host.querySelector('.mobile-archived-back'));
    expect(host.querySelector('.fab')).not.toBeNull();
    click(host.querySelector('.search-trigger'));
    expect(host.querySelector('.fab')).toBeNull();
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
  expect(adds.map((b) => b.title)).toEqual([t.sidebar.addGroup, t.sidebar.addBot]);
  click(adds[0]);
  click(adds[1]);
  expect(created).toEqual(['group', 'bot']);
  close();
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
  for (const [index, name] of ['routines', 'spend', 'terminal'].entries()) {
    click(footer[1]);
    const items = [...host.querySelectorAll('.tools-menu-item')];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      t.routines.title, spendCopyFor('zh').open, t.terminal.newTab, t.bulkModel.open, t.sidebar.archivedSessions,
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

test('desktop tools support arrows, Home, End, Escape, Tab and outside dismissal', () => {
  const { host, close } = open([]);
  const toggle = host.querySelector<HTMLButtonElement>('.tools-entry')!;
  click(toggle);
  const items = [...host.querySelectorAll<HTMLButtonElement>('.tools-menu-item')];
  expect(document.activeElement).toBe(items[0]);
  press(items[0], 'ArrowUp');
  expect(document.activeElement).toBe(items[4]);
  press(items[4], 'ArrowDown');
  expect(document.activeElement).toBe(items[0]);
  press(items[0], 'End');
  expect(document.activeElement).toBe(items[4]);
  press(items[4], 'Home');
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
    expect(items.indexOf(t.calendar.open)).toBe(0);
    expect(items.indexOf(spendCopyFor("zh").open)).toBe(1);
    expect(items.indexOf(t.terminal.title)).toBe(2);
    expect(items.indexOf(t.sidebar.archivedSessions)).toBe(4);

    const terminalItem = [...host.querySelectorAll<HTMLButtonElement>('.tools-menu-item')].find((item) => item.textContent?.includes(t.terminal.title));
    click(terminalItem);
    expect(runtime.calls.some((call) => call.name === 'openTerminal')).toBe(true);
    // Picking one closes the menu rather than leaving it hanging over the list.
    expect(host.querySelector('.tools-menu')).toBeNull();
    close();
  });
});

/** The roster-wide entry: every Bot is listed in the dialog, none of them ticked for you. */
test("the Bot section's 批量换模型 opens the dialog with nothing ticked", () => {
  const { host, runtime, close } = open([]);
  const button = host.querySelector(".ghead-bulk-model") as HTMLButtonElement;
  expect(button.getAttribute("aria-label")).toBe(t.bulkModel.open);
  click(button);
  expect(runtime.calls.find((c) => c.name === "openBulkModel")?.args).toEqual([]);
  close();
});

test("an empty roster offers no 批量换模型, in the header or the tools menu", () => {
  const runtime = fakeRuntime({ bots: [], sessions: [] });
  const view = render(Sidebar, {
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
    onNewTerminal: () => {},
    onOpenSettings: () => {},
    onCreateBot: () => {},
    onCreateGroup: () => {},
    onOpenArtifact: () => {},
  });
  expect(view.host.querySelector(".ghead-bulk-model")).toBeNull();
  click(view.host.querySelector(".tools-entry"));
  expect(view.host.querySelector(".tools-menu")).not.toBeNull();
  expect(view.host.querySelector(".tools-menu-bulk-model")).toBeNull();
  view.close();
});

test("a remote link offers no 批量换模型: it has no bulk route", () => {
  const { host, runtime, close } = open([], null, true);
  flushSync(() => {
    runtime.remote = true;
  });
  expect(host.querySelector(".ghead-bulk-model")).toBeNull();
  click(host.querySelector(".tools-entry"));
  expect(host.querySelector(".tools-menu")).not.toBeNull();
  expect(host.querySelector(".tools-menu-bulk-model")).toBeNull();
  close();
});

test("a wider window's + list is still the two +s: 批量换模型 sits beside them, not among them", () => {
  const { host, close } = open([]);
  const adds = [...host.querySelectorAll<HTMLButtonElement>(".ghead .add")];
  expect(adds.map((b) => b.title)).toEqual([t.sidebar.addGroup, t.sidebar.addBot]);
  expect(host.querySelector(".ghead-bulk-model")).not.toBeNull();
  close();
});

test("the desktop footer's tools menu has 批量换模型 too, after the tools and before the archive", () => {
  const { host, runtime, close } = open([], null, true);
  const toggle = host.querySelector<HTMLButtonElement>(".foot .tools-entry")!;
  click(toggle);
  const items = [...host.querySelectorAll(".tools-menu-item")].map((el) => el.textContent?.trim());
  expect(items.indexOf(t.bulkModel.open)).toBe(items.indexOf(t.terminal.newTab) + 1);
  expect(items.indexOf(t.sidebar.archivedSessions)).toBe(items.length - 1);
  click(host.querySelector(".tools-menu-bulk-model"));
  expect(runtime.calls.find((c) => c.name === "openBulkModel")?.args).toEqual([]);
  // Like the other tools, picking it closes the menu and hands focus back to the toggle.
  expect(host.querySelector(".tools-menu")).toBeNull();
  expect(document.activeElement).toBe(toggle);
  close();
});

test("on a phone 批量换模型 is in the tools menu, not the floating +", () => {
  withPhone(() => {
    const { host, runtime, close } = open([], null, true);
    click(host.querySelector(".tools-entry"));
    const items = [...host.querySelectorAll(".tools-menu-item")].map((el) => el.textContent?.trim());
    expect(items.indexOf(t.bulkModel.open)).toBe(items.indexOf(t.terminal.title) + 1);
    expect(items.indexOf(t.sidebar.archivedSessions)).toBe(items.length - 1);
    click(host.querySelector(".tools-menu-bulk-model"));
    expect(runtime.calls.find((c) => c.name === "openBulkModel")?.args).toEqual([]);
    expect(host.querySelector(".tools-menu")).toBeNull();
    // The floating + is for creating, so it is not asked a third question.
    click(host.querySelector(".fab"));
    const fabItems = [...host.querySelectorAll(".fab-menu-item")].map((b) => b.textContent?.trim());
    expect(fabItems).toEqual([t.sidebar.addBot, t.sidebar.addGroup]);
    close();
  });
});
