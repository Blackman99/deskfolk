/**
 * The board's own handling, split from TaskTrace.test.ts for length: long jobs folded to rounds,
 * the camera (wheel, fit, where you left it), the minimap, stops on the board, and your decisions.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { flushSync } from "svelte";
import { USER_MEMBER, type AcceptanceCheck, type Hold, type PlanRequirement, type RouteRecord, type SessionTaskSummary, type TaskDetail, type TaskTrace } from "@real-bot/protocol";
import { mockMonacoCss } from "../test-mocks.ts";

mockMonacoCss();
const { default: TaskTraceView } = await import("./TaskTrace.svelte");
const { default: TraceView } = await import("./TraceView.svelte");
import { copyFor } from "../copy.ts";
import { forgetTraceMinimap, loadTraceMinimap } from "./trace-minimap.ts";
import { forgetSpentAsks, forgetTraceView, loadTraceView, saveTraceView, type TraceViewAsk, type TraceViewKind } from "./trace-view.ts";
import { forgetKeptBoards } from "./task-trace.ts";
import { aBot, aDirect, aGroup, aHold } from "../test-fixtures.ts";
import { buttonByText, click, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { settle } from "../test-async.ts";

import { writer, artist, group, direct, job, detail, picture, drag, type Opened, open, until, aRecord, routedPicture, withMeasuredCards } from "./task-trace-test-kit.ts";

const t = copyFor("zh");

// A board left in one test would otherwise come back where that test left it in the next.
afterEach(() => {
  forgetKeptBoards();
  forgetTraceMinimap();
  forgetSpentAsks();
});

/** A job of `count` rounds: a line of yours and the Bot answering it, a minute apart. */
function longJob(count: number): TaskTrace {
  return {
    ...picture(),
    nodes: Array.from({ length: count }, (_, index) => {
      const minute = String(index).padStart(2, "0");
      const base = { session_id: "group-1", woken_elsewhere: null, artifacts: [], ask: null, approval: null, passed: 0 };
      return [
        {
          ...base,
          turn_id: `user:r${index}`,
          actor: USER_MEMBER,
          status: "completed" as const,
          woken_by_turn_id: null,
          trigger_message_id: `r${index}`,
          focus_message_id: `r${index}`,
          summary: `第 ${index} 句`,
          created_at: `2026-09-22T00:${minute}:00.000Z`,
        },
        {
          ...base,
          turn_id: `t${index}`,
          actor: "bot-1",
          status: "completed" as const,
          woken_by_turn_id: `user:r${index}`,
          trigger_message_id: `r${index}`,
          focus_message_id: `w${index}`,
          summary: `回第 ${index} 句`,
          created_at: `2026-09-22T00:${minute}:30.000Z`,
        },
      ];
    }).flat(),
  };
}

test("a long job opens with its older rounds folded to a line each, and a line unfolds its round", async () => {
  const view = open({ trace: longJob(5), pane: true });
  await until(view.host, ".trace-round");
  const rows = () => [...view.host.querySelectorAll<HTMLButtonElement>(".trace-round")];
  expect(rows()).toHaveLength(5);
  expect(rows().map((row) => row.classList.contains("is-folded"))).toEqual([true, true, true, false, false]);
  // Only the newest two rounds are drawn as cards; a folded line says whose line it was.
  expect(view.host.querySelectorAll(".trace-slot")).toHaveLength(4);
  expect(rows()[0]?.querySelector(".trace-round-said")?.textContent).toBe("你第 0 句");
  expect(rows()[0]?.getAttribute("aria-expanded")).toBe("false");

  click(rows()[0]!);
  flushSync();
  expect(rows()[0]?.getAttribute("aria-expanded")).toBe("true");
  expect(view.host.querySelectorAll(".trace-slot")).toHaveLength(6);
  expect(rows()[0]?.querySelector(".trace-round-said")).toBeNull();

  click(rows()[0]!);
  flushSync();
  expect(view.host.querySelectorAll(".trace-slot")).toHaveLength(4);
  view.close();
});

