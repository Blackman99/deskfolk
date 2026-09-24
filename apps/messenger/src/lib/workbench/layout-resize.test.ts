import { expect, test } from "bun:test";
import type { BranchNode, MinSizeLookup, Rect, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { makeBranch, makeLeaf, nodeAt, findPath, tiledLeaves } from "./layout-tree.ts";
import { computeGeometry } from "./layout-geometry.ts";
import {
  beginJunctionDrag,
  beginSashDrag,
  clampToRange,
  equalise,
  nudgeSash,
  resizeJunction,
  resizeSash,
} from "./layout-resize.ts";

const aTab = (id: string): WorkbenchTab => ({ id, kind: "chat", params: {} });
const flatMins: MinSizeLookup = () => ({ width: 100, height: 100 });
const viewport: Rect = { x: 0, y: 0, width: 1000, height: 800 };

function layoutOf(root: Parameters<typeof tiledLeaves>[0]): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: tiledLeaves(root)[0]!.id } };
}

function weightsOf(layout: WorkbenchLayout, branchId: string): number[] {
  const branch = nodeAt(layout.root, findPath(layout.root, branchId)!) as BranchNode;
  return branch.weights.map((weight) => Number(weight.toFixed(4)));
}

function widthsOf(layout: WorkbenchLayout): Record<string, number> {
  const geo = computeGeometry(layout, viewport, flatMins);
  return Object.fromEntries([...geo.leaves].map(([id, rect]) => [id, rect.width]));
}

function heightsOf(layout: WorkbenchLayout): Record<string, number> {
  const geo = computeGeometry(layout, viewport, flatMins);
  return Object.fromEntries([...geo.leaves].map(([id, rect]) => [id, rect.height]));
}

const twoColumns = () => layoutOf(makeBranch("r", "row", [
  makeLeaf("a", [aTab("t1")]),
  makeLeaf("b", [aTab("t2")]),
], [0.5, 0.5]));

/** Two columns, each divided at the same height: a genuine four-way cross. */
const crossLayout = () => layoutOf(makeBranch("r", "row", [
  makeBranch("cl", "column", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])], [0.5, 0.5]),
  makeBranch("cr", "column", [makeLeaf("c", [aTab("t3")]), makeLeaf("d", [aTab("t4")])], [0.5, 0.5]),
], [0.5, 0.5]));

test("dragging a divider moves exactly the two panes it is between", () => {
  const layout = twoColumns();
  const geo = computeGeometry(layout, viewport, flatMins);
  const drag = beginSashDrag(layout, geo, "r#1", flatMins)!;
  expect(drag).not.toBeNull();

  const next = resizeSash(layout, drag, 100);
  const widths = widthsOf(next);
  expect(widths.a).toBe(596);
  expect(widths.b).toBe(396);
  expect(widths.a! + widths.b!).toBe(viewport.width - 8);
});

test("a three-pane row moves only the pair either side of the divider", () => {
  // This is why branches are n-ary rather than nested pairs: nesting would make this drag move a
  // pane that the divider does not touch, which reads as a bug.
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")]), makeLeaf("c", [aTab("t3")]),
  ], [1 / 3, 1 / 3, 1 / 3]));
  const before = widthsOf(layout);
  const geo = computeGeometry(layout, viewport, flatMins);
  const drag = beginSashDrag(layout, geo, "r#1", flatMins)!;
  const after = widthsOf(resizeSash(layout, drag, 60));

  expect(after.a).toBe(before.a! + 60);
  expect(after.b).toBe(before.b! - 60);
  expect(after.c).toBe(before.c);
});

test("a divider stops at the minimum rather than squeezing a pane away", () => {
  const layout = twoColumns();
  const geo = computeGeometry(layout, viewport, flatMins);
  const drag = beginSashDrag(layout, geo, "r#1", flatMins)!;
  // 100px floor each, 992px to share: the divider can travel 396 either way, no further.
  expect(drag.range.hi).toBe(396);
  expect(drag.range.lo).toBe(-396);

  const shoved = widthsOf(resizeSash(layout, drag, 5000));
  expect(shoved.b).toBe(100);
  expect(shoved.a).toBe(892);
});

test("clampToRange keeps a delta inside what the drag allows", () => {
  expect(clampToRange(10, { lo: -5, hi: 5 })).toBe(5);
  expect(clampToRange(-10, { lo: -5, hi: 5 })).toBe(-5);
  expect(clampToRange(2, { lo: -5, hi: 5 })).toBe(2);
});

