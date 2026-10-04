import { loadScreenFlag, saveScreenFlag } from "./screen-prefs.ts";

/**
 * Trackpad mode on the Mac's screen: the phone's glass is a trackpad instead of the screen. A
 * finger moves the pointer by how far it travels, not to where it lands, so a small target on a
 * big screen is reachable without zooming in, and a tap clicks wherever the pointer already is.
 *
 * One finger: slide to move the pointer, tap to click, hold still for a moment and then slide to
 * drag with the button down. Two fingers: tap for a right click, slide to scroll, pinch to zoom
 * the picture on the phone. A third finger is ignored until every finger is up.
 *
 * noVNC's own gesture reader is no use here: it waits for 50 px of travel before a slide counts,
 * and anything shorter is a tap, which on a trackpad would click instead of nudging the pointer.
 */

export type Point = { x: number; y: number };
/** A finger on the glass, in the stage's own coordinates. */
export type Finger = { id: number; x: number; y: number };

export type TrackpadAction =
  /** Finger travel since the last move, in CSS pixels, and how fast it went (px/ms). */
  | { kind: "move"; dx: number; dy: number; speed: number }
  | { kind: "click"; button: "left" | "right" }
  /** The left button goes down for a drag, and comes up when the finger lifts. */
  | { kind: "press" }
  | { kind: "release" }
  /** One wheel step, named for the wheel: fingers moving down turn it up, as a page follows them. */
  | { kind: "wheel"; direction: "up" | "down" | "left" | "right" }
  /** Zoom on the phone: `scale` is from where the pinch started, `anchor` where it started. */
  | { kind: "pinch"; anchor: Point; scale: number; start: boolean };

export const TRACKPAD = {
  /** How far a finger may wander and still be a tap, or a hold. */
  slop: 8,
  /** Held this long without moving, one finger presses the button for a drag. */
  holdMs: 450,
  /** Two fingers on and off within this, without moving, are a right click. */
  twoTapMs: 300,
  /** How far the two fingers' midpoint moves before it is a scroll. */
  scrollSlop: 12,
  /** How much the gap between two fingers changes before it is a pinch. */
  pinchSlop: 24,
  /** Finger travel per wheel step. */
  wheelStep: 30,
} as const;

export type Clock = { now(): number; after(ms: number, run: () => void): () => void };

