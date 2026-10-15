import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { SessionTaskSummary } from "@real-bot/protocol";
import MultiSelect from "./MultiSelect.svelte";
import Select from "./Select.svelte";
import StopMenu from "./chat/StopMenu.svelte";
import ToolsMenu from "./sidebar/ToolsMenu.svelte";
import TraceJobSwitcher from "./overlays/TraceJobSwitcher.svelte";
import { closeMessageText, messageTextOpen } from "./chat/message-text-pages.ts";
import { copyFor } from "./copy.ts";
import { reactive } from "./test-reactive.svelte.ts";
import { click, fill, mouseDown, press, render } from "./test-render.ts";

const t = copyFor("zh");
const realMatchMedia = window.matchMedia;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  window.matchMedia = realMatchMedia;
});

/** As narrow as a phone, or not: every `max-width` query answers `on`. */
function asPhone(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("max-width"),
    media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function mount<P extends Record<string, unknown>>(component: unknown, props: P) {
  const view = render(component as never, props);
  cleanups.push(view.close);
  return view;
}

const sheet = (host: HTMLElement) => host.querySelector<HTMLElement>(".bottom-sheet-layer");

test("on a phone a select's choices come up as a sheet named after the field, and a choice closes it", () => {
  asPhone(true);
  const picked: string[] = [];
  const label = document.createElement("label");
  label.htmlFor = "speech-lang";
  label.textContent = "识别语言";
  document.body.append(label);
  cleanups.push(() => label.remove());
  const { host } = mount(Select, { id: "speech-lang", value: "zh", options: [{ value: "zh", label: "中文" }, { value: "en", label: "English" }], onchange: (v: string) => picked.push(v) });
  click(host.querySelector(".real-select-trigger"));
  flushSync();
  expect(host.querySelector(".real-select-menu")).toBeNull();
  expect(sheet(host)?.querySelector(".bottom-sheet-title")?.textContent).toBe("识别语言");
  const rows = [...sheet(host)!.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(rows.map((row) => row.textContent?.trim())).toEqual(["中文", "English"]);
  click(rows[1]);
  flushSync();
  expect(picked).toEqual(["en"]);
  expect(sheet(host)).toBeNull();
  expect(host.querySelector(".real-select-value")?.textContent?.trim()).toBe("English");
});

test("a sheet closes on its backdrop, on Back, and on Escape without the page around it hearing the key", () => {
  asPhone(true);
  const { host } = mount(Select, { ariaLabel: "模型", value: "a", options: ["a", "b"] });
  const trigger = host.querySelector(".real-select-trigger");

  click(trigger);
  flushSync();
  click(sheet(host)!.querySelector(".bottom-sheet-backdrop"));
  flushSync();
  expect(sheet(host)).toBeNull();

  click(trigger);
  flushSync();
  expect(messageTextOpen()).toBe(true);
  expect(closeMessageText()).toBe(true);
  flushSync();
  expect(sheet(host)).toBeNull();
  expect(messageTextOpen()).toBe(false);

  let heard = 0;
  const listen = () => (heard += 1);
  document.addEventListener("keydown", listen);
  cleanups.push(() => document.removeEventListener("keydown", listen));
  click(trigger);
  flushSync();
  press(sheet(host)!.querySelector(".bottom-sheet-panel"), "Escape");
  flushSync();
  expect(sheet(host)).toBeNull();
  expect(heard).toBe(0);
});

test("on a desktop the same select still drops down under the field", () => {
  asPhone(false);
  const { host } = mount(Select, { ariaLabel: "模型", value: "a", options: ["a", "b"] });
  click(host.querySelector(".real-select-trigger"));
  flushSync();
  expect(host.querySelector(".real-select-menu")).not.toBeNull();
  expect(sheet(host)).toBeNull();
});

test("on a phone a multi-select opens a sheet with its own search box, and stays open for several ticks", () => {
  asPhone(true);
  const { host } = mount(MultiSelect, {
    id: "members", ariaLabel: "成员", searchPlaceholder: "搜索",
    options: [{ value: "b1", label: "甲" }, { value: "b2", label: "乙" }, { value: "b3", label: "丙" }],
  });
  mouseDown(host.querySelector(".multi-select-field"));
  flushSync();
  expect(host.querySelector(".multi-select-menu")).toBeNull();
  const search = sheet(host)!.querySelector<HTMLInputElement>(".multi-select-sheet-search")!;
  // The keyboard comes up only when you choose to type.
  expect(document.activeElement).not.toBe(search);
  expect(document.activeElement).not.toBe(host.querySelector(".multi-select-input"));
  fill(search, "乙");
  flushSync();
  const rows = () => [...sheet(host)!.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(rows().map((row) => row.textContent?.trim())).toEqual(["乙"]);
  click(rows()[0]);
  fill(search, "");
  flushSync();
  click(rows()[2]);
  flushSync();
  expect(sheet(host)).not.toBeNull();
  expect([...host.querySelectorAll(".multi-select-chip-label")].map((chip) => chip.textContent)).toEqual(["乙", "丙"]);
  press(sheet(host)!.querySelector(".bottom-sheet-panel"), "Escape");
  flushSync();
  expect(sheet(host)).toBeNull();
});

test("on a phone the stop menu's choices come up as a sheet and a choice makes the stop", () => {
  asPhone(true);
  const picked: string[] = [];
  const items = [{ key: "bot", label: "停下这个 Bot", scope: "bot", id: "b1" }, { key: "all", label: "全部停下", scope: "all", id: null }];
  const { host } = mount(StopMenu, { items, t, onPick: (item: { key: string }) => void picked.push(item.key) });
  click(host.querySelector(".stop-menu-trigger"));
  flushSync();
  expect(host.querySelector(".stop-menu-list")).toBeNull();
  expect(sheet(host)?.querySelector(".bottom-sheet-title")?.textContent).toBe(t.control.menu);
  const rows = [...sheet(host)!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(rows.map((row) => row.textContent?.trim())).toEqual(["停下这个 Bot", "全部停下"]);
  click(rows[1]);
  flushSync();
  expect(picked).toEqual(["all"]);
  expect(sheet(host)).toBeNull();
});

test("on a phone the tools come up as a sheet; a tool closes it and opens", () => {
  asPhone(true);
  const anchor = document.createElement("button");
  document.body.append(anchor);
  cleanups.push(() => anchor.remove());
  const opened: string[] = [];
  const state = reactive({ open: true });
  const { host } = mount(ToolsMenu, {
    t, locale: "zh", phone: true, pages: true, anchor, archivedCount: 2,
    get open() { return state.open; }, set open(value: boolean) { state.open = value; },
    onOpenRoutines: () => opened.push("routines"), onOpenSpend: () => opened.push("spend"),
    onOpenTerminal: () => opened.push("terminal"), onOpenArchived: () => opened.push("archived"),
  });
  flushSync();
  expect(host.querySelector(".tools-menu")).toBeNull();
  const rows = [...sheet(host)!.querySelectorAll<HTMLElement>(".tools-menu-item")];
  expect(rows.at(-1)?.textContent).toContain(t.sidebar.archivedSessions);
  click(rows[1]);
  flushSync();
  expect(opened).toEqual(["spend"]);
  expect(state.open).toBe(false);
  expect(sheet(host)).toBeNull();
});

test("on a phone the jobs of a conversation come up as a sheet", () => {
  asPhone(true);
  const job = (id: string, title: string) => ({ id, title, dir: `work/${id}`, closed_at: null, status: "active" }) as unknown as SessionTaskSummary;
  const picked: string[] = [];
  const { host } = mount(TraceJobSwitcher, { jobs: [job("j1", "做片头"), job("j2", "配字幕")], currentId: "j1", heading: "做片头", t, onSelectJob: (id: string) => picked.push(id) });
  click(host.querySelector(".trace-title-trigger"));
  flushSync();
  expect(host.querySelector(".trace-switcher-popover")).toBeNull();
  const rows = [...sheet(host)!.querySelectorAll<HTMLElement>(".trace-job")];
  expect(rows.map((row) => row.querySelector(".trace-job-title")?.textContent)).toEqual(["做片头", "配字幕"]);
  click(rows[1]);
  expect(picked).toEqual(["j2"]);
});