test("a junction drag moves the bar across and every stem along, independently", () => {
  const layout = crossLayout();
  const geo = computeGeometry(layout, viewport, flatMins);
  const junction = geo.junctions[0]!;
  expect(junction.stems).toHaveLength(2);

  const drag = beginJunctionDrag(layout, geo, junction.id, flatMins)!;
  const next = resizeJunction(layout, drag, { across: 120, along: -80 });

  // Across: the columns changed width, by the amount asked for.
  expect(weightsOf(next, "r")).toEqual([0.6210, 0.3790]);
  // Along: BOTH stems moved the same number of pixels, so the cross is still a cross.
  expect(weightsOf(next, "cl")).toEqual(weightsOf(next, "cr"));
  const heights = heightsOf(next);
  expect(heights.a).toBe(316);
  expect(heights.c).toBe(316);
  // And the two axes did not interfere: widths are untouched by the vertical motion.
  expect(heights.a! + heights.b!).toBe(viewport.height - 8);
});

test("moving only one axis leaves the other exactly where it was", () => {
  const layout = crossLayout();
  const geo = computeGeometry(layout, viewport, flatMins);
  const drag = beginJunctionDrag(layout, geo, geo.junctions[0]!.id, flatMins)!;

  const acrossOnly = resizeJunction(layout, drag, { across: 90, along: 0 });
  expect(weightsOf(acrossOnly, "cl")).toEqual([0.5, 0.5]);
  expect(weightsOf(acrossOnly, "cr")).toEqual([0.5, 0.5]);

  const alongOnly = resizeJunction(layout, drag, { across: 0, along: 70 });
  expect(weightsOf(alongOnly, "r")).toEqual([0.5, 0.5]);
});

test("a cross stays rigid: when one stem hits its minimum they all stop", () => {
  // Both columns are divided at the same height, so this is one cross. The bottom-right pane
  // needs far more room than the others, so it is what limits the pair. Without the intersected
  // range the left stem would keep going and the cross would tear in two.
  const tallFloor: MinSizeLookup = (tab) =>
    tab?.id === "t4" ? { width: 100, height: 350 } : { width: 100, height: 100 };
  const layout = crossLayout();
  const geo = computeGeometry(layout, viewport, tallFloor);
  const junction = geo.junctions[0]!;
  expect(junction.stems).toHaveLength(2);

  const drag = beginJunctionDrag(layout, geo, junction.id, tallFloor)!;
  // The left column could give up 296px; the right one only 46. The pair may move 46.
  expect(drag.stems[0]!.range.hi).toBe(296);
  expect(drag.stems[1]!.range.hi).toBe(46);
  expect(drag.stemRange.hi).toBe(46);
  expect(drag.stemRange.hi).toBeLessThan(drag.bar.range.hi);

  const shoved = resizeJunction(layout, drag, { across: 0, along: 5000 });
  const geoAfter = computeGeometry(shoved, viewport, tallFloor);
  const height = (id: string) => geoAfter.leaves.get(id)!.height;
  expect(height("d")).toBe(350);
  // Both stems moved by the same 46px, so they are still in line — the cross survived.
  expect(height("a")).toBe(442);
  expect(height("c")).toBe(442);
  expect(height("b")).toBe(350);
});

test("a T-junction drags on both axes through the same code path", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeBranch("cl", "column", [makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")])], [0.5, 0.5]),
    makeLeaf("c", [aTab("t3")]),
  ], [0.5, 0.5]));
  const geo = computeGeometry(layout, viewport, flatMins);
  const drag = beginJunctionDrag(layout, geo, geo.junctions[0]!.id, flatMins)!;
  expect(drag.stems).toHaveLength(1);

  const next = resizeJunction(layout, drag, { across: -50, along: 40 });
  expect(widthsOf(next).a).toBe(446);
  expect(heightsOf(next).a).toBe(436);
});

test("equalise gives a branch back even shares and is a no-op when it already has them", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")]), makeLeaf("c", [aTab("t3")]),
  ], [0.6, 0.3, 0.1]));
  const even = equalise(layout, "r");
  expect(weightsOf(even, "r")).toEqual([0.3333, 0.3333, 0.3333]);
  expect(equalise(even, "r")).toBe(even);
  expect(equalise(layout, "missing")).toBe(layout);
});

test("the keyboard moves a divider the same way the pointer does", () => {
  const layout = twoColumns();
  const geo = computeGeometry(layout, viewport, flatMins);
  const nudged = nudgeSash(layout, geo, "r#1", flatMins, 16);
  expect(widthsOf(nudged).a).toBe(512);
  expect(nudgeSash(layout, geo, "missing#1", flatMins, 16)).toBe(layout);
});
