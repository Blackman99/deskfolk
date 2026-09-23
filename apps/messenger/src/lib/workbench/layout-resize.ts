/**
 * Moving dividers.
 *
 * A drag is prepared once, on pointer down, and then every move is arithmetic against that
 * prepared value. Nothing here reads the DOM, so a move costs the same whether there are two
 * panes or twenty, and the expensive part of a resize — telling xterm and Monaco to re-measure —
 * is left to the moment the pointer is released.
 *
 * The important thing this module says: **a junction drag is two independent sash resizes, one
 * per axis.** Moving a vertical bar changes widths; the horizontal dividers that end on it are
 * fractions of heights, which that motion does not touch. The only coupling is that one axis may
 * be commanding several collinear dividers at once, and they must move together or come apart.
 */
import type { Axis, BranchNode, MinSizeLookup, NodeId, WorkbenchLayout } from "./layout-types.ts";
import { findPath, isLeaf, nodeAt, renormalise, replaceAt } from "./layout-tree.ts";
import { allocate, contentExtent, minSize, type LayoutGeometry } from "./layout-geometry.ts";

export type Range = { lo: number; hi: number };

export type SashDrag = {
  sashId: string;
  branchId: NodeId;
  index: number;
  axis: Axis;
  /** Pixels the children share, dividers excluded. */
  extent: number;
  /** The sizes the children had when the drag began, so every move is measured from there. */
  sizes: number[];
  /** How far this divider may travel: negative toward the start, positive toward the end. */
  range: Range;
};

export type JunctionDrag = {
  junctionId: string;
  bar: SashDrag;
  /** Collinear dividers that end on the bar. One is a T-junction; more is a cross. */
  stems: SashDrag[];
  /** Every stem's range intersected, which is what keeps a cross rigid at a minimum. */
  stemRange: Range;
};

function branchAt(layout: WorkbenchLayout, branchId: NodeId): { branch: BranchNode; path: readonly number[] } | null {
  const path = findPath(layout.root, branchId);
  if (!path) return null;
  const branch = nodeAt(layout.root, path);
  if (!branch || isLeaf(branch)) return null;
  return { branch, path };
}

/** Work out what a divider may do, given where everything currently is. */
export function beginSashDrag(
  layout: WorkbenchLayout,
  geo: LayoutGeometry,
  sashId: string,
  mins: MinSizeLookup,
): SashDrag | null {
  const sash = geo.sashes.find((candidate) => candidate.id === sashId);
  if (!sash) return null;
  const found = branchAt(layout, sash.branchId);
  const rect = geo.branches.get(sash.branchId);
  if (!found || !rect) return null;
  const { branch } = found;
  const row = branch.axis === "row";
  const childMins = branch.children.map((child) => {
    const min = minSize(child, mins);
    return row ? min.width : min.height;
  });
  const extent = contentExtent(branch, rect);
  const sizes = allocate(extent, branch.weights, childMins);
  const before = sash.index - 1;
  const after = sash.index;
  return {
    sashId,
    branchId: sash.branchId,
    index: sash.index,
    axis: branch.axis,
    extent,
    sizes,
    range: {
      lo: -Math.max(0, sizes[before]! - childMins[before]!),
      hi: Math.max(0, sizes[after]! - childMins[after]!),
    },
  };
}

export function clampToRange(delta: number, range: Range): number {
  return Math.min(range.hi, Math.max(range.lo, delta));
}

/** The weights a branch would have if this divider moved by `delta` pixels. */
export function weightsAfterSash(drag: SashDrag, delta: number): number[] {
  const moved = clampToRange(delta, drag.range);
  const sizes = [...drag.sizes];
  sizes[drag.index - 1] = sizes[drag.index - 1]! + moved;
  sizes[drag.index] = sizes[drag.index]! - moved;
  if (drag.extent <= 0) return renormalise(sizes.map(() => 1));
  return renormalise(sizes.map((size) => Math.max(1e-6, size / drag.extent)));
}

export function resizeSash(layout: WorkbenchLayout, drag: SashDrag, delta: number): WorkbenchLayout {
  const found = branchAt(layout, drag.branchId);
  if (!found) return layout;
  const weights = weightsAfterSash(drag, delta);
  const next = { ...found.branch, weights };
  return { ...layout, root: replaceAt(layout.root, found.path, next) };
}

/**
 * Prepare a two-axis drag.
 *
 * The bar takes the motion across it; every stem takes the motion along it, each receiving the
 * **same pixel delta**. Identical pixels is what preserves collinearity even though each stem is
 * a fraction of a different branch's height. The stems' allowed travel is intersected once, here,
 * so when one of them reaches its minimum they all stop — otherwise a cross would tear apart at
 * the first minimum and could never be made square again.
 */
export function beginJunctionDrag(
  layout: WorkbenchLayout,
  geo: LayoutGeometry,
  junctionId: string,
  mins: MinSizeLookup,
): JunctionDrag | null {
  const junction = geo.junctions.find((candidate) => candidate.id === junctionId);
  if (!junction) return null;
  const bar = beginSashDrag(layout, geo, junction.bar.sashId, mins);
  if (!bar) return null;
  const stems: SashDrag[] = [];
  for (const stem of junction.stems) {
    const drag = beginSashDrag(layout, geo, stem.sashId, mins);
    if (drag) stems.push(drag);
  }
  if (stems.length === 0) return null;
  const stemRange = stems.reduce<Range>(
    (range, stem) => ({ lo: Math.max(range.lo, stem.range.lo), hi: Math.min(range.hi, stem.range.hi) }),
    { lo: -Infinity, hi: Infinity },
  );
  return { junctionId, bar, stems, stemRange: { lo: Math.min(0, stemRange.lo), hi: Math.max(0, stemRange.hi) } };
}

export type JunctionDelta = { across: number; along: number };

export function resizeJunction(
  layout: WorkbenchLayout,
  drag: JunctionDrag,
  delta: JunctionDelta,
): WorkbenchLayout {
  let next = resizeSash(layout, drag.bar, delta.across);
  const along = clampToRange(delta.along, drag.stemRange);
  for (const stem of drag.stems) {
    // The same pixel movement for each, not the same fraction: that is what keeps them in line.
    next = resizeSash(next, stem, along);
  }
  return next;
}

/** Give every child of a branch the same share. The one-gesture way back from a lopsided drag. */
export function equalise(layout: WorkbenchLayout, branchId: NodeId): WorkbenchLayout {
  const found = branchAt(layout, branchId);
  if (!found) return layout;
  const { branch, path } = found;
  const even = branch.children.map(() => 1 / branch.children.length);
  if (branch.weights.every((weight, i) => Math.abs(weight - even[i]!) < 1e-9)) return layout;
  return { ...layout, root: replaceAt(layout.root, path, { ...branch, weights: even }) };
}

/**
 * Nudge a pane's edge by the keyboard. The pointer-only divider is why the junction handle can be
 * smaller than a touch target: this is the accessible way to do the same thing.
 */
export function nudgeSash(
  layout: WorkbenchLayout,
  geo: LayoutGeometry,
  sashId: string,
  mins: MinSizeLookup,
  px: number,
): WorkbenchLayout {
  const drag = beginSashDrag(layout, geo, sashId, mins);
  if (!drag) return layout;
  return resizeSash(layout, drag, px);
}
