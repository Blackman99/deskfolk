/**
 * What the board's camera (`TraceCanvas`, mirrored from the messenger) reads off the page, given
 * NSH's views: a stand-in for the viewport element, whose box and tools strip are measured by
 * `onLayout`, and the responder handlers that turn a drag or two fingers into the pointer events
 * the camera takes (a drag pans, two fingers pinch). The camera's own maths — the drag threshold,
 * the zoom about a point, the slides — runs unchanged.
 *
 * Not carried over: the wheel (⌘/Ctrl + wheel to zoom, a plain wheel to pan). NSH's views hear no
 * wheel; the zoom buttons, a pinch and a drag do the same work.
 */
import { PanResponder, type GestureResponderEvent, type PanResponderGestureState, type PanResponderInstance, type TouchPoint } from "nsh";
import type { TraceCanvas } from "../../m/overlays/trace-canvas.svelte.ts";

export type Measured = { width: number; height: number; toolsHeight: number };

/** The viewport as the camera sees it: a box at the origin, and a strip of tools over its bottom. */
export function viewportStandIn(measured: () => Measured): HTMLElement {
  const box = () => {
    const { width, height } = measured();
    return { left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 };
  };
  return {
    getBoundingClientRect: box,
    parentElement: { querySelector: () => ({ clientHeight: measured().toolsHeight }) },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
  } as unknown as HTMLElement;
}

/** A pointer event as the camera reads one: which finger, and where in the viewport. */
function pointer(id: number, x: number, y: number): PointerEvent {
  return { pointerId: id, clientX: x, clientY: y, pointerType: "touch", button: 0, preventDefault: () => {} } as unknown as PointerEvent;
}

/**
 * Pan and pinch for the viewport. `origin` is where the viewport's top left is in the window (the
 * touches are in window points). A press that does not move is not taken: the card under it gets it.
 */
export function traceGestures(canvas: TraceCanvas, origin: () => { x: number; y: number }): PanResponderInstance {
  const down = new Map<number, { x: number; y: number }>();
  const at = (touch: TouchPoint) => ({ x: touch.pageX - origin().x, y: touch.pageY - origin().y });

  /** Brings the camera's fingers in line with the ones on the glass. */
  function sync(touches: readonly TouchPoint[]): void {
    const now = new Set(touches.map((touch) => touch.identifier));
    for (const id of [...down.keys()]) {
      if (now.has(id)) continue;
      const last = down.get(id)!;
      down.delete(id);
      canvas.onPointerUp(pointer(id, last.x, last.y));
    }
    for (const touch of touches) {
      const here = at(touch);
      if (!down.has(touch.identifier)) {
        down.set(touch.identifier, here);
        canvas.onPointerDown(pointer(touch.identifier, here.x, here.y));
      } else {
        down.set(touch.identifier, here);
        canvas.onPointerMove(pointer(touch.identifier, here.x, here.y));
      }
    }
  }

  function end(): void {
    for (const [id, last] of down) canvas.onPointerUp(pointer(id, last.x, last.y));
    down.clear();
  }

  return PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    // A drag past a few points is the board's, cards included: it takes the touches from the card's press.
    onMoveShouldSetPanResponderCapture: (_e: GestureResponderEvent, g: PanResponderGestureState) =>
      Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3 || g.numberActiveTouches > 1,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e: GestureResponderEvent, g: PanResponderGestureState) => {
      // The drag starts where the finger went down, not where it was taken: the first move carries what it already moved.
      const first = e.touches[0];
      if (first) {
        const start = { x: g.x0 - origin().x, y: g.y0 - origin().y };
        down.set(first.identifier, start);
        canvas.onPointerDown(pointer(first.identifier, start.x, start.y));
      }
      sync(e.touches);
    },
    onPanResponderMove: (e: GestureResponderEvent) => sync(e.touches),
    onPanResponderRelease: end,
    onPanResponderTerminate: end,
  });
}
