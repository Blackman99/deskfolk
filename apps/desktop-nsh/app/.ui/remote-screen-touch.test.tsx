/** The direct-touch reader of the remote screen page: taps, slides, holds, two fingers, a pinch. */
import { expect, test } from "nsh/test";
import { DirectTouch, type TouchAction } from "../src/ui/overlays/remote-screen-touch.ts";
import type { Clock, Finger } from "../src/m/overlays/screen-trackpad.ts";

function rig(zoomed = false) {
  let now = 0;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const clock: Clock = {
    now: () => now,
    after: (ms, run) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  const actions: TouchAction[] = [];
  const touch = new DirectTouch((a) => actions.push(a), () => zoomed, clock);
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (timer.live && timer.at <= now) {
        timer.live = false;
        timer.run();
      }
    }
  };
  return { touch, actions, advance };
}

const finger = (id: number, x: number, y: number): Finger => ({ id, x, y });

test("a tap is a left click where the finger landed", () => {
  const { touch, actions, advance } = rig();
  touch.update([finger(1, 40, 60)]);
  advance(100);
  touch.update([]);
  expect(actions).toEqual([{ kind: "click", at: { x: 40, y: 60 }, button: "left" }]);
});

test("a slide presses at the start, follows the finger and lets go where it lifts", () => {
  const { touch, actions } = rig();
  touch.update([finger(1, 10, 10)]);
  touch.update([finger(1, 40, 10)]);
  touch.update([finger(1, 80, 10)]);
  touch.update([]);
  expect(actions).toEqual([
    { kind: "press", at: { x: 10, y: 10 }, button: "left" },
    { kind: "move", at: { x: 40, y: 10 } },
    { kind: "move", at: { x: 80, y: 10 } },
    { kind: "release", at: { x: 80, y: 10 }, button: "left" },
  ]);
});

test("a finger held still presses the right button until it lifts", () => {
  const { touch, actions, advance } = rig();
  touch.update([finger(1, 5, 5)]);
  advance(1100);
  touch.update([]);
  expect(actions).toEqual([
    { kind: "press", at: { x: 5, y: 5 }, button: "right" },
    { kind: "release", at: { x: 5, y: 5 }, button: "right" },
  ]);
});

test("two fingers tapping are a right click, three a middle click", () => {
  const two = rig();
  two.touch.update([finger(1, 10, 10), finger(2, 30, 10)]);
  two.advance(100);
  two.touch.update([finger(2, 30, 10)]);
  two.touch.update([]);
  expect(two.actions).toEqual([{ kind: "click", at: { x: 20, y: 10 }, button: "right" }]);
  const three = rig();
  three.touch.update([finger(1, 0, 0), finger(2, 30, 0), finger(3, 60, 0)]);
  three.advance(100);
  three.touch.update([finger(2, 30, 0), finger(3, 60, 0)]);
  three.touch.update([]);
  expect(three.actions).toEqual([{ kind: "click", at: { x: 30, y: 0 }, button: "middle" }]);
});

test("two fingers sliding turn the Mac's wheel, a step per 50 points, the way a page follows them", () => {
  const { touch, actions } = rig();
  touch.update([finger(1, 10, 100), finger(2, 30, 100)]);
  touch.update([finger(1, 10, 160), finger(2, 30, 160)]);
  touch.update([finger(1, 10, 210), finger(2, 30, 210)]);
  const wheels = actions.filter((a) => a.kind === "wheel");
  expect(wheels).toHaveLength(2);
  expect(wheels.every((w) => w.kind === "wheel" && w.direction === "up")).toBe(true);
});

test("zoomed in, two fingers sliding move the view instead", () => {
  const { touch, actions } = rig(true);
  touch.update([finger(1, 10, 100), finger(2, 30, 100)]);
  touch.update([finger(1, 40, 100), finger(2, 60, 100)]);
  expect(actions.some((a) => a.kind === "wheel")).toBe(false);
  expect(actions.at(-1)).toEqual({ kind: "pan", moved: { x: 30, y: 0 }, start: false });
});

test("a pinch is the phone's: it scales from where it began and clicks nothing", () => {
  const { touch, actions } = rig();
  touch.update([finger(1, 100, 100), finger(2, 140, 100)]);
  touch.update([finger(1, 80, 100), finger(2, 160, 100)]);
  touch.update([finger(1, 80, 100)]);
  touch.update([]);
  expect(actions[0]).toEqual({ kind: "pinch", anchor: { x: 120, y: 100 }, scale: 1, start: true });
  expect(actions[1]).toEqual({ kind: "pinch", anchor: { x: 120, y: 100 }, scale: 2, start: false });
  expect(actions.some((a) => a.kind === "click")).toBe(false);
});

test("a cancelled slide lets the button go", () => {
  const { touch, actions } = rig();
  touch.update([finger(1, 10, 10)]);
  touch.update([finger(1, 60, 10)]);
  touch.cancel();
  expect(actions.at(-1)).toEqual({ kind: "release", at: { x: 60, y: 10 }, button: "left" });
});
