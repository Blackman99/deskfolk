/**
 * The modeller and the building archetypes. Parts are in a place's own grid units (x, y; the footprint
 * is ±0.3) and px (z, up). A faithful port of the Project prototype: every coordinate and colour is its.
 */
import { LIGHT, W, type Vec2, type Vec3 } from "./geometry.ts";

export type FaceKind = "solid" | "glass" | "panel" | "bulb" | "screen";

/** One shaded, outward-wound face of a part. */
export interface Face {
  readonly v: readonly Vec3[];
  readonly col: string;
  readonly kind: FaceKind;
  /** Its shade under the prototype's fixed sun, `LIGHT`; `shadeOf` gives it under the hour's. */
  readonly shade: number;
  /** Its outward unit normal, in the space the light is in (grid x and y at W px, z in px). */
  readonly n: Vec3;
}

/** A convex piece: its centre, the z it stands on (for paint order) and its faces. */
export interface Part {
  readonly c: Vec3;
  readonly z0: number;
  readonly faces: readonly Face[];
}

/** A face as the modeller is given it, before it is wound and shaded. */
export interface FaceSpec {
  v: readonly Vec3[];
  col: string;
  kind?: FaceKind;
}

/** A flat detail; `n` is the way it faces when that is not simply away from the part's centre. */
export interface Decal extends FaceSpec {
  n?: Vec3;
}

/** A wall of a box, named by its axis and the side it faces. */
export type PaneSide = "x+" | "x-" | "y+" | "y-";

/** A building's parts, and where its effects come out (in the same units as a part). */
export type PartList = Part[] & { emit: Vec3 };
export type ModelBuilder = (h: number) => PartList;

export const ARCHETYPE_IDS = ["camp", "song", "bible", "board", "scratch", "tools", "keys", "clips", "edit", "review", "paint", "film", "mail", "kit", "others", "relay"] as const;
export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

// ---- The modeller ----

/** A convex part: every face is wound outward and shaded once under `LIGHT`, its normal kept for the hour's light. */
export function part(faces: readonly FaceSpec[], c: Vec3, z0: number, decals?: readonly Decal[]): Part {
  const L = LIGHT;
  const out: Face[] = [];
  const add = (f: FaceSpec, want?: Vec3): void => {
    let v = f.v;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < v.length; i++) {
      const a = v[i];
      const b = v[(i + 1) % v.length];
      nx += (a[1] - b[1]) * W * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]) * W;
      nz += (a[0] - b[0]) * W * (a[1] + b[1]) * W;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    let wx: number;
    let wy: number;
    let wz: number;
    if (want) [wx, wy, wz] = want;
    else {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const p of v) {
        sx += p[0];
        sy += p[1];
        sz += p[2];
      }
      wx = (sx / v.length - c[0]) * W;
      wy = (sy / v.length - c[1]) * W;
      wz = sz / v.length - c[2];
    }
    if (nx * wx + ny * wy + nz * wz < 0) {
      v = v.slice().reverse();
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    if (nz < -0.9) return;
    const lam = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    out.push({ v, col: f.col, kind: f.kind || "solid", shade: 0.62 + 0.38 * lam, n: [nx, ny, nz] });
  };
  for (const f of faces) add(f);
  for (const d of decals || []) add(d, d.n);
  return { c, z0, faces: out };
}

export function box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, col: string, top?: string, decals?: readonly Decal[]): Part {
  const f: FaceSpec[] = [
    { v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], col: top || col },
    { v: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], col },
    { v: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], col },
    { v: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], col },
    { v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], col },
  ];
  return part(f, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], z0, decals);
}

/** A convex profile pushed along an axis: 'x' takes [y, z] points from x = a0 to a1, 'y' takes [x, z] points. */
export function ext(axis: "x" | "y", a0: number, a1: number, prof: readonly Vec2[], col: string, cap?: string, capKind?: FaceKind, decals?: readonly Decal[]): Part {
  const P = (a: number, p: Vec2): Vec3 => (axis === "x" ? [a, p[0], p[1]] : [p[0], a, p[1]]);
  const f: FaceSpec[] = [
    { v: prof.map((p) => P(a0, p)), col: cap || col, kind: capKind },
    { v: prof.map((p) => P(a1, p)), col: cap || col, kind: capKind },
  ];
  for (let i = 0; i < prof.length; i++) {
    const p = prof[i];
    const q = prof[(i + 1) % prof.length];
    f.push({ v: [P(a0, p), P(a1, p), P(a1, q), P(a0, q)], col });
  }
  let su = 0;
  let sz = 0;
  for (const p of prof) {
    su += p[0];
    sz += p[1];
  }
  return part(f, P((a0 + a1) / 2, [su / prof.length, sz / prof.length]), Math.min(...prof.map((p) => p[1])), decals);
}

