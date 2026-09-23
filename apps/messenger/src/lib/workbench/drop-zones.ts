/**
 * Where a dragged tab would land.
 *
 * Hit testing runs against the computed geometry, not the DOM, so a drag reads nothing per frame
 * and costs the same with twenty panes as with two. Five outcomes: onto the tab strip at a
 * position, into the pane's tab group, against one of its four edges to divide it there, or —
 * with the modifier held — floating free.
 */
import type { NodeId, PaneMin, Rect, WorkbenchLayout } from "./layout-types.ts";
import type { LayoutGeometry } from "./layout-geometry.ts";
import { clampFrame } from "./float-frame.ts";
import { WB_STRIP_PX } from "./pane-mins.ts";

/**
 * How much of a pane its edge bands take. Measured against the pane's **smaller** side, so a tall
 * narrow pane does not get a band wide enough to swallow its whole middle.
 */
export const WB_EDGE_BAND_FRACTION = 0.22;
export const WB_EDGE_BAND_MIN_PX = 32;
export const WB_EDGE_BAND_MAX_PX = 96;
/** A press has to travel this far before it is a drag rather than a click on a tab. */
export const WB_DRAG_THRESHOLD_PX = 4;

export type Side = "north" | "south" | "east" | "west";

export type DropZone =
  | { kind: "none" }
  | { kind: "centre"; leafId: NodeId }
  | { kind: "edge"; leafId: NodeId; side: Side }
  | { kind: "tabstrip"; leafId: NodeId; index: number }
  | { kind: "float"; point: { x: number; y: number } };

export type Point = { x: number; y: number };

export function edgeBand(rect: Rect): number {
  const shorter = Math.min(rect.width, rect.height);
  return Math.min(WB_EDGE_BAND_MAX_PX, Math.max(WB_EDGE_BAND_MIN_PX, shorter * WB_EDGE_BAND_FRACTION));
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width &&
    point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * Which tab position a pointer over the strip means. The strip is divided at the midpoint of each
 * tab, so dropping on a tab's left half puts the dragged one before it.
 */
export function tabInsertIndex(strip: Rect, tabWidths: readonly number[], x: number): number {
  let edge = strip.x;
  for (let i = 0; i < tabWidths.length; i++) {
    const width = tabWidths[i]!;
    if (x < edge + width / 2) return i;
    edge += width;
  }
  return tabWidths.length;
}

/**
 * The zone under a pointer.
 *
 * Corners resolve to whichever edge is nearer, and a tie is broken in a fixed order so the same
 * pixel always gives the same answer — a drop target that depends on iteration order is a drop
 * target nobody can test.
 */
export function dropZoneAt(
  geo: LayoutGeometry,
  point: Point,
  opts: { float?: boolean; stripHeight?: number } = {},
): DropZone {
  if (opts.float) return { kind: "float", point };
  if (!contains(geo.viewport, point)) return { kind: "none" };

  for (const [leafId, rect] of geo.leaves) {
    if (!contains(rect, point)) continue;
    const strip = { ...rect, height: opts.stripHeight ?? WB_STRIP_PX };
    if (contains(strip, point)) return { kind: "tabstrip", leafId, index: -1 };

    const band = edgeBand(rect);
    const distances: Array<{ side: Side; gap: number }> = [
      { side: "north", gap: point.y - rect.y },
      { side: "south", gap: rect.y + rect.height - point.y },
      { side: "west", gap: point.x - rect.x },
      { side: "east", gap: rect.x + rect.width - point.x },
    ];
    // A stable order, so a pointer exactly on a diagonal never flickers between two answers.
    let nearest = distances[0]!;
    for (const candidate of distances) if (candidate.gap < nearest.gap) nearest = candidate;
    if (nearest.gap < band) return { kind: "edge", leafId, side: nearest.side };
    return { kind: "centre", leafId };
  }
  return { kind: "none" };
}

/** The rectangle to draw so the person can see where the drop will put it. */
export function dropIndicatorRect(
  geo: LayoutGeometry,
  zone: DropZone,
  floatSize: PaneMin,
): Rect | null {
  if (zone.kind === "none") return null;
  if (zone.kind === "float") {
    return clampFrame(
      {
        x: zone.point.x - floatSize.width / 2,
        y: zone.point.y - floatSize.height / 2,
        width: floatSize.width,
        height: floatSize.height,
      },
      floatSize,
      geo.viewport,
    );
  }
  const rect = geo.leaves.get(zone.leafId);
  if (!rect) return null;
  if (zone.kind === "centre") return rect;
  if (zone.kind === "tabstrip") return { ...rect, height: WB_STRIP_PX };
  switch (zone.side) {
    case "north": return { ...rect, height: Math.round(rect.height / 2) };
    case "south": return { ...rect, y: rect.y + Math.round(rect.height / 2), height: Math.round(rect.height / 2) };
    case "west": return { ...rect, width: Math.round(rect.width / 2) };
    case "east": return { ...rect, x: rect.x + Math.round(rect.width / 2), width: Math.round(rect.width / 2) };
  }
}

/** Which way an edge divides, and on which side the dropped pane lands. */
export function sideToSplit(side: Side): { axis: "row" | "column"; side: "before" | "after" } {
  switch (side) {
    case "west": return { axis: "row", side: "before" };
    case "east": return { axis: "row", side: "after" };
    case "north": return { axis: "column", side: "before" };
    case "south": return { axis: "column", side: "after" };
  }
}

/**
 * Whether this drop would change anything. A drag that ends where it began should return the
 * layout it was given, so the app skips a re-render instead of rebuilding an identical tree.
 */
export function isNoOpDrop(
  layout: WorkbenchLayout,
  drag: { leafId: NodeId; tabId: string; onlyTab: boolean },
  zone: DropZone,
): boolean {
  if (zone.kind === "none") return true;
  if (zone.kind === "float") return false;
  if (zone.leafId !== drag.leafId) return false;
  // Back into its own group, or onto an edge of the pane it is the only occupant of: nothing to do.
  if (zone.kind === "centre") return true;
  if (zone.kind === "edge") return drag.onlyTab;
  if (zone.kind === "tabstrip") {
    const leaf = layout.floating.find((pane) => pane.leaf.id === drag.leafId)?.leaf ??
      findLeaf(layout, drag.leafId);
    if (!leaf) return true;
    const from = leaf.tabs.findIndex((tab) => tab.id === drag.tabId);
    return zone.index === from || zone.index === from + 1;
  }
  return false;
}

function findLeaf(layout: WorkbenchLayout, id: NodeId) {
  const walk = (node: WorkbenchLayout["root"]): WorkbenchLayout["root"] | null => {
    if (node.type === "leaf") return node.id === id ? node : null;
    for (const child of node.children) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  const found = walk(layout.root);
  return found && found.type === "leaf" ? found : null;
}
