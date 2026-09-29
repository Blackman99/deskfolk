import { afterEach, expect, test } from "bun:test";
import {
  WORKSPACE_DRAG_THRESHOLD_PX,
  ghostPlacement,
  pressWorkspacePaths,
  workspaceDrag,
  workspaceDropTarget,
  type WorkspaceDragItem,
} from "./workspace-drag.svelte.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** happy-dom has no layout, so what is "under the pointer" is whatever the test says it is. */
function pointAt(el: Element | null): void {
  const original = document.elementFromPoint;
  document.elementFromPoint = () => el;
  cleanups.push(() => {
    document.elementFromPoint = original;
  });
}

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: "mouse", ...init });
}

function setup(opts: { accepts?: boolean } = {}) {
  const row = document.createElement("button");
  const target = document.createElement("div");
  const inner = document.createElement("span");
  target.append(inner);
  document.body.append(row, target);
  const dropped: WorkspaceDragItem[][] = [];
  const action = workspaceDropTarget(target, { accepts: () => opts.accepts ?? true, drop: (items) => dropped.push(items) });
  const items: WorkspaceDragItem[] = [{ path: "docs/brief.md", isDir: false }, { path: "shots", isDir: true }];
  let asked = 0;
  row.addEventListener("pointerdown", (event) =>
    pressWorkspacePaths(event, {
      items: () => {
        asked += 1;
        return items;
      },
      label: (rows) => `${rows.length} items`,
    }),
  );
  let clicks = 0;
  row.addEventListener("click", () => (clicks += 1));
  cleanups.push(() => {
    action.destroy();
    row.remove();
    target.remove();
  });
  return { row, target, inner, dropped, items, asked: () => asked, clicks: () => clicks };
}

/** The click a browser fires after the release lands on the pressed row. */
function release(row: Element, x: number, y: number, type = "pointerup"): void {
  window.dispatchEvent(pointer(type, x, y));
  row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

test("a press that stays put is still a click, and nothing is dragged", () => {
  const { row, dropped, asked, clicks } = setup();
  row.dispatchEvent(pointer("pointerdown", 10, 10));
  window.dispatchEvent(pointer("pointermove", 10 + WORKSPACE_DRAG_THRESHOLD_PX - 1, 10));
  expect(workspaceDrag.current).toBeNull();
  release(row, 12, 10);
  expect(asked()).toBe(0);
  expect(dropped).toEqual([]);
  expect(clicks()).toBe(1);
});

test("past the threshold the rows ride under the pointer, and a release over a target hands them over", () => {
  const { row, target, inner, dropped, items, clicks } = setup();
  pointAt(inner);
  row.dispatchEvent(pointer("pointerdown", 10, 10));
  window.dispatchEvent(pointer("pointermove", 30, 40));
  expect(workspaceDrag.current).toMatchObject({ items, label: "2 items", x: 30, y: 40 });
  expect(workspaceDrag.current?.over === target).toBe(true);
  release(row, 30, 40);
  expect(workspaceDrag.current).toBeNull();
  expect(dropped).toEqual([items]);
  // The row that was dragged does not also open.
  expect(clicks()).toBe(0);
  // Only that one click: the next press is a click again.
  row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(clicks()).toBe(1);
});

test("a target that would not take it now is not lit and gets nothing", () => {
  const { row, inner, dropped } = setup({ accepts: false });
  pointAt(inner);
  row.dispatchEvent(pointer("pointerdown", 10, 10));
  window.dispatchEvent(pointer("pointermove", 40, 40));
  expect(workspaceDrag.current?.over).toBeNull();
  release(row, 40, 40);
  expect(dropped).toEqual([]);
});

test("released anywhere else, or put back with Escape, or cancelled, it drops nothing", () => {
  const { row, inner, dropped } = setup();
  pointAt(document.body);
  row.dispatchEvent(pointer("pointerdown", 10, 10));
  window.dispatchEvent(pointer("pointermove", 40, 40));
  release(row, 40, 40);

  pointAt(inner);
  row.dispatchEvent(pointer("pointerdown", 10, 10));
  window.dispatchEvent(pointer("pointermove", 40, 40));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(workspaceDrag.current).toBeNull();
  release(row, 40, 40);

  row.dispatchEvent(pointer("pointerdown", 10, 10));
  window.dispatchEvent(pointer("pointermove", 40, 40));
  release(row, 40, 40, "pointercancel");
  expect(workspaceDrag.current).toBeNull();
  expect(dropped).toEqual([]);
});

test("a finger, another button or a modifier click never starts a drag", () => {
  const { row, inner, dropped, asked } = setup();
  pointAt(inner);
  for (const init of [{ pointerType: "touch" }, { button: 2 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }] as PointerEventInit[]) {
    row.dispatchEvent(pointer("pointerdown", 10, 10, init));
    window.dispatchEvent(pointer("pointermove", 60, 60, init));
    expect(workspaceDrag.current).toBeNull();
    release(row, 60, 60);
  }
  expect(asked()).toBe(0);
  expect(dropped).toEqual([]);
});

test("the chip rides below and right of the pointer, and flips over near an edge", () => {
  const size = { width: 80, height: 22 };
  const viewport = { width: 1440, height: 900 };
  expect(ghostPlacement({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 112, y: 112 });
  // Dropping on the composer happens at the bottom of the window.
  expect(ghostPlacement({ x: 100, y: 880 }, size, viewport)).toEqual({ x: 112, y: 846 });
  expect(ghostPlacement({ x: 1400, y: 100 }, size, viewport)).toEqual({ x: 1308, y: 112 });
  expect(ghostPlacement({ x: 2, y: 2 }, { width: 2000, height: 2000 }, viewport)).toEqual({ x: 4, y: 4 });
});
