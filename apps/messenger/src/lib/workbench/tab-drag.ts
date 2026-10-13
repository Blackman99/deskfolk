/**
 * Dragging a tab, or a whole tab group, somewhere else.
 *
 * The reducer is pure and separate from the pointer plumbing: happy-dom has no layout, so the
 * geometry cannot be asserted through a mounted component, but every decision a drag makes can.
 *
 * Pointer events throughout, never HTML5 drag and drop — that has no pointer capture, an
 * uncontrollable drag image, and coarse coordinates in the webview this app ships in.
 */
import type { FloatFrame, NodeId, PaneMin, Rect, TabId, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { WB_DRAG_THRESHOLD_PX, isNoOpDrop, sideToSplit, stripIndex, type DropZone, type Point } from "./drop-zones.ts";
import {
  addTab,
  closeTab,
  focusLeaf,
  isLeaf,
  leafById,
  makeLeaf,
  reorderTab,
  splitLeaf,
} from "./layout-tree.ts";
import { frameForTearOut } from "./float-frame.ts";

export type TabDrag = {
  kind: "tab";
  leafId: NodeId;
  tabId: TabId;
  origin: Point;
  /** Set once the pointer has travelled far enough that this is a drag and not a click. */
  started: boolean;
};

export type LeafDrag = {
  kind: "leaf";
  leafId: NodeId;
  origin: Point;
  started: boolean;
};

/**
 * A tab that is in no pane yet — a conversation pulled in from the list — made where it is let
 * go. It has nowhere to leave, so no drop of it is a no-op but one on nothing.
 */
export type NewTabDrag = {
  kind: "new";
  tab: WorkbenchTab;
  origin: Point;
  started: boolean;
};

export type PaneDrag = TabDrag | LeafDrag | NewTabDrag;

/**
 * What a drag that starts outside the workbench carries: a tab already in it, which then moves
 * the way dragging it by its own strip would, or a new one.
 */
export type IncomingTab = { leafId: NodeId; tabId: TabId } | { tab: WorkbenchTab };

export function beginTabDrag(leafId: NodeId, tabId: TabId, origin: Point): TabDrag {
  return { kind: "tab", leafId, tabId, origin, started: false };
}

export function beginLeafDrag(leafId: NodeId, origin: Point): LeafDrag {
  return { kind: "leaf", leafId, origin, started: false };
}

export function beginIncomingDrag(from: IncomingTab, origin: Point): TabDrag | NewTabDrag {
  if ("tab" in from) return { kind: "new", tab: from.tab, origin, started: false };
  return beginTabDrag(from.leafId, from.tabId, origin);
}

/** Whether the pointer has moved far enough to mean a drag. A click on a tab still just selects. */
export function passedThreshold(drag: PaneDrag, point: Point): boolean {
  if (drag.started) return true;
  return Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y) >= WB_DRAG_THRESHOLD_PX;
}

export type DropIds = {
  /** A fresh node id, for a pane a drop has to create. */
  node: () => NodeId;
};

export type DropContext = DropIds & {
  viewport: Rect;
  floatMin: PaneMin;
  /** The rect the dragged pane came from, so a tear-out keeps roughly its size. */
  sourceRect?: Rect;
};

function tabsOf(layout: WorkbenchLayout, drag: TabDrag | LeafDrag): WorkbenchTab[] {
  const leaf = leafById(layout, drag.leafId);
  if (!leaf) return [];
  if (drag.kind === "leaf") return leaf.tabs;
  const tab = leaf.tabs.find((candidate) => candidate.id === drag.tabId);
  return tab ? [tab] : [];
}

/** Take the dragged tabs out of where they were. May remove the pane they left empty. */
function detach(layout: WorkbenchLayout, drag: TabDrag | LeafDrag, ids: DropIds): WorkbenchLayout {
  const moving = tabsOf(layout, drag);
  let next = layout;
  for (const tab of moving) next = closeTab(next, drag.leafId, tab.id, ids.node());
  return next;
}

/**
 * Where the drop leaves the layout.
 *
 * A drop that changes nothing returns the layout it was given, so the app skips a re-render
 * rather than rebuilding an identical tree.
 */
