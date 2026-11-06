import { expect, test } from "nsh/test";
import { regionAt } from "./wheel";

test("the wheel goes to the innermost view under the pointer", () => {
  const board = { name: "board", rect: { x: 0, y: 0, width: 800, height: 600 } };
  const minimap = { name: "minimap", rect: { x: 600, y: 450, width: 180, height: 120 } };
  const gone = { name: "gone", rect: null };
  expect(regionAt([board, minimap, gone], 700, 500)?.name).toBe("minimap");
  expect(regionAt([minimap, board], 100, 100)?.name).toBe("board");
  expect(regionAt([board, minimap], 900, 100)).toBe(null);
});
