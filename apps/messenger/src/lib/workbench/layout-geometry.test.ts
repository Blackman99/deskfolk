import { expect, test } from "bun:test";
import type { MinSizeLookup, Rect, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { WB_SASH_PX } from "./layout-types.ts";
import { makeBranch, makeLeaf, tiledLeaves } from "./layout-tree.ts";
import {
  WB_JUNCTION_SNAP_PX,
  allocate,
  canSplit,
  computeGeometry,
  findJunctions,
  minSize,
  neighbourLeaf,
  shouldGoSolo,
  trackTemplate,
  type SashRect,
} from "./layout-geometry.ts";

const aTab = (id: string, kind = "chat"): WorkbenchTab => ({ id, kind, params: {} });
/** A flat 100x100 floor for every kind, so the arithmetic under test is the only variable. */
const flatMins: MinSizeLookup = () => ({ width: 100, height: 100 });
const viewport: Rect = { x: 0, y: 0, width: 1000, height: 800 };

function layoutOf(root: Parameters<typeof tiledLeaves>[0]): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: tiledLeaves(root)[0]!.id } };
}

// ------------------------------------------------------------------ allocate

test("allocate hands out space by weight and adds up exactly", () => {
  expect(allocate(1000, [0.5, 0.5], [0, 0])).toEqual([500, 500]);
  expect(allocate(1000, [0.25, 0.75], [0, 0])).toEqual([250, 750]);
  const three = allocate(1000, [1 / 3, 1 / 3, 1 / 3], [0, 0, 0]);
  expect(three.reduce((a, b) => a + b, 0)).toBe(1000);
});

test("a track that would fall under its minimum freezes and the rest share what is left", () => {
  // 10% of 1000 is 100, under the 300 floor, so it takes 300 and the other splits the other 700.
  expect(allocate(1000, [0.1, 0.9], [300, 0])).toEqual([300, 700]);
  expect(allocate(1000, [0.5, 0.5], [800, 0])).toEqual([800, 200]);
});

test("when nothing fits, everyone shrinks in proportion rather than overflowing", () => {
  const sizes = allocate(300, [0.5, 0.5], [400, 200]);
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(300);
  expect(sizes[0]!).toBeGreaterThan(sizes[1]!);
});

test("allocate never returns a fractional pixel", () => {
  const sizes = allocate(997, [0.3, 0.3, 0.4], [0, 0, 0]);
  for (const size of sizes) expect(Number.isInteger(size)).toBe(true);
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(997);
});

// ------------------------------------------------------------------ minSize

test("minimums add along the axis and take the largest across it", () => {
  const row = makeBranch("r", "row", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])]);
  expect(minSize(row, flatMins)).toEqual({ width: 100 + 100 + WB_SASH_PX, height: 100 });
  const column = makeBranch("c", "column", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])]);
  expect(minSize(column, flatMins)).toEqual({ width: 100, height: 100 + 100 + WB_SASH_PX });
});

test("a pane's minimum follows its active tab, not the largest tab it holds", () => {
  const mins: MinSizeLookup = (tab) => (tab?.kind === "terminal" ? { width: 600, height: 200 } : { width: 360, height: 240 });
  const leaf = makeLeaf("a", [aTab("t1", "chat"), aTab("t2", "terminal")]);
  expect(minSize(leaf, mins).width).toBe(360);
  expect(minSize({ ...leaf, activeTabId: "t2" }, mins).width).toBe(600);
});

// ------------------------------------------------------------------ tiling

test("leaf rectangles tile the viewport with no gap and no overlap", () => {
  const root = makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]),
    makeBranch("c", "column", [makeLeaf("b", [aTab("t2")]), makeLeaf("d", [aTab("t3")])]),
  ]);
  const geo = computeGeometry(layoutOf(root), viewport, flatMins);
  const rects = [...geo.leaves.values()];
  const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  const sashArea = geo.sashes.reduce((sum, sash) => sum + sash.rect.width * sash.rect.height, 0);
  // Panes plus dividers account for the whole viewport exactly: no gap anywhere, nothing counted
  // twice. The dividers never overlap each other, because one always stops where another begins.
  expect(area + sashArea).toBe(viewport.width * viewport.height);

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      const overlaps =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlaps).toBe(false);
    }
  }
});

