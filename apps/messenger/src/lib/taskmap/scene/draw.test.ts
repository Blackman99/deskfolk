import { describe, expect, test } from "bun:test";
import { BY, NIGHT, SHADE, W, axes, mix, type Vec3 } from "./geometry.ts";
import {
  LAMPS, ROADS, SLAB_IDS, TREES, buildGround, castOffset, drawBuilding, faceColor, islandShadow, lampShadow, lightAt, shadeOf, shadowOf, treeShadow,
  type BuiltModel, type LightLevel,
} from "./draw.ts";
import { ARCHETYPE_IDS } from "./models.ts";

const DAY: LightLevel = { n: 0, w: 0 };
const NIGHT_LIGHT: LightLevel = { n: 1, w: 0 };
const TURNS = Array.from({ length: 36 }, (_, i) => i * 10);

const numbers = (s: string): number[] => (s.match(/-?[\d.]+(?:e-?\d+)?|NaN|Infinity/g) || []).map(Number);
const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const brightness = (hex: string): number => channels(hex).reduce((a, b) => a + b, 0);

describe("buildGround", () => {
  test("at 180 degrees the floating island's slab is above the town's in z, and behind it at 0", () => {
    const at180 = buildGround(180).slabs;
    const at0 = buildGround(0).slabs;
    const [town, , ext] = SLAB_IDS.map((_, i) => i);
    expect(at180[ext].z).toBeGreaterThan(at180[town].z);
    expect(at0[ext].z).toBeLessThan(at0[town].z);
  });

  test("slabs are painted in an order that follows how far down the picture they are", () => {
    for (const deg of TURNS) {
      const g = buildGround(deg);
      const byDepth = g.slabs.map((s, i) => ({ s, i })).sort((a, b) => a.s.depth - b.s.depth);
      expect(byDepth.map((x) => x.s.z)).toEqual([2, 3, 4]);
      expect(g.phi).toBe(deg);
    }
  });

  test("everything is finite, the box has room for buildings above and labels below, and only the island has clouds", () => {
    for (const deg of TURNS) {
      const g = buildGround(deg);
      expect(Object.values(g.box).every(Number.isFinite)).toBe(true);
      expect(g.box.x1).toBeGreaterThan(g.box.x0);
      expect(g.box.y1).toBeGreaterThan(g.box.y0);
      for (const id of SLAB_IDS) {
        expect(Number.isFinite(g.lb[id].x) && Number.isFinite(g.lb[id].y)).toBe(true);
        // A label sits below its slab's front corner, inside the box.
        expect(g.lb[id].y).toBeLessThanOrEqual(g.box.y1);
      }
      for (const text of [g.roads, g.shadow, ...Object.values(g.tops), ...g.slabs.flatMap((s) => s.faces.map((f) => f.d))]) expect(numbers(text).every(Number.isFinite)).toBe(true);
      // Each slab's top is there to clip that island's shadows to.
      expect(SLAB_IDS.every((id) => g.tops[id].startsWith("M"))).toBe(true);
      // Every slab shows its top and at least two sides at any turn (a box seen from above).
      for (const s of g.slabs) expect(s.faces.length).toBeGreaterThanOrEqual(3);
      expect(g.slabs.map((s) => s.puffs.length)).toEqual([0, 0, 8]);
    }
  });

  test("the roads cover every road segment and the lane to the island", () => {
    const g = buildGround(37);
    expect((g.roads.match(/M/g) || []).length).toBe(ROADS.length + 1);
  });

  test("the scenery tables are finite ground points", () => {
    for (const [gx, gy] of [...TREES, ...LAMPS]) expect(Number.isFinite(gx) && Number.isFinite(gy)).toBe(true);
  });
});

