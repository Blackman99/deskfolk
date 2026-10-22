/**
 * Drawing: a building as screen polygons for a turn of the map, the ground slabs and their roads,
 * and the light of the hour. A faithful port of the Project prototype's `draw`, `ground`, `faceColor` and `light`.
 */
import { BX, BY, LIFT, LIGHT, NIGHT, SHADE, W, axes, hull, mix, plot, proj, type Box, type Vec2, type Vec3 } from "./geometry.ts";
import { MODELS, box, type ArchetypeId, type Face, type Part } from "./models.ts";

// ---- Light ----

/** How far the scene is into the evening (`n`, 0 day to 1 night) and how warm it is (`w`, 0 to 1). */
export interface LightLevel {
  readonly n: number;
  readonly w: number;
}

export type LightName = "day" | "golden" | "dusk" | "night" | "dawn";

/** What hangs in the sky, and how high: 0 on the horizon, 1 at the top of its arc. */
export interface SkyBody {
  readonly kind: "sun" | "moon";
  readonly height: number;
}

export interface Light extends LightLevel {
  readonly name: LightName;
  /** Toward the sun by day and the moon by night: a unit vector in the modeller's space (grid x and y at W px, z in px). */
  readonly dir: Vec3;
  /** How much the light comes from somewhere: 0 with its body on the horizon (the sky's even light, no shadows), up to 1. */
  readonly cast: number;
  readonly body: SkyBody;
}

/** The light a building or the ground is shaded by; a bare level (a story's, a test's) keeps the prototype's fixed sun. */
export type Lighting = LightLevel & { readonly dir?: Vec3; readonly cast?: number };

/** The compass on the ground: north is grid (-1, -1), up the screen at turn 0, where the dial's needle points. */
const EAST: Vec2 = [Math.SQRT1_2, -Math.SQRT1_2];
const SOUTH: Vec2 = [Math.SQRT1_2, Math.SQRT1_2];
/** The sun is up from 6:00 to 19:00, so golden hour still has it low in the west; the moon has the rest. */
const SUNRISE = 6;
const SUNSET = 19;
const SUN_TOP = (58 * Math.PI) / 180;
const MOON_TOP = (40 * Math.PI) / 180;
/** How high a body stands before its light has its whole direction: below it shading flattens and shadows fade. */
const CLEAR = (15 * Math.PI) / 180;
/** Moonlight casts at most this much of what sunlight does. */
const MOON_CAST = 0.5;

const smooth = (x: number): number => {
  const s = Math.min(1, Math.max(0, x));
  return s * s * (3 - 2 * s);
};

/** A body `t` of the way across the sky (0 rising in the east, 1 setting in the west, through the south), at most `top` high. */
function arc(t: number, top: number): { dir: Vec3; elev: number } {
  const az = Math.PI * t;
  const gx = Math.cos(az) * EAST[0] + Math.sin(az) * SOUTH[0];
  const gy = Math.cos(az) * EAST[1] + Math.sin(az) * SOUTH[1];
  const elev = top * Math.max(0, Math.sin(Math.PI * t));
  return { dir: [gx * Math.cos(elev), gy * Math.cos(elev), Math.sin(elev)], elev };
}

/**
 * The light at a local hour (0 to 24, with minutes as a fraction): day, golden hour, dusk, night, dawn,
 * and where it comes from: the sun rises in the east at 6:00 and sets in the west at 19:00, the moon
 * takes the night the same way across. Whichever is up lights the town; at the horizon, where they
 * hand over, the light has no direction, so nothing jumps.
 */
export function lightAt(hourLocal: number): Light {
  const h = hourLocal;
  const sunT = (h - SUNRISE) / (SUNSET - SUNRISE);
  const up = sunT > 0 && sunT < 1;
  const moonT = (((h - SUNSET) % 24) + 24) % 24 / (24 - SUNSET + SUNRISE);
  const top = up ? SUN_TOP : MOON_TOP;
  const { dir, elev } = arc(up ? sunT : moonT, top);
  const cast = (up ? 1 : MOON_CAST) * smooth(elev / CLEAR);
  const at = { dir, cast, body: { kind: up ? ("sun" as const) : ("moon" as const), height: elev / top } };
  if (h >= 6.5 && h < 16.5) return { n: 0, w: 0, name: "day", ...at };
  if (h >= 16.5 && h < 18) return { n: 0, w: Math.min(1, (h - 16.5) / 0.75), name: "golden", ...at };
  if (h >= 18 && h < 19.5) return { n: (h - 18) / 1.5, w: (19.5 - h) / 1.5, name: h < 18.75 ? "golden" : "dusk", ...at };
  if (h >= 5 && h < 6.5) return { n: (6.5 - h) / 1.5, w: 0, name: "dawn", ...at };
  return { n: 1, w: 0, name: "night", ...at };
}

