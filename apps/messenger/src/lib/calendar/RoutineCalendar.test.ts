import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aRoutine, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import RoutineCalendar from "./RoutineCalendar.svelte";

const t = copyFor("zh");

test("the calendar shows a roster source and does not write the snapshot when a source is hidden", () => {
  const runtime = reactive(fakeRuntime({
    bots: [aBot()],
    routines: [aRoutine()],
  }));
  const { host, close } = render(RoutineCalendar, { runtime, t });
  expect(host.querySelector(".routine-calendar")).not.toBeNull();
  expect(host.textContent).toContain("Researcher");
  expect(host.textContent).toContain(t.routines.zone);
  const chip = host.querySelector<HTMLButtonElement>(".source-chip")!;
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  click(chip);
  flushSync();
  expect(chip.getAttribute("aria-pressed")).toBe("false");
  expect(runtime.snapshot.routines).toHaveLength(1);
  expect(runtime.calls.map((call) => call.name)).not.toContain("patchRoutine");
  click(chip);
  flushSync();
  expect(host.querySelector(".source-chip .bot-face img")?.getAttribute("src")).toContain("data:image/svg");
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

test('phone filters expand, retain hidden Bots when collapsed, and reset without changing routines', () => {
  const viewport = (window as unknown as { happyDOM: { setViewport: (size: { width: number; height: number }) => void } }).happyDOM;
  viewport.setViewport({ width: 390, height: 844 });
  const runtime = reactive(fakeRuntime({ bots: [aBot()], routines: [aRoutine()] }));
  const { host, close } = render(RoutineCalendar, { runtime, t });
  try {
    const toggle = host.querySelector('.filter-toggle')!;
    const sources = host.querySelector('.calendar-sources')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(getComputedStyle(sources).display).toBe('none');
    expect(getComputedStyle(host.querySelector('.s5c-toolbar')!).display).toBe('grid');
    click(toggle);
    expect(getComputedStyle(sources).display).toBe('flex');
    click(host.querySelector('.source-chip'));
    expect(toggle.textContent).toContain('0/1');
    click(toggle);
    expect(getComputedStyle(sources).display).toBe('none');
    expect(toggle.textContent).toContain('0/1');
    click(host.querySelector('.filter-reset-btn'));
    expect(toggle.textContent).toContain('1/1');
    expect(runtime.calls.map((call) => call.name)).not.toContain('patchRoutine');
    viewport.setViewport({ width: 1280, height: 900 });
    expect(getComputedStyle(sources).display).toBe('flex');
    expect(getComputedStyle(toggle).display).toBe('none');
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
