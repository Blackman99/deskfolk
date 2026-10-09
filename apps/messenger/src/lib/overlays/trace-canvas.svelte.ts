/**
 * The flow board's camera: where it sits, how far zoomed, and the gestures that move it.
 *
 * The board inside a fixed viewport: no scrollbars, it is dragged.
 *
 * A fan is wider than any window it opens in, and a scrollbar on each axis turns reading a
 * flow into operating a pair of sliders. So the viewport stays put and the board moves under
 * it — drag, the wheel or a two-finger swipe to pan, ⌘/Ctrl + wheel or a pinch to zoom, and the
 * window's own corner still resizes the viewport itself.
 *
 * One finger drags the board rather than the page. The board is the page here, so nothing is
 * stolen; it does mean the gesture has to be taken properly, which is why the listeners below
 * are bound non-passively.
 *
 * Everything about the job itself — its trace, its rounds, its folds — stays the component's own
 * state; this class only ever reads that through the getters it was built with, so it keeps
 * working across a reload of the same job or a switch to another one without being told. What it
 * does NOT own: the component keeps the one Escape listener, the fold/unfold-a-round arithmetic
 * (that also touches which rounds are folded, not just the camera) and the focus-token effect
 * (that also unfolds a round) — see TraceView.svelte for why.
 */
import { prefersReducedMotion } from "../reduced-motion.ts";
import { deferWhileDragging } from "../workbench/pane-resize.svelte.ts";
import {
  TRACE_GLIDE_MS,
  centerOnNode,
  fitView,
  focusMoveDue,
  focusNode,
  glideView,
  keepPlacedFocus,
  keptBoard,
  keptBoardAge,
  openView,
  pinchSpan,
  placedFocusOf,
  zoomAt,
  type KeptBoard,
  type TraceBox,
  type TraceFlow,
  type TraceFocus,
  type TraceView
} from "./task-trace.ts";
import { viewCentredOn } from "./trace-minimap.ts";

/** What the camera reads from the component, fresh on every call, and how it writes a box back. */
export type TraceCanvasDeps = {
  sessionId: () => string;
  flow: () => TraceFlow | null;
  currentId: () => string | null;
  focus: () => TraceFocus | null;
  focusToken: () => number;
  boxes: () => Record<string, TraceBox>;
  setBox: (id: string, box: TraceBox) => void;
};

export class TraceCanvas {
  private readonly deps: TraceCanvasDeps;

  view = $state<TraceView>({ scale: 1, x: 0, y: 0 });
  viewportEl = $state<HTMLElement | null>(null);
  /** The viewport's size as state, for what draws the view (the minimap); the camera reads the box. */
  viewportSize = $state<{ width: number; height: number }>({ width: 0, height: 0 });
  /** Which focus request has already moved the board. A reload of the same one does not. */
  placedFocus = $state<number | null>(null);
  /** Where that card was when we centred it, so a later measurement can follow it once. */
  anchored = $state<{ token: number; turn: string; x: number; y: number; width: number; height: number } | null>(
    null
  );
  // Read in the markup (the cursor, and whether a card is a target), so they are state.
  drag = $state<{ x: number; y: number; view: TraceView } | null>(null);
  pinch = $state<{ span: number; view: TraceView; at: { x: number; y: number } } | null>(null);
  dragged = $state(false);

  fitted: string | null = null;
  /** A pan or a zoom is the view being yours; a measurement must not pull it back. */
  userMoved = false;
  /** The view the board opened on, so the cards' measurements can move it while it still is. */
  openedView: (TraceView & { job: string }) | null = null;
  glideFrame: ReturnType<typeof setTimeout> | 0 = 0;
  /** Where the slide in progress is going, so an unmount keeps the end and not the halfway. */
  glideTarget: TraceView | null = null;
  glideThis = false;
  glideFromMemory = false;
  /** Live pointers, so two of them can be read as a pinch and one as a drag. */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** Every card on screen, so any of them can be re-read without waiting for a resize. */
  readonly slots = new Map<string, HTMLElement>();

  constructor(sessionId: string, taskId: string | null, deps: TraceCanvasDeps) {
    this.deps = deps;
    /**
     * The last place this job's board was left, for the frames before its job arrives. Putting it
     * back for real — with whether it was still the opening view — is `resume`, once it has.
     */
    this.view = keptBoard(sessionId, taskId)?.view ?? { scale: 1, x: 0, y: 0 };
    /**
     * This board was already open a moment ago, just not the tab in front, so the first move
     * slides. A layout restored tomorrow starts where it was without sliding across the window.
     */
    this.glideFromMemory = (keptBoardAge(sessionId, taskId) ?? Infinity) < 10_000;
    /** A request this conversation's board already moved for is spent, on this copy of it too. */
    this.placedFocus = placedFocusOf(sessionId);
  }

