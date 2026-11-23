import { expect, test } from "bun:test";
import { choiceNumber, choiceOf, displayEntries, loadDisplayChoice, saveDisplayChoice, sideOf, type ScreenDisplay } from "./screen-displays.ts";

// The Mac this was measured on: a 5K main screen, a 4K one left of it, the built-in one below that.
const main: ScreenDisplay = { id: 3, main: true, x: 0, y: 0, width: 2560, height: 1440 };
const builtIn: ScreenDisplay = { id: 1, main: false, x: -2056, y: 1296, width: 1728, height: 1117 };
const left: ScreenDisplay = { id: 2, main: false, x: -2304, y: 0, width: 2304, height: 1296 };

test("the main screen comes first, the others left to right, numbered from 2", () => {
  const entries = displayEntries([main, builtIn, left]);
  expect(entries.map((e) => [e.display.id, e.number])).toEqual([[3, null], [2, 2], [1, 3]]);
});

test("each other screen says where it sits from the main one", () => {
  expect(sideOf(left, main)).toEqual({ h: "left", v: null });
  expect(sideOf(builtIn, main)).toEqual({ h: "left", v: "below" });
  expect(sideOf({ ...main, id: 9, main: false, x: 2560 }, main)).toEqual({ h: "right", v: null });
  expect(sideOf({ ...main, id: 9, main: false, y: -1440 }, main)).toEqual({ h: null, v: "above" });
});

test("no screen flagged main: the first stands in", () => {
  expect(displayEntries([{ ...left }, { ...builtIn }])[0]!.display.id).toBe(2);
  expect(displayEntries([])).toEqual([]);
});

test("a choice becomes the number the native client takes", () => {
  expect(choiceNumber("all")).toBe(-1);
  expect(choiceNumber("main")).toBe(0);
  expect(choiceNumber(2)).toBe(2);
  expect(choiceOf(null)).toBe("all");
  expect(choiceOf(main)).toBe("main");
  expect(choiceOf(left)).toBe(2);
});

test("the choice is kept on the phone, the main screen by default", () => {
  saveDisplayChoice("main");
  expect(loadDisplayChoice()).toBe("main");
  saveDisplayChoice(2);
  expect(loadDisplayChoice()).toBe(2);
  saveDisplayChoice("all");
  expect(loadDisplayChoice()).toBe("all");
  saveDisplayChoice("main");
  expect(loadDisplayChoice()).toBe("main");
});