describe("lightAt", () => {
  test("names the hours of the day", () => {
    expect(lightAt(12).name).toBe("day");
    expect(lightAt(6.5).name).toBe("day");
    expect(lightAt(16.4).name).toBe("day");
    expect(lightAt(17).name).toBe("golden");
    expect(lightAt(18.5).name).toBe("golden");
    expect(lightAt(19).name).toBe("dusk");
    expect(lightAt(22).name).toBe("night");
    expect(lightAt(2).name).toBe("night");
    expect(lightAt(5.5).name).toBe("dawn");
  });

  test("is dark at night, bright by day, and n and w always stay within 0 to 1", () => {
    expect(lightAt(12)).toMatchObject({ n: 0, w: 0, name: "day" });
    expect(lightAt(23)).toMatchObject({ n: 1, w: 0, name: "night" });
    for (let m = 0; m < 1440; m++) {
      const L = lightAt(m / 60);
      expect(L.n).toBeGreaterThanOrEqual(0);
      expect(L.n).toBeLessThanOrEqual(1);
      expect(L.w).toBeGreaterThanOrEqual(0);
      expect(L.w).toBeLessThanOrEqual(1);
    }
  });

  test("evening deepens, morning lifts, and the warm hour comes before the dark", () => {
    let prev = lightAt(16.5).n;
    for (let h = 16.5; h <= 19.5; h += 0.05) {
      const n = lightAt(h).n;
      expect(n).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = n;
    }
    prev = lightAt(5).n;
    for (let h = 5; h <= 6.5; h += 0.05) {
      const n = lightAt(h).n;
      expect(n).toBeLessThanOrEqual(prev + 1e-9);
      prev = n;
    }
    expect(lightAt(17.5).w).toBeGreaterThan(lightAt(17.5).n);
  });

  // The ground's compass: north is grid (-1, -1), up the screen at turn 0; east is (1, -1).
  const toward = (dir: Vec3, gx: number, gy: number) => (dir[0] * gx + dir[1] * gy) / Math.hypot(gx, gy);

  test("the sun rises in the east, stands highest in the south around midday and sets in the west; the moon has the night", () => {
    const morning = lightAt(7);
    const noon = lightAt(12.5);
    const evening = lightAt(18);
    for (const L of [morning, noon, evening]) expect(L.body.kind).toBe("sun");
    expect(toward(morning.dir, 1, -1)).toBeGreaterThan(0.5);
    expect(toward(evening.dir, -1, 1)).toBeGreaterThan(0.5);
    expect(toward(noon.dir, 1, 1)).toBeGreaterThan(0.4);
    expect(noon.body.height).toBeCloseTo(1, 2);
    expect(noon.dir[2]).toBeGreaterThan(morning.dir[2]);
    expect(noon.dir[2]).toBeGreaterThan(evening.dir[2]);
    for (const h of [20, 23, 1, 4]) expect(lightAt(h).body.kind).toBe("moon");
    expect(toward(lightAt(20.5).dir, 1, -1)).toBeGreaterThan(0.5);
    for (let m = 0; m < 1440; m++) {
      const L = lightAt(m / 60);
      expect(Math.hypot(...L.dir)).toBeCloseTo(1, 9);
      expect(L.dir[2]).toBeGreaterThanOrEqual(0);
      expect(L.cast).toBeGreaterThanOrEqual(0);
      expect(L.cast).toBeLessThanOrEqual(1);
    }
  });

  test("the light has no direction where the sun and moon hand over, so no wall or shadow jumps", () => {
    for (const h of [6, 19]) {
      expect(lightAt(h).cast).toBeCloseTo(0, 6);
      expect(lightAt(h - 1 / 60).cast).toBeLessThan(0.02);
      expect(lightAt(h + 1 / 60).cast).toBeLessThan(0.02);
    }
    // A wall facing east, minute by minute through the day and night, never changes shade by much at once.
    const wall = { n: [Math.SQRT1_2, 0, Math.SQRT1_2] as Vec3, shade: 0.8 };
    let prev = shadeOf(wall, lightAt(0));
    for (let m = 1; m <= 1440; m++) {
      const next = shadeOf(wall, lightAt((m % 1440) / 60));
      expect(Math.abs(next - prev)).toBeLessThan(0.02);
      prev = next;
    }
    // Moonlight casts less than the midday sun.
    expect(lightAt(0.5).cast).toBeLessThan(lightAt(12.5).cast);
  });
});