  viewportBox(): { width: number; height: number } {
    const box = this.viewportEl?.getBoundingClientRect();
    return { width: box?.width ?? 0, height: box?.height ?? 0 };
  }

  boardBox(): { width: number; height: number } {
    const flow = this.deps.flow();
    return { width: flow?.width ?? 0, height: flow?.height ?? 0 };
  }

  /** No fence: the board goes where it is dragged. `适应` is the way back. */
  settle(next: TraceView): void {
    this.view = next;
  }

  localPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const box = this.viewportEl?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }

  /** The bottom tools float over the canvas, so fitting aims at what is actually clear. */
  clearBox(): { width: number; height: number } {
    const bottomChrome = this.viewportEl?.parentElement?.querySelector(".trace-tools")?.clientHeight ?? 0;
    const box = this.viewportBox();
    return { width: box.width - 24, height: Math.max(120, box.height - bottomChrome - 24) };
  }

  /** A view worked out for the clear box, put where that box is: 12px in from the top and the sides. */
  private inClear(at: TraceView): TraceView {
    return { ...at, x: at.x + 12, y: at.y + 12 };
  }

  /** All of the board in view, from wherever a drag or a zoom left it. */
  fitBoard(): void {
    const flow = this.deps.flow();
    if (!flow?.width || !this.viewportEl) return;
    // Pressing it is choosing the view: neither the opening nor a message's card pulls it back now.
    this.userMoved = true;
    this.openedView = null;
    this.glideTo(this.inClear(fitView(this.boardBox(), this.clearBox())));
  }

  /** Whole when the whole board can be read; otherwise on its newest round, at the bottom. */
  openBoard(): void {
    this.stopGlide();
    const flow = this.deps.flow();
    const currentId = this.deps.currentId();
    if (!flow?.width || !this.viewportEl || !currentId) return;
    this.view = this.inClear(openView(flow, this.clearBox()));
    this.openedView = { ...this.view, job: currentId };
  }

  /**
   * Come back to a job's board where it was left, instead of opening it afresh. False when it has
   * not been left before. A board left on the view it opened on is still on it, so it goes on
   * following the layout; any other is yours, and stays put.
   */
  resume(board: KeptBoard | undefined, job: string): boolean {
    if (!board) return false;
    this.stopGlide();
    this.view = { ...board.view };
    this.openedView = board.opened ? { ...board.view, job } : null;
    this.userMoved = !board.opened;
    this.fitted = job;
    return true;
  }

  /** The camera as it is being left: where a slide in progress was going, not its halfway. */
  leaving(): { view: TraceView; opened: boolean } {
    return { view: { ...(this.glideTarget ?? this.view) }, opened: this.stillOpened() };
  }

  /**
   * Still on the view it opened on. The first paint lays the board out from estimated heights and
   * the measured ones land a frame later, taller or shorter, which moves the bottom it opened on.
   * Any pan, zoom, fit or slide is a different view, and from then on the view is yours.
   */
  stillOpened(): boolean {
    const at = this.openedView;
    return (
      !!at &&
      at.job === this.deps.currentId() &&
      at.x === this.view.x &&
      at.y === this.view.y &&
      at.scale === this.view.scale
    );
  }

  /**
   * Put the asked-for card in the middle, at a size a card can be read at.
   * False when the viewport has no size yet, or this job has no such card — the caller fits.
   */
  focusBoard(): boolean {
    const focus = this.deps.focus();
    const flow = this.deps.flow();
    if (!focus || !flow || !this.viewportEl) return false;
    const box = this.viewportBox();
    if (!box.width || !box.height) return false;
    const node = focusNode(flow.placements.map((placement) => placement.node), focus);
    const placement = node ? flow.placements.find((row) => row.node.turn_id === node.turn_id) : null;
    this.placedFocus = this.deps.focusToken();
    keepPlacedFocus(this.deps.sessionId(), this.placedFocus);
    if (!placement) return false;
    const next = centerOnNode(placement, box);
    // From here the view is the card's, not the one the board opened on. A slide only moves on its
    // first timer, and until then the board would still read as opened and be opened again.
    this.openedView = null;
    if (this.glideThis) this.glideTo(next);
    else this.view = next;
    this.anchored = {
      token: this.deps.focusToken(),
      turn: placement.node.turn_id,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height
    };
    return true;
  }

  /** The card moved after we centred it — the first measurement, usually. */
  focusDrifted(): boolean {
    const here = this.anchored;
    const flow = this.deps.flow();
    if (!here || here.token !== this.deps.focusToken() || !flow) return false;
    const placement = flow.placements.find((row) => row.node.turn_id === here.turn);
    if (!placement) return false;
    return (
      placement.x !== here.x ||
      placement.y !== here.y ||
      placement.width !== here.width ||
      placement.height !== here.height
    );
  }

  /**
   * The pure-camera half of "a new message's request starts from a view that is not yours yet":
   * reset to not-yours, and work out whether an already-open board should slide to the card or
   * land on it at once. The component calls this from the focus-token effect, which also has to
   * unfold the round the card is in — a fold-state change this class has no business making.
   */
  syncFocusToken(): void {
    this.userMoved = false;
    const currentId = this.deps.currentId();
    this.glideThis = this.glideFromMemory || (this.fitted === currentId && currentId !== null);
    this.glideFromMemory = false;
  }

  stopGlide(): void {
    if (!this.glideFrame) return;
    clearTimeout(this.glideFrame);
    this.glideFrame = 0;
    this.glideTarget = null;
  }

  /**
   * Slide the board that is already on screen. A fresh one has nothing to slide from.
   *
   * The clock is `setTimeout`, not an animation frame: the board lives in its own tab, and a
   * frame never fires while that tab is in the background, which would leave the slide halfway.
   */
  glideTo(next: TraceView): void {
    this.stopGlide();
    if (prefersReducedMotion()) {
      this.view = next;
      return;
    }
    const from = this.view;
    const started = performance.now();
    this.glideTarget = next;
    const step = () => {
      const t = (performance.now() - started) / TRACE_GLIDE_MS;
      if (t >= 1) {
        this.view = next;
        this.glideFrame = 0;
        this.glideTarget = null;
        return;
      }
      this.view = glideView(from, next, t);
      this.glideFrame = setTimeout(step, 16);
    };
    this.glideFrame = setTimeout(step, 16);
  }

  /**
   * The minimap's press and drag: this board point in the middle of the view, at the zoom it is at.
   * A press slides there; the drag that follows keeps it under the pointer.
   */
  centreOn(point: { x: number; y: number }, glide: boolean): void {
    // Moving it from the map is choosing the view, as a drag on the board is.
    this.userMoved = true;
    this.openedView = null;
    const next = viewCentredOn(this.view, this.viewportBox(), point);
    if (glide) {
      this.glideTo(next);
      return;
    }
    this.stopGlide();
    this.settle(next);
  }

  /** The zoom buttons zoom about the middle of the view. */
  zoomTo(scale: number): void {
    this.stopGlide();
    const box = this.viewportBox();
    this.settle(zoomAt(this.view, scale, { x: box.width / 2, y: box.height / 2 }));
  }

  onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.userMoved = true;
    this.stopGlide();
    // ⌘/Ctrl + wheel zooms at the pointer, and a trackpad pinch arrives as ctrl+wheel too.
    if (event.ctrlKey || event.metaKey) {
      const step = Math.exp(-event.deltaY / 400);
      this.settle(zoomAt(this.view, this.view.scale * step, this.localPoint(event)));
      return;
    }
    // Anything else pans. The rounds stack down the board as they happen, so reading a job is
    // going down it, and a wheel that zoomed instead turned that into dragging. A wheel that
    // counts in lines (Firefox) is turned into pixels; Shift on a plain wheel goes sideways.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewportBox().height : 1;
    const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
    const dy = (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit;
    this.settle({ ...this.view, x: this.view.x - dx, y: this.view.y - dy });
  };

  onPointerDown = (event: PointerEvent): void => {
    // Anywhere is the canvas, cards included: a press that turns into a drag pans, and a
    // press that does not is still the card's click. Reserving the cards would have left
    // most of a full board unpannable, which is the whole board once it is zoomed in.
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.dragged = false;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        span: pinchSpan([
          { clientX: a!.x, clientY: a!.y },
          { clientX: b!.x, clientY: b!.y }
        ]),
        view: this.view,
        at: this.localPoint({ clientX: (a!.x + b!.x) / 2, clientY: (a!.y + b!.y) / 2 })
      };
      this.drag = null;
      return;
    }
    // Capture is taken only once a drag has actually started. Capturing on the press moves the
    // click to the capturing element, which is how the file chips and the cards stopped
    // opening: the press reached them, the click landed on the canvas.
    this.drag = { x: event.clientX, y: event.clientY, view: this.view };
  };

  onPointerMove = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.preventDefault();
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const span = pinchSpan([
        { clientX: a!.x, clientY: a!.y },
        { clientX: b!.x, clientY: b!.y }
      ]);
      if (!span || !this.pinch.span) return;
      this.settle(zoomAt(this.pinch.view, this.pinch.view.scale * (span / this.pinch.span), this.pinch.at));
      this.dragged = true;
      this.userMoved = true;
      this.stopGlide();
      return;
    }
    if (!this.drag) return;
    const dx = event.clientX - this.drag.x;
    const dy = event.clientY - this.drag.y;
    if (!this.dragged && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
    if (!this.dragged) {
      this.dragged = true;
      this.userMoved = true;
      this.stopGlide();
      // Now it is a drag, so the pointer belongs to the canvas until it is let go.
      try {
        this.viewportEl?.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that has already gone is not worth failing the pan over.
      }
    }
    this.settle({ ...this.drag.view, x: this.drag.view.x + dx, y: this.drag.view.y + dy });
  };

  onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.drag = null;
    if (this.viewportEl?.hasPointerCapture?.(event.pointerId)) this.viewportEl.releasePointerCapture(event.pointerId);
  };

  /** A drag that ends on a card must not also open it. */
  swallowClickAfterDrag = (event: MouseEvent): void => {
    if (!this.dragged) return;
    event.stopPropagation();
    event.preventDefault();
    this.dragged = false;
  };

  /** A press with no drag behind it leaves nothing to swallow. */
  clearDragFlag = (): void => {
    this.dragged = false;
  };

  /** Wheel and pointer, bound by hand: Svelte's are passive, where `preventDefault` is ignored. */
  gestures = (node: HTMLElement) => {
    const options = { passive: false } as const;
    node.addEventListener("click", this.swallowClickAfterDrag, true);
    node.addEventListener("wheel", this.onWheel, options);
    node.addEventListener("pointerdown", this.onPointerDown, options);
    node.addEventListener("pointermove", this.onPointerMove, options);
    node.addEventListener("pointerup", this.onPointerUp);
    node.addEventListener("pointercancel", this.onPointerUp);
    node.addEventListener("pointerleave", this.onPointerUp);
    return {
      destroy: () => {
        node.removeEventListener("click", this.swallowClickAfterDrag, true);
        node.removeEventListener("wheel", this.onWheel);
        node.removeEventListener("pointerdown", this.onPointerDown);
        node.removeEventListener("pointermove", this.onPointerMove);
        node.removeEventListener("pointerup", this.onPointerUp);
        node.removeEventListener("pointercancel", this.onPointerUp);
        node.removeEventListener("pointerleave", this.onPointerUp);
      }
    };
  };

  /** A pane is often zero-sized for the first frame; the move waits until it has a box. */
  watchViewport = (node: HTMLElement) => {
    // Read off the node itself: the binding that sets `viewportEl` need not have run yet.
    const sizeOf = () => {
      const box = node.getBoundingClientRect();
      return { width: box.width, height: box.height };
    };
    this.viewportSize = sizeOf();
    if (typeof ResizeObserver === "undefined") return;
    // The size lands a frame later: a state write inside the callback, while the shell's columns
    // are still animating, has WebKit report a ResizeObserver loop on every frame of it.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (this.deps.focus() && focusMoveDue(this.deps.focusToken(), this.placedFocus)) this.focusBoard();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = sizeOf();
        if (box.width !== this.viewportSize.width || box.height !== this.viewportSize.height) this.viewportSize = box;
      });
    });
    observer.observe(node);
    return {
      destroy: () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      }
    };
  };

  /** Measure a card and keep the layout honest about it. */
  recordBox(id: string, element: HTMLElement): void {
    const width = Math.round(element.offsetWidth);
    const height = Math.round(element.offsetHeight);
    const known = this.deps.boxes()[id];
    // Only on a real change: writing the same box back would re-run the layout forever.
    if (!width || !height || (known && known.width === width && known.height === height)) return;
    this.deps.setBox(id, { width, height });
  }

  measured = (element: HTMLElement, id: string) => {
    this.slots.set(id, element);
    // A pane resize used to write every card's box on each frame and lay the board out again.
    const deferred = deferWhileDragging(() => this.recordBox(id, element));
    deferred.run();
    if (typeof ResizeObserver === "undefined") {
      return {
        destroy: () => {
          deferred.cancel();
          this.slots.delete(id);
        }
      };
    }
    const observer = new ResizeObserver(deferred.run);
    observer.observe(element);
    return {
      destroy: () => {
        observer.disconnect();
        deferred.cancel();
        this.slots.delete(id);
      }
    };
  };
}