test("one pane fills the viewport and has no dividers", () => {
  const geo = computeGeometry(layoutOf(makeLeaf("only", [aTab("t1")])), viewport, flatMins);
  expect(geo.leaves.get("only")).toEqual(viewport);
  expect(geo.sashes).toEqual([]);
  expect(geo.junctions).toEqual([]);
});

test("the track template carries both the minimum and the share", () => {
  const branch = makeBranch("r", "row", [makeLeaf("a"), makeLeaf("b")], [0.25, 0.75]);
  expect(trackTemplate(branch, [360, 600])).toBe("minmax(360px, 250.000fr) 8px minmax(600px, 750.000fr)");
});

test("the tracks still fill the branch once one of them sits at its minimum", () => {
  // Shares of 0.5 and 0.5 with the second pane held at its floor left the first a factor of 0.5
  // on its own, and the browser gives a lone factor under 1 only that fraction of what is left.
  const branch = makeBranch("r", "row", [makeLeaf("a"), makeLeaf("b")], [0.5, 0.5]);
  const factors = [...trackTemplate(branch, [360, 600]).matchAll(/([\d.]+)fr/g)].map((m) => Number(m[1]));
  expect(factors).toHaveLength(2);
  for (const factor of factors) expect(factor).toBeGreaterThanOrEqual(1);
  expect(factors[0]! / factors[1]!).toBeCloseTo(1);
});

// ------------------------------------------------------------------ junctions

/** Two columns, each split at the same height: the classic four-way cross. */
function crossLayout(splitLeft: number, splitRight: number): WorkbenchLayout {
  return layoutOf(makeBranch("r", "row", [
    makeBranch("cl", "column", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])], [splitLeft, 1 - splitLeft]),
    makeBranch("cr", "column", [makeLeaf("c", [aTab("t3")]), makeLeaf("d", [aTab("t4")])], [splitRight, 1 - splitRight]),
  ], [0.5, 0.5]));
}

test("a T-junction has one bar and one stem", () => {
  // Left column is split; the right side is whole, so the horizontal divider ends on the vertical.
  const root = makeBranch("r", "row", [
    makeBranch("cl", "column", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])], [0.5, 0.5]),
    makeLeaf("c", [aTab("t3")]),
  ], [0.5, 0.5]);
  const geo = computeGeometry(layoutOf(root), viewport, flatMins);
  expect(geo.junctions).toHaveLength(1);
  const junction = geo.junctions[0]!;
  expect(junction.bar.axis).toBe("row");
  expect(junction.stems).toHaveLength(1);
  expect(junction.point.x).toBeCloseTo(500, 0);
});

test("two columns split at the same height make one cross, not two handles", () => {
  const geo = computeGeometry(crossLayout(0.5, 0.5), viewport, flatMins);
  expect(geo.junctions).toHaveLength(1);
  expect(geo.junctions[0]!.stems).toHaveLength(2);
});

test("stems within the snap are one cross; just outside it they are two junctions", () => {
  const height = viewport.height;
  // A hair apart: inside the tolerance, so grabbing the point moves both.
  const near = crossLayout(0.5, 0.5 + (WB_JUNCTION_SNAP_PX - 2) / height);
  expect(computeGeometry(near, viewport, flatMins).junctions[0]!.stems).toHaveLength(2);

  // Clearly apart: two separate T-junctions on the same bar, each moving its own side.
  const far = crossLayout(0.5, 0.5 + (WB_JUNCTION_SNAP_PX + 6) / height);
  const junctions = computeGeometry(far, viewport, flatMins).junctions;
  expect(junctions).toHaveLength(2);
  expect(junctions.every((junction) => junction.stems.length === 1)).toBe(true);
});

