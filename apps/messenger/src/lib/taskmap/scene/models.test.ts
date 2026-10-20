import { describe, expect, test } from "bun:test";
import { axes, type Vec2 } from "./geometry.ts";
import { ARCHETYPE_IDS, MODELS, type Face, type Part } from "./models.ts";

// Model checks a render would show at once: details off their wall, and faces of one part drawn over each other.

const HEIGHTS = [12, 23.5, 54];
const TURNS = Array.from({ length: 36 }, (_, i) => i * 10);

/** The axis (0 = x, 1 = y) a face is flat on and where, or null for a face not flat on either. */
function planeOf(f: Face): [number, number] | null {
  for (const a of [0, 1]) {
    const x = f.v[0][a];
    if (f.v.every((p) => Math.abs(p[a] - x) < 1e-9)) return [a, x];
  }
  return null;
}

function area(q: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Convex clip (Sutherland-Hodgman), both polygons counter-clockwise in screen space (positive area here). */
function clip(subject: readonly Vec2[], clipper: readonly Vec2[]): Vec2[] {
  let out: Vec2[] = subject.slice();
  for (let i = 0; i < clipper.length && out.length; i++) {
    const a = clipper[i];
    const b = clipper[(i + 1) % clipper.length];
    const inp = out;
    out = [];
    const side = (p: Vec2): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j];
      const q = inp[(j + 1) % inp.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return out;
}

const span = (f: Face, i: number): [number, number] => [Math.min(...f.v.map((q) => q[i])), Math.max(...f.v.map((q) => q[i]))];

/** The area of a wall, for telling a wall from the detail on it: the detail is the smaller of the two. */
function wallSize(f: Face): number {
  const pl = planeOf(f);
  if (!pl) return Infinity;
  const u = 1 - pl[0];
  const [u0, u1] = span(f, u);
  const [z0, z1] = span(f, 2);
  return (u1 - u0) * (z1 - z0);
}

/** A part's faces split into details (each with the wall it sits on) and solids. */
function split(pt: Part): { solids: Face[]; details: Array<[Face, Face]> } {
  const solids: Face[] = [];
  const details: Array<[Face, Face]> = [];
  for (const f of pt.faces) {
    const pl = planeOf(f);
    const walls = pl
      ? pt.faces.filter((g) => {
          if (g === f) return false;
          const q = planeOf(g);
          return q !== null && q[0] === pl[0] && Math.abs(Math.abs(q[1] - pl[1]) - 0.004) < 1e-6;
        })
      : [];
    const wall = walls.find((g) => wallSize(g) > wallSize(f));
    if (wall) details.push([f, wall]);
    else solids.push(f);
  }
  return { solids, details };
}

describe("archetypes", () => {
  test("there are fifteen, each with a place for its effects", () => {
    expect(ARCHETYPE_IDS.length).toBe(15);
    expect(Object.keys(MODELS)).toEqual([...ARCHETYPE_IDS]);
    for (const id of ARCHETYPE_IDS) {
      const parts = MODELS[id](23.5);
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.emit).toHaveLength(3);
      expect(parts.emit.every(Number.isFinite)).toBe(true);
    }
  });

  for (const id of ARCHETYPE_IDS) {
    describe(id, () => {
      test("every coordinate, colour and shade is sound", () => {
        for (const h of HEIGHTS) {
          for (const pt of MODELS[id](h)) {
            expect(pt.c.every(Number.isFinite)).toBe(true);
            expect(Number.isFinite(pt.z0)).toBe(true);
            for (const f of pt.faces) {
              expect(f.v.length).toBeGreaterThanOrEqual(3);
              for (const v of f.v) expect(v.every(Number.isFinite)).toBe(true);
              expect(f.col).toMatch(/^#[0-9a-f]{6}$/);
              expect(f.shade).toBeGreaterThanOrEqual(0.62);
              // The sun vector is a hair longer than 1.
              expect(f.shade).toBeLessThanOrEqual(1.001);
            }
          }
        }
      });

      test("the projection is finite at every turn", () => {
        for (const h of HEIGHTS) {
          const parts = MODELS[id](h);
          for (const deg of TURNS) {
            const { ex, ey } = axes(deg);
            for (const pt of parts) for (const f of pt.faces) for (const v of f.v) {
              expect(Number.isFinite(v[0] * ex[0] + v[1] * ey[0])).toBe(true);
              expect(Number.isFinite(v[0] * ex[1] + v[1] * ey[1] - v[2])).toBe(true);
            }
          }
        }
      });

      test("no two visible solid faces of a part overlap by more than 1.5 px2", () => {
        let pairs = 0;
        for (const h of HEIGHTS) {
          for (const pt of MODELS[id](h)) {
            const { solids } = split(pt);
            for (const deg of TURNS) {
              const { ex, ey } = axes(deg);
              const vis = solids.map((f) => f.v.map((v): Vec2 => [v[0] * ex[0] + v[1] * ey[0], v[0] * ex[1] + v[1] * ey[1] - v[2]])).filter((q) => area(q) > 0.3);
              for (let i = 0; i < vis.length; i++) {
                for (let j = i + 1; j < vis.length; j++) {
                  pairs++;
                  const inter = clip(vis[i], vis[j]);
                  const a = inter.length > 2 ? Math.abs(area(inter)) : 0;
                  if (a > 1.5) throw new Error(`${id} h${h} part z0=${pt.z0} @${deg}deg: ${a.toFixed(1)} px2`);
                }
              }
            }
          }
        }
        expect(pairs).toBeGreaterThan(0);
      });

      test("each detail lies 0.004 in front of a wall of its own part, within its bounds", () => {
        for (const h of HEIGHTS) {
          for (const pt of MODELS[id](h)) {
            for (const [f, wall] of split(pt).details) {
              const u = 1 - (planeOf(f) as [number, number])[0];
              const [fu0, fu1] = span(f, u);
              const [wu0, wu1] = span(wall, u);
              const [fz0, fz1] = span(f, 2);
              const [wz0, wz1] = span(wall, 2);
              const where = `${id} h${h}: ${f.kind} u ${fu0.toFixed(3)}..${fu1.toFixed(3)} on ${wu0.toFixed(3)}..${wu1.toFixed(3)}, z ${fz0.toFixed(1)}..${fz1.toFixed(1)} on ${wz0.toFixed(1)}..${wz1.toFixed(1)}`;
              // Within the wall's box (a gable cap's pane is checked against the cap's bounding box).
              expect(fu0 >= wu0 - 0.005 && fu1 <= wu1 + 0.005 && fz0 >= wz0 - 0.5 && fz1 <= wz1 + 0.5 && fz1 > fz0, where).toBe(true);
            }
          }
        }
      });

      test("glass, panels, bulbs and screens are all details on a wall", () => {
        for (const h of HEIGHTS) {
          for (const pt of MODELS[id](h)) {
            for (const f of split(pt).solids) {
              // The film camera's lens is a lit glass cap on a pushed-out disc, a surface of its own, not a pane.
              if (f.kind !== "solid" && !(id === "film" && f.kind === "glass")) throw new Error(`${id} h${h}: ${f.kind} not on a wall`);
            }
          }
        }
      });
    });
  }
});
