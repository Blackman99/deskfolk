/** Where the cascading picker's columns stand: the first on the trigger's edge, each next one beside the row it came from. */
import { expect, test } from "nsh/test";
import { columnHeight, columnShifts, type ColumnFrame } from "./tune-picker-state";

const frame = (height: number, rows: string[], scroll = 0): ColumnFrame => ({
  height,
  listTop: 30,
  scroll,
  rows: Object.fromEntries(rows.map((row, i) => [row, i * 40])),
});

const focus: Record<string, string> = { account: "work", model: "opus" };
const focusOf = (level: string) => focus[level] ?? "";

test("a column taller than the one it came from stands on the edge too, not under it", () => {
  // Two accounts, a long list of models: the models' first row cannot come level with the account
  // without going past the trigger, so both stand on the edge and the accounts do not move.
  const frames = { account: frame(110, ["home", "work"]), model: frame(390, ["", "opus", "sonnet", "haiku"]) };
  expect(columnShifts(["account", "model"], focusOf, frames, "top", 600)).toEqual([0, 0]);
});

test("a shorter column opens with its first row level with the row it came from", () => {
  const frames = { model: frame(390, ["", "opus", "sonnet"]), effort: frame(200, ["", "low", "high"]) };
  const [model, effort] = columnShifts(["model", "effort"], focusOf, frames, "top", null);
  expect(model).toBe(0);
  // The row's top, up from the edge, is where the levels' first row is.
  const rowFromEdge = model! + 390 - (30 + 40);
  expect(effort! + 200 - 30).toBe(rowFromEdge);
});

test("the column follows its row as the list scrolls", () => {
  const still = columnShifts(["model", "effort"], focusOf, { model: frame(390, ["", "opus"]), effort: frame(200, []) }, "top", null);
  const scrolled = columnShifts(["model", "effort"], focusOf, { model: frame(390, ["", "opus"], 20), effort: frame(200, []) }, "top", null);
  expect(scrolled[1]! - still[1]!).toBe(20);
});

test("the room on the trigger's side holds a column in", () => {
  const frames = { model: frame(390, ["", "opus"]), effort: frame(200, []) };
  expect(columnShifts(["model", "effort"], focusOf, frames, "top", null)[1]).toBe(150);
  expect(columnShifts(["model", "effort"], focusOf, frames, "top", 300)[1]).toBe(100);
});

test("opening downwards, a column hangs level with its row from the edge", () => {
  const frames = { model: frame(390, ["", "opus"]), effort: frame(200, []) };
  // The row starts 30 + 40 below the models' head; the levels' first row 30 below theirs.
  expect(columnShifts(["model", "effort"], focusOf, frames, "bottom", null)).toEqual([0, 40]);
});

test("a column not yet measured, or with no row to come from, stands on the edge", () => {
  expect(columnShifts(["model", "effort"], focusOf, { model: frame(390, ["", "opus"]) }, "top", null)).toEqual([0, 0]);
  expect(columnShifts(["model", "effort"], () => "gone", { model: frame(390, ["", "opus"]), effort: frame(200, []) }, "top", null)).toEqual([0, 0]);
});

test("a column is as tall as the room, within bounds", () => {
  expect(columnHeight(null)).toBe(420);
  expect(columnHeight(100)).toBe(220);
  expect(columnHeight(500)).toBe(500);
  expect(columnHeight(1000)).toBe(640);
});