test("a divider meeting another at its very end is not a junction", () => {
  // The outer row's sash runs the full height, so the inner column's sash at the top edge is the
  // boundary of the whole layout, not a point anyone can drag in two directions.
  const sashes: SashRect[] = [
    { id: "bar#1", branchId: "bar", index: 1, axis: "row", rect: { x: 500, y: 0, width: 8, height: 800 } },
    { id: "stem#1", branchId: "stem", index: 1, axis: "column", rect: { x: 0, y: 0, width: 500, height: 8 } },
  ];
  expect(findJunctions(sashes)).toEqual([]);
});

test("a stem two levels down still finds the bar it ends on", () => {
  const root = makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]),
    makeBranch("c", "column", [
      makeLeaf("b", [aTab("t2")]),
      makeBranch("r2", "row", [makeLeaf("d", [aTab("t3")]), makeLeaf("e", [aTab("t4")])], [0.5, 0.5]),
    ], [0.5, 0.5]),
  ], [0.5, 0.5]);
  const geo = computeGeometry(layoutOf(root), viewport, flatMins);
  // The column's sash ends on the outer row's sash.
  const onOuter = geo.junctions.filter((junction) => junction.bar.branchId === "r");
  expect(onOuter).toHaveLength(1);
  expect(onOuter[0]!.stems[0]!.branchId).toBe("c");
});

// ------------------------------------------------------------------ navigation

test("neighbour finds the pane beside you, including on a pinwheel", () => {
  const geo = computeGeometry(crossLayout(0.5, 0.5), viewport, flatMins);
  expect(neighbourLeaf(geo, "a", "right")).toBe("c");
  expect(neighbourLeaf(geo, "a", "down")).toBe("b");
  expect(neighbourLeaf(geo, "d", "left")).toBe("b");
  expect(neighbourLeaf(geo, "d", "up")).toBe("c");
  expect(neighbourLeaf(geo, "a", "left")).toBeNull();
  expect(neighbourLeaf(geo, "a", "up")).toBeNull();
});

test("a pinwheel picks the neighbour that shares the most edge", () => {
  // Left column split high, right column split low: from the tall left-top pane, going right,
  // both right-hand panes touch, but one shares much more of the edge.
  const geo = computeGeometry(crossLayout(0.75, 0.25), viewport, flatMins);
  expect(neighbourLeaf(geo, "a", "right")).toBe("d");
});

// ------------------------------------------------------------------ degradation

test("a narrow window goes solo whatever the tree says", () => {
  const layout = crossLayout(0.5, 0.5);
  expect(shouldGoSolo(layout, { x: 0, y: 0, width: 640, height: 800 }, flatMins)).toBe(true);
  expect(shouldGoSolo(layout, viewport, flatMins)).toBe(false);
});

test("a layout that no longer fits goes solo before it is squeezed to nothing", () => {
  const mins: MinSizeLookup = () => ({ width: 600, height: 100 });
  const layout = crossLayout(0.5, 0.5);
  expect(shouldGoSolo(layout, { x: 0, y: 0, width: 1000, height: 800 }, mins)).toBe(true);
  expect(shouldGoSolo(layout, { x: 0, y: 0, width: 1400, height: 800 }, mins)).toBe(false);
});

test("a split that would not fit is refused", () => {
  const layout = layoutOf(makeLeaf("a", [aTab("t1")]));
  const tight = { x: 0, y: 0, width: 700, height: 800 };
  expect(canSplit(layout, "a", "row", tight, flatMins, { width: 600, height: 200 })).toBe(false);
  expect(canSplit(layout, "a", "row", viewport, flatMins, { width: 600, height: 200 })).toBe(true);
  expect(canSplit(layout, "missing", "row", viewport, flatMins, { width: 10, height: 10 })).toBe(false);
});