/** A cylinder, frustum or cone (r1 = 0) standing on the ground plane. */
export function cyl(cx: number, cy: number, r0: number, r1: number, z0: number, z1: number, col: string, n: number, rot?: number, top?: string): Part {
  const ring = (r: number, z: number): Vec3[] =>
    Array.from({ length: n }, (_, k): Vec3 => {
      const a = (rot || 0) + (2 * Math.PI * k) / n;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
    });
  const b = ring(r0, z0);
  const t = r1 > 0 ? ring(r1, z1) : null;
  const f: FaceSpec[] = [];
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    f.push({ v: t ? [b[k], b[k2], t[k2], t[k]] : [b[k], b[k2], [cx, cy, z1]], col });
  }
  if (t) f.push({ v: t, col: top || col });
  return part(f, [cx, cy, (z0 + z1) / 2], z0);
}

/** A flat detail a hair in front of a wall: side 'x+' is the wall at x = at, facing +x; u runs along the wall. */
export function pane(side: PaneSide, at: number, u0: number, u1: number, z0: number, z1: number, col: string, kind: FaceKind): Decal {
  const s = side[1] === "+" ? 1 : -1;
  const a = at + s * 0.004;
  const v: Vec3[] =
    side[0] === "x"
      ? [[a, u0, z0], [a, u1, z0], [a, u1, z1], [a, u0, z1]]
      : [[u0, a, z0], [u1, a, z0], [u1, a, z1], [u0, a, z1]];
  return { v, col, kind, n: side[0] === "x" ? [s, 0, 0] : [0, s, 0] };
}

/** Rows of windows on one wall, as many as the wall is tall. */
export function windows(side: PaneSide, at: number, u0: number, u1: number, h: number, cols: number, z0?: number): Decal[] {
  const out: Decal[] = [];
  const base = z0 || 0;
  const rows = Math.max(1, Math.floor((h - base - 6) / 13));
  const cw = (u1 - u0) / cols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z = base + 4 + r * 13;
      out.push(pane(side, at, u0 + cw * (c + 0.28), u0 + cw * (c + 0.72), z, Math.min(z + 7, h - 2), "#cfe6f0", "glass"));
    }
  }
  return out;
}

/** Windows on all four walls of a box (the turned-away ones are culled with their wall). */
export function allWindows(x0: number, y0: number, x1: number, y1: number, h: number, cols: number, z0?: number): Decal[] {
  return [...windows("x+", x1, y0, y1, h, cols, z0), ...windows("x-", x0, y0, y1, h, cols, z0), ...windows("y+", y1, x0, x1, h, cols, z0), ...windows("y-", y0, x0, x1, h, cols, z0)];
}

export function gable(axis: "x" | "y", a0: number, a1: number, b0: number, b1: number, z: number, rise: number, col: string, cap?: string): Part {
  return ext(axis, a0, a1, [[b0, z], [(b0 + b1) / 2, z + rise], [b1, z]], col, cap);
}

/** An ellipse of n points in a (horizontal, vertical) profile plane, to push along an axis with `ext`. */
export function disc(cx: number, cz: number, r: number, rz: number, n: number): Vec2[] {
  return Array.from({ length: n }, (_, k): Vec2 => {
    const a = (2 * Math.PI * k) / n;
    return [cx + r * Math.cos(a), cz + rz * Math.sin(a)];
  });
}

function withEmit(parts: Part[], emit: Vec3): PartList {
  return Object.assign(parts, { emit });
}

// ---- The building archetypes; a place picks one by its `model`. h is the body height, which grows with visits. ----

