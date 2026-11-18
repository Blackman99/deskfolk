import { expect, test } from "bun:test";
import { ladderPlace, ladderSlot, movedTo } from "./ladder-drag.ts";

const middles = [20, 68, 116];

test("a held rung lands after every other rung whose middle it has reached", () => {
  expect(ladderSlot(middles, 0, 20)).toBe(0);
  expect(ladderSlot(middles, 0, 69)).toBe(1);
  expect(ladderSlot(middles, 0, 116)).toBe(2);
  expect(ladderSlot(middles, 2, 68)).toBe(1);
  expect(ladderSlot(middles, 2, 67)).toBe(1);
  expect(ladderSlot(middles, 2, 0)).toBe(0);
  expect(ladderSlot(middles, 2, 20)).toBe(0);
});

test("the rungs it passes move one place towards where it came from", () => {
  expect([0, 1, 2].map((index) => ladderPlace(index, 0, 2))).toEqual([2, 0, 1]);
  expect([0, 1, 2].map((index) => ladderPlace(index, 2, 0))).toEqual([1, 2, 0]);
  expect([0, 1, 2].map((index) => ladderPlace(index, 1, 1))).toEqual([0, 1, 2]);
  expect(movedTo(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  expect(movedTo(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
});
