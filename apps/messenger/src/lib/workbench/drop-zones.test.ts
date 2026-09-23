import { expect, test } from "bun:test";
import type { MinSizeLookup, Rect, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { makeBranch, makeLeaf, tiledLeaves } from "./layout-tree.ts";
import { computeGeometry } from "./layout-geometry.ts";
import {
  WB_EDGE_BAND_MAX_PX,
  WB_EDGE_BAND_MIN_PX,
  dropIndicatorRect,
  dropZoneAt,
  edgeBand,
  isNoOpDrop,
  sideToSplit,
  tabInsertIndex,
} from "./drop-zones.ts";

const aTab = (id: string): WorkbenchTab => ({ id, kind: "chat", params: {} });
const flatMins: MinSizeLookup = () => ({ width: 100, height: 100 });
const viewport: Rect = { x: 0, y: 0, width: 1000, height: 800 };

function layoutOf(root: Parameters<typeof tiledLeaves>[0]): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: tiledLeaves(root)[0]!.id } };
}
const single = () => layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2"), aTab("t3")]));
const geoOf = (layout: WorkbenchLayout) => computeGeometry(layout, viewport, flatMins);

test("the band is a fraction of the shorter side, with a floor and a ceiling", () => {
  // A tall narrow pane must not get a band so wide it swallows the middle.
  expect(edgeBand({ x: 0, y: 0, width: 200, height: 900 })).toBe(200 * 0.22);
  expect(edgeBand({ x: 0, y: 0, width: 80, height: 900 })).toBe(WB_EDGE_BAND_MIN_PX);
  expect(edgeBand({ x: 0, y: 0, width: 2000, height: 2000 })).toBe(WB_EDGE_BAND_MAX_PX);
});

test("the middle of a pane joins its tab group", () => {
  expect(dropZoneAt(geoOf(single()), { x: 500, y: 400 })).toEqual({ kind: "centre", leafId: "a" });
});

test("each edge band divides the pane on that side", () => {
  const geo = geoOf(single());
  expect(dropZoneAt(geo, { x: 10, y: 400 })).toEqual({ kind: "edge", leafId: "a", side: "west" });
  expect(dropZoneAt(geo, { x: 990, y: 400 })).toEqual({ kind: "edge", leafId: "a", side: "east" });
  expect(dropZoneAt(geo, { x: 500, y: 790 })).toEqual({ kind: "edge", leafId: "a", side: "south" });
  // The top band is the tab strip, so "north" starts below it.
  expect(dropZoneAt(geo, { x: 500, y: 40 })).toEqual({ kind: "edge", leafId: "a", side: "north" });
});

test("the tab strip is its own zone, above the north band", () => {
  expect(dropZoneAt(geoOf(single()), { x: 300, y: 10 })).toEqual({ kind: "tabstrip", leafId: "a", index: -1 });
});

test("a corner picks the nearer edge, and a tie is always resolved the same way", () => {
  const geo = geoOf(single());
  // Nearer the left than the bottom.
  expect(dropZoneAt(geo, { x: 12, y: 700 })).toEqual({ kind: "edge", leafId: "a", side: "west" });
  // Exactly on the diagonal of the bottom-left corner: north comes first in the fixed order, but
  // it is not in range here, so the answer is stable rather than arbitrary.
  const tie = dropZoneAt(geo, { x: 20, y: 780 });
  expect(dropZoneAt(geo, { x: 20, y: 780 })).toEqual(tie);
});

test("the pointer outside the workbench is not a drop", () => {
  expect(dropZoneAt(geoOf(single()), { x: -5, y: 400 })).toEqual({ kind: "none" });
  expect(dropZoneAt(geoOf(single()), { x: 500, y: 5000 })).toEqual({ kind: "none" });
});

test("the modifier turns any position into a float", () => {
  const zone = dropZoneAt(geoOf(single()), { x: 500, y: 400 }, { float: true });
  expect(zone).toEqual({ kind: "float", point: { x: 500, y: 400 } });
});

