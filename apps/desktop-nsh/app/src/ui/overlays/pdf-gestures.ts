/**
 * The drags on a page's overlay, for `PdfViewer` (its `beginGesture` .. `onGestureUp` in the
 * Svelte): a new box drawn by dragging (a press is a small one), the pending box moved, and one of
 * its corners dragged. The Svelte measured the overlay under every pointer move; a PanResponder
 * reports how far the finger has gone since it went down, so a box is `origin + distance / drawn
 * size` and nothing is measured: the page may scroll under the finger without the box slipping.
 */
import { PanResponder, signal } from "nsh";
import {
  boxBetween,
  clickBox,
  isClick,
  isUsableBox,
  moveBox,
  resizeBox,
  toNorm,
  type Handle,
  type NormBox,
  type NormPoint,
  type Size,
} from "../../m/annotations/region-box.ts";
import { grabbedPoint, handleCorner } from "../../m/annotations/pdf-region.ts";

/** What a page overlay draws of the drag under way. */
export type PdfGestureView = { kind: "new" | "move" | "resize"; page: number; box: NormBox };

type Gesture =
  | { kind: "new"; page: number; start: NormPoint }
  | { kind: "move"; page: number; origin: NormBox }
  | { kind: "resize"; page: number; origin: NormBox; handle: Handle };

export type PdfGestureHost = {
  /** Annotate mode is on, a new box may be made, and none is pending. */
  choosing: () => boolean;
  /** A page's size on screen (CSS px) now. */
  drawnSize: (page: number) => Size | undefined;
  /** A page's size at 100%, for the shape of a click's box. */
  pageSize: (page: number) => Size | undefined;
  /** A new box was chosen. */
  onDraft: (page: number, region: NormBox) => void;
  /** The pending box was moved or resized. */
  onPendingChange: (page: number, region: NormBox) => void;
};

const same = (a: NormBox, b: NormBox) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export function createPdfGestures(host: PdfGestureHost) {
  const live = signal<PdfGestureView | null>(null);
  let gesture: Gesture | null = null;

  const rect = (page: number) => {
    const size = host.drawnSize(page);
    return { left: 0, top: 0, width: size?.width ?? 0, height: size?.height ?? 0 };
  };

  /** Where the gesture's box is with the finger `dx`, `dy` points from where it went down. */
  function boxAt(g: Gesture, dx: number, dy: number): NormBox {
    const d = rect(g.page);
    if (d.width <= 0 || d.height <= 0) return g.kind === "new" ? { ...g.start, w: 0, h: 0 } : g.origin;
    if (g.kind === "new") return boxBetween(g.start, toNorm(g.start.x * d.width + dx, g.start.y * d.height + dy, d));
    if (g.kind === "move") return moveBox(g.origin, dx / d.width, dy / d.height);
    const corner = handleCorner(g.origin, g.handle);
    return resizeBox(g.origin, g.handle, grabbedPoint({ x: corner.x + dx / d.width, y: corner.y + dy / d.height }, { x: 0, y: 0 }));
  }

  function begin(next: Gesture): void {
    gesture = next;
    live.set({ kind: next.kind, page: next.page, box: next.kind === "new" ? { ...next.start, w: 0, h: 0 } : next.origin });
  }

  function end(): Gesture | null {
    const g = gesture;
    gesture = null;
    live.set(null);
    return g;
  }

  function move(dx: number, dy: number): void {
    const g = gesture;
    if (g) live.set({ kind: g.kind, page: g.page, box: boxAt(g, dx, dy) });
  }

  function release(dx: number, dy: number): void {
    const g = end();
    if (!g) return;
    const click = isClick({ x: 0, y: 0 }, { x: dx, y: dy });
    if (g.kind === "new") {
      // Annotate mode went off (or a box became pending) mid-drag: nothing to hand over.
      if (!host.choosing()) return;
      const dragged = boxAt(g, dx, dy);
      const size = host.pageSize(g.page);
      const region = click || !isUsableBox(dragged) ? (size ? clickBox(g.start, size) : null) : dragged;
      if (region && isUsableBox(region)) host.onDraft(g.page, region);
      return;
    }
    // A press on the box or a handle that did not move leaves it where it was.
    if (click) return;
    const next = boxAt(g, dx, dy);
    if (!same(next, g.origin) && isUsableBox(next)) host.onPendingChange(g.page, next);
  }

  /**
   * The responder of one overlay, box or handle. `page` is read when the finger goes down (a row is
   * recycled for other pages), `region` is the pending box it moves or resizes.
   */
  function responder(
    page: () => number,
    what: { kind: "new" } | { kind: "move"; region: () => NormBox | null } | { kind: "resize"; handle: Handle; region: () => NormBox | null },
  ) {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => (what.kind === "new" ? host.choosing() : what.region() !== null) && gesture === null,
      onPanResponderGrant: (e) => {
        const n = page();
        if (what.kind === "new") {
          begin({ kind: "new", page: n, start: toNorm(e.locationX, e.locationY, rect(n)) });
          return;
        }
        const region = what.region();
        if (!region) return;
        begin(what.kind === "move" ? { kind: "move", page: n, origin: region } : { kind: "resize", page: n, origin: region, handle: what.handle });
      },
      onPanResponderMove: (_e, g) => move(g.dx, g.dy),
      onPanResponderRelease: (_e, g) => release(g.dx, g.dy),
      onPanResponderTerminate: () => {
        end();
      },
      onPanResponderTerminationRequest: () => false,
    });
  }

  return { live, responder, abort: end, active: () => gesture !== null };
}

export type PdfGestures = ReturnType<typeof createPdfGestures>;
