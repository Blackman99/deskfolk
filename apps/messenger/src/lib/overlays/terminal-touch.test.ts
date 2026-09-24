import { expect, test } from "bun:test";
import { swipeAsWheel } from "./terminal-touch.ts";

/** 20 rows of 16px, as xterm lays them out; happy-dom has no layout to measure. */
function fakeTerm(mode: { mouse?: string; buffer?: string } = {}) {
  const host = document.createElement("div");
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  screen.getBoundingClientRect = () => ({ height: 320 }) as DOMRect;
  element.append(screen);
  host.append(element);
  document.body.append(host);
  const term = {
    element,
    rows: 20,
    modes: { mouseTrackingMode: mode.mouse ?? "none" },
    buffer: { active: { type: mode.buffer ?? "normal" } },
  };
  // happy-dom's WheelEvent is no MouseEvent and drops where it happened; a browser keeps it.
  const wheels: Array<{ deltaY: number; deltaMode: number }> = [];
  element.addEventListener("wheel", (event) => wheels.push({ deltaY: event.deltaY, deltaMode: event.deltaMode }));
  const stop = swipeAsWheel(host, term);
  return { host, screen, term, wheels, stop };
}

/** A finger's path over the screen, one point per touchmove. What each move's default was. */
function swipe(target: Element, points: Array<[number, number]>, fingers = 1): boolean[] {
  const at = ([x, y]: [number, number]) =>
    Array.from({ length: fingers }, (_, i) => new Touch({ identifier: i, target, clientX: x + i * 40, clientY: y }));
  const send = (type: string, touches: Touch[]) => {
    const event = new TouchEvent(type, { touches, changedTouches: touches, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  send("touchstart", at(points[0]!));
  const prevented = points.slice(1).map((point) => send("touchmove", at(point)));
  send("touchend", []);
  return prevented;
}

test("for a program holding the mouse, a finger moving down is the wheel going up, a row at a time", () => {
  // Claude Code, a full-screen TUI: its transcript is its own, and the wheel is how it is scrolled.
  const { screen, wheels } = fakeTerm({ mouse: "any", buffer: "alternate" });
  const prevented = swipe(screen, [[100, 50], [100, 106]]);
  // 56px over 16px rows is three and a half: three steps now.
  const step = { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_LINE };
  expect(wheels).toEqual([step, step, step]);
  // Held by the terminal, so the page under it does not bounce instead.
  expect(prevented).toEqual([true]);
});

test("a finger moving up is the wheel going down, and a slow drag adds up across moves", () => {
  const { screen, wheels } = fakeTerm({ mouse: "vt200" });
  // Six moves of 6px each: none is a row on its own, together they are two and a quarter.
  swipe(screen, [[80, 200], [80, 194], [80, 188], [80, 182], [80, 176], [80, 170], [80, 164]]);
  expect(wheels.map((wheel) => wheel.deltaY)).toEqual([1, 1]);
});

test("turning back mid-swipe goes back the other way", () => {
  const { screen, wheels } = fakeTerm({ buffer: "alternate" });
  swipe(screen, [[80, 100], [80, 132], [80, 100]]);
  expect(wheels.map((wheel) => wheel.deltaY)).toEqual([-1, -1, 1, 1]);
});

test("on the alternate screen without the mouse, the swipe still goes to xterm's wheel", () => {
  // less and vim: xterm turns a wheel there into arrow keys, and history into the program's.
  const { screen, wheels } = fakeTerm({ buffer: "alternate" });
  swipe(screen, [[80, 100], [80, 148]]);
  expect(wheels).toHaveLength(3);
});

test("a plain shell's swipe is xterm's own, which scrolls its scrollback", () => {
  const { screen, wheels } = fakeTerm();
  const prevented = swipe(screen, [[80, 100], [80, 200], [80, 300]]);
  expect(wheels).toEqual([]);
  expect(prevented).toEqual([false, false]);
});

test("a program that takes the mouse mid-swipe gets only what moves after that", () => {
  const { screen, term, wheels } = fakeTerm();
  const touch = (type: string, y: number) =>
    screen.dispatchEvent(
      new TouchEvent(type, {
        touches: [new Touch({ identifier: 0, target: screen, clientX: 80, clientY: y })],
        bubbles: true,
        cancelable: true,
      }),
    );
  touch("touchstart", 100);
  touch("touchmove", 180);
  term.modes.mouseTrackingMode = "any";
  touch("touchmove", 212);
  expect(wheels.map((wheel) => wheel.deltaY)).toEqual([-1, -1]);
});

test("two fingers are a pinch, not a scroll", () => {
  const { screen, wheels } = fakeTerm({ mouse: "any", buffer: "alternate" });
  swipe(screen, [[80, 100], [80, 200]], 2);
  expect(wheels).toEqual([]);
});

test("once stopped, a swipe is left alone", () => {
  const { screen, wheels, stop } = fakeTerm({ mouse: "any", buffer: "alternate" });
  stop();
  swipe(screen, [[80, 100], [80, 200]]);
  expect(wheels).toEqual([]);
});
