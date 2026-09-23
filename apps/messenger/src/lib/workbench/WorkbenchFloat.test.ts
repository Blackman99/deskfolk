import { expect, test } from "bun:test";
import { flushSync, createRawSnippet } from "svelte";
import WorkbenchFloat from "./WorkbenchFloat.svelte";
import { copyFor } from "../copy.ts";
import { render } from "../test-render.ts";
import { makeLeaf } from "./layout-tree.ts";
import type { FloatFrame, WorkbenchTab } from "./layout-types.ts";

const t = copyFor("zh");
const leaf = makeLeaf("f", [{ id: "t1", kind: "chat", params: {} } satisfies WorkbenchTab]);
const tabBody = createRawSnippet((tab: () => WorkbenchTab) => ({
  render: () => `<div data-body="${tab().id}">${tab().kind}</div>`,
}));
const tabLabel = createRawSnippet((tab: () => WorkbenchTab) => ({
  render: () => `<span>${tab().id}</span>`,
}));

const frame: FloatFrame = { x: 30, y: 40, width: 400, height: 300 };
const viewport = { x: 0, y: 0, width: 1000, height: 800 };

function mount() {
  const frames: FloatFrame[] = [];
  const { host, close } = render(WorkbenchFloat as never, {
    leaf,
    frame,
    z: 0,
    focused: true,
    min: { width: 100, height: 100 },
    viewport,
    t,
    tabBody,
    tabLabel,
    onFrame: (_id: string, next: FloatFrame) => { frames.push(next); },
    onFocus: () => {},
    onActivate: () => {},
    onCloseTab: () => {},
  } as never);
  return { host, close, frames, pane: host.querySelector(".wb-float") as HTMLElement };
}

function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y, button: 0 }));
  flushSync();
}

test("moving a floating pane follows the pointer and commits when it is released", () => {
  const { host, close, frames, pane } = mount();
  try {
    const bar = host.querySelector(".wb-float-bar") as HTMLElement;
    pointer(bar, "pointerdown", 10, 10);
    expect(frames).toHaveLength(0);
    pointer(bar, "pointermove", 30, 25);
    expect(frames).toHaveLength(0);
    expect(pane.style.transform).toBe("translate3d(20px, 15px, 0)");
    pointer(bar, "pointerup", 30, 25);
    expect(frames).toEqual([{ x: 50, y: 55, width: 400, height: 300 }]);
    expect(pane.style.transform).toBe("");
  } finally {
    close();
  }
});

test("a press on the title bar that does not move does not write the layout", () => {
  const { host, close, frames } = mount();
  try {
    const bar = host.querySelector(".wb-float-bar") as HTMLElement;
    pointer(bar, "pointerdown", 10, 10);
    pointer(bar, "pointerup", 10, 10);
    expect(frames).toHaveLength(0);
  } finally {
    close();
  }
});

test("pulling a corner resizes on screen and commits when the pointer is released", () => {
  const { host, close, frames, pane } = mount();
  try {
    const corner = host.querySelector(".wb-float-corner.is-se") as HTMLElement;
    pointer(corner, "pointerdown", 0, 0);
    pointer(corner, "pointermove", 40, 20);
    expect(frames).toHaveLength(0);
    expect(pane.style.width).toBe("440px");
    expect(pane.style.height).toBe("320px");
    pointer(corner, "pointerup", 40, 20);
    expect(frames).toEqual([{ x: 30, y: 40, width: 440, height: 320 }]);
  } finally {
    close();
  }
});
