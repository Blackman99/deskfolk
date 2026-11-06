/**
 * Touches on the picture itself (trackpad mode off), as noVNC's gesture handler read them for the
 * messenger: a tap is a left click where the finger landed, two fingers tapping a right click, three
 * a middle click; one finger sliding drags with the left button; one held still for a second
 * presses the right button until it lifts. Two fingers sliding scroll the Mac (or, zoomed in, move the
 * view on the phone) and a pinch zooms the picture on the phone, never the Mac.
 *
 * Positions are the stage's own coordinates; the view turns them into the Mac's pixels.
 */
import { realClock, type Clock, type Finger, type Point } from "../../m/overlays/screen-trackpad.ts";

export type TouchAction =
  | { kind: "click"; at: Point; button: "left" | "right" | "middle" }
  /** A button goes down for a drag (left) or a hold (right), and comes up with `release`. */
  | { kind: "press"; at: Point; button: "left" | "right" }
  | { kind: "move"; at: Point }
  | { kind: "release"; at: Point; button: "left" | "right" }
  /** One wheel step at `at`, named for the wheel. */
  | { kind: "wheel"; at: Point; direction: "up" | "down" }
  /** Zoom on the phone: `scale` is from where the pinch began, `anchor` the midpoint there. */
  | { kind: "pinch"; anchor: Point; scale: number; start: boolean }
  /** Two fingers moving the zoomed view: how far since they went down. */
  | { kind: "pan"; moved: Point; start: boolean };

export const TOUCH = {
  /** How far a finger may wander and still be a tap or a hold. */
  slop: 10,
  /** Held still this long, one finger presses the right button. */
  holdMs: 1000,
  /** Fingers on and off within this, without moving, are a tap. */
  tapMs: 1000,
  /** How much the gap between two fingers changes before it is a pinch. */
  pinchSlop: 24,
  /** How far two fingers' midpoint moves before it is a scroll or a pan. */
  scrollSlop: 12,
  /** Finger travel per wheel step: noVNC's GESTURE_SCRLSENS. */
  wheelStep: 50,
} as const;

type One = { name: "one"; id: number; start: Point; last: Point; moved: boolean; held: boolean };
type Many = {
  name: "many";
  ids: number[];
  startTime: number;
  startCenter: Point;
  startGap: number;
  lastCenter: Point;
  travel: Point;
  carried: number;
  mode: "pending" | "scroll" | "pan" | "pinch";
};
type State = { name: "idle" } | One | Many | { name: "lifting" } | { name: "done" };

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const center = (fingers: readonly Finger[]): Point => ({
  x: fingers.reduce((sum, f) => sum + f.x, 0) / fingers.length,
  y: fingers.reduce((sum, f) => sum + f.y, 0) / fingers.length,
});

export class DirectTouch {
  #state: State = { name: "idle" };
  #cancelHold: (() => void) | null = null;

  constructor(
    private readonly emit: (action: TouchAction) => void,
    /** Whether two fingers sliding move the view (zoomed in) rather than scroll the Mac. */
    private readonly zoomed: () => boolean,
    private readonly clock: Clock = realClock,
  ) {}

  /** Every finger on the glass now, after a touch started, moved or ended. */
  update(fingers: readonly Finger[]): void {
    const state = this.#state;
    switch (state.name) {
      case "idle":
        this.#begin(fingers);
        return;
      case "one": {
        const finger = fingers.find((f) => f.id === state.id);
        if (!finger) {
          this.#clearHold();
          const at = state.last;
          if (state.held) this.emit({ kind: "release", at, button: "right" });
          else if (state.moved) this.emit({ kind: "release", at, button: "left" });
          else this.emit({ kind: "click", at: state.start, button: "left" });
          this.#state = fingers.length ? { name: "done" } : { name: "idle" };
          return;
        }
        // A second finger before anything started makes it a two-finger gesture.
        if (fingers.length > 1 && !state.moved && !state.held) {
          this.#clearHold();
          this.#begin(fingers);
          return;
        }
        const at = { x: finger.x, y: finger.y };
        if (!state.moved && !state.held && distance(at, state.start) > TOUCH.slop) {
          this.#clearHold();
          state.moved = true;
          this.emit({ kind: "press", at: state.start, button: "left" });
        }
        if (state.moved || state.held) {
          state.last = at;
          this.emit({ kind: "move", at });
        }
        return;
      }
      case "many":
        this.#many(state, fingers);
        return;
      case "lifting":
      case "done":
        if (fingers.length === 0) this.#state = { name: "idle" };
        return;
    }
  }