/** What a face turned away from the light, or the light with no direction, still gets of it: the sky's even light. */
const FLAT = 0.55;

/**
 * A face's shade under a light: the more squarely it faces the light, the brighter, flattening toward the sky's
 * even light as the body nears the horizon. A bare level keeps the face's shade under the prototype's fixed sun.
 */
export function shadeOf(f: Pick<Face, "n" | "shade">, L: Lighting): number {
  if (!L.dir) return f.shade;
  const lam = Math.max(0, f.n[0] * L.dir[0] + f.n[1] * L.dir[1] + f.n[2] * L.dir[2]);
  const c = L.cast ?? 1;
  return 0.62 + 0.38 * (lam * c + FLAT * (1 - c));
}

/** Where a lighting comes from: the hour's sun or moon, or the prototype's fixed sun for a bare level. */
export function lightDir(L: Lighting): Vec3 {
  return L.dir ?? LIGHT;
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

/** One building of `archetype` and body height `h` at the turn `phi`, parts painted back to front, shaded by the hour's light. */
export function drawBuilding(archetype: ArchetypeId, h: number, L: Lighting, busy: boolean, hot: boolean, phi: number, cache: ModelCache): DrawnBuilding {
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
      const fill = faceColor({ col: f.col, kind: f.kind, shade: shadeOf(f, L) }, L, busy, hot);
      faces.push({ pts: pts2(q), fill, stroke: mix(fill, NIGHT, 0.3) });
    }
  }
  let top = Infinity;
  for (const x of all) top = Math.min(top, x[1]);
  const ring = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]) => at([a * 0.4, b * 0.4, 0]));
  return { faces, hull: pts2(hull(all)), ring: pts2(ring), top: top - BY, emit: at(m.emit) };
}

// ---- Shadows ----

/** Below this the light comes in so low that a shadow would cross the town: it stops at the length it has here. */
const SHADOW_MIN_Z = 0.3;

/** Where a point `z` px up falls on the ground under the light, in grid units from the point beneath it. */
export function castOffset(z: number, dir: Vec3): Vec2 {
  const t = z / Math.max(dir[2], SHADOW_MIN_Z);
  return [(-dir[0] * t) / W, (-dir[1] * t) / W];
}

/** A ground offset in grid units, in picture px at the turn `phi`. */
function onPicture(phi: number, g: Vec2): Vec2 {
  const { ex, ey } = axes(phi);
  return [g[0] * ex[0] + g[1] * ey[0], g[0] * ex[1] + g[1] * ey[1]];
}

/** A flat ring on the ground, as picture px points around `c`: a circle seen from above at the map's 2:1. */
function ring(c: Vec2, r: number): Vec2[] {
  return Array.from({ length: 12 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 6), c[1] + (r / 2) * Math.sin((i * Math.PI) / 6)] as const);
}

const outlines = new Map<string, Vec2[][]>();

/**
 * A building's shadow on the ground: the hull of each part's corners cast along the light, in picture px from
 * the building's ground point. Kept by shape, turn and light, so a map at rest builds the very same outline.
 */
export function shadowOf(archetype: ArchetypeId, h: number, phi: number, dir: Vec3, cache: ModelCache): Vec2[][] {
  const hh = Math.round(h * 2) / 2;
  const key = `${archetype}:${hh}:${phi}:${dir.map((x) => x.toFixed(4)).join(",")}`;
  let out = outlines.get(key);
  if (out) return out;
  out = modelOf(archetype, hh, cache).parts.map((pt) => {
    const pts: Vec2[] = [];
    for (const f of pt.faces) for (const v of f.v) {
      const o = castOffset(v[2], dir);
      pts.push(onPicture(phi, [v[0] + o[0], v[1] + o[1]]));
    }
    return hull(pts);
  });
  if (outlines.size > 600) outlines.clear();
  outlines.set(key, out);
  return out;
}

/** A tree's shadow, in picture px from its foot: a pine's cone, or a round crown's blob on its trunk. */
export function treeShadow(pine: boolean, phi: number, dir: Vec3): Vec2[] {
  const at = (z: number) => onPicture(phi, castOffset(z, dir));
  const pts: Vec2[] = [[-2, 0], [2, 0]];
  if (pine) {
    const [bx, by] = at(7);
    pts.push(at(37), [bx - 11, by], [bx + 11, by]);
  } else pts.push(...ring(at(14), 11), ...ring(at(28), 11));
  return hull(pts);
}

