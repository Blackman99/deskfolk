import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { FILE_DROP_SESSION_ID, type SessionSummary } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aMessage, anApproval, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { spendCopyFor } from "../spend/spend-copy.ts";
import { updateChecker } from "../update-checker.svelte.ts";
import { click, press, render } from "../test-render.ts";
import SidebarRail from "./SidebarRail.svelte";

const t = copyFor("en");

function open(selectedId: string | null = null, workspacePath: string | null = null) {
  const runtime = fakeRuntime({
    bots: [aBot({ id: "bot-1", name: "Writer" }), aBot({ id: "bot-2", name: "Researcher" })],
    sessions: [
      aGroup({ id: "sess-1", name: "Video crew" }),
      aGroup({ id: "sess-old", name: "Old crew", archived_at: "2026-09-20T00:00:00.000Z" }),
      aDirect({ id: "direct-1", unread_count: 4 }),
      aDirect({ id: "direct-pin", participants: [
        { member: "user", joined_at: "t", left_at: null },
        { member: "bot-2", joined_at: "t", left_at: null },
      ] }),
      aDirect({
        id: FILE_DROP_SESSION_ID,
        participants: [{ member: "user", joined_at: "t", left_at: null }],
        last_message: aMessage({ body: "shot.png", session_id: FILE_DROP_SESSION_ID }),
      }),
      aBotDirect(),
    ],
    turns: [aTurn({ id: "turn-1", session_id: "sess-1", status: "waiting_approval" })],
    approvals: [anApproval({ turn_id: "turn-1" }), anApproval({ id: "appr-2", turn_id: "turn-1" })],
  });
  runtime.selectedId = selectedId;
  runtime.snapshot.settings.workspace_path = workspacePath;
  const menus: string[] = [];
  let expanded = 0;
  let settings = 0;
  let searches = 0;
  /** Every footer action the rail dispatched, in order. */
  const tools: string[] = [];
  const view = render(SidebarRail, {
    runtime,
    t,
    pinnedSessionIds: ["direct-pin"],
    contextMenuSessionId: null,
    workspaceOpen: false,
    onOpenContextMenu: (_e: MouseEvent, session: SessionSummary) => menus.push(session.id),
    onExpand: () => (expanded += 1),
    onToggleWorkspace: () => tools.push("workspace"),
    onOpenRoutines: () => tools.push("routines"),
    onOpenSpend: () => tools.push("spend"),
    onNewTerminal: () => tools.push("terminal"),
    onOpenArchived: () => tools.push("archived"),
    onOpenSettings: () => (settings += 1),
    onOpenSearch: () => (searches += 1),
  });
  return { ...view, runtime, menus, tools, expanded: () => expanded, settings: () => settings, searches: () => searches };
}

const item = (host: HTMLElement, id: string) => host.querySelector(`.rail-item[data-session="${id}"]`) as HTMLElement | null;

test("the rail keeps the list's order and sections, avatars only, and leaves out what the list leaves out", () => {
  const view = open("direct-1");
  const ids = [...view.host.querySelectorAll<HTMLElement>(".rail-item")].map((el) => el.dataset.session);
  expect(ids).toEqual(["direct-pin", FILE_DROP_SESSION_ID, "sess-1", "direct-1", "botbot-1"]);
  expect(view.host.querySelectorAll(".rail-divider")).toHaveLength(4);
  expect(item(view.host, "sess-old")).toBeNull();
  // Names live in the styled tip, not a native title; nothing but the picture is drawn.
  expect(item(view.host, "sess-1")?.hasAttribute("title")).toBe(false);
  expect(item(view.host, "sess-1")?.querySelector(".row-avatar")).not.toBeNull();
  expect(item(view.host, "direct-1")?.getAttribute("aria-current")).toBe("true");
  expect(item(view.host, "direct-1")?.classList.contains("is-on")).toBe(true);
  view.close();
});

