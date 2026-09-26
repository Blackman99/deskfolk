/**
 * Where a dragged tab would land.
 *
 * Hit testing runs against the computed geometry, not the DOM, so a drag reads nothing per frame
 * and costs the same with twenty panes as with two. Five outcomes: onto the tab strip at a
 * position, into the pane's tab group, against one of its four edges to divide it there, or —
 * with the modifier held — floating free.
 *
 * The one thing the geometry cannot know is where each tab sits: a tab is as wide as its name,
 * and the row scrolls once they no longer fit. Those rows are measured once when a drag begins
 * (`TabRow`), and again only for a row the drag itself scrolls.
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
/** How near a row's end the pointer has to be for a drag to scroll the row that way. */
export const WB_ROW_SCROLL_BAND_PX = 32;
/** How far the row scrolls per frame at the very end of that band, and just inside it. */
export const WB_ROW_SCROLL_MAX_PX = 14;
export const WB_ROW_SCROLL_MIN_PX = 3;

export type Side = "north" | "south" | "east" | "west";

export type DropZone =
  | { kind: "none" }
  | { kind: "centre"; leafId: NodeId }
  | { kind: "edge"; leafId: NodeId; side: Side }
  | { kind: "tabstrip"; leafId: NodeId; index: number }
  | { kind: "float"; point: { x: number; y: number } };

export type Point = { x: number; y: number };

/**
 * A pane's tab row as measured, in the workbench's coordinates.
 */
export type TabRow = {
  /** The strip across the top of the pane. A floating pane's can only be found this way. */
  strip: Rect;
  /** The part of the row that is on screen. A tab scrolled out of it cannot be pointed at. */
  visible: { x: number; width: number };
  /** Where the first tab starts, moved with the row's scroll, and how wide each tab is. */
  start: number;
  widths: readonly number[];
};

export type DropZoneOptions = {
  float?: boolean;
  stripHeight?: number;
  /** Each pane's measured tab row, so a drop on a strip knows between which two tabs. */
  rows?: ReadonlyMap<NodeId, TabRow>;
  /**
   * The floating panes, top-most first. Their strips sit over the tiled panes, so they are
   * tried before any of those.
   */
  floating?: readonly NodeId[];
};

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
 * tab, so dropping on a tab's left half puts the dragged one before it. A pointer past either end
 * of what is on screen counts as that end: the tabs scrolled out of view are not under it.
 */
export function tabInsertIndex(row: Pick<TabRow, "visible" | "start" | "widths">, x: number): number {
  const at = Math.min(Math.max(x, row.visible.x), row.visible.x + row.visible.width);
  let edge = row.start;
  for (let i = 0; i < row.widths.length; i++) {
    const width = row.widths[i]!;
    if (at < edge + width / 2) return i;
    edge += width;
  }
  return row.widths.length;
}

/**
 * Where on the strip a drop at `index` goes: `-1` from a strip nobody measured means after the
 * last tab, and so does anything past the end.
 */
export function stripIndex(index: number, tabCount: number): number {
  return index < 0 || index > tabCount ? tabCount : index;
}

/**
 * How far a drag near either end of a row that overflows scrolls it this frame: negative
 * towards the start. Faster the nearer the end, and at full speed past it — over the strip's
 * own buttons. Zero where the row cannot go that way.
 */
export function rowScrollStep(row: TabRow, x: number): number {
  const content = row.widths.reduce((sum, width) => sum + width, 0);
  const left = row.visible.x;
  const right = row.visible.x + row.visible.width;
  const speed = (depth: number) =>
    Math.round(WB_ROW_SCROLL_MIN_PX + (WB_ROW_SCROLL_MAX_PX - WB_ROW_SCROLL_MIN_PX) * Math.min(1, depth));
  // Half a pixel of slack: a scroll position is fractional on a Retina screen.
  if (x < left + WB_ROW_SCROLL_BAND_PX && row.start < left - 0.5) {
    return -speed((left + WB_ROW_SCROLL_BAND_PX - x) / WB_ROW_SCROLL_BAND_PX);
  }
  if (x > right - WB_ROW_SCROLL_BAND_PX && row.start + content > right + 0.5) {
    return speed((x - (right - WB_ROW_SCROLL_BAND_PX)) / WB_ROW_SCROLL_BAND_PX);
  }
  return 0;
}

/**
 * The bar drawn in the gap a tab would drop into. It stays on the visible part of the row, so a
 * gap scrolled just out of view still shows at the row's end.
 */
export function tabMarkerRect(row: TabRow, index: number): Rect {
  const at = stripIndex(index, row.widths.length);
  let gap = row.start;
  for (let i = 0; i < at; i++) gap += row.widths[i]!;
  const x = Math.min(Math.max(gap, row.visible.x + 1), row.visible.x + row.visible.width - 1);
  return { x: x - 1, y: row.strip.y + 6, width: 2, height: Math.max(0, row.strip.height - 8) };
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
  opts: DropZoneOptions = {},
): DropZone {
  if (opts.float) return { kind: "float", point };
  if (!contains(geo.viewport, point)) return { kind: "none" };

  const onStrip = (leafId: NodeId): DropZone => {
    const row = opts.rows?.get(leafId);
    return { kind: "tabstrip", leafId, index: row ? tabInsertIndex(row, point.x) : -1 };
  };
  for (const leafId of opts.floating ?? []) {
    const strip = opts.rows?.get(leafId)?.strip;
    if (strip && contains(strip, point)) return onStrip(leafId);
  }

  for (const [leafId, rect] of geo.leaves) {
    if (!contains(rect, point)) continue;
    const strip = { ...rect, height: opts.stripHeight ?? WB_STRIP_PX };
    if (contains(strip, point)) return onStrip(leafId);

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

/**
 * The rectangle to draw so the person can see where the drop will put it. On a measured strip
 * that is the bar in the gap between two tabs (`tabMarkerRect`), not the strip itself.
 */
export function dropIndicatorRect(
  geo: LayoutGeometry,
  zone: DropZone,
  floatSize: PaneMin,
  rows?: ReadonlyMap<NodeId, TabRow>,
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
  const row = zone.kind === "tabstrip" ? rows?.get(zone.leafId) : undefined;
  if (zone.kind === "tabstrip" && row) return tabMarkerRect(row, zone.index);
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
    // A whole group put back on its own strip.
    if (!drag.tabId) return true;
    const leaf = layout.floating.find((pane) => pane.leaf.id === drag.leafId)?.leaf ??
      findLeaf(layout, drag.leafId);
    if (!leaf) return true;
    const from = leaf.tabs.findIndex((tab) => tab.id === drag.tabId);
    const index = stripIndex(zone.index, leaf.tabs.length);
    return index === from || index === from + 1;
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