test("a message asking for a card in a folded round opens that round", async () => {
  const view = open({ trace: longJob(5), pane: true, focus: { messageId: "w0", turnId: "t0" }, focusToken: 1 });
  await until(view.host, ".trace-round");
  const first = view.host.querySelector(".trace-round");
  expect(first?.classList.contains("is-folded")).toBe(false);
  expect([...view.host.querySelectorAll(".trace-card-who")].length).toBe(6);
  view.close();
});

test("folding a round keeps its line where you pressed it, and a fold that empties the view brings the cards back", async () => {
  // The newest round fans out to three Bots, wider than any other, so folding it moves the spine.
  const base = longJob(5);
  const answer = base.nodes.find((node) => node.turn_id === "t4")!;
  const trace = {
    ...base,
    nodes: [
      ...base.nodes,
      { ...answer, turn_id: "t4b", actor: "bot-2", focus_message_id: "w4b", created_at: "2026-09-22T00:04:40.000Z" },
      { ...answer, turn_id: "t4c", focus_message_id: "w4c", created_at: "2026-09-22T00:04:50.000Z" },
    ],
  };
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    await withMeasuredCards(async () => {
      const view = open({ trace, pane: true });
      await until(view.host, ".trace-slot");
      await new Promise((resolve) => setTimeout(resolve, 60));
      flushSync();
      const flow = view.host.querySelector<HTMLElement>(".trace-flow")!;
      const board = () => {
        const [, x, y, scale] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(flow.style.transform)!;
        return { x: Number(x), y: Number(y), scale: Number(scale), width: Number.parseFloat(flow.style.width), height: Number.parseFloat(flow.style.height) };
      };
      const newest = () => [...view.host.querySelectorAll<HTMLElement>(".trace-round")].at(-1)!;
      const onScreen = (row: HTMLElement) => {
        const at = board();
        return { x: at.x + Number.parseFloat(row.style.left) * at.scale, y: at.y + Number.parseFloat(row.style.top) * at.scale };
      };
      const expectAt = (row: HTMLElement, at: { x: number; y: number }) => {
        expect(onScreen(row).x).toBeCloseTo(at.x, 6);
        expect(onScreen(row).y).toBeCloseTo(at.y, 6);
      };
      // Read down to the newest round, so its line sits at the top of the view.
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: onScreen(newest()).y - 20 });
      view.host.querySelector(".trace-viewport")!.dispatchEvent(wheel);
      flushSync();
      const pressed = onScreen(newest());
      const wide = board().width;

      click(newest());
      flushSync();
      expect(newest().classList.contains("is-folded")).toBe(true);
      // The spine moved, and the line you pressed did not.
      expect(board().width).toBeLessThan(wide);
      expectAt(newest(), pressed);

      // Nothing is left under it, so the board slides down until the whole of it is in view.
      await new Promise((resolve) => setTimeout(resolve, 450));
      flushSync();
      const settled = board();
      expect(settled.y).toBe(12);
      expect(settled.y + settled.height * settled.scale).toBeLessThanOrEqual(588);
      expect(onScreen(newest()).x).toBeCloseTo(pressed.x, 6);
      expect(onScreen(newest()).y).toBeGreaterThan(pressed.y);

      // Unfolding holds the line too; the cards come back under it.
      const folded = onScreen(newest());
      click(newest());
      flushSync();
      expect(newest().classList.contains("is-folded")).toBe(false);
      expectAt(newest(), folded);
      view.close();
    });
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

