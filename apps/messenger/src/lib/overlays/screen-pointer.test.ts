import { expect, test } from "bun:test";
import { BUTTON, PointerOut, pointerEvent } from "./screen-pointer.ts";
import type { Clock } from "./screen-trackpad.ts";

test("a pointer event is RFB's six bytes: type 5, buttons, then x and y big-endian", () => {
  expect([...pointerEvent(4111, 2657, BUTTON.left)]).toEqual([5, 1, 0x10, 0x0f, 0x0a, 0x61]);
  // Rounded, kept on the screen's side of zero, and never the extended-event bit.
  expect([...pointerEvent(-3, 10.6, 0xff)]).toEqual([5, 0x7f, 0, 0, 0, 11]);
});

function out() {
  let now = 1000;
  const due: Array<{ at: number; run: () => void }> = [];
  const clock: Clock = {
    now: () => now,
    after: (ms, run) => {
      const timer = { at: now + ms, run };
      due.push(timer);
      return () => { due.splice(due.indexOf(timer), 1); };
    },
  };
  const sent: number[][] = [];
  const pointer = new PointerOut((bytes) => sent.push([...bytes]), clock, 25);
  const advance = (ms: number) => {
    now += ms;
    for (const timer of due.filter((t) => t.at <= now)) {
      due.splice(due.indexOf(timer), 1);
      timer.run();
    }
  };
  /** What went out, as [buttons, x, y]. */
  const events = () => sent.map((b) => [b[1], (b[2]! << 8) | b[3]!, (b[4]! << 8) | b[5]!]);
  return { pointer, advance, events };
}

test("moves go out at most once per gap, the latest position winning", () => {
  const { pointer, advance, events } = out();
  pointer.moveTo({ x: 10, y: 10 });
  pointer.moveTo({ x: 20, y: 20 });
  pointer.moveTo({ x: 30, y: 30 });
  expect(events()).toEqual([[0, 10, 10]]);
  advance(25);
  expect(events()).toEqual([[0, 10, 10], [0, 30, 30]]);
  advance(100);
  pointer.moveTo({ x: 40, y: 40 });
  expect(events()).toEqual([[0, 10, 10], [0, 30, 30], [0, 40, 40]]);
});

test("a click goes at once where it is aimed, and a move still waiting is dropped", () => {
  const { pointer, advance, events } = out();
  pointer.moveTo({ x: 10, y: 10 });
  pointer.moveTo({ x: 50, y: 60 });
  pointer.click({ x: 50, y: 60 }, BUTTON.right);
  advance(100);
  expect(events()).toEqual([[0, 10, 10], [BUTTON.right, 50, 60], [0, 50, 60]]);
});

test("a held button rides along on every move until it is let go", () => {
  const { pointer, advance, events } = out();
  pointer.press({ x: 5, y: 5 }, BUTTON.left);
  advance(30);
  pointer.moveTo({ x: 80, y: 5 });
  pointer.release({ x: 90, y: 5 }, BUTTON.left);
  pointer.wheel({ x: 90, y: 5 }, BUTTON.wheelUp);
  expect(events()).toEqual([[1, 5, 5], [1, 80, 5], [0, 90, 5], [BUTTON.wheelUp, 90, 5], [0, 90, 5]]);
});

test("reset forgets a held button and a move still waiting", () => {
  const { pointer, advance, events } = out();
  pointer.press({ x: 5, y: 5 }, BUTTON.left);
  pointer.moveTo({ x: 9, y: 9 });
  pointer.reset();
  advance(100);
  pointer.moveTo({ x: 7, y: 7 });
  expect(events()).toEqual([[1, 5, 5], [0, 7, 7]]);
});