test("what waits on you outranks what is unread, and both are on the avatar", () => {
  const view = open();
  const waiting = item(view.host, "sess-1")?.querySelector(".rail-badge");
  expect(waiting?.classList.contains("is-waiting")).toBe(true);
  expect(waiting?.textContent).toBe("2");
  const unread = item(view.host, "direct-1");
  expect(unread?.querySelector(".rail-badge:not(.is-waiting)")?.textContent).toBe("4");
  expect(unread?.getAttribute("aria-label")).toBe("Writer · Unread 4");
  expect(item(view.host, "direct-pin")?.querySelector(".rail-badge")).toBeNull();
  view.close();
});

test("an avatar opens its conversation or its menu, and the rail's buttons expand the list or open settings", () => {
  const view = open();
  click(item(view.host, "sess-1"));
  expect(view.runtime.calls.filter((call) => call.name === "selectSession").map((call) => call.args[0])).toEqual(["sess-1"]);
  item(view.host, "direct-1")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(view.menus).toEqual(["direct-1"]);
  const expand = view.host.querySelector(".rail-expand") as HTMLElement;
  expect(expand.getAttribute("aria-label")).toBe(t.sidebar.show);
  click(expand);
  expect(view.expanded()).toBe(1);
  click(view.host.querySelector(".rail-settings"));
  expect(view.settings()).toBe(1);
  view.close();
});

test("the rail's footer is the list's — workspace, tools, settings — as icons, and the tools menu flies out beside it", () => {
  const unset = open();
  const foot = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>(".rail-foot button")];
  expect(foot(unset.host).map((button) => button.getAttribute("aria-label"))).toEqual([t.sidebar.workspace, t.sidebar.tools, t.sidebar.settings]);
  // No workspace yet: still a button, so the reason can be reached, and the click does nothing.
  expect(foot(unset.host)[0].disabled).toBe(false);
  expect(foot(unset.host)[0].getAttribute("aria-disabled")).toBe("true");
  expect(foot(unset.host)[0].hasAttribute("title")).toBe(false);
  unset.close();

  const view = open(null, "/fixture");
  const [workspace, tools, settings] = foot(view.host);
  expect(workspace.getAttribute("aria-disabled")).toBeNull();
  expect(workspace.hasAttribute("title")).toBe(false);
  click(workspace);
  click(settings);
  expect(view.tools).toEqual(["workspace"]);
  expect(view.settings()).toBe(1);
  // The menu opens off the tools button with the list's four items, and each one dispatches and closes it.
  for (const [index, name] of ["routines", "spend", "terminal", "archived"].entries()) {
    click(tools);
    expect(tools.getAttribute("aria-expanded")).toBe("true");
    const items = [...view.host.querySelectorAll<HTMLButtonElement>(".tools-menu-item")];
    // Labels follow the snapshot's locale (the fixture's is zh); the archived count rides on its item.
    expect(items.map((item) => item.querySelector("span")?.textContent)).toEqual([t.routines.title, spendCopyFor("zh").open, t.terminal.newTab, t.sidebar.archivedSessions]);
    expect(view.host.querySelector(".tools-menu-badge")?.textContent).toBe("1");
    expect(document.activeElement).toBe(items[0]);
    click(items[index]);
    expect(view.tools.at(-1)).toBe(name);
    expect(view.host.querySelector(".tools-menu")).toBeNull();
    expect(tools.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(tools);
  }
  // ArrowUp opens on the last item; Escape closes and gives the button its focus back.
  press(tools, "ArrowUp");
  expect(document.activeElement).toBe(view.host.querySelector(".tools-menu-archived"));
  press(document.activeElement, "Escape");
  expect(view.host.querySelector(".tools-menu")).toBeNull();
  expect(document.activeElement).toBe(tools);
  view.close();
});

