import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aRoutine, fakeRuntime } from "../test-fixtures.ts";
import { click, fill, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import RoutineCalendar from "./RoutineCalendar.svelte";

const t = copyFor("zh");

test("the calendar shows a roster source and does not write the snapshot when a source is hidden", () => {
  const runtime = reactive(fakeRuntime({
    bots: [aBot(), aBot({ id: "bot-2", name: "Idle", duties: "闲着" })],
    routines: [aRoutine()],
  }));
  const { host, close } = render(RoutineCalendar, { runtime, t });
  const calendar = host.querySelector<HTMLElement>(".routine-calendar")!;
  expect(calendar).not.toBeNull();
  expect(getComputedStyle(calendar).height).toBe("100%");
  expect(getComputedStyle(calendar).minHeight).toBe("0");
  expect(getComputedStyle(host.querySelector(".calendar-stage")!).minHeight).toBe("0");
  expect(host.textContent).toContain("Researcher");
  expect(host.textContent).not.toContain("Idle");
  expect(host.textContent).toContain(t.routines.zone);
  expect(host.querySelector(".roster-filter-menu")).toBeNull();
  expect(host.querySelector(".source-chip")).toBeNull();
  const trigger = host.querySelector<HTMLButtonElement>(".roster-filter-trigger")!;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.textContent).toContain(t.calendar.filterAll);
  click(trigger);
  const option = host.querySelector<HTMLButtonElement>(".roster-filter-option")!;
  expect(host.querySelectorAll(".roster-filter-option")).toHaveLength(1);
  expect(option.textContent).toContain("Researcher");
  expect(option.textContent).not.toContain("Idle");
  expect(option.getAttribute("aria-selected")).toBe("true");
  expect(option.querySelector(".bot-face img")?.getAttribute("src")).toContain("data:image/svg");
  click(option);
  expect(option.getAttribute("aria-selected")).toBe("false");
  expect(host.querySelector(".calendar-empty")).toBeNull();
  expect(runtime.snapshot.routines).toHaveLength(1);
  expect(runtime.calls.map((call) => call.name)).not.toContain("patchRoutine");
  click(option);
  expect(option.getAttribute("aria-selected")).toBe("true");
  const month = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "月");
  click(month);
  const face = host.querySelector(".event-face");
  expect(face?.textContent).toContain("Researcher");
  expect(face?.querySelector("img")?.getAttribute("src")).toContain("data:image/svg");
  click(face?.closest("button"));
  const detail = host.querySelector(".detail");
  expect(detail?.textContent).toContain("Researcher");
  expect(detail?.textContent).toContain("Morning brief");
  expect(detail?.textContent).toContain("Summarize today's work");
  expect(host.querySelector(".s5c-popover")).toBeNull();
  expect(runtime.calls.map((call) => call.name)).not.toContain("patchRoutine");
  close();
});

test("the agenda names the Bot on each routine", () => {
  const runtime = reactive(fakeRuntime({
    bots: [aBot(), aBot({ id: "bot-2", name: "Idle", duties: "闲着", avatar: null })],
    routines: [aRoutine()],
  }));
  const { host, close } = render(RoutineCalendar, { runtime, t });
  click([...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "议程"));
  const row = host.querySelector<HTMLButtonElement>(".routine-agenda-item")!;
  expect(row.textContent).toContain("Researcher");
  expect(row.textContent).toContain("Morning brief");
  expect(row.querySelector(".bot-face img")?.getAttribute("src")).toContain("data:image/svg");
  expect(host.querySelector(".routine-agenda")?.textContent).not.toContain("Idle");
  expect(getComputedStyle(host.querySelector(".s5c-agenda")!).display).toBe("none");
  click(row);
  expect(host.querySelector(".detail")?.textContent).toContain("Researcher");
  expect(host.querySelector(".detail")?.textContent).toContain("Morning brief");
  expect(runtime.calls.map((call) => call.name)).not.toContain("patchRoutine");
  close();
});

test("the roster filter searches by name or duties, keeps a hidden Bot while closed, and resets", () => {
  const runtime = reactive(fakeRuntime({
    bots: [
      aBot(),
      aBot({ id: "bot-2", name: "Writer", duties: "写稿", avatar: null }),
      aBot({ id: "bot-3", name: "Idle", duties: "闲着", avatar: null }),
    ],
    routines: [
      aRoutine(),
      aRoutine({ id: "routine-2", bot_id: "bot-2", title: "Draft" }),
    ],
  }));
  const { host, close } = render(RoutineCalendar, { runtime, t });
  const trigger = host.querySelector<HTMLButtonElement>(".roster-filter-trigger")!;
  click(trigger);
  const name = host.querySelector<HTMLElement>(".roster-filter-name")!;
  const hint = host.querySelector<HTMLElement>(".roster-filter-hint")!;
  expect(getComputedStyle(name).flexShrink).toBe("0");
  expect(getComputedStyle(hint).flexGrow).toBe("1");
  expect(getComputedStyle(hint).minWidth).not.toBe("auto");
  const labels = () => [...host.querySelectorAll(".roster-filter-option")].map((el) => el.textContent ?? "");
  expect(labels().some((text) => text.includes("Researcher"))).toBe(true);
  expect(labels().some((text) => text.includes("Writer"))).toBe(true);
  expect(labels().some((text) => text.includes("Idle"))).toBe(false);
  fill(host.querySelector(".roster-filter-search"), "稿");
  expect(labels()).toHaveLength(1);
  expect(labels()[0]).toContain("Writer");
  fill(host.querySelector(".roster-filter-search"), "没有这个人");
  expect(host.querySelector(".roster-filter-empty")?.textContent).toBe(t.calendar.filterNoMatch);
  fill(host.querySelector(".roster-filter-search"), "writer");
  expect(labels()).toHaveLength(1);
  expect(labels()[0]).toContain("Writer");
  fill(host.querySelector(".roster-filter-search"), "");
  click([...host.querySelectorAll(".roster-filter-option")].find((el) => el.textContent?.includes("Researcher")));
  expect(trigger.textContent).toContain("1/2");
  expect(host.querySelector(".roster-filter-menu")).not.toBeNull();
  click(trigger);
  expect(host.querySelector(".roster-filter-menu")).toBeNull();
  expect(trigger.textContent).toContain("1/2");
  click(trigger);
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  flushSync();
  expect(host.querySelector(".roster-filter-menu")).toBeNull();
  expect(trigger.textContent).toContain("1/2");
  click(host.querySelector(".filter-reset-btn"));
  expect(trigger.textContent).toContain(t.calendar.filterAll);
  expect(runtime.calls.map((call) => call.name)).not.toContain("patchRoutine");
  click(trigger);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(host.querySelector(".roster-filter-menu")).toBeNull();
  close();
});