test("the wheel pans the board and only ⌘/Ctrl + wheel zooms it", async () => {
  const view = open({ trace: longJob(5), pane: true });
  await until(view.host, ".trace-slot");
  const viewport = view.host.querySelector(".trace-viewport")!;
  const board = () => {
    const style = (view.host.querySelector(".trace-flow") as HTMLElement).style.transform;
    const [, x, y, scale] = /translate\(([^,]+)px, ([^)]+)px\) scale\(([^)]+)\)/.exec(style)!;
    return { x: Number(x), y: Number(y), scale: Number(scale) };
  };
  const wheel = (init: WheelEventInit) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    // happy-dom's WheelEvent drops the modifier keys from its init; a browser's does not.
    for (const key of ["ctrlKey", "metaKey", "shiftKey"] as const) {
      Object.defineProperty(event, key, { value: init[key] ?? false });
    }
    viewport.dispatchEvent(event);
    flushSync();
  };
  const start = board();
  wheel({ deltaY: 120 });
  expect(board()).toEqual({ ...start, y: start.y - 120 });
  wheel({ deltaX: 40 });
  expect(board()).toEqual({ ...start, x: start.x - 40, y: start.y - 120 });
  // A trackpad pinch arrives as ctrl + wheel, and ⌘ + wheel is the mouse's way to the same.
  wheel({ deltaY: -200, ctrlKey: true });
  expect(board().scale).toBeGreaterThan(start.scale);
  const zoomed = board().scale;
  wheel({ deltaY: 200, metaKey: true });
  expect(board().scale).toBeLessThan(zoomed);
  view.close();
});

test("the fit button brings the whole board back from wherever it was dragged, and the percentage goes back to life size", async () => {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    await withMeasuredCards(async () => {
      const view = open({ trace: longJob(3), pane: true });
      await until(view.host, ".trace-slot");
      await new Promise((resolve) => setTimeout(resolve, 60));
      flushSync();
      const flow = view.host.querySelector<HTMLElement>(".trace-flow")!;
      const board = () => {
        const [, x, y, scale] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(flow.style.transform)!;
        return { x: Number(x), y: Number(y), scale: Number(scale), width: Number.parseFloat(flow.style.width), height: Number.parseFloat(flow.style.height) };
      };
      const viewport = view.host.querySelector(".trace-viewport")!;
      const wheel = (init: WheelEventInit) => {
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
        for (const key of ["ctrlKey", "metaKey", "shiftKey"] as const) {
          Object.defineProperty(event, key, { value: init[key] ?? false });
        }
        viewport.dispatchEvent(event);
        flushSync();
      };
      const zoomButton = (label: string) => view.host.querySelector<HTMLButtonElement>(`.trace-zoom button[aria-label="${label}"]`);
      // Zoomed in and dragged off into empty canvas.
      for (let i = 0; i < 3; i += 1) click(zoomButton(t.trace.zoomIn));
      wheel({ deltaY: 2000, deltaX: 1500 });
      expect(board().scale).toBeGreaterThan(1);

      const fit = zoomButton(t.trace.zoomFit);
      expect(fit?.title).toBe(t.trace.zoomFit);
      click(fit);
      await new Promise((resolve) => setTimeout(resolve, 450));
      flushSync();
      const fitted = board();
      // All of it inside the view, 12px clear of each edge, the middle of it in the middle.
      expect(fitted.scale).toBeLessThanOrEqual(1);
      expect(fitted.x).toBeGreaterThanOrEqual(12);
      expect(fitted.y).toBeGreaterThanOrEqual(12);
      expect(fitted.x + fitted.width * fitted.scale).toBeLessThanOrEqual(788);
      expect(fitted.y + fitted.height * fitted.scale).toBeLessThanOrEqual(588);
      expect(fitted.x + (fitted.width * fitted.scale) / 2).toBeCloseTo(400, 0);
      // As large as that allows: it fills the view one way, or is drawn at life size.
      const fills =
        Math.abs(fitted.width * fitted.scale - 776) < 1 || Math.abs(fitted.height * fitted.scale - 576) < 1;
      expect(fills || fitted.scale === 1).toBe(true);

      // Zoomed out, the percentage takes it back to 100% and keeps the middle of the view where it was.
      click(zoomButton(t.trace.zoomOut));
      const out = board();
      expect(out.scale).toBeLessThan(fitted.scale);
      const middle = { x: (400 - out.x) / out.scale, y: (300 - out.y) / out.scale };
      const level = view.host.querySelector<HTMLButtonElement>(".trace-zoom-level")!;
      expect(level.title).toBe(t.trace.zoomReset);
      click(level);
      const life = board();
      expect(life.scale).toBe(1);
      expect(level.textContent?.trim()).toBe("100%");
      expect(400 - life.x).toBeCloseTo(middle.x, 6);
      expect(300 - life.y).toBeCloseTo(middle.y, 6);
      view.close();
    });
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

/** The viewport an 800 × 600 pane gives the board. */
async function inViewport(run: () => Promise<void>): Promise<void> {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    await withMeasuredCards(run);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
}

/** Let the cards measure and the board place itself on them. */
async function laidOut(view: { host: HTMLElement }): Promise<void> {
  await until(view.host, ".trace-slot");
  await new Promise((resolve) => setTimeout(resolve, 60));
  flushSync();
}

function cameraOf(view: { host: HTMLElement }): string {
  return view.host.querySelector<HTMLElement>(".trace-flow")!.style.transform;
}

function pan(view: { host: HTMLElement }, by: { x: number; y: number }): void {
  const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: -by.x, deltaY: -by.y });
  view.host.querySelector(".trace-viewport")!.dispatchEvent(wheel);
  flushSync();
}