test("the right pane is picked when there are several", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")]),
  ], [0.5, 0.5]));
  const geo = geoOf(layout);
  expect(dropZoneAt(geo, { x: 250, y: 400 })).toEqual({ kind: "centre", leafId: "a" });
  expect(dropZoneAt(geo, { x: 750, y: 400 })).toEqual({ kind: "centre", leafId: "b" });
});

test("a tab lands before the tab whose left half the pointer is over", () => {
  const strip = { x: 0, y: 0, width: 400, height: 28 };
  const widths = [100, 100, 100];
  expect(tabInsertIndex(strip, widths, 10)).toBe(0);
  expect(tabInsertIndex(strip, widths, 60)).toBe(1);
  expect(tabInsertIndex(strip, widths, 140)).toBe(1);
  expect(tabInsertIndex(strip, widths, 160)).toBe(2);
  expect(tabInsertIndex(strip, widths, 390)).toBe(3);
});

test("the indicator shows half the pane for an edge and the whole body for the centre", () => {
  const geo = geoOf(single());
  const size = { width: 400, height: 300 };
  expect(dropIndicatorRect(geo, { kind: "centre", leafId: "a" }, size)).toEqual(viewport);
  expect(dropIndicatorRect(geo, { kind: "edge", leafId: "a", side: "east" }, size))
    .toEqual({ x: 500, y: 0, width: 500, height: 800 });
  expect(dropIndicatorRect(geo, { kind: "edge", leafId: "a", side: "north" }, size))
    .toEqual({ x: 0, y: 0, width: 1000, height: 400 });
  expect(dropIndicatorRect(geo, { kind: "none" }, size)).toBeNull();
});

test("the float indicator is centred on the pointer and stays on screen", () => {
  const geo = geoOf(single());
  const size = { width: 400, height: 300 };
  const centred = dropIndicatorRect(geo, { kind: "float", point: { x: 500, y: 400 } }, size)!;
  expect(centred).toEqual({ x: 300, y: 250, width: 400, height: 300 });
  const cornered = dropIndicatorRect(geo, { kind: "float", point: { x: 0, y: 0 } }, size)!;
  expect(cornered.x).toBe(8);
  expect(cornered.y).toBe(8);
});

test("each edge maps to the division it means", () => {
  expect(sideToSplit("west")).toEqual({ axis: "row", side: "before" });
  expect(sideToSplit("east")).toEqual({ axis: "row", side: "after" });
  expect(sideToSplit("north")).toEqual({ axis: "column", side: "before" });
  expect(sideToSplit("south")).toEqual({ axis: "column", side: "after" });
});

test("a drop that changes nothing is recognised as such", () => {
  const layout = single();
  const drag = { leafId: "a", tabId: "t2", onlyTab: false };
  expect(isNoOpDrop(layout, drag, { kind: "none" })).toBe(true);
  expect(isNoOpDrop(layout, drag, { kind: "centre", leafId: "a" })).toBe(true);
  // Back where it already sits, from either side of the gap.
  expect(isNoOpDrop(layout, drag, { kind: "tabstrip", leafId: "a", index: 1 })).toBe(true);
  expect(isNoOpDrop(layout, drag, { kind: "tabstrip", leafId: "a", index: 2 })).toBe(true);
  expect(isNoOpDrop(layout, drag, { kind: "tabstrip", leafId: "a", index: 0 })).toBe(false);
  // Dividing a pane to put back the only tab it holds would leave it where it started.
  expect(isNoOpDrop(layout, { ...drag, onlyTab: true }, { kind: "edge", leafId: "a", side: "east" })).toBe(true);
  expect(isNoOpDrop(layout, drag, { kind: "edge", leafId: "a", side: "east" })).toBe(false);
  expect(isNoOpDrop(layout, drag, { kind: "float", point: { x: 1, y: 1 } })).toBe(false);
});
