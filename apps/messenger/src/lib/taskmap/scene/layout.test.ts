import { describe, expect, test } from "bun:test";
import { assignBadges, badgeBox, layoutPlates, type LabelBox, type PlacedActor, type PlateBlock } from "./layout.ts";

const plate = (over: Partial<PlateBlock> = {}): PlateBlock => ({ z: 1, px: 500, plateY: 300, name: "src", n: 3, flag: false, lines: [], ...over });

const actor = (b: number, over: Partial<PlacedActor> = {}): PlacedActor => ({
  b,
  short: "Claude",
  hasModel: false,
  modelShort: "",
  x: 100 * b,
  y: 200,
  badgeTop: 4,
  side: 1,
  lift: 0,
  present: true,
  walking: false,
  ...over,
});

/** The height the plate is laid out at: the rule is 23px and a line is 13.5px, 26 more for a flag, all over the zoom. */
const plateHeight = (b: PlateBlock, zoom: number): number => (23 + b.lines.length * 13.5 + (b.flag ? 26 : 0)) / zoom;

const overlapY = (b1: PlateBlock, b2: PlateBlock, zoom: number): number => {
  const top1 = b1.plateY - plateHeight(b1, zoom);
  const top2 = b2.plateY - plateHeight(b2, zoom);
  return Math.min(b1.plateY, b2.plateY) - Math.max(top1, top2);
};

describe("layoutPlates", () => {
  test("two plates that overlap at the start do not overlap after layout", () => {
    for (const zoom of [1, 1.7, 2.5]) {
      const a = plate({ z: 2, plateY: 300 });
      const b = plate({ z: 1, plateY: 305 });
      expect(overlapY(a, b, zoom)).toBeGreaterThan(1.5 / zoom);
      layoutPlates([a, b], [], [[500, 600], [500, 600]], zoom);
      expect(overlapY(a, b, zoom)).toBeLessThanOrEqual(1.5 / zoom);
    }
  });

  test("the nearer plate (higher z) keeps its wish and the farther one makes way", () => {
    const near = plate({ z: 9, plateY: 300 });
    const far = plate({ z: 1, plateY: 300 });
    layoutPlates([far, near], [], [[500, 600], [500, 600]], 1);
    expect(near.plateY).toBe(300);
    expect(far.plateY).not.toBe(300);
    expect(Math.abs(far.plateY - 300)).toBeLessThanOrEqual(150);
  });

  test("a pile of plates spreads out, each within 150px of its wish", () => {
    const blocks = [0, 1, 2, 3].map((i) => plate({ z: i, plateY: 300 + i * 4, lines: i % 2 ? [{ text: "Claude work", model: "" }] : [] }));
    layoutPlates(blocks, [], blocks.map(() => [500, 800] as [number, number]), 1);
    for (let i = 0; i < blocks.length; i++) {
      expect(Math.abs(blocks[i].plateY - (300 + i * 4))).toBeLessThanOrEqual(150 + 0.5);
      for (let j = i + 1; j < blocks.length; j++) expect(overlapY(blocks[i], blocks[j], 1)).toBeLessThanOrEqual(1.5);
    }
  });

  test("a plate never goes below its building's floor", () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 200; round++) {
      const n = 2 + Math.floor(rnd() * 4);
      const zoom = [1, 1.5, 2.5][round % 3];
      const at: Array<[number, number]> = [];
      const blocks: PlateBlock[] = [];
      for (let i = 0; i < n; i++) {
        const floorY = 150 + Math.floor(rnd() * 400);
        at.push([500, floorY + 12]);
        // The wish is at or above the floor, as a building's top always is.
        blocks.push(plate({ z: Math.floor(rnd() * 20), px: 480 + Math.floor(rnd() * 60), plateY: floorY - Math.floor(rnd() * 80), flag: rnd() > 0.5, lines: rnd() > 0.5 ? [{ text: "Claude work", model: " · Opus" }] : [] }));
      }
      layoutPlates(blocks, [actor(0), actor(1, { x: 460 })], at, zoom);
      blocks.forEach((b, k) => expect(b.plateY).toBeLessThanOrEqual(at[k][1] - 12));
    }
  });

  test("a plate keeps clear of a character's head and badge when there is room", () => {
    const who = actor(0, { x: 470, y: 300 });
    const head: LabelBox = [who.x + 6, who.y + who.badgeTop, who.x + 52, who.y + 60];
    const b = plate({ px: 500, plateY: 340 });
    const zoom = 1;
    layoutPlates([b], [who], [[500, 700]], zoom);
    const w = 60;
    const box: LabelBox = [500 - w / 2, b.plateY - plateHeight(b, zoom), 500 + w / 2, b.plateY];
    const ox = Math.min(box[2], head[2]) - Math.max(box[0], head[0]);
    const oy = Math.min(box[3], head[3]) - Math.max(box[1], head[1]);
    expect(ox > 1.5 && oy > 1.5).toBe(false);
  });

  test("a walking or absent character is no obstacle", () => {
    const wish = 340;
    for (const gone of [{ walking: true }, { present: false }]) {
      const b = plate({ px: 500, plateY: wish });
      layoutPlates([b], [actor(0, { x: 470, y: 300, ...gone })], [[500, 700]], 1);
      expect(b.plateY).toBe(wish);
    }
  });

  test("a plate with room keeps its wish, rounded", () => {
    const b = plate({ plateY: 300.4 });
    layoutPlates([b], [], [[500, 700]], 1);
    expect(b.plateY).toBe(300);
  });

  test("a wish below the floor stays put: there is nothing above to try that would be allowed", () => {
    const b = plate({ plateY: 500 });
    layoutPlates([b], [], [[500, 400]], 1);
    expect(b.plateY).toBe(500);
  });
});