test("a board brought forward again is where you left it, with the rounds you unfolded", async () => {
  // A tab that is not the one showing is unmounted: bringing it back mounts the board anew, and it
  // used to open afresh on its newest round instead of where you had been reading.
  await inViewport(async () => {
    const first = open({ trace: longJob(5), pane: true });
    await laidOut(first);
    const opened = cameraOf(first);
    click(first.host.querySelector(".trace-round")!);
    flushSync();
    pan(first, { x: 40, y: 260 });
    const left = cameraOf(first);
    expect(left).not.toBe(opened);
    first.close();

    const again = open({ trace: longJob(5), pane: true });
    await laidOut(again);
    expect(cameraOf(again)).toBe(left);
    expect(again.host.querySelector(".trace-round")?.classList.contains("is-folded")).toBe(false);
    again.close();
  });
});

test("a message's card is centred once: its tab brought forward again stays where you took the board", async () => {
  await inViewport(async () => {
    const focus = { messageId: "m3", turnId: "t-artist" };
    const first = open({ pane: true, focus, focusToken: 1 });
    await laidOut(first);
    const centred = cameraOf(first);
    pan(first, { x: 0, y: -180 });
    const left = cameraOf(first);
    expect(left).not.toBe(centred);
    first.close();

    // The tab still carries the request it was opened with; it has been answered already.
    const again = open({ pane: true, focus, focusToken: 1 });
    await laidOut(again);
    expect(cameraOf(again)).toBe(left);

    // A new request does move it.
    again.props.focus = { messageId: "m1", turnId: null };
    again.props.focusToken = 2;
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 450));
    flushSync();
    expect(cameraOf(again)).not.toBe(left);
    again.close();
  });
});

