/**
 * Drawing: a building as screen polygons for a turn of the map, the ground slabs and their roads,
 * and the light of the hour. A faithful port of the Project prototype's `draw`, `ground`, `faceColor` and `light`.
 */
import { BX, BY, LIFT, NIGHT, SHADE, axes, hull, mix, proj, type Box, type Vec2, type Vec3 } from "./geometry.ts";
import { MODELS, box, type ArchetypeId, type Face, type Part } from "./models.ts";

// ---- Light ----

/** How far the scene is into the evening (`n`, 0 day to 1 night) and how warm it is (`w`, 0 to 1). */
export interface LightLevel {
  readonly n: number;
  readonly w: number;
}

export type LightName = "day" | "golden" | "dusk" | "night" | "dawn";

export interface Light extends LightLevel {
  readonly name: LightName;
}

/** The light at a local hour (0 to 24, with minutes as a fraction): day, golden hour, dusk, night, dawn. */
export function lightAt(hourLocal: number): Light {
  const h = hourLocal;
  if (h >= 6.5 && h < 16.5) return { n: 0, w: 0, name: "day" };
  if (h >= 16.5 && h < 18) return { n: 0, w: Math.min(1, (h - 16.5) / 0.75), name: "golden" };
  if (h >= 18 && h < 19.5) return { n: (h - 18) / 1.5, w: (19.5 - h) / 1.5, name: h < 18.75 ? "golden" : "dusk" };
  if (h >= 5 && h < 6.5) return { n: (6.5 - h) / 1.5, w: 0, name: "dawn" };
  return { n: 1, w: 0, name: "night" };
}

/**
 * The colour of a shaded face under the light: lit glass and bulbs glow at night (and when `busy`),
 * screens glow when `busy`, everything else warms at golden hour and sinks into the night colour.
 * `hot` (the hovered building) lifts it toward white.
 */
export function faceColor(f: Pick<Face, "col" | "kind" | "shade">, L: LightLevel, busy: boolean, hot: boolean): string {
  let c: string;
  if (f.kind === "glass" || f.kind === "bulb") {
    const day = mix(SHADE, f.col, 0.86 + 0.14 * f.shade);
    const lit = busy ? "#ffe7a0" : "#ffd36e";
    c = mix(busy && f.kind === "glass" ? mix(day, "#ffffff", 0.35) : day, lit, L.n * (busy ? 1 : 0.7) + (f.kind === "bulb" && busy ? 0.6 : 0));
  } else if (f.kind === "screen") {
    c = mix(mix(SHADE, f.col, f.shade), "#6fe3ff", busy ? 1 : L.n * 0.6);
  } else {
    c = mix(SHADE, f.col, f.shade);
    if (L.w) c = mix(c, "#ffb070", 0.12 * L.w);
    if (L.n) c = mix(c, NIGHT, 0.36 * L.n);
  }
  if (hot) c = mix(c, "#ffffff", 0.18);
  return c;
}

// ---- Buildings ----

/** A built archetype at one (rounded) height: its parts and where its effects come out. */
export interface BuiltModel {
  readonly parts: readonly Part[];
  readonly emit: Vec3;
}

/** Models already built, keyed `${archetype}:${height rounded to a half}`; the caller owns the map. */
export type ModelCache = Map<string, BuiltModel>;

export interface DrawnFace {
  /** SVG polygon points, in the building's own picture box (origin at BX, BY). */
  pts: string;
  fill: string;
  stroke: string;
}

export interface DrawnBuilding {
  faces: DrawnFace[];
  /** The silhouette as polygon points, for hit testing. */
  hull: string;
  /** The footprint ring as polygon points, for the selection mark. */
  ring: string;
  /** The topmost y of the building relative to its origin (negative: above it). */
  top: number;
  /** Where the effects come out, in the picture box. */
  emit: Vec2;
}

const pts2 = (q: readonly Vec2[]): string => q.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

function modelOf(archetype: ArchetypeId, h: number, cache: ModelCache): BuiltModel {
  const hh = Math.round(h * 2) / 2;
  const key = `${archetype}:${hh}`;
  let m = cache.get(key);
  if (!m) {
    const parts = MODELS[archetype](hh);
    m = { parts, emit: parts.emit || [0, 0, 20] };
    cache.set(key, m);
  }
  return m;
}

