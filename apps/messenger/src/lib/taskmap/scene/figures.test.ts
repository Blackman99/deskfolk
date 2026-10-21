import { expect, test } from "bun:test";
import { assignFigures, drawFigure, FIGURE_IDS, FIGURE_PALETTES, figureModel } from "./figures.ts";

const day = { w: 0, n: 0, k: "day" } as never;

test("each character of a map gets its own shape and colour, and the same character always the same ones", () => {
  const keys = ["bot-a", "bot-b", "bot-c", "bot-d", "bot-e", "bot-f", "bot-g", "bot-h"];
  const looks = assignFigures(keys);
  expect(new Set(looks.map((l) => l.figure)).size).toBe(8);
  expect(new Set(looks.map((l) => l.palette.body)).size).toBe(8);
  expect(assignFigures(keys)).toEqual(looks);
  // A ninth character reuses a shape rather than having none.
  expect(FIGURE_IDS).toContain(assignFigures([...keys, "bot-i"])[8]!.figure);
});

test("every figure stands inside its picture box, its feet at the bottom, with a face and a place for its avatar", () => {
  const cache = new Map();
  for (const id of FIGURE_IDS) {
    const drawn = drawFigure(figureModel(id, FIGURE_PALETTES[0]!, cache), day);
    const points = drawn.faces.flatMap((f) => f.pts.split(" ").map((p) => p.split(",").map(Number) as [number, number]));
    expect(drawn.faces.length).toBeGreaterThan(8);
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(58);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(64);
    }
    expect(Math.max(...points.map((p) => p[1]))).toBeGreaterThan(56);
    expect(drawn.chest[1]).toBeGreaterThan(drawn.top);
    expect(drawn.chest[1]).toBeLessThan(60);
  }
});