test("a job picked again in the switcher is where you left it", async () => {
  await inViewport(async () => {
    const view = open({ trace: longJob(5), otherTrace: { ...longJob(3), id: "task-2", title: "上周的排期" }, pane: true, writeBack: true });
    await laidOut(view);
    pan(view, { x: -30, y: 220 });
    const left = cameraOf(view);

    view.props.taskId = "task-2";
    flushSync();
    for (let i = 0; i < 20 && !view.host.querySelector(".trace-titles h2")?.textContent?.includes("上周的排期"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await laidOut(view);
    expect(cameraOf(view)).not.toBe(left);

    view.props.taskId = "task-1";
    flushSync();
    for (let i = 0; i < 20 && !view.host.querySelector(".trace-titles h2")?.textContent?.includes("先出分镜"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await laidOut(view);
    expect(cameraOf(view)).toBe(left);
    view.close();
  });
});

/** The board's camera as numbers: where the middle of an 800 × 600 view is on the board, and the zoom. */
function middleOf(view: { host: HTMLElement }): { x: number; y: number; scale: number } {
  const [, x, y, scale] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(cameraOf(view))!;
  const zoom = Number(scale);
  return { x: (400 - Number(x)) / zoom, y: (300 - Number(y)) / zoom, scale: zoom };
}

function rectOf(el: Element): { x: number; y: number; width: number; height: number } {
  const read = (name: string) => Number(el.getAttribute(name));
  return { x: read("x"), y: read("y"), width: read("width"), height: read("height") };
}

function pointer(el: Element, type: string, at: { x: number; y: number }): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: at.x, clientY: at.y }));
  flushSync();
}

test("the minimap draws every card and frames the view; pressing it slides the board there, and dragging the frame carries it", async () => {
  await inViewport(async () => {
    const view = open({ trace: longJob(5), pane: true });
    await laidOut(view);
    const map = view.host.querySelector(".trace-minimap")!;
    expect(map).not.toBeNull();
    expect(map.querySelectorAll(".minimap-card")).toHaveLength(view.host.querySelectorAll(".trace-slot").length);
    // Folded rounds are their line, on the map as on the board.
    expect(map.querySelectorAll(".minimap-round.is-folded").length).toBe(view.host.querySelectorAll(".trace-round.is-folded").length);
    expect(map.querySelector(".minimap-view")).not.toBeNull();

    // Off into empty canvas, then back by pressing a card on the map: it slides into the middle.
    pan(view, { x: -2400, y: -1800 });
    const target = map.querySelector('.minimap-card[data-turn="t4"]')!;
    const drawn = rectOf(target);
    const slot = [...view.host.querySelectorAll<HTMLElement>(".trace-slot")].find((el) => el.textContent?.includes("回第 4 句"))!;
    const card = { x: Number.parseFloat(slot.style.left) + 124, y: Number.parseFloat(slot.style.top) + slot.offsetHeight / 2 };
    const scale = middleOf(view).scale;
    const at = { x: drawn.x + drawn.width / 2, y: drawn.y + drawn.height / 2 };
    pointer(map, "pointerdown", at);
    pointer(map, "pointerup", at);
    await new Promise((resolve) => setTimeout(resolve, 450));
    flushSync();
    const landed = middleOf(view);
    expect(landed.scale).toBe(scale);
    expect(landed.x).toBeCloseTo(card.x, 3);
    expect(landed.y).toBeCloseTo(card.y, 3);

    // The frame picked up and moved takes the view with it, by as much as the map says.
    const frame = rectOf(map.querySelector(".minimap-view")!);
    const perPixel = 800 / scale / frame.width;
    const from = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    pointer(map, "pointerdown", from);
    // A press on the frame alone moves nothing.
    expect(middleOf(view).x).toBeCloseTo(landed.x, 3);
    pointer(map, "pointermove", { x: from.x - 6, y: from.y - 10 });
    pointer(map, "pointerup", { x: from.x - 6, y: from.y - 10 });
    const moved = middleOf(view);
    expect(moved.x).toBeCloseTo(landed.x - 6 * perPixel, 3);
    expect(moved.y).toBeCloseTo(landed.y - 10 * perPixel, 3);
    view.close();
  });
});

