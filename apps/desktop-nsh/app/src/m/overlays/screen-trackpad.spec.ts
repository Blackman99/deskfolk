import { afterEach, expect, test } from "bun:test";
import { TRACKPAD, TrackpadGestures, loadTrackpadMode, pointerGain, saveTrackpadMode, type Clock, type Finger, type TrackpadAction } from "./screen-trackpad.ts";

/** A clock the test winds by hand, timers and all. */
function fakeClock() {
  let now = 0;
  let timers: Array<{ at: number; run: () => void }> = [];
  const clock: Clock = {
    now: () => now,
    after: (ms, run) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => { timers = timers.filter((t) => t !== timer); };
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers = timers.filter((t) => t !== timer);
      timer.run();
    }
  };
  return { clock, advance };
}

function pad() {
  const { clock, advance } = fakeClock();
  const actions: TrackpadAction[] = [];
  const gestures = new TrackpadGestures((action) => actions.push(action), clock);
  /** One touch event: every finger on the glass afterwards, `ms` after the last one. */
  const touch = (fingers: Array<[number, number, number]>, ms = 16) => {
    advance(ms);
    gestures.update(fingers.map(([id, x, y]): Finger => ({ id, x, y })));
  };
  const kinds = () => actions.map((action) => (action.kind === "click" ? `click ${action.button}` : action.kind === "wheel" ? `wheel ${action.direction}` : action.kind));
  return { gestures, actions, touch, advance, kinds };
}

const travel = (actions: TrackpadAction[]) =>
  actions.reduce((sum, action) => (action.kind === "move" ? { x: sum.x + action.dx, y: sum.y + action.dy } : sum), { x: 0, y: 0 });

test("a tap clicks, and a finger that wanders less than the slop is still a tap", () => {
  const { touch, kinds } = pad();
  touch([[1, 100, 100]]);
  touch([[1, 104, 103]]);
  touch([]);
  expect(kinds()).toEqual(["click left"]);
});

test("a slide moves the pointer by all of its travel, slop included, and clicks nothing", () => {
  const { touch, actions, kinds } = pad();
  touch([[1, 100, 100]]);
  touch([[1, 105, 100]]);
  touch([[1, 120, 110]]);
  touch([[1, 160, 130]]);
  touch([]);
  expect(kinds()).toEqual(["move", "move"]);
  expect(travel(actions)).toEqual({ x: 60, y: 30 });
  expect(actions.every((action) => action.kind !== "move" || action.speed > 0)).toBe(true);
});

test("held still, one finger presses the button, drags with it down and lets go on lifting", () => {
  const { touch, advance, actions, kinds } = pad();
  touch([[1, 100, 100]]);
  advance(TRACKPAD.holdMs);
  expect(kinds()).toEqual(["press"]);
  // A tremor while holding is not yet a drag.
  touch([[1, 103, 102]]);
  expect(kinds()).toEqual(["press"]);
  touch([[1, 140, 100]]);
  // A second finger landing mid-drag changes nothing.
  touch([[1, 160, 100], [2, 300, 300]]);
  touch([[2, 300, 300]]);
  touch([]);
  expect(kinds()).toEqual(["press", "move", "move", "release"]);
  expect(travel(actions)).toEqual({ x: 60, y: 0 });
});

test("a hold let go without moving is a click, a slow one", () => {
  const { touch, advance, kinds } = pad();
  touch([[1, 50, 50]]);
  advance(TRACKPAD.holdMs + 200);
  touch([]);
  expect(kinds()).toEqual(["press", "release"]);
});

test("a slide that started never turns into a hold", () => {
  const { touch, advance, kinds } = pad();
  touch([[1, 50, 50]]);
  touch([[1, 80, 50]]);
  advance(TRACKPAD.holdMs * 2);
  touch([]);
  expect(kinds()).toEqual(["move"]);
});

test("two fingers tapped are a right click, however unevenly they lift", () => {
  const { touch, kinds } = pad();
  touch([[1, 100, 100], [2, 160, 100]]);
  touch([[2, 161, 101]], 60);
  touch([], 40);
  expect(kinds()).toEqual(["click right"]);
});