describe("shadeOf", () => {
  test("a face turned to the light is brighter than one turned away; a bare level keeps the fixed sun's shade", () => {
    const morning = lightAt(8);
    const east = { n: [Math.SQRT1_2, -Math.SQRT1_2, 0] as Vec3, shade: 0.7 };
    const west = { n: [-Math.SQRT1_2, Math.SQRT1_2, 0] as Vec3, shade: 0.7 };
    expect(shadeOf(east, morning)).toBeGreaterThan(shadeOf(west, morning));
    expect(shadeOf(west, lightAt(17))).toBeGreaterThan(shadeOf(east, lightAt(17)));
    expect(shadeOf(east, DAY)).toBe(0.7);
    for (const L of [morning, lightAt(12.5), lightAt(23)]) {
      expect(shadeOf(east, L)).toBeGreaterThanOrEqual(0.62);
      expect(shadeOf(east, L)).toBeLessThanOrEqual(1);
    }
  });
});

describe("shadows", () => {
  const cache = new Map<string, BuiltModel>();
  const centre = (polys: readonly (readonly (readonly [number, number])[])[]) => {
    const pts = polys.flat();
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  };

  test("a point casts away from the light, longer the lower the light, and never past its cap", () => {
    const morning = lightAt(7.5).dir;
    const noon = lightAt(12.5).dir;
    const [mx, my] = castOffset(50, morning);
    // The sun in the east puts the shadow to the west.
    expect((mx - my) / Math.SQRT2).toBeLessThan(0);
    expect(Math.hypot(...castOffset(50, morning))).toBeGreaterThan(Math.hypot(...castOffset(50, noon)));
    expect(Math.hypot(...castOffset(50, [1, 0, 0.01]))).toBeLessThanOrEqual(50 / 0.3 / W + 1e-9);
  });

  test("a building's shadow falls on the side away from the sun, and the evening's on the other side", () => {
    for (const phi of [0, 90, 217]) {
      const { ex, ey } = axes(phi);
      const west = [-ex[0] + ey[0], -ex[1] + ey[1]];
      const side = (h: number) => {
        const [x, y] = centre(shadowOf("bible", 40, phi, lightAt(h).dir, cache));
        return x * west[0] + y * west[1];
      };
      expect(side(7.5)).toBeGreaterThan(0);
      expect(side(17.5)).toBeLessThan(0);
    }
  });

  test("outlines are finite, kept by shape, turn and light, and every shape casts one", () => {
    const dir = lightAt(9).dir;
    for (const id of ARCHETYPE_IDS) {
      const polys = shadowOf(id, 30, 25, dir, cache);
      expect(polys.length).toBeGreaterThan(0);
      expect(polys.flat(2).every(Number.isFinite)).toBe(true);
    }
    expect(shadowOf("camp", 30.1, 25, dir, cache)).toBe(shadowOf("camp", 30, 25, dir, cache));
    for (const pts of [treeShadow(true, 25, dir), treeShadow(false, 25, dir), lampShadow(25, dir)]) {
      expect(pts.length).toBeGreaterThanOrEqual(3);
      expect(pts.flat().every(Number.isFinite)).toBe(true);
    }
    expect(numbers(islandShadow(25, dir)).every(Number.isFinite)).toBe(true);
  });
});

describe("faceColor", () => {
  const wall = { col: "#d64a62", kind: "solid", shade: 0.8 } as const;
  const glass = { col: "#cfe6f0", kind: "glass", shade: 0.8 } as const;
  const screen = { col: "#24323f", kind: "screen", shade: 0.8 } as const;

  test("a wall is its shade by day and darker at night; hovering lifts it", () => {
    expect(faceColor(wall, DAY, false, false)).toBe(mix(SHADE, wall.col, wall.shade));
    expect(brightness(faceColor(wall, NIGHT_LIGHT, false, false))).toBeLessThan(brightness(faceColor(wall, DAY, false, false)));
    expect(brightness(faceColor(wall, DAY, false, true))).toBeGreaterThan(brightness(faceColor(wall, DAY, false, false)));
  });

  test("glass and screens glow when the place is busy, and lit glass beats unlit at night", () => {
    expect(brightness(faceColor(glass, NIGHT_LIGHT, true, false))).toBeGreaterThan(brightness(faceColor(glass, NIGHT_LIGHT, false, false)));
    expect(brightness(faceColor(glass, NIGHT_LIGHT, false, false))).toBeGreaterThan(brightness(faceColor(wall, NIGHT_LIGHT, false, false)));
    expect(brightness(faceColor(screen, DAY, true, false))).toBeGreaterThan(brightness(faceColor(screen, DAY, false, false)));
    expect(faceColor(screen, DAY, false, false)).toBe(mix(SHADE, screen.col, screen.shade));
  });

  test("the night colour is where a fully dark wall tends", () => {
    const dark = faceColor({ col: NIGHT, kind: "solid", shade: 1 }, NIGHT_LIGHT, false, false);
    expect(dark).toBe(NIGHT);
  });
});

