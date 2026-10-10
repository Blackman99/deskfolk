import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import ModelPicker from "./ModelPicker.svelte";
import { copyFor } from "./copy.ts";
import { groupModels, type PickerData } from "./model-picker.ts";
import { click, fill, press, render } from "./test-render.ts";
import { settle } from "./test-async.ts";
import { closeMessageText } from "./chat/message-text-pages.ts";

const t = copyFor("zh");
const cleanups: Array<() => void> = [];
const realMatchMedia = window.matchMedia;
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  window.matchMedia = realMatchMedia;
});

function asPhone(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("max-width"),
    media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const rows = (ids: string[]) => ids.map((id) => ({ value: id, label: id }));
const opencode = [...Array(40)].map((_, i) => `${["alibaba", "nvidia", "xai"][i % 3]}/model-${i}`);

function data(): PickerData {
  return {
    specials: [{ value: "", label: "跟随默认" }],
    sources: [
      { key: "endpoint:cpa", label: "My CPA", mark: { kind: "custom", name: "Custom" }, groups: [{ key: "", label: null, rows: rows(["gemini-3.8", "grok-4.7"]) }] },
      { key: "agent:codex", label: "Codex", mark: { kind: "agent", runner: "codex", name: "Codex" }, groups: [{ key: "", label: null, rows: [{ value: "codex:gpt-5.6-terra", label: "GPT-5.6-Terra", detail: "gpt-5.6-terra" }] }] },
      { key: "agent:opencode", label: "OpenCode", mark: { kind: "agent", runner: "opencode", name: "OpenCode" }, groups: groupModels(rows(opencode)) },
      { key: "agent:dsh", label: "DSH", mark: { kind: "agent", runner: "dsh", name: "DSH" }, groups: [], custom: (typed) => `dsh:${typed}` },
      { key: "agent:zcode", label: "ZCode", mark: null, groups: [], disabled: true, note: "没装" },
    ],
  };
}

function open(value = "", props: Record<string, unknown> = {}) {
  const changes: string[] = [];
  const view = render(ModelPicker, { value, data: data(), t, ariaLabel: "模型", onchange: (next: string) => changes.push(next), ...props });
  cleanups.push(view.close);
  return { ...view, changes, trigger: view.host.querySelector<HTMLButtonElement>(".real-select-trigger")! };
}

const visibleRows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".mp-row")].map((row) => row.querySelector(".mp-row-label")?.textContent?.trim());

test("closed, it shows the model with its source's mark and name", () => {
  asPhone(false);
  const { trigger } = open("codex:gpt-5.6-terra");
  expect(trigger.textContent).toContain("GPT-5.6-Terra");
  expect(trigger.textContent).toContain("Codex");
  expect(trigger.querySelector("[data-agent-logo='codex']")).not.toBeNull();
});

test("on a wide window: sources on the left, the one pointed at on the right, the chosen model's source first", async () => {
  asPhone(false);
  const { host, trigger } = open("codex:gpt-5.6-terra");
  click(trigger);
  await settle();
  const sources = [...host.querySelectorAll<HTMLElement>(".mp-source")];
  expect(sources.map((el) => el.querySelector(".mp-source-label")?.textContent)).toEqual(["My CPA", "Codex", "OpenCode", "DSH", "ZCode"]);
  expect(host.querySelector(".mp-source.is-active")?.textContent).toContain("Codex");
  expect(visibleRows(host)).toEqual(["跟随默认", "GPT-5.6-Terra"]);
  // Pointing at another source shows its models, grouped.
  sources[2]!.dispatchEvent(new MouseEvent("mouseenter"));
  await settle();
  expect([...host.querySelectorAll(".mp-group")].map((el) => el.firstChild?.textContent)).toEqual(["alibaba", "nvidia", "xai"]);
  // One not found cannot be pointed into.
  sources[4]!.dispatchEvent(new MouseEvent("mouseenter"));
  await settle();
  expect(host.querySelector(".mp-source.is-active")?.textContent).toContain("OpenCode");
});

test("the keys walk sources and rows, and Enter picks", async () => {
  asPhone(false);
  const { host, trigger, changes } = open("gemini-3.8");
  click(trigger);
  await settle();
  const search = host.querySelector<HTMLInputElement>(".mp-search input")!;
  press(search, "ArrowLeft");
  press(search, "ArrowDown");
  expect(host.querySelector(".mp-source.is-active")?.textContent).toContain("Codex");
  press(search, "ArrowRight");
  press(search, "Enter");
  expect(changes).toEqual(["codex:gpt-5.6-terra"]);
  expect(host.querySelector(".mp-panel")).toBeNull();
});