test("two fingers that rest too long, or a second finger after a first, click nothing", () => {
  const slow = pad();
  slow.touch([[1, 100, 100], [2, 160, 100]]);
  slow.touch([], TRACKPAD.twoTapMs + 50);
  expect(slow.kinds()).toEqual([]);

  // The second finger lands a little after the first, as it usually does: still a right click.
  const staggered = pad();
  staggered.touch([[1, 100, 100]]);
  staggered.touch([[1, 100, 100], [2, 160, 100]], 30);
  staggered.touch([], 80);
  expect(staggered.kinds()).toEqual(["click right"]);
});

test("two fingers sliding down turn the wheel up, a step per stretch of travel", () => {
  const { touch, kinds } = pad();
  touch([[1, 100, 100], [2, 160, 100]]);
  touch([[1, 100, 110], [2, 160, 110]]);
  // Past the slop: travel counts from where the fingers landed.
  touch([[1, 100, 140], [2, 160, 140]]);
  touch([[1, 100, 175], [2, 160, 175]]);
  expect(kinds()).toEqual(["wheel up", "wheel up"]);
  touch([[1, 100, 100], [2, 160, 100]]);
  touch([[1, 40, 100], [2, 100, 100]]);
  touch([]);
  // Back up 75 on top of the 15 left over is two steps down; then left 60, two steps.
  expect(kinds()).toEqual(["wheel up", "wheel up", "wheel down", "wheel down", "wheel right", "wheel right"]);
});

test("fingers spreading apart pinch, measured from where they started, and never scroll", () => {
  const { touch, actions } = pad();
  touch([[1, 100, 100], [2, 200, 100]]);
  touch([[1, 80, 100], [2, 220, 100]]);
  touch([[1, 50, 100], [2, 250, 100]]);
  touch([]);
  expect(actions).toEqual([
    { kind: "pinch", anchor: { x: 150, y: 100 }, scale: 1.4, start: true },
    { kind: "pinch", anchor: { x: 150, y: 100 }, scale: 2, start: false },
  ]);
});

test("three fingers are left alone until all of them are up", () => {
  const { touch, kinds } = pad();
  touch([[1, 100, 100], [2, 150, 100]]);
  touch([[1, 100, 100], [2, 150, 100], [3, 200, 100]]);
  touch([[1, 100, 200], [2, 150, 200]]);
  touch([[1, 100, 260]]);
  touch([]);
  touch([[4, 10, 10]]);
  touch([]);
  expect(kinds()).toEqual(["click left"]);
});

test("touches the browser takes back click nothing, and let go of a held button", () => {
  const { gestures, touch, advance, kinds } = pad();
  touch([[1, 10, 10]]);
  gestures.cancel();
  touch([]);
  expect(kinds()).toEqual([]);
  touch([[1, 10, 10]]);
  advance(TRACKPAD.holdMs);
  gestures.cancel();
  expect(kinds()).toEqual(["press", "release"]);
  // Reset says nothing at all.
  touch([[1, 10, 10]]);
  advance(TRACKPAD.holdMs);
  gestures.reset();
  touch([]);
  expect(kinds()).toEqual(["press", "release", "press"]);
});

test("a careful finger moves the pointer less than itself, a quick one more", () => {
  expect(pointerGain(0)).toBe(0.6);
  expect(pointerGain(0.35)).toBeCloseTo(1, 6);
  expect(pointerGain(5)).toBe(2.5);
  let last = 0;
  for (let speed = 0; speed < 2; speed += 0.05) {
    expect(pointerGain(speed)).toBeGreaterThanOrEqual(last);
    last = pointerGain(speed);
  }
});

afterEach(() => saveTrackpadMode(false));

test("the mode is kept on this phone", () => {
  expect(loadTrackpadMode()).toBe(false);
  saveTrackpadMode(true);
  expect(loadTrackpadMode()).toBe(true);
  saveTrackpadMode(false);
  expect(loadTrackpadMode()).toBe(false);
});