test("the minimap lights and dims what the board does", async () => {
  await inViewport(async () => {
    const view = open({ trace: routedPicture(), pane: true });
    await laidOut(view);
    const chip = [...view.host.querySelectorAll<HTMLButtonElement>(".trace-highlight")].find((b) => b.textContent?.includes("有反馈"))!;
    click(chip);
    flushSync();
    const card = (turn: string) => view.host.querySelector(`.minimap-card[data-turn="${turn}"]`)!;
    expect(card("t-writer").classList.contains("is-lit")).toBe(true);
    expect(card("t-artist").classList.contains("is-dim")).toBe(true);
    // Each card in its status's colour, as on the board.
    expect(card("t-artist").classList.contains("is-running")).toBe(true);
    view.close();
  });
});

test("the minimap can be put away from the zoom pill, and stays away on the next board", async () => {
  await inViewport(async () => {
    const view = open({ pane: true });
    await laidOut(view);
    const toggle = view.host.querySelector<HTMLButtonElement>(".trace-zoom-minimap")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.title).toBe(t.trace.minimapHide);
    expect(view.host.querySelector(".trace-minimap")).not.toBeNull();
    click(toggle);
    flushSync();
    expect(view.host.querySelector(".trace-minimap")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe(t.trace.minimapShow);
    expect(loadTraceMinimap()).toBe(false);
    view.close();

    const again = open({ pane: true });
    await laidOut(again);
    expect(again.host.querySelector(".trace-minimap")).toBeNull();
    click(again.host.querySelector<HTMLButtonElement>(".trace-zoom-minimap"));
    flushSync();
    expect(again.host.querySelector(".trace-minimap")).not.toBeNull();
    again.close();
  });
});

