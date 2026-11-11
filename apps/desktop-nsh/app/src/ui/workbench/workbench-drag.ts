/**
 * Dragging a tab, or a whole group by its strip, across the workbench (`startPaneDrag` of
 * `Workbench.svelte`). The gesture itself is the host's: the strip's `PanResponder` (or, for a
 * conversation pulled in from the sidebar, the list row's) reports the pointer in the window's
 * coordinates, and a `Session` turns that into drop zones, the indicator and the ghost chip, and on
 * release into the layout `applyDrop` makes of it.
 *
 * Not carried over: Alt (⌥) turning any position into a float works only while the mouse is heard
 * moving over the workbench (`alt()`); the rest of the drop logic is the messenger's own modules.
 */
import { signal } from "nsh";
import type { LeafNode, MinSizeLookup, PaneMin, Rect, WorkbenchLayout } from "../../m/workbench/layout-types.ts";
import type { LayoutGeometry } from "../../m/workbench/layout-geometry.ts";
import { activateTab, findTab, focusLeaf, leafById } from "../../m/workbench/layout-tree.ts";
import { dragGate } from "../../m/workbench/pane-resize.svelte.ts";
import { dropIndicatorRect, dropZoneAt, isNoOpDrop, rowScrollStep, type DropZone, type Point, type TabRow } from "../../m/workbench/drop-zones.ts";
import { applyDrop, passedThreshold, type PaneDrag } from "../../m/workbench/tab-drag.ts";
import { WB_FALLBACK_MIN } from "../../m/workbench/pane-mins.ts";
import type { RowRegistry } from "./types";

export type DragSession = {
  /** The pointer is at `point` (window coordinates). */
  move: (point: Point) => void;
  /** Let go; `cancelled` drops nothing. */
  end: (cancelled?: boolean) => void;
};

export type PaneDragContext = {
  layout: () => WorkbenchLayout;
  geometry: () => LayoutGeometry | null;
  viewport: () => Rect;
  mins: MinSizeLookup;
  rows: RowRegistry;
  freshId: () => string;
  commit: (next: WorkbenchLayout) => void;
  /** A point in the window as the workbench's own: the workbench's origin taken off. */
  toLocal: (page: Point) => Point;
  /** The workbench measures where it is in the window; asked when a drag starts. */
  refreshOrigin: () => Promise<void>;
  /** Alt is held: any position is a float. */
  alt: () => boolean;
};