test("the flyout sits beside the rail, bottoms aligned, and falls back to the left when there is no room", () => {
  const view = open(null, "/fixture");
  const tools = view.host.querySelector<HTMLButtonElement>(".rail-tools")!;
  tools.getBoundingClientRect = () => ({ left: 12, right: 52, top: 700, bottom: 736, width: 40, height: 36 } as DOMRect);
  click(tools);
  const menu = view.host.querySelector<HTMLElement>(".tools-menu")!;
  menu.getBoundingClientRect = () => ({ left: 0, right: 208, top: 0, bottom: 180, width: 208, height: 180 } as DOMRect);
  window.dispatchEvent(new Event("resize"));
  expect(menu.style.left).toBe("58px");
  expect(menu.style.top).toBe(`${736 - 180}px`);
  // A window too narrow for it on the right puts it on the left, clamped to the margin.
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 240, configurable: true });
  window.dispatchEvent(new Event("resize"));
  expect(menu.style.left).toBe("8px");
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  view.close();
});

const tipFor = (id: string) => document.querySelector<HTMLElement>(`[data-rail-tip="${id}"] .rail-tooltip`);
const tip = () => document.querySelector<HTMLElement>(".rail-tooltip");

function pointer(type: string, pointerType: string) {
  return new PointerEvent(type, { bubbles: true, pointerType, cancelable: true });
}

function enter(el: HTMLElement, pointerType = "mouse"): void {
  if (pointerType !== "touch") el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
  el.dispatchEvent(pointer("pointerenter", pointerType));
}

function leave(el: HTMLElement, pointerType = "mouse"): void {
  if (pointerType !== "touch") el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false, clientX: -1, clientY: -1 }));
  el.dispatchEvent(pointer("pointerleave", pointerType));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the search icon sits under expand, names search, and opens it", () => {
  const view = open();
  const buttons = [...view.host.querySelectorAll<HTMLButtonElement>("nav > .rail-action")];
  expect(buttons.map((button) => button.classList.contains("rail-expand") || button.classList.contains("rail-search"))).toEqual([true, true]);
  expect(buttons[0].classList.contains("rail-expand")).toBe(true);
  expect(buttons[1].classList.contains("rail-search")).toBe(true);
  const search = buttons[1];
  expect(search.getAttribute("aria-label")).toBe(t.sidebar.searchShort);
  expect(search.hasAttribute("title")).toBe(false);
  click(search);
  expect(view.searches()).toBe(1);
  expect(tip()).toBeNull();
  view.close();
});

test("a conversation's tip waits on hover, is immediate on focus, and names the title with its badge", async () => {
  const view = open();
  const waiting = item(view.host, "sess-1")!;
  const unread = item(view.host, "direct-1")!;
  enter(waiting);
  expect(tip()).toBeNull();
  await wait(120);
  // Not yet: a pass across the rail must not flash every name.
  expect(tip()).toBeNull();
  await wait(120);
  flushSync();
  const shown = tipFor("rail-tip-sess-1")!;
  expect(shown.getAttribute("role")).toBe("tooltip");
  expect([...shown.querySelectorAll(".rail-tooltip-line")].map((line) => line.textContent)).toEqual([
    "Video crew",
    `${t.sidebar.statusWaitingApproval} 2`,
  ]);
  expect(waiting.getAttribute("aria-describedby")).toBe(shown.id);
  expect(waiting.hasAttribute("title")).toBe(false);
  leave(waiting);
  await wait(160);
  flushSync();
  expect(tipFor("rail-tip-sess-1")).toBeNull();

  unread.focus();
  flushSync();
  const focused = tipFor("rail-tip-direct-1")!;
  expect([...focused.querySelectorAll(".rail-tooltip-line")].map((line) => line.textContent)).toEqual([
    "Writer",
    `${t.sidebar.unread} 4`,
  ]);
  expect(unread.getAttribute("aria-describedby")).toBe(focused.id);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  unread.dispatchEvent(escape);
  flushSync();
  expect(escape.defaultPrevented).toBe(true);
  expect(tipFor("rail-tip-direct-1")).toBeNull();
  expect(document.activeElement).toBe(unread);
  view.close();
});

