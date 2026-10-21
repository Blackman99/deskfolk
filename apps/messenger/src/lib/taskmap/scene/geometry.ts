/**
 * The town's projection: a ground grid turned by `phi` degrees and drawn as an oblique picture.
 * Pure functions of `phi`, no state beyond a one-entry memo. A port of the Project prototype.
 */

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

/** A rectangle in picture px. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Grid cell width in px (one grid unit along either ground axis, before the turn). */
export const A = 96;
/** Half the footprint of a place's building, in grid units (the prototype declares it and never reads it). */
export const S = 0.3;
/** Body height of a place nobody visited, and of the busiest one. */
export const HMIN = 12;
export const HMAX = 54;
/** How high the floating island sits above the town, in px. */
export const LIFT = 30;
/** The grid point that lands on (CX, CY). */
export const PX = 1.5;
export const PY = 1;
export const CX = 508;
export const CY = 395;
/** Where a building's own origin sits in its picture box. */
export const BX = 90;
export const BY = 190;
/** Px per grid unit for the shading normals, so ground x, y and the px z are on one scale. */
export const W = 136;
/** The sun never moves. */
export const LIGHT: Vec3 = [-0.315, 0.495, 0.81];
export const SHADE = "#232a3b";
export const NIGHT = "#1a2244";

export interface Axes {
  readonly phi: number;
  /** Where one step along grid x lands, in px. */
  readonly ex: Vec2;
  /** Where one step along grid y lands, in px. */
  readonly ey: Vec2;
  /** The unit vector in grid units that points at the viewer (toward the screen's bottom). */
  readonly front: Vec2;
}

let lastAxes: Axes | null = null;

export function axes(phi: number): Axes {
  const p = phi || 0;
  if (lastAxes && lastAxes.phi === p) return lastAxes;
  const r = (p * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const ex: Vec2 = [(c - s) * A, ((c + s) * A) / 2];
  const ey: Vec2 = [-(s + c) * A, ((c - s) * A) / 2];
  const fl = Math.hypot(ex[1], ey[1]);
  lastAxes = { phi: p, ex, ey, front: [ex[1] / fl, ey[1] / fl] };
  return lastAxes;
}

/** A ground point (grid units) and a lift (px) to its place in the picture. */
export function proj(phi: number, gx: number, gy: number, lift?: number): Vec2 {
  const { ex, ey } = axes(phi);
  const dx = gx - PX;
  const dy = gy - PY;
  return [CX + dx * ex[0] + dy * ey[0], CY + dx * ex[1] + dy * ey[1] - (lift || 0)];
}

/** The ground point (grid units) under a picture point, the inverse of `proj` at lift 0. */
export function unproj(phi: number, wx: number, wy: number): Vec2 {
  const { ex, ey } = axes(phi);
  const X = wx - CX;
  const Y = wy - CY;
  const det = ex[0] * ey[1] - ey[0] * ex[1];
  return [PX + (X * ey[1] - ey[0] * Y) / det, PY + (ex[0] * Y - ex[1] * X) / det];
}

/** Paint order of a ground point: further down the picture is in front. */
export function depth(phi: number, gx: number, gy: number): number {
  return 100 + Math.round(((proj(phi, gx, gy, 0)[1] - CY) / (A / 2)) * 10);
}

/** Convex hull (monotone chain), counter-clockwise on screen with y down. */
export function hull(pts: readonly Vec2[]): Vec2[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Vec2[] = [];
  const up: Vec2[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

const rgbCache = new Map<string, readonly [number, number, number]>();

/** A `#rrggbb` colour's channels, 0 to 255. */
export function rgb(hex: string): readonly [number, number, number] {
  let c = rgbCache.get(hex);
  if (!c) {
    c = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    rgbCache.set(hex, c);
  }
  return c;
}

/** A mix of two `#rrggbb` colours, `t` of the way from `a` to `b`; the ends come back as they were given. */
export function mix(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const x = rgb(a);
  const y = rgb(b);
  let out = "#";
  for (let i = 0; i < 3; i++) out += Math.round(x[i] + (y[i] - x[i]) * t).toString(16).padStart(2, "0");
  return out;
}