describe("badgeBox", () => {
  test("grows left, right, or both ways around the head, and narrows as the map zooms in", () => {
    const left = badgeBox(actor(0, { side: -1 }), 1);
    const right = badgeBox(actor(0, { side: 1 }), 1);
    const mid = badgeBox(actor(0, { side: 0 }), 1);
    const head = 100 * 0 + 29;
    expect(left[2]).toBeCloseTo(head + 14.5, 9);
    expect(right[0]).toBeCloseTo(head - 14.5, 9);
    expect((mid[0] + mid[2]) / 2).toBeCloseTo(head, 9);
    expect(left[2] - left[0]).toBeCloseTo(right[2] - right[0], 9);
    expect(left[2] - left[0]).toBeCloseTo(mid[2] - mid[0], 9);
    const zoomed = badgeBox(actor(0, { side: 1 }), 2);
    expect(right[2] - right[0]).toBeCloseTo(2 * (zoomed[2] - zoomed[0]), 9);
    expect(right[3] - right[1]).toBeCloseTo(28, 9);
  });

  test("a model tag and wider letters make it wider, and a lift raises it", () => {
    const plain = badgeBox(actor(0), 1);
    const tagged = badgeBox(actor(0, { hasModel: true, modelShort: "Opus 5.5" }), 1);
    const cjk = badgeBox(actor(0, { short: "导入界面" }), 1);
    expect(tagged[2] - tagged[0]).toBeGreaterThan(plain[2] - plain[0]);
    expect(cjk[2] - cjk[0]).toBeGreaterThan(plain[2] - plain[0]);
    const lifted = badgeBox(actor(0, { lift: 2 }), 1);
    expect(plain[3] - lifted[3]).toBeCloseTo(56, 9);
  });
});

describe("assignBadges", () => {
  test("a lone character's badge grows right", () => {
    const a = [actor(0)];
    assignBadges(a, 1);
    expect([a[0].side, a[0].lift]).toEqual([1, 0]);
  });

  test("the left half grows left, the right half right, the middle one is centred, by x", () => {
    const a = [actor(2, { x: 300 }), actor(0, { x: 100 }), actor(1, { x: 200 })];
    assignBadges(a, 1);
    expect(a.map((x) => x.side)).toEqual([1, -1, 0]);
    const four = [0, 1, 2, 3].map((b) => actor(b, { x: b * 300 }));
    assignBadges(four, 1);
    expect(four.map((x) => x.side)).toEqual([-1, -1, 1, 1]);
  });

  test("a badge that would reach past the town's left edge grows right instead", () => {
    const a = [actor(0, { x: 10 }), actor(1, { x: 400 })];
    assignBadges(a, 1, 0);
    expect(a.map((x) => x.side)).toEqual([1, 1]);
    const roomy = [actor(0, { x: 300 }), actor(1, { x: 600 })];
    assignBadges(roomy, 1, 0);
    expect(roomy.map((x) => x.side)).toEqual([-1, 1]);
  });

  test("a tie in x goes by the character's index", () => {
    const a = [actor(1, { x: 100 }), actor(0, { x: 100 })];
    assignBadges(a, 1);
    expect(a.map((x) => x.side)).toEqual([1, -1]);
  });

  test("badges that would cover each other rise, up to two levels, and the ones that rise clear what they cleared", () => {
    const a = [0, 1, 2, 3].map((b) => actor(b, { x: 100 + b }));
    assignBadges(a, 1);
    expect(a.every((x) => x.lift >= 0 && x.lift <= 2)).toBe(true);
    expect(a.some((x) => x.lift > 0)).toBe(true);
    expect(Math.max(...a.map((x) => x.lift))).toBe(2);
    const boxes = a.map((x) => badgeBox(x, 1));
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < i; j++) {
        if (a[i].lift >= 2) continue;
        const ox = Math.min(boxes[i][2], boxes[j][2]) - Math.max(boxes[i][0], boxes[j][0]);
        const oy = Math.min(boxes[i][3], boxes[j][3]) - Math.max(boxes[i][1], boxes[j][1]);
        expect(ox > 1 && oy > 1).toBe(false);
      }
    }
  });

  test("characters off the map are not counted and get side 1, lift 0", () => {
    const a = [actor(0, { x: 100 }), actor(1, { x: 105, present: false, side: -1, lift: 2 }), actor(2, { x: 400 })];
    assignBadges(a, 1);
    expect([a[1].side, a[1].lift]).toEqual([1, 0]);
    expect([a[0].side, a[2].side]).toEqual([-1, 1]);
    expect(a[0].lift).toBe(0);
  });

  test("whatever the actors held before is overwritten", () => {
    const a = [actor(0, { side: 7, lift: 9 })];
    assignBadges(a, 1);
    expect([a[0].side, a[0].lift]).toEqual([1, 0]);
  });
});
