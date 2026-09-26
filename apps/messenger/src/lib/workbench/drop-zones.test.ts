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
  rowScrollStep,
  sideToSplit,
  stripIndex,
  tabInsertIndex,
  tabMarkerRect,
  WB_ROW_SCROLL_MAX_PX,
  type TabRow,
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

/** Three tabs a hundred wide from x 4, in a row that shows all of them. */
const rowOf = (over: Partial<TabRow> = {}): TabRow => ({
  strip: { x: 0, y: 0, width: 1000, height: 32 },
  visible: { x: 4, width: 300 },
  start: 4,
  widths: [100, 100, 100],
  ...over,
});

test("a tab lands before the tab whose left half the pointer is over", () => {
  const row = rowOf({ start: 0, visible: { x: 0, width: 400 } });
  expect(tabInsertIndex(row, 10)).toBe(0);
  expect(tabInsertIndex(row, 60)).toBe(1);
  expect(tabInsertIndex(row, 140)).toBe(1);
  expect(tabInsertIndex(row, 160)).toBe(2);
  expect(tabInsertIndex(row, 390)).toBe(3);
});

test("past the tabs, on the strip's own buttons, is after the last tab", () => {
  expect(tabInsertIndex(rowOf(), 900)).toBe(3);
});

test("in a scrolled row only the tabs on screen can be pointed at", () => {
  // Scrolled 120 along, 120 wide: most of the second tab and the start of the third are showing.
  const row = rowOf({ start: 4 - 120, visible: { x: 4, width: 120 } });
  // Left of the row is its left end, not the first tab scrolled out past it.
  expect(tabInsertIndex(row, 0)).toBe(1);
  expect(tabInsertIndex(row, 60)).toBe(2);
  // Right of it, over the + and ⋯, is its right end: the third tab's left half, not past it.
  expect(tabInsertIndex(row, 900)).toBe(2);
});

test("a strip that was measured says between which two tabs the drop goes", () => {
  const geo = geoOf(single());
  const rows = new Map([["a", rowOf()]]);
  expect(dropZoneAt(geo, { x: 140, y: 10 }, { rows })).toEqual({ kind: "tabstrip", leafId: "a", index: 1 });
  expect(dropZoneAt(geo, { x: 600, y: 10 }, { rows })).toEqual({ kind: "tabstrip", leafId: "a", index: 3 });
  // Below the strip it is the pane, as before.
  expect(dropZoneAt(geo, { x: 500, y: 400 }, { rows })).toEqual({ kind: "centre", leafId: "a" });
});

test("a floating pane's strip is hit before the pane it floats over, the top one first", () => {
  const geo = geoOf(single());
  const over = (id: string, x: number): [string, TabRow] =>
    [id, rowOf({ strip: { x, y: 300, width: 300, height: 32 }, visible: { x, width: 200 }, start: x, widths: [100, 100] })];
  const rows = new Map([["a", rowOf()], over("f1", 200), over("f2", 350)]);
  expect(dropZoneAt(geo, { x: 260, y: 310 }, { rows, floating: ["f2", "f1"] }))
    .toEqual({ kind: "tabstrip", leafId: "f1", index: 1 });
  // Where the two overlap, the one on top.
  expect(dropZoneAt(geo, { x: 380, y: 310 }, { rows, floating: ["f2", "f1"] }))
    .toEqual({ kind: "tabstrip", leafId: "f2", index: 0 });
  expect(dropZoneAt(geo, { x: 380, y: 310 }, { rows, floating: ["f1", "f2"] }))
    .toEqual({ kind: "tabstrip", leafId: "f1", index: 2 });
  // Off their strips the tiled pane underneath is still what the pointer is on.
  expect(dropZoneAt(geo, { x: 260, y: 400 }, { rows, floating: ["f2", "f1"] })).toEqual({ kind: "centre", leafId: "a" });
});

test("a strip nobody measured, or a position past its end, means after the last tab", () => {
  expect(stripIndex(-1, 3)).toBe(3);
  expect(stripIndex(7, 3)).toBe(3);
  expect(stripIndex(0, 3)).toBe(0);
  expect(stripIndex(3, 3)).toBe(3);
});