/** A lamp's shadow, in picture px from its foot: the pole and the bulb on top of it. */
export function lampShadow(phi: number, dir: Vec3): Vec2[] {
  const top = onPicture(phi, castOffset(26, dir));
  return hull([[-1, 0], [1, 0], [top[0] - 1, top[1]], [top[0] + 1, top[1]], ...ring(onPicture(phi, castOffset(28, dir)), 4)]);
}

// ---- Ground ----

/** A point on the town's plan, in plots, as a ground point in grid units. */
const onPlan = ([x, y]: Vec2): Vec2 => [plot(x), plot(y)];

/** Trees and lamps, as ground points in grid units (placed on the plan); the scenery sorts among the buildings by `depth`. */
export const TREES: readonly Vec2[] = ([[1.0, 2.4], [1.32, 2.28], [0.68, 2.32], [3.4, -0.38], [-1.95, 2.05], [-0.42, -0.4], [3.45, 2.45], [-0.42, 2.45], [1.5, -0.42], [-1.92, 0.12], [2.55, 2.42]] as const).map(onPlan);
export const LAMPS: readonly Vec2[] = ([[0.5, 0.14], [2.5, 0.14], [1.5, 1.14], [3.14, 1.5], [0.5, 2.14], [-0.14, 1.5]] as const).map(onPlan);

/** Road segments between ground points (the lane to the floating island is added by `buildGround`). */
export const ROADS: ReadonlyArray<readonly [Vec2, Vec2]> = ([
  [[0, 0], [3, 0]], [[0, 1], [3, 1]], [[0, 2], [3, 2]],
  [[0, 0], [0, 2]], [[1, 0], [1, 1]], [[2, 0], [2, 2]], [[3, 0], [3, 2]],
  [[-1.65, 0.55], [-1.65, 1.65]], [[-1.65, 1], [0, 1]],
] as const).map(([a, b]) => [onPlan(a), onPlan(b)] as const);

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

/** The islands, their corners on the plan. */
const SLABS: readonly SlabSpec[] = ([
  { id: "town", x0: -0.6, y0: -0.6, x1: 3.6, y1: 2.6, T: 16, L: 0, top: "#bfdca2", side: "#c9a273" },
  { id: "ws", x0: -2.15, y0: 0, x1: -1.15, y1: 2.2, T: 12, L: 0, top: "#c9e2b0", side: "#c9a273" },
  { id: "ext", x0: 0.4, y0: -2.2, x1: 3.6, y1: -1.1, T: 12, L: LIFT, top: "#f3f6fb", side: "#d3deec", cloud: true },
] satisfies readonly SlabSpec[]).map((s) => ({ ...s, x0: plot(s.x0), y0: plot(s.y0), x1: plot(s.x1), y1: plot(s.y1) }));

export interface GroundFace {
  /** SVG path. */
  d: string;
  col: string;
  shade: number;
  /** Its outward unit normal, for the hour's light (`shadeOf`). */
  n: Vec3;
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
  /** The floating island's shadow on the air beneath it, an SVG path: a cue that it floats, whatever the hour. */
  shadow: string;
  /** Each slab's top as an SVG path: what the shadows on that island are clipped to. */
  tops: Record<SlabId, string>;
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
  const tops = {} as Record<SlabId, string>;
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
      if (area > 0.6) faces.push({ d: path(q), col: f.col, shade: f.shade, n: f.n });
      if (f.n[2] > 0.9) tops[s.id] = path(q);
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
  roads += `M${pt(plot(1), plot(-1.65), LIFT)}L${pt(plot(3), plot(-1.65), LIFT)}`;
  const shadow = path(([[0.5, -2.05], [3.7, -2.05], [3.7, -0.95], [0.5, -0.95]] as const).map(([x, y]) => proj(p, plot(x), plot(y), 0)));
  return { phi: p, slabs, roads, shadow, tops, lb, box: bounds };
}

/**
 * The floating island's shadow cast along the light, as an SVG path: drawn only where it falls on the town
 * (the low morning sun can lay it there). On the air it stays the ground's fixed `shadow`: cast there by a low
 * sun it would hang off the island as a long grey sheet.
 */
export function islandShadow(phi: number, dir: Vec3): string {
  const s = SLABS.find((x) => x.id === "ext")!;
  const pts: Vec2[] = [];
  for (const z of [s.L - s.T, s.L]) {
    const [ox, oy] = castOffset(z, dir);
    for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y0], [s.x1, s.y1], [s.x0, s.y1]] as const) pts.push(proj(phi, x + ox, y + oy, 0));
  }
  return path(hull(pts));
}
