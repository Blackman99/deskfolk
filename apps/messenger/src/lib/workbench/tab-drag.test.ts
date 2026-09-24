import { expect, test } from "bun:test";
import type { PaneMin, Rect, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { assertInvariants, leafById, makeBranch, makeLeaf, tiledLeaves } from "./layout-tree.ts";
import {
  applyDrop,
  beginLeafDrag,
  beginTabDrag,
  dockFloating,
  passedThreshold,
  type DropContext,
} from "./tab-drag.ts";

const aTab = (id: string): WorkbenchTab => ({ id, kind: "chat", params: {} });
const viewport: Rect = { x: 0, y: 0, width: 1000, height: 800 };
const floatMin: PaneMin = { width: 300, height: 280 };

let seq = 0;
const ctx = (over: Partial<DropContext> = {}): DropContext => ({
  node: () => `n${++seq}`,
  viewport,
  floatMin,
  sourceRect: { x: 0, y: 0, width: 500, height: 400 },
  ...over,
});

function layoutOf(root: Parameters<typeof tiledLeaves>[0], focusId?: string): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: focusId ?? tiledLeaves(root)[0]!.id } };
}

const twoPanes = () => layoutOf(makeBranch("r", "row", [
  makeLeaf("a", [aTab("t1"), aTab("t2")]),
  makeLeaf("b", [aTab("t3")]),
], [0.5, 0.5]));

test("a press only becomes a drag once it has travelled", () => {
  const drag = beginTabDrag("a", "t1", { x: 100, y: 100 });
  expect(passedThreshold(drag, { x: 102, y: 100 })).toBe(false);
  expect(passedThreshold(drag, { x: 110, y: 100 })).toBe(true);
  // Once started it stays started, so a drag back to the origin does not turn into a click.
  expect(passedThreshold({ ...drag, started: true }, { x: 100, y: 100 })).toBe(true);
});

test("reordering inside one strip never detaches the tab", () => {
  const layout = layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2"), aTab("t3")]));
  const moved = applyDrop(layout, beginTabDrag("a", "t1", { x: 0, y: 0 }), { kind: "tabstrip", leafId: "a", index: 3 }, ctx());
  expect(leafById(moved, "a")!.tabs.map((tab) => tab.id)).toEqual(["t2", "t3", "t1"]);
  assertInvariants(moved);
});

test("reordering the only tab of a pane leaves it alone rather than closing the pane", () => {
  // Detaching first would remove the pane the tab is being dropped into, and the tab would have
  // nowhere to land.
  const layout = layoutOf(makeLeaf("a", [aTab("t1")]));
  const drag = beginTabDrag("a", "t1", { x: 0, y: 0 });
  expect(applyDrop(layout, drag, { kind: "tabstrip", leafId: "a", index: 0 }, ctx())).toBe(layout);
});

test("dropping a tab into another pane's group moves it there", () => {
  const layout = twoPanes();
  const moved = applyDrop(layout, beginTabDrag("a", "t2", { x: 0, y: 0 }), { kind: "centre", leafId: "b" }, ctx());
  expect(leafById(moved, "a")!.tabs.map((tab) => tab.id)).toEqual(["t1"]);
  expect(leafById(moved, "b")!.tabs.map((tab) => tab.id)).toEqual(["t3", "t2"]);
  expect(moved.focus.leafId).toBe("b");
  assertInvariants(moved);
});

test("dropping a tab at a position in another pane's strip lands it there", () => {
  const layout = twoPanes();
  const moved = applyDrop(layout, beginTabDrag("a", "t1", { x: 0, y: 0 }), { kind: "tabstrip", leafId: "b", index: 0 }, ctx());
  expect(leafById(moved, "b")!.tabs.map((tab) => tab.id)).toEqual(["t1", "t3"]);
  assertInvariants(moved);
});

test("dropping on an edge divides that pane and puts the tab on that side", () => {
  const layout = twoPanes();
  const east = applyDrop(layout, beginTabDrag("a", "t2", { x: 0, y: 0 }), { kind: "edge", leafId: "b", side: "east" }, ctx());
  expect(tiledLeaves(east.root).map((leaf) => leaf.tabs.map((tab) => tab.id)))
    .toEqual([["t1"], ["t3"], ["t2"]]);
  assertInvariants(east);

  const south = applyDrop(layout, beginTabDrag("a", "t2", { x: 0, y: 0 }), { kind: "edge", leafId: "b", side: "south" }, ctx());
  // A column inside the row: the new pane is under B, not beside it.
  const right = (south.root as { children: Array<{ type: string; axis?: string }> }).children[1]!;
  expect(right.type).toBe("branch");
  expect(right.axis).toBe("column");
  assertInvariants(south);
});