test("the gap marker sits between the two tabs, and stays on the part of the row on screen", () => {
  expect(tabMarkerRect(rowOf(), 1)).toEqual({ x: 103, y: 6, width: 2, height: 24 });
  // After the last tab, which ends right at the row's edge: drawn just inside it.
  expect(tabMarkerRect(rowOf(), 3)).toEqual({ x: 302, y: 6, width: 2, height: 24 });
  // A gap scrolled out to the left shows at the row's left end.
  const scrolled = rowOf({ start: 4 - 150, visible: { x: 4, width: 120 } });
  expect(tabMarkerRect(scrolled, 0).x).toBe(4);
  expect(tabMarkerRect(scrolled, 3).x).toBe(4 + 120 - 2);
});

test("on a measured strip the indicator is the gap marker, for a floating pane too", () => {
  const geo = geoOf(single());
  const size = { width: 400, height: 300 };
  const float = rowOf({ strip: { x: 200, y: 300, width: 300, height: 32 }, visible: { x: 200, width: 200 }, start: 200 });
  const rows = new Map([["a", rowOf()], ["f", float]]);
  expect(dropIndicatorRect(geo, { kind: "tabstrip", leafId: "a", index: 1 }, size, rows))
    .toEqual({ x: 103, y: 6, width: 2, height: 24 });
  expect(dropIndicatorRect(geo, { kind: "tabstrip", leafId: "f", index: 0 }, size, rows))
    .toEqual({ x: 200, y: 306, width: 2, height: 24 });
  // Unmeasured, it is still the whole strip.
  expect(dropIndicatorRect(geo, { kind: "tabstrip", leafId: "a", index: 1 }, size)?.width).toBe(1000);
});

test("a row that overflows scrolls towards whichever end the pointer is near", () => {
  // 300 of tabs in 120 of row, scrolled 100 along: there is more on both sides.
  const row = rowOf({ start: 4 - 100, visible: { x: 4, width: 120 } });
  expect(rowScrollStep(row, 64)).toBe(0);
  expect(rowScrollStep(row, 10)).toBeLessThan(0);
  expect(rowScrollStep(row, 120)).toBeGreaterThan(0);
  // Faster the nearer the end, and at full speed past it.
  expect(rowScrollStep(row, 5)).toBeLessThan(rowScrollStep(row, 30));
  expect(rowScrollStep(row, 900)).toBe(WB_ROW_SCROLL_MAX_PX);
  expect(rowScrollStep(row, -50)).toBe(-WB_ROW_SCROLL_MAX_PX);
});

test("a row does not scroll past its ends, or at all when everything fits", () => {
  expect(rowScrollStep(rowOf(), 900)).toBe(0);
  expect(rowScrollStep(rowOf(), 0)).toBe(0);
  // At the start of an overflowing row, only onwards.
  const atStart = rowOf({ visible: { x: 4, width: 120 } });
  expect(rowScrollStep(atStart, 5)).toBe(0);
  expect(rowScrollStep(atStart, 120)).toBeGreaterThan(0);
  // At its end, only back.
  const atEnd = rowOf({ start: 4 - 180, visible: { x: 4, width: 120 } });
  expect(rowScrollStep(atEnd, 120)).toBe(0);
  expect(rowScrollStep(atEnd, 5)).toBeLessThan(0);
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
  // Unmeasured means after the last tab, which is a move for the middle one.
  expect(isNoOpDrop(layout, drag, { kind: "tabstrip", leafId: "a", index: -1 })).toBe(false);
  expect(isNoOpDrop(layout, { ...drag, tabId: "t3" }, { kind: "tabstrip", leafId: "a", index: -1 })).toBe(true);
  // A whole group put back on its own strip, anywhere along it.
  expect(isNoOpDrop(layout, { leafId: "a", tabId: "", onlyTab: true }, { kind: "tabstrip", leafId: "a", index: 2 })).toBe(true);
  // Dividing a pane to put back the only tab it holds would leave it where it started.
  expect(isNoOpDrop(layout, { ...drag, onlyTab: true }, { kind: "edge", leafId: "a", side: "east" })).toBe(true);
  expect(isNoOpDrop(layout, drag, { kind: "edge", leafId: "a", side: "east" })).toBe(false);
  expect(isNoOpDrop(layout, drag, { kind: "float", point: { x: 1, y: 1 } })).toBe(false);
});