export function createPaneDrag(ctx: PaneDragContext) {
  const paneDrag = signal<PaneDrag | null>(null);
  const dropZone = signal<DropZone>({ kind: "none" });
  /** Every pane's tab row, measured when a drag starts: where each tab is, which the geometry cannot say. */
  const tabRows = signal<ReadonlyMap<string, TabRow>>(new Map());
  const ghost = signal<{ x: number; y: number; label: string } | null>(null);

  /** The array order is the z-order, so the last one is on top. */
  const floatingTopFirst = () =>
    ctx
      .layout()
      .floating.map((pane) => pane.leaf.id)
      .reverse();

  /** A pane's floor is what it is showing, floating or not: a flow board keeps room for its cards. */
  const minOf = (leaf: LeafNode | null): PaneMin => ctx.mins(leaf?.tabs.find((tab) => tab.id === leaf.activeTabId) ?? null);

  const inFront = (at: WorkbenchLayout, tabId: string): WorkbenchLayout => {
    const found = findTab(at, tabId);
    return found ? activateTab(focusLeaf(at, found.leaf.id), found.leaf.id, tabId) : at;
  };

  async function measureRows(): Promise<Map<string, TabRow>> {
    await ctx.refreshOrigin();
    const out = new Map<string, TabRow>();
    await Promise.all(
      [...ctx.rows].map(async ([id, handle]) => {
        const row = await handle.measure();
        if (!row) return;
        const at = ctx.toLocal({ x: row.strip.x, y: row.strip.y });
        const start = ctx.toLocal({ x: row.start, y: 0 }).x;
        const visible = ctx.toLocal({ x: row.visible.x, y: 0 }).x;
        out.set(id, {
          strip: { x: at.x, y: at.y, width: row.strip.width, height: row.strip.height },
          visible: { x: visible, width: row.visible.width },
          start,
          widths: row.widths,
        });
      }),
    );
    return out;
  }

  /** Starts a drag at `origin` (window coordinates). `outside`: the press is on something outside the workbench, a row in the list. */
  function begin(drag: PaneDrag, label: string, outside = false): DragSession {
    let current = drag;
    let point: Point = ctx.toLocal({ x: drag.origin.x, y: drag.origin.y });
    let float = false;
    let ready = false;
    let over = false;
    let scrolling: ReturnType<typeof setTimeout> | undefined;
    // The drag was made from window coordinates: `origin` is moved into the workbench's.
    current = { ...current, origin: point };

    const locate = () => {
      const geometry = ctx.geometry();
      dropZone.set(geometry ? dropZoneAt(geometry, point, { float, rows: tabRows(), floating: floatingTopFirst() }) : { kind: "none" });
    };

    /** A row that overflows scrolls on its own while the pointer rests near either end. */
    const scrollRow = () => {
      scrolling = undefined;
      if (over) return;
      const zone = dropZone();
      if (zone.kind !== "tabstrip") return;
      const row = tabRows().get(zone.leafId);
      const handle = ctx.rows.get(zone.leafId);
      if (!row || !handle) return;
      const step = rowScrollStep(row, point.x);
      if (step === 0 || !handle.scrollBy(step)) return;
      void handle.measure().then((measured) => {
        if (!measured || over) return;
        const start = ctx.toLocal({ x: measured.start, y: 0 }).x;
        tabRows.set(new Map(tabRows()).set(zone.leafId, { ...row, start }));
        locate();
      });
      scrolling = setTimeout(scrollRow, 16);
    };

    function move(page: Point): void {
      if (over) return;
      point = ctx.toLocal(page);
      if (!current.started) {
        if (!passedThreshold(current, point)) return;
        current = { ...current, started: true };
        paneDrag.set(current);
        dragGate.begin();
        void measureRows().then((rows) => {
          if (over) return;
          tabRows.set(rows);
          ready = true;
          locate();
        });
      }
      locate();
      ghost.set({ x: point.x, y: point.y, label });
      if (ready && !scrolling) scrolling = setTimeout(scrollRow, 16);
    }

    function end(cancelled = false): void {
      if (over) return;
      over = true;
      if (scrolling) clearTimeout(scrolling);
      scrolling = undefined;
      if (!current.started) return;
      const layout = ctx.layout();
      const zone: DropZone = cancelled ? { kind: "none" } : dropZone();
      // A new tab floats the size one torn out of the pane in front would.
      const sourceRect = ctx.geometry()?.leaves.get(current.kind === "new" ? layout.focus.leafId : current.leafId);
      const moved = current.kind === "new" ? null : leafById(layout, current.leafId);
      const tabId = current.kind === "tab" ? current.tabId : null;
      const floatMin: PaneMin =
        current.kind === "new" ? ctx.mins(current.tab) : tabId ? ctx.mins(moved?.tabs.find((tab) => tab.id === tabId) ?? null) : minOf(moved);
      paneDrag.set(null);
      dropZone.set({ kind: "none" });
      tabRows.set(new Map());
      ghost.set(null);
      dragGate.end();
      let next = applyDrop(layout, current, zone, { node: ctx.freshId, viewport: ctx.viewport(), floatMin, sourceRect });
      // Let go anywhere in the workbench, the tab comes to the front where it now is, even back where it was.
      if (outside && tabId && zone.kind !== "none") next = inFront(next, tabId);
      if (next !== layout) ctx.commit(next);
    }

    // Alt is read as the pointer moves: through the mouse the workbench hears.
    const alt = () => {
      float = ctx.alt();
    };
    return {
      move: (page) => {
        alt();
        move(page);
      },
      end,
    };
  }

  /** The drop indicator and what it looks like: a bar in a tab gap rather than a box. */
  const indicator = () => {
    const geometry = ctx.geometry();
    const drag = paneDrag();
    return geometry && drag?.started ? dropIndicatorRect(geometry, dropZone(), WB_FALLBACK_MIN, tabRows()) : null;
  };
  /** Between two tabs, the indicator is a bar in the gap, and none at all where the drop would leave the tab where it is. */
  const onTabGap = () => {
    const zone = dropZone();
    return zone.kind === "tabstrip" && tabRows().has(zone.leafId);
  };
  const idleGap = () => {
    const drag = paneDrag();
    if (!onTabGap() || !drag || drag.kind === "new") return false;
    return isNoOpDrop(ctx.layout(), { leafId: drag.leafId, tabId: drag.kind === "tab" ? drag.tabId : "", onlyTab: drag.kind === "leaf" }, dropZone());
  };
  const draggedTab = () => {
    const drag = paneDrag();
    return drag?.started && drag.kind === "tab" ? drag.tabId : null;
  };
  const draggedLeaf = () => {
    const drag = paneDrag();
    return drag?.started && drag.kind === "leaf" ? drag.leafId : null;
  };

  return { begin, paneDrag, dropZone, ghost, indicator, onTabGap, idleGap, draggedTab, draggedLeaf, minOf };
}
