/**
 * Dragging the dividers (`startSash` and `startJunction` of `Workbench.svelte`). A divider is pressed
 * and moved by its own `PanResponder`; while it moves, `live` is the layout the pointer would leave,
 * which the workbench draws in place of the real one (every pane on the branch takes its new share at
 * once), and on release that layout is committed. A crossing moves the divider through it and the
 * dividers that end on it by the same distance, which keeps them in line.
 */
import { signal } from "nsh";
import type { MinSizeLookup, WorkbenchLayout } from "../../m/workbench/layout-types.ts";
import type { LayoutGeometry } from "../../m/workbench/layout-geometry.ts";
import { beginJunctionDrag, beginSashDrag, resizeJunction, resizeSash, type JunctionDrag, type SashDrag } from "../../m/workbench/layout-resize.ts";
import { dragGate } from "../../m/workbench/pane-resize.svelte.ts";
import type { DragPhase, DragPoint } from "./types";

export function createResizer(ctx: {
  layout: () => WorkbenchLayout;
  geometry: () => LayoutGeometry | null;
  mins: MinSizeLookup;
  commit: (next: WorkbenchLayout) => void;
}) {
  /** The arrangement while a divider is moving; null at rest. */
  const live = signal<WorkbenchLayout | null>(null);
  /** Which divider is under the pointer right now; it keeps the accent for the whole drag. */
  const draggingSash = signal<string | null>(null);
  /** The crossing in hand. */
  const draggingJunction = signal<string | null>(null);
  let session: { layout: WorkbenchLayout; next: (point: DragPoint) => WorkbenchLayout | null; changed: (point: DragPoint) => boolean } | null = null;

  function finish(): void {
    session = null;
    live.set(null);
    draggingSash.set(null);
    draggingJunction.set(null);
    dragGate.end();
  }

  function sash(sashId: string, phase: DragPhase, point: DragPoint): void {
    if (phase === "start") {
      if (session) finish();
      const geometry = ctx.geometry();
      const layout = ctx.layout();
      const drag: SashDrag | null = geometry ? beginSashDrag(layout, geometry, sashId, ctx.mins) : null;
      if (!drag) return;
      session = {
        layout,
        next: (p) => resizeSash(layout, drag, drag.axis === "row" ? p.dx : p.dy),
        changed: (p) => (drag.axis === "row" ? p.dx : p.dy) !== 0,
      };
      draggingSash.set(sashId);
      dragGate.begin();
      return;
    }
    if (!session) return;
    if (phase === "move") live.set(session.next(point));
    else {
      const done = session;
      const commit = phase === "end" && done.changed(point) ? done.next(point) : null;
      try {
        if (commit) ctx.commit(commit);
      } finally {
        finish();
      }
    }
  }

  function junction(junctionId: string, phase: DragPhase, point: DragPoint): void {
    if (phase === "start") {
      if (session) finish();
      const geometry = ctx.geometry();
      const layout = ctx.layout();
      const drag: JunctionDrag | null = geometry ? beginJunctionDrag(layout, geometry, junctionId, ctx.mins) : null;
      if (!drag) return;
      const vertical = drag.bar.axis === "row";
      const delta = (p: DragPoint) => ({ across: vertical ? p.dx : p.dy, along: vertical ? p.dy : p.dx });
      session = {
        layout,
        next: (p) => resizeJunction(layout, drag, delta(p)),
        changed: (p) => delta(p).across !== 0 || delta(p).along !== 0,
      };
      draggingJunction.set(junctionId);
      dragGate.begin();
      return;
    }
    if (!session) return;
    if (phase === "move") live.set(session.next(point));
    else {
      const done = session;
      const commit = phase === "end" && done.changed(point) ? done.next(point) : null;
      try {
        if (commit) ctx.commit(commit);
      } finally {
        finish();
      }
    }
  }

  return { live, draggingSash, draggingJunction, sash, junction };
}