export function applyDrop(
  layout: WorkbenchLayout,
  drag: PaneDrag,
  zone: DropZone,
  ctx: DropContext,
): WorkbenchLayout {
  if (drag.kind === "new") return placeTabs(layout, [drag.tab], zone, ctx) ?? layout;
  const leaf = leafById(layout, drag.leafId);
  if (!leaf) return layout;
  const moving = tabsOf(layout, drag);
  if (moving.length === 0) return layout;

  const onlyTab = drag.kind === "leaf" || leaf.tabs.length === 1;
  if (isNoOpDrop(layout, { leafId: drag.leafId, tabId: drag.kind === "tab" ? drag.tabId : "", onlyTab }, zone)) {
    return layout;
  }

  if (zone.kind === "float") return placeTabs(detach(layout, drag, ctx), moving, zone, ctx) ?? layout;

  if (zone.kind === "none") return layout;

  // Reordering inside one strip is the one case that never detaches: the pane would close under
  // the drag if this were its only tab, and the tab would have nowhere to land.
  if (zone.kind === "tabstrip" && zone.leafId === drag.leafId && drag.kind === "tab") {
    const from = leaf.tabs.findIndex((tab) => tab.id === drag.tabId);
    const gap = stripIndex(zone.index, leaf.tabs.length);
    return reorderTab(layout, drag.leafId, drag.tabId, gap > from ? gap - 1 : gap);
  }

  return placeTabs(detach(layout, drag, ctx), moving, zone, ctx) ?? layout;
}

/**
 * Put tabs that are in no pane at a drop zone: floating, into a pane's group, onto its strip at a
 * position, or in a pane split off one of its edges. Null where there is nowhere to put them —
 * no zone, or a pane that is not there.
 */
function placeTabs(
  layout: WorkbenchLayout,
  moving: WorkbenchTab[],
  zone: DropZone,
  ctx: DropContext,
): WorkbenchLayout | null {
  if (zone.kind === "none") return null;

  if (zone.kind === "float") {
    const frame: FloatFrame = frameForTearOut(
      ctx.sourceRect ?? { x: 0, y: 0, width: ctx.floatMin.width, height: ctx.floatMin.height },
      zone.point,
      ctx.floatMin,
      ctx.viewport,
    );
    const id = ctx.node();
    const floated: WorkbenchLayout = {
      ...layout,
      floating: [...layout.floating, { leaf: makeLeaf(id, moving), frame }],
    };
    return focusLeaf(floated, id);
  }

  // The pane being dropped on may have gone when the source pane closed behind the drag.
  if (!leafById(layout, zone.leafId)) return null;

  if (zone.kind === "centre") {
    let next = layout;
    for (const tab of moving) next = addTab(next, zone.leafId, tab);
    return focusLeaf(next, zone.leafId);
  }

  if (zone.kind === "tabstrip") {
    const at = stripIndex(zone.index, leafById(layout, zone.leafId)!.tabs.length);
    let next = layout;
    moving.forEach((tab, offset) => {
      next = addTab(next, zone.leafId, tab, at + offset);
    });
    return focusLeaf(next, zone.leafId);
  }

  const { axis, side } = sideToSplit(zone.side);
  const id = ctx.node();
  return splitLeaf(layout, zone.leafId, axis, side, moving, { leaf: id, branch: ctx.node() });
}

/** Put a floating pane back into the tiled tree at a drop zone. */
export function dockFloating(
  layout: WorkbenchLayout,
  leafId: NodeId,
  zone: DropZone,
  ctx: DropContext,
): WorkbenchLayout {
  const pane = layout.floating.find((candidate) => candidate.leaf.id === leafId);
  if (!pane) return layout;
  if (zone.kind === "float" || zone.kind === "none") return layout;
  const target = leafById(layout, zone.leafId);
  if (!target || !isLeaf(target)) return layout;

  const without: WorkbenchLayout = {
    ...layout,
    floating: layout.floating.filter((candidate) => candidate.leaf.id !== leafId),
  };
  if (zone.kind === "centre" || zone.kind === "tabstrip") {
    const at = zone.kind === "tabstrip" ? stripIndex(zone.index, target.tabs.length) : undefined;
    let next = without;
    pane.leaf.tabs.forEach((tab, offset) => {
      next = addTab(next, zone.leafId, tab, at === undefined ? undefined : at + offset);
    });
    return focusLeaf(next, zone.leafId);
  }
  const { axis, side } = sideToSplit(zone.side);
  return splitLeaf(without, zone.leafId, axis, side, pane.leaf.tabs, { leaf: ctx.node(), branch: ctx.node() });
}
