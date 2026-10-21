import { expect, test } from "bun:test";
import { folkLook, generateBoringAvatar } from "@real-bot/protocol";
import { faceColor } from "./draw.ts";
import { FIGURE_GEOMETRY, FIGURE_LAYERS } from "./figure-assets.ts";
import { assignFigures, drawFigure, FIGURE_FOOT, FIGURE_IDS, figureFace, figureTint } from "./figures.ts";
import { rgb } from "./geometry.ts";

test("each character of a map gets its own figure, and the same character always the same one", () => {
  const keys = ["bot-a", "bot-b", "bot-c", "bot-d", "bot-e", "bot-f", "bot-g", "bot-h"];
  const looks = assignFigures(keys);
  expect(new Set(looks).size).toBe(8);
  expect(assignFigures(keys)).toEqual(looks);
  // A ninth character reuses a figure rather than having none.
  expect(FIGURE_IDS).toContain(assignFigures([...keys, "bot-i"])[8]!);
});

test("every figure has its layers, stands on its feet in its box, and wears its pin on its body", () => {
  for (const id of FIGURE_IDS) {
    for (const part of ["body", "arm-l", "arm-r"]) expect(`${id}-${part}` in FIGURE_LAYERS).toBe(true);
    const d = drawFigure(id, { eyes: "dot", mouth: "smile" });
    // It stands where the actor box puts its feet; seen from above, the front of its feet reaches ~10 px lower.
    expect(d.body.y + d.body.h - FIGURE_FOOT[1]).toBeGreaterThan(4);
    expect(d.body.y + d.body.h - FIGURE_FOOT[1]).toBeLessThan(12);
    expect(d.body.x).toBeGreaterThan(-12);
    expect(d.body.x + d.body.w).toBeLessThan(70);
    // The pin is on the body, under the face, and its badge stands over the top of its hat.
    expect(d.chest[0]).toBeGreaterThan(d.body.x);
    expect(d.chest[0]).toBeLessThan(d.body.x + d.body.w);
    expect(d.chest[1]).toBeGreaterThan(d.mouthAt[1]);
    expect(d.top).toBeLessThan(d.body.y + 1);
    expect(d.chestR).toBeGreaterThan(3);
  }
  expect(drawFigure("sesame", { eyes: "dot", mouth: "smile" }).front).not.toBeNull();
  expect(drawFigure("pudding", { eyes: "dot", mouth: "smile" }).front).toBeNull();
  // Shoulders sit either side of the body, above the feet.
  expect(FIGURE_GEOMETRY.shoulderL[0]).toBeLessThan(FIGURE_GEOMETRY.feet[0]);
  expect(FIGURE_GEOMETRY.shoulderR[0]).toBeGreaterThan(FIGURE_GEOMETRY.feet[0]);
});

test("a Bot whose avatar is a folk lends its figure that folk's face; any other avatar gives Pudding's own", () => {
  const svg = generateBoringAvatar({ name: "导演" });
  const look = folkLook(Number.parseInt(/mask_folk_([0-9a-z]+)"/.exec(svg)![1]!, 36));
  expect(figureFace(svg)).toEqual({ eyes: look.eyes, mouth: look.mouth });
  expect(figureFace("data:image/jpeg;base64,AAAA")).toEqual({ eyes: "dot", mouth: "smile" });
  expect(figureFace(null)).toEqual({ eyes: "dot", mouth: "smile" });
  expect(drawFigure("taro", { eyes: "wink", mouth: "cat" }).eyes.href).toBe(drawFigure("mochi", { eyes: "wink", mouth: "open" }).eyes.href);
});

test("the hour's light falls on a figure as it falls on a building's wall", () => {
  expect(figureTint({ w: 0, n: 0 })).toBeNull();
  for (const L of [{ w: 1, n: 0 }, { w: 0.4, n: 0.6 }, { w: 0, n: 1 }]) {
    const { color, alpha } = figureTint(L)!;
    const over = color.match(/\d+/g)!.map(Number);
    for (const col of ["#ef9f2c", "#6b82d6", "#f6f3ec"]) {
      const c = rgb(col);
      const want = rgb(faceColor({ col, kind: "solid", shade: 1 }, L, false, false));
      for (let i = 0; i < 3; i++) expect(Math.abs(c[i]! * (1 - alpha) + over[i]! * alpha - want[i]!)).toBeLessThan(1.6);
    }
  }
});
