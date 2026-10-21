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

test("what a character holds turns about its hand, and its work shows at spots on what it holds", () => {
  const face = { eyes: "dot", mouth: "smile" } as const;
  const holds: Record<string, string> = { pudding: "", mochi: "r", taro: "r", sakura: "lr", matcha: "r", caramel: "r", sesame: "l", blueberry: "r" };
  for (const id of FIGURE_IDS) {
    const d = drawFigure(id, face);
    expect([d.heldL !== null, d.heldR !== null]).toEqual([holds[id]!.includes("l"), holds[id]!.includes("r")]);
    // The hand it turns about is in the held thing's picture.
    for (const [held, hand] of [[d.heldL, d.handL], [d.heldR, d.handR]] as const) {
      if (!held) continue;
      expect(hand[0]).toBeGreaterThan(held.x - 2);
      expect(hand[0]).toBeLessThan(held.x + held.w + 2);
      expect(hand[1]).toBeGreaterThan(held.y - 2);
      expect(hand[1]).toBeLessThan(held.y + held.h + 2);
    }
    expect(Object.keys(d.spots).length).toBeGreaterThan(0);
    for (const css of Object.values(d.spots)) expect(css).toMatch(/^left:-?[\d.]+%;top:-?[\d.]+%$/);
  }
  expect(FIGURE_GEOMETRY.handL[1]).toBeGreaterThan(FIGURE_GEOMETRY.shoulderL[1]);
  expect(FIGURE_GEOMETRY.handR[1]).toBeGreaterThan(FIGURE_GEOMETRY.shoulderR[1]);
  // The hammer's head, the mug's rim, the wand's star and the book are on what the hand holds.
  for (const [id, spot, side] of [["caramel", "hammer", "r"], ["mochi", "steam", "r"], ["blueberry", "wand", "r"], ["sesame", "book", "l"]] as const) {
    const [x, y, w, h] = FIGURE_LAYERS[`${id}-held-${side}`].box;
    const p = (FIGURE_GEOMETRY.work[id] as Record<string, readonly [number, number]>)[spot]!;
    expect(p[0]).toBeGreaterThan(x);
    expect(p[0]).toBeLessThan(x + w);
    expect(p[1]).toBeGreaterThan(y - 0.01);
    expect(p[1]).toBeLessThan(y + h);
  }
  // Pudding's antenna is a layer of its own, its foot on top of its head.
  const pudding = drawFigure("pudding", face);
  expect(drawFigure("mochi", face).antenna).toBeNull();
  expect(pudding.antennaAt[1]).toBeGreaterThan(pudding.antenna!.y);
  expect(pudding.antennaAt[1]).toBeLessThan(pudding.antenna!.y + pudding.antenna!.h + 1);
  expect(pudding.antennaAt[1]).toBeLessThan(pudding.body.y + 6);
});