test("an unset workspace still explains itself from the keyboard, and the click does nothing", () => {
  const view = open();
  const workspace = view.host.querySelector<HTMLButtonElement>(".rail-workspace")!;
  workspace.focus();
  flushSync();
  const shown = tipFor("rail-tip-workspace")!;
  expect([...shown.querySelectorAll(".rail-tooltip-line")].map((line) => line.textContent)).toEqual([
    t.sidebar.workspace,
    t.sidebar.workspaceUnset,
  ]);
  click(workspace);
  expect(view.tools).toEqual([]);
  expect(tipFor("rail-tip-workspace")).toBeNull();
  view.close();
});

test("a shortcut tip names the control and the keys, and a touch acts without leaving one open", async () => {
  const view = open(null, "/fixture");
  const expand = view.host.querySelector<HTMLButtonElement>(".rail-expand")!;
  expand.focus();
  flushSync();
  expect([...tipFor("rail-tip-expand")!.querySelectorAll(".rail-tooltip-line")].map((line) => line.textContent)).toEqual([t.sidebar.show, "⌘B"]);
  expand.blur();
  const search = view.host.querySelector<HTMLButtonElement>(".rail-search")!;
  search.focus();
  flushSync();
  const searchLines = [...tipFor("rail-tip-search")!.querySelectorAll(".rail-tooltip-line")].map((line) => line.textContent);
  expect(searchLines[0]).toBe(t.sidebar.searchShort);
  expect(searchLines[1]).toMatch(/⌘K|Ctrl\+K/);
  search.blur();
  flushSync();
  expect(tipFor("rail-tip-search")).toBeNull();

  search.dispatchEvent(pointer("pointerdown", "touch"));
  enter(search, "touch");
  click(search);
  expect(view.searches()).toBe(1);
  await wait(250);
  expect(tipFor("rail-tip-search")).toBeNull();
  view.close();
});

test("settings names a waiting update, and Escape on a tip leaves the tools menu open", () => {
  const view = open();
  const settings = view.host.querySelector<HTMLButtonElement>(".rail-settings")!;
  settings.focus();
  flushSync();
  expect(tipFor("rail-tip-settings")?.textContent).toBe(t.sidebar.settings);
  updateChecker.result = { current: "0.1.0", latest: "0.2.0", updateAvailable: true, releaseUrl: null, downloadUrl: null, publishedAt: null, notes: null };
  flushSync();
  expect(tipFor("rail-tip-settings")?.textContent).toBe(`${t.sidebar.settings} · ${t.sidebar.updateAvailable}`);
  expect(view.host.querySelector(".rail-update-dot")).not.toBeNull();
  updateChecker.result = null;
  flushSync();
  const tools = view.host.querySelector<HTMLButtonElement>(".rail-tools")!;
  click(tools);
  expect(view.host.querySelector(".tools-menu")).not.toBeNull();
  tools.focus();
  flushSync();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  tools.dispatchEvent(escape);
  flushSync();
  expect(escape.defaultPrevented).toBe(true);
  expect(tipFor("rail-tip-tools")).toBeNull();
  expect(view.host.querySelector(".tools-menu")).not.toBeNull();
  press(view.host.querySelector(".tools-menu"), "Escape");
  expect(view.host.querySelector(".tools-menu")).toBeNull();
  view.close();
});

test("taking the rail away clears a tip and its pending hover", async () => {
  const view = open();
  const waiting = item(view.host, "sess-1")!;
  waiting.focus();
  flushSync();
  expect(tip()).not.toBeNull();
  view.close();
  expect(document.querySelector("[data-rail-tip]")).toBeNull();

  const again = open();
  enter(item(again.host, "sess-1")!);
  again.close();
  await wait(250);
  expect(document.querySelector("[data-rail-tip]")).toBeNull();
});