describe("drawBuilding", () => {
  test("every archetype is drawn with finite polygons at every turn", () => {
    const cache = new Map<string, BuiltModel>();
    for (const id of ARCHETYPE_IDS) {
      for (const h of [12, 54]) {
        for (const deg of TURNS) {
          const d = drawBuilding(id, h, DAY, false, false, deg, cache);
          expect(d.faces.length).toBeGreaterThan(0);
          for (const f of d.faces) {
            expect(numbers(f.pts).length).toBeGreaterThanOrEqual(6);
            expect(numbers(f.pts).every(Number.isFinite)).toBe(true);
            expect(f.fill).toMatch(/^#[0-9a-f]{6}$/);
            expect(f.stroke).toMatch(/^#[0-9a-f]{6}$/);
          }
          expect(numbers(d.hull).length).toBeGreaterThanOrEqual(6);
          expect(numbers(d.ring)).toHaveLength(8);
          expect(Number.isFinite(d.top)).toBe(true);
          expect(d.top).toBeLessThan(0);
          expect(d.emit.every(Number.isFinite)).toBe(true);
          // The top is the highest point of the picture, relative to the building's origin.
          const ys = d.faces.flatMap((f) => numbers(f.pts).filter((_, i) => i % 2 === 1));
          expect(Math.min(...ys) - BY).toBeCloseTo(d.top, 1);
        }
      }
    }
  });

  test("a taller building rises higher", () => {
    const cache = new Map<string, BuiltModel>();
    for (const id of ARCHETYPE_IDS) expect(drawBuilding(id, 54, DAY, false, false, 0, cache).top).toBeLessThan(drawBuilding(id, 12, DAY, false, false, 0, cache).top);
  });

  test("models are cached by archetype and height rounded to a half", () => {
    const cache = new Map<string, BuiltModel>();
    drawBuilding("camp", 23.1, DAY, false, false, 0, cache);
    drawBuilding("camp", 23.2, DAY, true, true, 90, cache);
    expect([...cache.keys()]).toEqual(["camp:23"]);
    drawBuilding("camp", 23.4, DAY, false, false, 0, cache);
    drawBuilding("song", 23.4, DAY, false, false, 0, cache);
    expect([...cache.keys()].sort()).toEqual(["camp:23", "camp:23.5", "song:23.5"]);
    const model = cache.get("camp:23");
    drawBuilding("camp", 23.1, DAY, false, false, 180, cache);
    expect(cache.get("camp:23")).toBe(model);
  });

  test("busy and hovered change colours, not shapes", () => {
    const cache = new Map<string, BuiltModel>();
    const calm = drawBuilding("edit", 33, NIGHT_LIGHT, false, false, 45, cache);
    const busy = drawBuilding("edit", 33, NIGHT_LIGHT, true, true, 45, cache);
    expect(busy.faces.map((f) => f.pts)).toEqual(calm.faces.map((f) => f.pts));
    expect(busy.hull).toBe(calm.hull);
    expect(busy.emit).toEqual(calm.emit);
    expect(busy.faces.map((f) => f.fill)).not.toEqual(calm.faces.map((f) => f.fill));
  });

  test("turning the map by half a turn shows the other walls", () => {
    const cache = new Map<string, BuiltModel>();
    const front = drawBuilding("bible", 33, DAY, false, false, 0, cache);
    const back = drawBuilding("bible", 33, DAY, false, false, 180, cache);
    expect(back.faces.map((f) => f.pts)).not.toEqual(front.faces.map((f) => f.pts));
  });
});