for (const width of [390, 1280]) test(`routine details stay centered and scroll within the viewport at ${width}px`, () => {
  const viewport = (window as unknown as { happyDOM: { setViewport: (size: { width: number; height: number }) => void } }).happyDOM;
  viewport.setViewport({ width, height: 844 });
  const runtime = reactive(fakeRuntime({ bots: [aBot()], routines: [aRoutine({ instruction: 'Long instruction\n'.repeat(100) })] }));
  const { host, close } = render(RoutineCalendar, { runtime, t });
  try {
    click([...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '月'));
    click(host.querySelector('.event-face')?.closest('button'));
    const backdrop = host.querySelector('.detail-backdrop')!;
    const detail = host.querySelector('.detail')!;
    expect(getComputedStyle(backdrop).alignItems).toBe('center');
    expect(getComputedStyle(backdrop).justifyContent).toBe('center');
    expect(getComputedStyle(detail).maxHeight).toBe('100%');
    expect(getComputedStyle(detail).overflowY).toBe('auto');
    expect(getComputedStyle(detail).borderBottomLeftRadius).not.toBe('0px');
    click(detail);
    expect(host.querySelector('.detail')).not.toBeNull();
    click(host.querySelector('.detail-close'));
    expect(host.querySelector('.detail')).toBeNull();
    expect(host.querySelector('.routine-calendar')).not.toBeNull();
  } finally {
    close();
    viewport.setViewport({ width: 1024, height: 768 });
  }
});

for (const width of [390, 1280]) test(`roster filter stays a closed dropdown at ${width}px`, () => {
  const viewport = (window as unknown as { happyDOM: { setViewport: (size: { width: number; height: number }) => void } }).happyDOM;
  viewport.setViewport({ width, height: 844 });
  const runtime = reactive(fakeRuntime({ bots: [aBot(), aBot({ id: "bot-2", name: "Idle" })], routines: [aRoutine()] }));
  const { host, close } = render(RoutineCalendar, { runtime, t });
  try {
    const trigger = host.querySelector<HTMLButtonElement>('.roster-filter-trigger')!;
    expect(host.querySelector('.roster-filter-menu')).toBeNull();
    expect(host.querySelector('.calendar-sources')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toContain(t.calendar.filterAll);
    expect(host.textContent).not.toContain('Idle');
    if (width <= 680) {
      expect(getComputedStyle(trigger).minHeight).toBe('44px');
      expect(getComputedStyle(host.querySelector('.s5c-toolbar')!).display).toBe('grid');
    }
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.roster-filter-menu')).not.toBeNull();
    expect(host.querySelectorAll('.roster-filter-option')).toHaveLength(1);
    click(host.querySelector('.roster-filter-option'));
    expect(trigger.textContent).toContain('0/1');
    click(trigger);
    expect(host.querySelector('.roster-filter-menu')).toBeNull();
    expect(trigger.textContent).toContain('0/1');
    click(host.querySelector('.filter-reset-btn'));
    expect(trigger.textContent).toContain(t.calendar.filterAll);
    expect(runtime.calls.map((call) => call.name)).not.toContain('patchRoutine');
  } finally {
    close();
    viewport.setViewport({ width: 1024, height: 768 });
  }
});

for (const width of [390, 1280]) test(`calendar back at ${width}px has an accessible label and closes the page`, () => {
  const viewport = (window as unknown as { happyDOM: { setViewport: (size: { width: number; height: number }) => void } }).happyDOM;
  viewport.setViewport({ width, height: 844 });
  const runtime = reactive(fakeRuntime({ bots: [aBot()], routines: [] }));
  const { host, close } = render(RoutineCalendar, { runtime, t });
  try {
    const back = host.querySelector('.calendar-back')!;
    expect(back.getAttribute('aria-label')).toBe(t.common.back);
    expect(host.querySelector('.calendar-close')).toBeNull();
    expect(getComputedStyle(back.querySelector('span')!).display === 'none').toBe(width <= 680);
    if (width <= 680) expect(getComputedStyle(back).width).toBe('44px');
    click(back);
    expect(runtime.calls.map((call) => call.name)).toEqual(["closeRoutines"]);
  } finally {
    close();
    viewport.setViewport({ width: 1024, height: 768 });
  }
});