test("a search looks through every source, and a source that takes typed names offers the one typed", async () => {
  asPhone(false);
  const { host, trigger, changes } = open("");
  click(trigger);
  await settle();
  const search = host.querySelector<HTMLInputElement>(".mp-search input")!;
  fill(search, "grok");
  expect([...host.querySelectorAll(".mp-heading")].map((el) => el.textContent?.trim())).toEqual(["My CPA"]);
  expect(visibleRows(host)).toEqual(["grok-4.7"]);
  fill(search, "zzz");
  expect(host.querySelector(".mp-empty")?.textContent).toBe(t.modelPicker.noMatch);
  // DSH lists nothing: pointed at, it takes the name typed.
  fill(search, "");
  host.querySelectorAll<HTMLElement>(".mp-source")[3]!.dispatchEvent(new MouseEvent("mouseenter"));
  await settle();
  expect(host.querySelector(".mp-empty")?.textContent).toContain(t.modelPicker.noModels);
  fill(search, "deepseek-v4-flash");
  expect(visibleRows(host)).toEqual([t.modelPicker.useTyped("deepseek-v4-flash")]);
  press(search, "Enter");
  expect(changes).toEqual(["dsh:deepseek-v4-flash"]);
});

test("Escape clears the search first, then closes", async () => {
  asPhone(false);
  const { host, trigger } = open("");
  click(trigger);
  await settle();
  const search = host.querySelector<HTMLInputElement>(".mp-search input")!;
  fill(search, "gpt");
  press(search, "Escape");
  expect(search.value).toBe("");
  expect(host.querySelector(".mp-panel")).not.toBeNull();
  press(search, "Escape");
  expect(host.querySelector(".mp-panel")).toBeNull();
});

test("on a phone: a sheet from the bottom, one level at a time, Back going up", async () => {
  asPhone(true);
  const { host, trigger, changes } = open("");
  click(trigger);
  await settle();
  expect(host.querySelector(".mp-sheet")).not.toBeNull();
  expect(host.querySelector(".mp-panel")).toBeNull();
  expect(host.querySelector(".mp-sheet-title")?.textContent).toBe("模型");
  const navs = () => [...host.querySelectorAll<HTMLButtonElement>(".mp-sheet-nav")];
  expect(navs().map((el) => el.querySelector(".mp-row-label")?.textContent)).toEqual(["My CPA", "Codex", "OpenCode", "DSH", "ZCode"]);
  expect(navs()[4]!.disabled).toBe(true);
  // OpenCode lists 40: its providers are a level of their own.
  click(navs()[2]);
  expect(host.querySelector(".mp-sheet-title")?.textContent).toBe("OpenCode");
  expect(navs().map((el) => el.querySelector(".mp-row-label")?.textContent)).toEqual(["alibaba", "nvidia", "xai"]);
  click(navs()[1]);
  expect(host.querySelector(".mp-sheet-title")?.textContent).toBe("nvidia");
  expect(visibleRows(host)[0]).toBe("model-1");
  // The phone's Back goes up a level, then another, then closes.
  expect(closeMessageText()).toBe(true);
  flushSync();
  expect(host.querySelector(".mp-sheet-title")?.textContent).toBe("OpenCode");
  click(host.querySelector(`[aria-label="${t.modelPicker.back}"]`));
  expect(host.querySelector(".mp-sheet-title")?.textContent).toBe("模型");
  click(navs()[1]);
  click(host.querySelector(".mp-row"));
  expect(changes).toEqual(["codex:gpt-5.6-terra"]);
  expect(host.querySelector(".mp-sheet")).toBeNull();
});

test("on a phone, a picker of one source opens on its models, the rows that are not models on top", async () => {
  asPhone(true);
  const single: PickerData = { specials: [{ value: "", label: "Codex 默认" }], sources: [data().sources[1]!] };
  const view = render(ModelPicker, { value: "", data: single, t, ariaLabel: "模型" });
  cleanups.push(view.close);
  click(view.host.querySelector(".real-select-trigger"));
  await settle();
  expect(view.host.querySelector(`[aria-label="${t.modelPicker.back}"]`)).toBeNull();
  expect(visibleRows(view.host)).toEqual(["Codex 默认", "GPT-5.6-Terra"]);
  // Its search finds the row above the models too; Escape clears it, and goes no further than the sheet.
  const search = view.host.querySelector<HTMLInputElement>(".mp-search input")!;
  fill(search, "默认");
  expect(visibleRows(view.host)).toEqual(["Codex 默认"]);
  let leaked = 0;
  const outside = (event: KeyboardEvent) => { if (event.key === "Escape") leaked += 1; };
  document.addEventListener("keydown", outside);
  press(search, "Escape");
  document.removeEventListener("keydown", outside);
  expect(leaked).toBe(0);
  expect(search.value).toBe("");
});