/** One building of `archetype` and body height `h` at the turn `phi`, parts painted back to front. */
export function drawBuilding(archetype: ArchetypeId, h: number, L: LightLevel, busy: boolean, hot: boolean, phi: number, cache: ModelCache): DrawnBuilding {
  const { ex, ey } = axes(phi);
  const m = modelOf(archetype, h, cache);
  const at = (v: Vec3): Vec2 => [BX + v[0] * ex[0] + v[1] * ey[0], BY + v[0] * ex[1] + v[1] * ey[1] - v[2]];
  const order = m.parts.map((pt) => ({ pt, key: pt.c[0] * ex[1] + pt.c[1] * ey[1] + 0.6 * pt.z0 })).sort((a, b) => a.key - b.key);
  const faces: DrawnFace[] = [];
  const all: Vec2[] = [];
  for (const { pt } of order) {
    for (const f of pt.faces) {
      const q = f.v.map(at);
      for (const x of q) all.push(x);
      // Twice the signed area: a face turned away (or edge-on) has none and is not drawn.
      let area = 0;
      for (let i = 0; i < q.length; i++) {
        const a = q[i];
        const b = q[(i + 1) % q.length];
        area += a[0] * b[1] - b[0] * a[1];
      }
      if (area <= 0.6) continue;
      const fill = faceColor(f, L, busy, hot);
      faces.push({ pts: pts2(q), fill, stroke: mix(fill, NIGHT, 0.3) });
    }
  }
  let top = Infinity;
  for (const x of all) top = Math.min(top, x[1]);
  const ring = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]) => at([a * 0.4, b * 0.4, 0]));
  return { faces, hull: pts2(hull(all)), ring: pts2(ring), top: top - BY, emit: at(m.emit) };
}

// ---- Ground ----

/** Trees and lamps, as ground points in grid units; the scenery sorts among the buildings by `depth`. */
export const TREES: readonly Vec2[] = [[1.0, 2.4], [1.32, 2.28], [0.68, 2.32], [3.4, -0.38], [-1.95, 2.05], [-0.42, -0.4], [3.45, 2.45], [-0.42, 2.45], [1.5, -0.42], [-1.92, 0.12], [2.55, 2.42]];
export const LAMPS: readonly Vec2[] = [[0.5, 0.14], [2.5, 0.14], [1.5, 1.14], [3.14, 1.5], [0.5, 2.14], [-0.14, 1.5]];

/** Road segments between ground points (the lane to the floating island is added by `buildGround`). */
export const ROADS: ReadonlyArray<readonly [Vec2, Vec2]> = [
  [[0, 0], [3, 0]], [[0, 1], [3, 1]], [[0, 2], [3, 2]],
  [[0, 0], [0, 2]], [[1, 0], [1, 1]], [[2, 0], [2, 2]], [[3, 0], [3, 2]],
  [[-1.65, 0.55], [-1.65, 1.65]], [[-1.65, 1], [0, 1]],
];

export const SLAB_IDS = ["town", "ws", "ext"] as const;
export type SlabId = (typeof SLAB_IDS)[number];

interface SlabSpec {
  readonly id: SlabId;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Thickness. */
  readonly T: number;
  /** The level of its top. */
  readonly L: number;
  readonly top: string;
  readonly side: string;
  readonly cloud?: boolean;
}

const SLABS: readonly SlabSpec[] = [
  { id: "town", x0: -0.6, y0: -0.6, x1: 3.6, y1: 2.6, T: 16, L: 0, top: "#bfdca2", side: "#c9a273" },
  { id: "ws", x0: -2.15, y0: 0, x1: -1.15, y1: 2.2, T: 12, L: 0, top: "#c9e2b0", side: "#c9a273" },
  { id: "ext", x0: 0.4, y0: -2.2, x1: 3.6, y1: -1.1, T: 12, L: LIFT, top: "#f3f6fb", side: "#d3deec", cloud: true },
];

export interface GroundFace {
  /** SVG path. */
  d: string;
  col: string;
  shade: number;
}