test("a viewport too small to spare a corner draws no minimap", async () => {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 240, height: 180, top: 0, left: 0, right: 240, bottom: 180, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    const view = open({ pane: true });
    await until(view.host, ".trace-slot");
    flushSync();
    expect(view.host.querySelector(".trace-zoom-minimap")).not.toBeNull();
    expect(view.host.querySelector(".trace-minimap")).toBeNull();
    view.close();
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

test("the board shows your stops over its job, lifts one, and its stop menu stops the job or every Bot", async () => {
  const view = open({ pane: true });
  await until(view.host, ".trace-meta");
  const stops: unknown[] = [];
  const lifts: string[] = [];
  const props = view.props as unknown as { holds: Hold[] | null; onStop: (choice: unknown) => void; onLift: (hold: Hold) => unknown };
  props.onStop = (choice) => void stops.push(choice);
  props.onLift = (hold) => void lifts.push(hold.id);
  props.holds = [];
  flushSync();
  click(view.host.querySelector(".stop-menu-trigger"));
  expect([...view.host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["停下这件事《先出分镜》", "停下所有 Bot"]);
  click(buttonByText(view.host, "停下这件事《先出分镜》"));
  expect(stops).toEqual([{ scope: "plan", id: "task-1" }]);

  props.holds = [
    aHold({ id: "h-1", scope: "plan", scope_id: "task-1", plan_title: "先出分镜" }),
    aHold({ id: "h-2", scope: "bot", scope_id: "bot-1" }),
    aHold({ id: "h-3", scope: "bot_plan", scope_id: "bot-2:task-1", plan_title: "先出分镜", lift_on_next_user_message: true }),
    aHold({ id: "h-4", scope: "plan", scope_id: "task-2", plan_title: "上周的排期" }),
  ];
  flushSync();
  // A stop on one Bot's whole work, or on another job, is not this board's; a Stop for now is not shown (ADR 0081).
  expect([...view.host.querySelectorAll(".trace-hold-label")].map((label) => label.textContent)).toEqual(["「先出分镜」这件事"]);
  click(view.host.querySelector(".trace-hold-lift"));
  expect(lifts).toEqual(["h-1"]);
  expect(view.host.querySelector(".trace-hold-error")).toBeNull();
  // A refused lift says so on its chip, where the time was.
  props.onLift = async () => ({ status: 409 });
  flushSync();
  click(view.host.querySelector(".trace-hold-lift"));
  await Promise.resolve();
  flushSync();
  expect(view.host.querySelector(".trace-hold-error")?.textContent).toBe("没做成，再试一次");
  click(view.host.querySelector(".stop-menu-trigger"));
  expect([...view.host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["停下所有 Bot"]);
  view.close();
});

test("with the daemon out of reach the board's stop menu and lifts show but cannot be pressed", async () => {
  const view = open({ pane: true });
  await until(view.host, ".trace-meta");
  const pressed: unknown[] = [];
  const props = view.props as unknown as { holds: Hold[] | null; onStop: (choice: unknown) => void; onLift: (hold: Hold) => unknown; controlsDisabled: boolean };
  props.onStop = (choice) => void pressed.push(choice);
  props.onLift = (hold) => void pressed.push(hold.id);
  props.holds = [aHold({ id: "h-3", scope: "bot_plan", scope_id: "bot-2:task-1", plan_title: "先出分镜" })];
  props.controlsDisabled = true;
  flushSync();
  const trigger = view.host.querySelector<HTMLButtonElement>(".stop-menu-trigger");
  const lift = view.host.querySelector<HTMLButtonElement>(".trace-hold-lift");
  expect(trigger?.disabled).toBe(true);
  expect(lift?.disabled).toBe(true);
  click(trigger);
  click(lift);
  expect(view.host.querySelector('[role="menuitem"]')).toBeNull();
  expect(pressed).toEqual([]);
  // Back in reach: both work again.
  props.controlsDisabled = false;
  flushSync();
  click(view.host.querySelector(".trace-hold-lift"));
  expect(pressed).toEqual(["h-3"]);
  view.close();
});

test("before the daemon has stops the board offers none", async () => {
  const view = open({ pane: true });
  await until(view.host, ".trace-meta");
  expect(view.host.querySelector(".stop-menu-trigger")).toBeNull();
  expect(view.host.querySelector(".trace-holds")).toBeNull();
  view.close();
});

test("your decisions hang under the card they answer: an answer with its question, a 放行, a 退回 with your words", async () => {
  const base = picture();
  const decided: TaskTrace = {
    ...base,
    nodes: [
      ...base.nodes,
      { ...base.nodes[0]!, turn_id: "decision:ask-1", woken_by_turn_id: "t-writer", trigger_message_id: "ask-1", focus_message_id: "ask-1",
        summary: "粉丝纪念向", created_at: "2026-09-22T00:05:00.000Z", decision: { kind: "answer", question: "这支 MV 打算怎么用？" } },
      { ...base.nodes[0]!, turn_id: "decision:card-1", woken_by_turn_id: "t-writer", trigger_message_id: "card-1", focus_message_id: "card-1",
        summary: "人物太粗糙", created_at: "2026-09-22T00:06:00.000Z", decision: { kind: "reject", submission_id: "s1" } },
      { ...base.nodes[0]!, turn_id: "decision:card-2", woken_by_turn_id: "t-writer", trigger_message_id: "card-2", focus_message_id: "card-2",
        summary: "", created_at: "2026-09-22T00:07:00.000Z", decision: { kind: "approve", submission_id: "s2", result: "检查没过，已退回" } },
    ],
  };
  const view = open({ trace: decided });
  await until(view.host, ".trace-decision");
  const chips = [...view.host.querySelectorAll(".trace-decision")].map((chip) => chip.textContent?.trim());
  expect(chips).toEqual(["回答", "退回", "放行"]);
  const cards = [...view.host.querySelectorAll(".trace-card")].filter((card) => card.querySelector(".trace-decision"));
  expect(cards[0]!.querySelector(".trace-wait")?.textContent).toContain("问：这支 MV 打算怎么用？");
  expect(cards[1]!.querySelector(".trace-summary")?.textContent).toBe("人物太粗糙");
  expect(cards[2]!.querySelector(".trace-wait")?.textContent).toContain("检查没过，已退回");
});