  /** The system took the touches back: nothing clicks, and a button held lets go. */
  cancel(): void {
    const state = this.#state;
    this.reset();
    if (state.name === "one" && (state.moved || state.held)) {
      this.emit({ kind: "release", at: state.last, button: state.held ? "right" : "left" });
    }
  }

  /** Forgets any gesture under way without a word. */
  reset(): void {
    this.#clearHold();
    this.#state = { name: "idle" };
  }

  #begin(fingers: readonly Finger[]): void {
    if (fingers.length === 1) {
      const finger = fingers[0]!;
      const start = { x: finger.x, y: finger.y };
      this.#state = { name: "one", id: finger.id, start, last: start, moved: false, held: false };
      this.#cancelHold = this.clock.after(TOUCH.holdMs, () => {
        this.#cancelHold = null;
        const state = this.#state;
        if (state.name !== "one" || state.moved || state.held) return;
        state.held = true;
        this.emit({ kind: "press", at: state.start, button: "right" });
      });
    } else if (fingers.length >= 2) {
      const first = fingers.slice(0, 3);
      const middle = center(first);
      this.#state = {
        name: "many",
        ids: first.map((f) => f.id),
        startTime: this.clock.now(),
        startCenter: middle,
        startGap: first.length === 2 ? distance(first[0]!, first[1]!) : 0,
        lastCenter: middle,
        travel: { x: 0, y: 0 },
        carried: 0,
        mode: "pending",
      };
    }
  }

  #many(state: Many, fingers: readonly Finger[]): void {
    const mine = state.ids.map((id) => fingers.find((f) => f.id === id));
    if (fingers.length > state.ids.length) {
      this.#state = { name: "done" };
      return;
    }
    if (mine.some((f) => !f)) {
      // A finger lifted: two or three fingers tapping are a click, anything longer was a gesture.
      const quick = this.clock.now() - state.startTime <= TOUCH.tapMs;
      if (state.mode === "pending" && quick) {
        const button = state.ids.length >= 3 ? "middle" : "right";
        this.emit({ kind: "click", at: state.startCenter, button });
      }
      this.#state = fingers.length ? { name: "lifting" } : { name: "idle" };
      return;
    }
    if (state.ids.length !== 2) return;
    const [a, b] = mine as [Finger, Finger];
    const middle = center([a, b]);
    state.travel = { x: middle.x - state.startCenter.x, y: middle.y - state.startCenter.y };
    if (state.mode === "pending") {
      if (Math.abs(distance(a, b) - state.startGap) > TOUCH.pinchSlop) {
        state.mode = "pinch";
        this.emit({ kind: "pinch", anchor: state.startCenter, scale: 1, start: true });
      } else if (Math.hypot(state.travel.x, state.travel.y) > TOUCH.scrollSlop) {
        state.mode = this.zoomed() ? "pan" : "scroll";
        if (state.mode === "pan") this.emit({ kind: "pan", moved: { x: 0, y: 0 }, start: true });
      }
    }
    if (state.mode === "pinch") {
      this.emit({ kind: "pinch", anchor: state.startCenter, scale: distance(a, b) / (state.startGap || 1), start: false });
    } else if (state.mode === "pan") {
      this.emit({ kind: "pan", moved: state.travel, start: false });
    } else if (state.mode === "scroll") {
      // Fingers moving down turn the wheel up, as a page follows them.
      state.carried += middle.y - state.lastCenter.y;
      while (Math.abs(state.carried) >= TOUCH.wheelStep) {
        this.emit({ kind: "wheel", at: state.startCenter, direction: state.carried > 0 ? "up" : "down" });
        state.carried -= Math.sign(state.carried) * TOUCH.wheelStep;
      }
    }
    state.lastCenter = middle;
  }

  #clearHold(): void {
    this.#cancelHold?.();
    this.#cancelHold = null;
  }
}
