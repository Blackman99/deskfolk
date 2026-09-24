import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { SearchHit } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aRoutine, fakeRuntime } from "../test-fixtures.ts";
import { click, fill, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import GlobalSearch from "./GlobalSearch.svelte";
import { matchesSearchShortcut } from "./shortcuts.ts";
import { nextSearchIndex } from "./results.ts";

const t = copyFor("en");
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const rows: SearchHit[] = [
  { kind: "session", id: "sess-1", snippet: "Project", session_title: "Project" },
  { kind: "message", id: "msg-1", session_id: "sess-1", snippet: "Project update", session_title: "Project" },
  { kind: "file", path: "work/project/report.md", snippet: "work/project/report.md" },
  { kind: "routine", id: "routine-1", snippet: "Project routine" },
];
function open(hits: SearchHit[] = []) {
  const runtime = reactive(fakeRuntime({ bots: [aBot()], sessions: [aDirect({ id: "sess-1" })], routines: [aRoutine()] }));
  runtime.searchQuery = hits.length ? "project" : "";
  runtime.searchHits = hits;
  runtime.runSearch = async (q: string) => { runtime.searchQuery = q; runtime.searchHits = q ? rows : []; };
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const selected: SearchHit[] = [];
  let closed = 0;
  const view = render(GlobalSearch, { runtime, t, opener, onClose: () => { closed++; }, onSelect: (hit: SearchHit) => selected.push(hit) });
  let unmounted = false;
  const close = () => { if (!unmounted) { unmounted = true; view.close(); } };
  cleanups.push(() => { close(); opener.remove(); });
  return { ...view, close, runtime, opener, selected, closed: () => closed };
}

test("global search focuses a modal field and shows an instruction before a query", () => {
  const view = open();
  expect(view.host.querySelector("dialog")?.open).toBe(true);
  expect(document.activeElement).toBe(view.host.querySelector("input"));
  expect(view.host.textContent).toContain(t.sidebar.searchIntro);
  expect(view.host.querySelectorAll('[role="option"]')).toHaveLength(0);
  fill(view.host.querySelector("input"), "project");
  expect(view.host.querySelectorAll('[role="option"]')).toHaveLength(4);
  click(view.host.querySelector(".search-clear"));
  expect(view.runtime.searchQuery).toBe("");
  expect(document.activeElement).toBe(view.host.querySelector("input"));
});

test("category filters, file paths, arrow keys and Enter select the visible result", () => {
  const view = open(rows);
  const buttons = [...view.host.querySelectorAll<HTMLButtonElement>(".search-categories button")];
  click(buttons.find((button) => button.textContent === "File"));
  expect(view.host.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(view.host.querySelector(".result-name")?.textContent).toBe("report.md");
  expect(view.host.querySelector(".result-secondary")?.textContent).toBe("work/project/report.md");
  press(view.host.querySelector("input"), "Enter", { isComposing: true });
  expect(view.selected).toEqual([]);
  press(view.host.querySelector("input"), "Enter");
  expect(view.selected).toEqual([rows[2]]);
  click(buttons[0]);
  press(view.host.querySelector("input"), "ArrowUp");
  expect(view.host.querySelector('[aria-selected="true"]')?.textContent).toContain("Project routine");
});

test("historical routines with missing owners stay readable and cannot be opened", () => {
  const view = open([rows[3], rows[0]]);
  flushSync(() => { view.runtime.snapshot.bots = []; });
  const options = view.host.querySelectorAll('[role="option"]');
  expect(options[0].getAttribute("aria-disabled")).toBe("true");
  expect(options[0].textContent).toContain(t.sidebar.routineUnavailable);
  click(options[0]);
  expect(view.selected).toEqual([]);
  press(view.host.querySelector("input"), "Enter");
  expect(view.selected).toEqual([rows[0]]);
});

test("loading, failed, empty and disconnected states each have their own message", () => {
  const view = open(rows);
  flushSync(() => { view.runtime.searchLoading = true; });
  expect(view.host.textContent).toContain(t.sidebar.searchLoading);
  expect(view.host.querySelectorAll('[role="option"]')).toHaveLength(0);
  flushSync(() => { view.runtime.searchLoading = false; view.runtime.searchError = true; });
  expect(view.host.textContent).toContain(t.sidebar.searchFailed);
  const queries: string[] = [];
  view.runtime.runSearch = async (q) => { queries.push(q); };
  click(view.host.querySelector(".search-retry"));
  expect(queries).toEqual(["project"]);
  flushSync(() => { view.runtime.searchError = false; view.runtime.searchHits = []; });
  expect(view.host.textContent).toContain(t.sidebar.searchNoResults);
  flushSync(() => { view.runtime.connection = "disconnected"; });
  expect(view.host.textContent).toContain(t.sidebar.searchOffline);
});

test("Escape stays inside the modal, and cancelling restores the invoking control", () => {
  const view = open(rows);
  let escaped = 0;
  const listener = () => { escaped++; };
  window.addEventListener("keydown", listener);
  press(view.host.querySelector("input"), "Escape");
  window.removeEventListener("keydown", listener);
  expect(view.closed()).toBe(1);
  expect(escaped).toBe(0);
  view.close();
  expect(document.activeElement).toBe(view.opener);
});

test("selection drags to the backdrop preserve the dialog; an outside click cancels", () => {
  const view = open();
  const dialog = view.host.querySelector("dialog")!;
  view.host.querySelector("input")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  click(dialog);
  expect(view.closed()).toBe(0);
  dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  click(dialog);
  expect(view.closed()).toBe(1);
});

test("result navigation wraps and skips unavailable rows", () => {
  expect(nextSearchIndex([false, true, false, true], -1, 1)).toBe(1);
  expect(nextSearchIndex([false, true, false, true], 1, -1)).toBe(3);
  expect(nextSearchIndex([false], 0, 1)).toBe(-1);
});

test("search shortcut works while typing and reserves plain K for the terminal and editor", () => {
  const key = (target: Element, extra: KeyboardEventInit = {}) => ({ target, key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...extra }) as unknown as KeyboardEvent;
  const field = document.createElement("input");
  expect(matchesSearchShortcut(key(field))).toBe(true);
  expect(matchesSearchShortcut(key(field, { isComposing: true }))).toBe(false);
  expect(matchesSearchShortcut(key(field, { altKey: true }))).toBe(false);
  for (const className of ["xterm", "monaco-editor"]) {
    const editor = document.createElement("div"); editor.className = className; editor.append(field);
    expect(matchesSearchShortcut(key(field))).toBe(false);
    expect(matchesSearchShortcut(key(field, { shiftKey: true }))).toBe(true);
  }
});