test("moving the last tab out closes the pane it left", () => {
  const layout = twoPanes();
  const moved = applyDrop(layout, beginTabDrag("b", "t3", { x: 0, y: 0 }), { kind: "centre", leafId: "a" }, ctx());
  expect(tiledLeaves(moved.root).map((leaf) => leaf.id)).toEqual(["a"]);
  expect(leafById(moved, "a")!.tabs.map((tab) => tab.id)).toEqual(["t1", "t2", "t3"]);
  assertInvariants(moved);
});

test("dragging the strip moves the whole group", () => {
  const layout = twoPanes();
  const moved = applyDrop(layout, beginLeafDrag("a", { x: 0, y: 0 }), { kind: "centre", leafId: "b" }, ctx());
  expect(tiledLeaves(moved.root).map((leaf) => leaf.id)).toEqual(["b"]);
  expect(leafById(moved, "b")!.tabs.map((tab) => tab.id)).toEqual(["t3", "t1", "t2"]);
  assertInvariants(moved);
});

test("a drop that changes nothing gives back the layout it was handed", () => {
  const layout = twoPanes();
  const drag = beginTabDrag("a", "t1", { x: 0, y: 0 });
  expect(applyDrop(layout, drag, { kind: "centre", leafId: "a" }, ctx())).toBe(layout);
  expect(applyDrop(layout, drag, { kind: "none" }, ctx())).toBe(layout);
  // Dividing a pane to put back the only tab it holds would leave it exactly where it started.
  const single = layoutOf(makeLeaf("a", [aTab("t1")]));
  expect(applyDrop(single, drag, { kind: "edge", leafId: "a", side: "east" }, ctx())).toBe(single);
});

test("a tab dragged out floats, keeping roughly the size it came from", () => {
  const layout = twoPanes();
  const floated = applyDrop(layout, beginTabDrag("a", "t2", { x: 0, y: 0 }), { kind: "float", point: { x: 500, y: 400 } }, ctx());
  expect(floated.floating).toHaveLength(1);
  const pane = floated.floating[0]!;
  expect(pane.leaf.tabs.map((tab) => tab.id)).toEqual(["t2"]);
  expect(pane.frame.width).toBe(400);
  expect(pane.frame.height).toBe(320);
  expect(floated.focus).toEqual({ zone: "floating", leafId: pane.leaf.id });
  expect(leafById(floated, "a")!.tabs.map((tab) => tab.id)).toEqual(["t1"]);
  assertInvariants(floated);
});

test("a floating pane docks back where it is dropped", () => {
  const base = twoPanes();
  const floated = applyDrop(base, beginTabDrag("a", "t2", { x: 0, y: 0 }), { kind: "float", point: { x: 500, y: 400 } }, ctx());
  const id = floated.floating[0]!.leaf.id;

  const docked = dockFloating(floated, id, { kind: "centre", leafId: "b" }, ctx());
  expect(docked.floating).toEqual([]);
  expect(leafById(docked, "b")!.tabs.map((tab) => tab.id)).toEqual(["t3", "t2"]);
  assertInvariants(docked);

  const split = dockFloating(floated, id, { kind: "edge", leafId: "b", side: "south" }, ctx());
  expect(split.floating).toEqual([]);
  expect(tiledLeaves(split.root)).toHaveLength(3);
  assertInvariants(split);
});

test("docking a pane that is not floating, or nowhere, changes nothing", () => {
  const layout = twoPanes();
  expect(dockFloating(layout, "a", { kind: "centre", leafId: "b" }, ctx())).toBe(layout);
  const floated = applyDrop(layout, beginTabDrag("a", "t2", { x: 0, y: 0 }), { kind: "float", point: { x: 500, y: 400 } }, ctx());
  const id = floated.floating[0]!.leaf.id;
  expect(dockFloating(floated, id, { kind: "none" }, ctx())).toBe(floated);
  expect(dockFloating(floated, id, { kind: "float", point: { x: 1, y: 1 } }, ctx())).toBe(floated);
});