export const realClock: Clock = {
  now: () => performance.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

type One = { name: "one"; id: number; start: Point; last: Point; lastTime: number; speed: number; moving: boolean; held: boolean };
type Two = {
  name: "two";
  a: number;
  b: number;
  startTime: number;
  startCenter: Point;
  startGap: number;
  lastCenter: Point;
  travel: Point;
  mode: "pending" | "scroll" | "pinch";
};
type State = { name: "idle" } | One | Two | { name: "lifting"; startTime: number; tap: boolean } | { name: "done" };

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Touches in, trackpad actions out. Fed every finger on the glass after each touch event. */
export class TrackpadGestures {
  #state: State = { name: "idle" };
  #cancelHold: (() => void) | null = null;

  constructor(
    private readonly emit: (action: TrackpadAction) => void,
    private readonly clock: Clock = realClock,
  ) {}

  /** Every finger on the glass now, after a touchstart, touchmove or touchend. */
  update(fingers: readonly Finger[]): void {
    const now = this.clock.now();
    const state = this.#state;
    switch (state.name) {
      case "idle":
        this.#begin(fingers, now);
        return;
      case "one": {
        const finger = fingers.find((f) => f.id === state.id);
        if (!finger) {
          this.#clearHold();
          if (state.held) this.emit({ kind: "release" });
          else if (!state.moving) this.emit({ kind: "click", button: "left" });
          this.#state = fingers.length ? { name: "done" } : { name: "idle" };
          return;
        }
        // A second finger turns a slide into a two-finger gesture; a drag under way keeps going.
        if (fingers.length > 1 && !state.held) {
          this.#clearHold();
          this.#begin(fingers, now);
          return;
        }
        this.#moveOne(state, finger, now);
        return;
      }
      case "two": {
        const a = fingers.find((f) => f.id === state.a);
        const b = fingers.find((f) => f.id === state.b);
        if (fingers.length > 2) {
          this.#state = { name: "done" };
          return;
        }
        if (!a || !b) {
          const tap = state.mode === "pending" && now - state.startTime <= TRACKPAD.twoTapMs;
          if (fingers.length) {
            this.#state = { name: "lifting", startTime: state.startTime, tap };
            return;
          }
          if (tap) this.emit({ kind: "click", button: "right" });
          this.#state = { name: "idle" };
          return;
        }
        this.#moveTwo(state, a, b);
        return;
      }
      case "lifting":
        if (fingers.length === 0) {
          if (state.tap && now - state.startTime <= TRACKPAD.twoTapMs) this.emit({ kind: "click", button: "right" });
          this.#state = { name: "idle" };
        } else if (fingers.length > 1) {
          this.#state = { name: "done" };
        }
        return;
      case "done":
        if (fingers.length === 0) this.#state = { name: "idle" };
        return;
    }
  }

  /** The browser took the touches back: nothing clicks, and a button held for a drag lets go. */
  cancel(): void {
    const held = this.#state.name === "one" && this.#state.held;
    this.reset();
    if (held) this.emit({ kind: "release" });
  }

  /** Forgets any gesture under way without a word, for a connection that is gone. */
  reset(): void {
    this.#clearHold();
    this.#state = { name: "idle" };
  }

  #begin(fingers: readonly Finger[], now: number): void {
    if (fingers.length === 1) {
      const finger = fingers[0]!;
      const start = { x: finger.x, y: finger.y };
      this.#state = { name: "one", id: finger.id, start, last: start, lastTime: now, speed: 0, moving: false, held: false };
      this.#cancelHold = this.clock.after(TRACKPAD.holdMs, () => {
        this.#cancelHold = null;
        const state = this.#state;
        if (state.name !== "one" || state.moving || state.held) return;
        state.held = true;
        this.emit({ kind: "press" });
      });
    } else if (fingers.length === 2) {
      const [a, b] = fingers as [Finger, Finger];
      const center = midpoint(a, b);
      this.#state = {
        name: "two",
        a: a.id,
        b: b.id,
        startTime: now,
        startCenter: center,
        startGap: distance(a, b) || 1,
        lastCenter: center,
        travel: { x: 0, y: 0 },
        mode: "pending",
      };
    } else if (fingers.length > 2) {
      this.#state = { name: "done" };
    }
  }

  #moveOne(state: One, finger: Finger, now: number): void {
    // Short of the slop the finger is still a tap or a hold; past it, the travel counts from where it landed.
    if (!state.moving) {
      if (distance(finger, state.start) <= TRACKPAD.slop) return;
      state.moving = true;
      if (!state.held) this.#clearHold();
    }
    const dx = finger.x - state.last.x;
    const dy = finger.y - state.last.y;
    if (!dx && !dy) return;
    const elapsed = Math.max(1, now - state.lastTime);
    // Touch events come in uneven bursts: smoothed, one quick pair does not fling the pointer.
    state.speed = state.speed ? state.speed * 0.5 + (Math.hypot(dx, dy) / elapsed) * 0.5 : Math.hypot(dx, dy) / elapsed;
    state.last = { x: finger.x, y: finger.y };
    state.lastTime = now;
    this.emit({ kind: "move", dx, dy, speed: state.speed });
  }

  #moveTwo(state: Two, a: Finger, b: Finger): void {
    const center = midpoint(a, b);
    const gap = distance(a, b);
    if (state.mode === "pending") {
      if (Math.abs(gap - state.startGap) > TRACKPAD.pinchSlop) {
        state.mode = "pinch";
        this.emit({ kind: "pinch", anchor: state.startCenter, scale: gap / state.startGap, start: true });
        return;
      }
      if (distance(center, state.startCenter) <= TRACKPAD.scrollSlop) return;
      state.mode = "scroll";
    }
    if (state.mode === "pinch") {
      this.emit({ kind: "pinch", anchor: state.startCenter, scale: gap / state.startGap, start: false });
      return;
    }
    state.travel.x += center.x - state.lastCenter.x;
    state.travel.y += center.y - state.lastCenter.y;
    state.lastCenter = center;
    const step = TRACKPAD.wheelStep;
    for (; state.travel.y >= step; state.travel.y -= step) this.emit({ kind: "wheel", direction: "up" });
    for (; state.travel.y <= -step; state.travel.y += step) this.emit({ kind: "wheel", direction: "down" });
    for (; state.travel.x >= step; state.travel.x -= step) this.emit({ kind: "wheel", direction: "left" });
    for (; state.travel.x <= -step; state.travel.x += step) this.emit({ kind: "wheel", direction: "right" });
  }

  #clearHold(): void {
    this.#cancelHold?.();
    this.#cancelHold = null;
  }
}

/**
 * How far the pointer goes for a finger's travel, by how fast the finger moves (px/ms): a slow
 * finger is careful and moves the pointer less than itself across the picture, a quick one
 * crosses the screen. 1 is the pointer keeping pace with the finger over the picture.
 */
export function pointerGain(speed: number): number {
  const curve: ReadonlyArray<readonly [number, number]> = [[0.1, 0.6], [0.35, 1], [1.4, 2.5]];
  if (speed <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i]!;
    const [x0, y0] = curve[i - 1]!;
    if (speed <= x1) return y0 + ((speed - x0) / (x1 - x0)) * (y1 - y0);
  }
  return curve[curve.length - 1]![1];
}

/** Whether this phone last used trackpad mode on the Mac's screen. */
export function loadTrackpadMode(): boolean {
  return loadScreenFlag("trackpad");
}

export function saveTrackpadMode(on: boolean): void {
  saveScreenFlag("trackpad", on);
}