/** A puff of cloud under the floating island; the numbers the prototype formats as text stay text. */
export interface GroundPuff {
  x: string;
  y: string;
  rx: number;
  ry: string;
}

export interface GroundSlab {
  faces: GroundFace[];
  puffs: GroundPuff[];
  /** The picture y of the slab's centre. */
  depth: number;
  /** Paint order among the slabs, from 2. */
  z: number;
}

export interface Ground {
  phi: number;
  /** In `SLAB_IDS` order. */
  slabs: GroundSlab[];
  /** One SVG path of all the roads, the lane to the floating island included. */
  roads: string;
  /** The floating island's shadow on the town, an SVG path. */
  shadow: string;
  /** Where each slab's label goes (below its front corner). */
  lb: Record<SlabId, { x: number; y: number }>;
  /** What the picture covers, with room above for the buildings and below for the labels. */
  box: Box;
}

const path = (ps: readonly Vec2[]): string => `M${ps.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}Z`;

/** The slabs, roads and shadow for the turn `phi`. Build once per turn, not once per frame. */
export function buildGround(phi: number): Ground {
  const p = phi || 0;
  const bounds: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const lb = {} as Record<SlabId, { x: number; y: number }>;
  const slabs: GroundSlab[] = SLABS.map((s) => {
    const solid = box(s.x0, s.y0, s.x1, s.y1, s.L - s.T, s.L, s.side, s.top);
    const faces: GroundFace[] = [];
    const pts: Vec2[] = [];
    for (const f of solid.faces) {
      const q = f.v.map((v) => proj(p, v[0], v[1], v[2]));
      let area = 0;
      for (let i = 0; i < q.length; i++) {
        const a = q[i];
        const b = q[(i + 1) % q.length];
        area += a[0] * b[1] - b[0] * a[1];
      }
      for (const x of q) pts.push(x);
      if (area > 0.6) faces.push({ d: path(q), col: f.col, shade: f.shade });
    }
    for (const [x, y] of pts) {
      bounds.x0 = Math.min(bounds.x0, x);
      bounds.x1 = Math.max(bounds.x1, x);
      bounds.y0 = Math.min(bounds.y0, y);
      bounds.y1 = Math.max(bounds.y1, y);
    }
    const front = pts.reduce((a, b) => (b[1] > a[1] ? b : a));
    lb[s.id] = { x: Math.round(front[0]), y: Math.round(front[1] + 8) };
    const puffs: GroundPuff[] = [];
    if (s.cloud) {
      const z = s.L - s.T + 2;
      const at: ReadonlyArray<readonly [number, number, number]> = [
        [s.x0, s.y0, 18], [s.x1, s.y0, 16], [s.x1, s.y1, 20], [s.x0, s.y1, 17],
        [(s.x0 + s.x1) / 2, s.y1, 22], [s.x1, (s.y0 + s.y1) / 2, 19], [(s.x0 + s.x1) / 2, s.y0, 15], [s.x0, (s.y0 + s.y1) / 2, 16],
      ];
      for (const [gx, gy, r] of at) {
        const [x, y] = proj(p, gx, gy, z);
        puffs.push({ x: x.toFixed(1), y: (y + 4).toFixed(1), rx: r, ry: (r * 0.55).toFixed(1) });
      }
    }
    const [, cy] = proj(p, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, 0);
    return { faces, puffs, depth: cy, z: 0 };
  });
  slabs.slice().sort((a, b) => a.depth - b.depth).forEach((s, i) => {
    s.z = 2 + i;
  });
  bounds.y0 -= 130;
  bounds.y1 += 30;
  const pt = (x: number, y: number, lift: number): string => {
    const [px, py] = proj(p, x, y, lift);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  };
  let roads = ROADS.map(([a, b]) => `M${pt(a[0], a[1], 0)}L${pt(b[0], b[1], 0)}`).join("");
  roads += `M${pt(1, -1.65, LIFT)}L${pt(3, -1.65, LIFT)}`;
  const shadow = path(([[0.5, -2.05], [3.7, -2.05], [3.7, -0.95], [0.5, -0.95]] as const).map(([x, y]) => proj(p, x, y, 0)));
  return { phi: p, slabs, roads, shadow, lb, box: bounds };
}