export const MODELS: Readonly<Record<ArchetypeId, ModelBuilder>> = {
  // A tent on a wooden deck, flag flying.
  camp: (h) => {
    const th = 22 + h * 0.75;
    const flag: Vec3[] = [[-0.235, -0.24, th + 15], [-0.07, -0.24, th + 11], [-0.235, -0.24, th + 6]];
    const parts = [
      box(-0.3, -0.3, 0.3, 0.3, 0, 4, "#b98d61", "#d6b285"),
      ext("x", -0.24, 0.24, [[-0.27, 4], [0, th], [0.27, 4]], "#ee9550", "#f6b47e", "solid", [
        pane("x+", 0.24, -0.07, 0.07, 4, 4 + (th - 4) * 0.42, "#8a4f2b", "solid"),
        pane("x-", -0.24, -0.07, 0.07, 4, 4 + (th - 4) * 0.42, "#8a4f2b", "solid"),
      ]),
      cyl(-0.24, -0.24, 0.014, 0.014, 4, th + 16, "#6b5a4a", 4, Math.PI / 4),
      part([], [-0.17, -0.24, th + 10], th + 6, [{ v: flag, col: "#2a9d8f", n: [0, 1, 0] }, { v: flag, col: "#2a9d8f", n: [0, -1, 0] }]),
    ];
    return withEmit(parts, [0, 0, th]);
  },
  // A domed studio with an antenna.
  song: (h) => {
    const dome = "#bcb1ee";
    const parts = [
      box(-0.27, -0.27, 0.27, 0.27, 0, h, "#8c7bd3", "#a294dc", allWindows(-0.27, -0.27, 0.27, 0.27, h, 2)),
      cyl(0, 0, 0.23, 0.21, h, h + 5, dome, 12),
      cyl(0, 0, 0.21, 0.16, h + 5, h + 11, dome, 12),
      cyl(0, 0, 0.16, 0.08, h + 11, h + 15.5, dome, 12),
      cyl(0, 0, 0.08, 0, h + 15.5, h + 17.5, dome, 12),
      cyl(0, 0, 0.012, 0.012, h + 17, h + 32, "#4d4380", 4, Math.PI / 4),
      box(-0.026, -0.026, 0.026, 0.026, h + 32, h + 36, "#e5484d"),
    ];
    return withEmit(parts, [0, 0, h + 36]);
  },
  // A library with a portico of columns under a pediment.
  bible: (h) => {
    const parts = [
      box(-0.3, 0.12, 0.3, 0.3, 0, 3, "#e5d8ba", "#efe5cc"),
      box(-0.28, -0.28, 0.28, 0.12, 0, h, "#b8574a", "#c4675a", [
        ...windows("x+", 0.28, -0.28, 0.12, h, 2), ...windows("x-", -0.28, -0.28, 0.12, h, 2), ...windows("y-", -0.28, -0.28, 0.28, h, 3),
        pane("y+", 0.12, -0.06, 0.06, 3, Math.max(8, h * 0.6), "#5a2a24", "solid"),
      ]),
      ...[-0.22, -0.08, 0.06, 0.2].map((x) => box(x - 0.022, 0.215, x + 0.022, 0.259, 3, h, "#f3ead6")),
      gable("y", -0.31, 0.31, -0.31, 0.31, h, 16, "#7f3a31", "#f3ead6"),
    ];
    return withEmit(parts, [0, 0, h + 16]);
  },
  // A billboard on legs, a storyboard of panels on both faces.
  board: (h) => {
    const z0 = 6 + h * 0.45;
    const z1 = z0 + 26 + h * 0.55;
    const rowH = (z1 - z0 - 6) / 2;
    const cols = ["#7fb7d9", "#ef9a8a", "#9fd18b", "#f6d8a8", "#b9a6e8", "#86d0c8"];
    const panes: Decal[] = [];
    const faces: ReadonlyArray<readonly [PaneSide, number, number]> = [["y+", 0.045, 0], ["y-", -0.045, 2]];
    for (const [side, at, shift] of faces) {
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 3; c++) {
          const u0 = -0.29 + c * 0.195;
          const zz = z0 + 3 + r * rowH;
          panes.push(pane(side, at, u0 + 0.012, u0 + 0.183, zz + 1.5, zz + rowH - 1.5, cols[(r * 3 + c + shift) % 6], "panel"));
        }
      }
    }
    const parts = [
      box(-0.22, -0.02, -0.18, 0.02, 0, z0, "#59636b"),
      box(0.18, -0.02, 0.22, 0.02, 0, z0, "#59636b"),
      box(-0.31, -0.045, 0.31, 0.045, z0, z1, "#f2c14e", "#f6d47a", panes),
    ];
    return withEmit(parts, [0, 0, z1]);
  },
  // A leaning pile of paper with a pencil and a crumpled ball on top.
  scratch: (h) => {
    const s = 3 + h / 5;
    const sheets: ReadonlyArray<readonly [number, number, number, string]> = [[0, 0, 0.25, "#f4efe1"], [0.03, -0.02, 0.24, "#e2d9c1"], [-0.025, 0.03, 0.23, "#f8f5ec"], [0.02, 0.02, 0.22, "#e8e0cb"]];
    const parts = sheets.map(([x, y, r, col], i) => box(x - r, y - r, x + r, y + r, i * s, (i + 1) * s, col, "#fbf9f3"));
    const top = 4 * s;
    parts.push(box(-0.2, -0.02, 0.14, 0.02, top, top + 5, "#f2c14e"));
    parts.push(box(0.14, -0.02, 0.2, 0.02, top, top + 5, "#f1d3a8"));
    parts.push(box(-0.24, -0.02, -0.2, 0.02, top, top + 5, "#ef8fa0"));
    parts.push(cyl(-0.08, 0.13, 0.06, 0.045, top, top + 8, "#d9d2bf", 6, 0.3));
    return withEmit(parts, [0, 0, top + 6]);
  },
  // A workshop with a sawtooth roof and a smoking chimney.
  tools: (h) => {
    const parts = [
      box(-0.28, -0.28, 0.28, 0.28, 0, h, "#3f9a86", "#4fae99", [
        ...windows("x+", 0.28, -0.28, 0.28, h, 2), ...windows("x-", -0.28, -0.28, 0.28, h, 2), ...windows("y-", -0.28, -0.28, 0.28, h, 2),
        pane("y+", 0.28, -0.13, 0.13, 0, Math.min(h - 3, 22), "#245a4e", "solid"),
      ]),
      ext("x", -0.28, 0.28, [[-0.28, h], [-0.28, h + 11], [0, h]], "#2e7465"),
      ext("x", -0.28, 0.28, [[0, h], [0, h + 11], [0.28, h]], "#2e7465"),
      box(0.12, -0.2, 0.2, -0.12, h, h + 24, "#8a5a44"),
      box(0.105, -0.215, 0.215, -0.105, h + 24, h + 27, "#6e4535"),
    ];
    return withEmit(parts, [0.16, -0.16, h + 28]);
  },
  // A long gallery of tall glass frames under a skylight pyramid.
  keys: (h) => {
    const hb = 4 + h * 0.8;
    const frames: Decal[] = [];
    const sides: ReadonlyArray<readonly [PaneSide, number]> = [["y+", 0.22], ["y-", -0.22]];
    for (const [side, at] of sides) for (const x of [-0.2, 0, 0.2]) frames.push(pane(side, at, x - 0.065, x + 0.065, 3, hb - 3, "#cfe6f0", "glass"));
    const parts = [
      box(-0.3, -0.22, 0.3, 0.22, 0, hb, "#5aa6d6", "#7bbbe2", [...frames, ...windows("x+", 0.3, -0.22, 0.22, hb, 2), ...windows("x-", -0.3, -0.22, 0.22, hb, 2)]),
      cyl(0, 0, 0.21, 0, hb, hb + 15, "#d3ebf7", 4, Math.PI / 4),
    ];
    return withEmit(parts, [0, 0, hb + 15]);
  },
  // A hangar, barrel roof, big striped door, a red light on top.
  clips: (h) => {
    const hb = 4 + h * 0.7;
    const R = 18;
    const prof: Vec2[] = [];
    for (let k = 0; k <= 8; k++) {
      const a = (Math.PI * k) / 8;
      prof.push([0.26 * Math.cos(a), hb + R * Math.sin(a)]);
    }
    const door = (side: PaneSide, at: number): Decal[] => [pane(side, at, -0.13, 0.13, 0, hb * 0.85, "#232f52", "solid"), pane(side, at, -0.13, 0.13, hb * 0.85 - 3, hb * 0.85, "#f2c14e", "panel")];
    const parts = [
      box(-0.3, -0.26, 0.3, 0.26, 0, hb, "#3e5182", "#4a5f93", [...door("x+", 0.3), ...door("x-", -0.3), ...windows("y+", 0.26, -0.3, 0.3, hb, 3), ...windows("y-", -0.26, -0.3, 0.3, hb, 3)]),
      ext("x", -0.3, 0.3, prof, "#5a6fa3", "#4a5f93"),
      box(-0.03, -0.03, 0.03, 0.03, hb + R, hb + R + 5, "#e5484d"),
    ];
    return withEmit(parts, [0, 0, hb + R + 5]);
  },
  // A stepped block with glowing screens.
  edit: (h) => {
    const hb = 4 + h * 0.6;
    const ht = hb + 10 + h * 0.4;
    const walls: PaneSide[] = ["x+", "x-", "y+", "y-"];
    const screens = walls.map((sd) => pane(sd, sd[1] === "+" ? 0.2 : -0.2, -0.15, 0.15, hb + 3, ht - 3, "#24323f", "screen"));
    const parts = [
      box(-0.3, -0.3, 0.3, 0.3, 0, hb, "#9bc34a", "#add15f", allWindows(-0.3, -0.3, 0.3, 0.3, hb, 3)),
      box(-0.2, -0.2, 0.2, 0.2, hb, ht, "#7da93a", "#8fbb48", screens),
    ];
    return withEmit(parts, [0, 0, ht]);
  },
  // A cinema with a lit marquee and a spire.
  review: (h) => {
    const zc = Math.max(8, h * 0.55);
    const front: Decal[] = [pane("y+", 0.28, -0.08, 0.08, 0, Math.min(zc - 1, 16), "#5e1a28", "solid")];
    if (h - 2 > zc + 10) front.push(pane("y+", 0.28, -0.2, 0.2, zc + 7, Math.min(h - 2, zc + 17), "#fff3d6", "panel"));
    const parts = [
      box(-0.28, -0.28, 0.28, 0.28, 0, h, "#d64a62", "#e0667b", [...front, ...windows("x+", 0.28, -0.28, 0.28, h, 2), ...windows("x-", -0.28, -0.28, 0.28, h, 2), ...windows("y-", -0.28, -0.28, 0.28, h, 2)]),
      box(-0.24, 0.28, 0.24, 0.37, zc, zc + 6, "#f2c14e", "#f7d77c", [-0.18, -0.09, 0, 0.09, 0.18].map((x) => pane("y+", 0.37, x - 0.022, x + 0.022, zc + 1.5, zc + 4.5, "#fff2c4", "bulb"))),
      cyl(0, 0, 0.1, 0, h, h + 20, "#9e2f45", 6),
    ];
    return withEmit(parts, [0, 0, h + 20]);
  },
  // A round tower with a balcony and a pointed hat.
  paint: (h) => {
    const top = 30 + h * 0.9;
    const parts = [
      cyl(0, 0, 0.27, 0.27, 0, 6, "#c96f9f", 12, 0, "#d98bb4"),
      cyl(0, 0, 0.19, 0.17, 6, top, "#e48fbd", 12),
      cyl(0, 0, 0.23, 0.23, top - 3, top, "#b85d8e", 12),
      cyl(0, 0, 0.26, 0, top, top + 26, "#7d4fa3", 12),
    ];
    return withEmit(parts, [0, 0, top + 26]);
  },
  // A film camera: body, lens, two reels on top.
  film: (h) => {
    const hb = 10 + h * 0.6;
    const R = Math.min(12, hb / 2 - 1);
    const parts = [
      box(-0.26, -0.2, 0.26, 0.2, 0, hb, "#5a5cc4", "#6d70d0"),
      ext("y", 0.2, 0.34, disc(0, hb / 2, 0.11, R, 10), "#2f3170", "#a8b8ff", "glass"),
      ext("y", -0.03, 0.03, disc(-0.12, hb + 13, 0.11, 13, 10), "#34368a", "#4a4ca3"),
      ext("y", -0.03, 0.03, disc(0.12, hb + 13, 0.11, 13, 10), "#34368a", "#4a4ca3"),
    ];
    return withEmit(parts, [0, 0.34, hb / 2]);
  },
  // An archive of drawers under a hipped roof.
  mail: (h) => {
    const rows = Math.max(1, Math.floor((h - 4) / 9));
    const drawers: Decal[] = [];
    const walls: ReadonlyArray<readonly [PaneSide, number]> = [["x+", 0.28], ["y+", 0.28], ["x-", -0.28], ["y-", -0.28]];
    for (const [side, at] of walls) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < 3; c++) {
          const u0 = -0.24 + c * 0.165;
          drawers.push(pane(side, at, u0, u0 + 0.14, 3 + r * 9, 9 + r * 9, "#b8945c", "panel"));
        }
      }
    }
    const parts = [
      box(-0.28, -0.28, 0.28, 0.28, 0, h, "#d6b47a", "#e2c592", drawers),
      cyl(0, 0, 0.39, 0, h, h + 13, "#a0794a", 4, Math.PI / 4),
    ];
    return withEmit(parts, [0, 0, h + 13]);
  },
  // A green warehouse with a long gable roof and big doors.
  kit: (h) => {
    const hb = 6 + h * 0.8;
    const parts = [
      box(-0.3, -0.24, 0.3, 0.24, 0, hb, "#6fae5a", "#80bd6a", [
        pane("x+", 0.3, -0.13, 0.13, 0, hb * 0.75, "#3d6a30", "solid"), pane("x-", -0.3, -0.13, 0.13, 0, hb * 0.75, "#3d6a30", "solid"),
        ...windows("y+", 0.24, -0.3, 0.3, hb, 3), ...windows("y-", -0.24, -0.3, 0.3, hb, 3),
      ]),
      gable("x", -0.32, 0.32, -0.27, 0.27, hb, 15, "#4c7f3c", "#80bd6a"),
    ];
    return withEmit(parts, [0, 0, hb + 15]);
  },
  // A cluster of small houses.
  others: (h) => {
    const house = (x: number, y: number, hh: number, col: string, axis: "x" | "y"): Part[] => [
      box(x - 0.1, y - 0.1, x + 0.1, y + 0.1, 0, hh, col, col, allWindows(x - 0.1, y - 0.1, x + 0.1, y + 0.1, hh, 1)),
      axis === "x" ? gable("x", x - 0.115, x + 0.115, y - 0.115, y + 0.115, hh, 9, "#56657a", col) : gable("y", y - 0.115, y + 0.115, x - 0.115, x + 0.115, hh, 9, "#56657a", col),
    ];
    const parts = [...house(-0.14, -0.14, 8 + h * 0.4, "#8a9bb0", "x"), ...house(0.15, -0.05, 6 + h * 0.3, "#a3b1c2", "y"), ...house(-0.03, 0.16, 10 + h * 0.5, "#7c8ea6", "x")];
    return withEmit(parts, [-0.03, 0.16, 19 + h * 0.5]);
  },
  // A relay station: a low hut, a dish turned to the sky and a mast with a beacon.
  relay: (h) => {
    const hb = 7 + h * 0.4;
    const top = hb + 20 + h * 0.5;
    const parts = [
      box(-0.27, -0.22, 0.14, 0.22, 0, hb, "#4a5a6e", "#5d6e84", [...windows("y+", 0.22, -0.27, 0.14, hb, 2), ...windows("x-", -0.27, -0.22, 0.22, hb, 2)]),
      cyl(-0.07, 0, 0.03, 0.03, hb, hb + 6, "#8a97a8", 6),
      ext("y", -0.04, 0.03, disc(-0.07, hb + 14, 0.17, 9, 14), "#dfe6ee", "#ffffff"),
      cyl(0.2, -0.1, 0.045, 0.02, 0, top, "#8a97a8", 4, Math.PI / 4),
      box(0.18, -0.12, 0.22, -0.08, top, top + 4, "#e5484d"),
    ];
    return withEmit(parts, [0.2, -0.1, top + 4]);
  },
};
