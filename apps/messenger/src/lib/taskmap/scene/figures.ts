/**
 * The characters of the map (ADR 0097): small figures modelled like its buildings, one shape for
 * each character of a map and a colour of its own, so two Bots never look alike. A figure always
 * turns its face to you (it is drawn at one turn of its own, whatever the map's), and wears its
 * Bot's own avatar on its chest. Parts are in grid units (x, y; a figure is about ±0.15 across) and
 * px (z, up from its feet), with the modeller the buildings use.
 */
import { axes, mix, NIGHT, type Vec2, type Vec3 } from "./geometry.ts";
import { faceColor, type DrawnFace, type Light } from "./draw.ts";
import { box, cyl, disc, part, type Decal, type Part } from "./models.ts";

export const FIGURE_IDS = ["robot", "astronaut", "wizard", "bear", "knight", "tv", "chef", "cat"] as const;
export type FigureId = (typeof FIGURE_IDS)[number];

/** A figure's colours: its body, a darker and a lighter one of the same hue, and a contrast. */
export type FigurePalette = { body: string; dark: string; light: string; accent: string };

/** Eight hues, apart from each other and from the town's ground; a map gives each character its own. */
export const FIGURE_PALETTES: readonly FigurePalette[] = [
  { body: "#2f9e8f", dark: "#1d6b61", light: "#7fd1c4", accent: "#f2c14e" },
  { body: "#e0674f", dark: "#a8432f", light: "#f3a796", accent: "#2f6fd6" },
  { body: "#5b5fd1", dark: "#3b3f99", light: "#a5a8f0", accent: "#f08c3c" },
  { body: "#e3a22b", dark: "#a8731a", light: "#f5d27e", accent: "#5b3fa8" },
  { body: "#4f9d3a", dark: "#336b25", light: "#9fd38a", accent: "#e0567a" },
  { body: "#c4498f", dark: "#8c2f63", light: "#eb9cc8", accent: "#2fb3a3" },
  { body: "#3c93d6", dark: "#24679c", light: "#97c9ef", accent: "#f2c14e" },
  { body: "#6b7a8f", dark: "#475263", light: "#b4bfcd", accent: "#e8643c" },
];

const SKIN = "#f1c9a5";
const INK = "#1c2430";
const WHITE = "#f4f6f8";

export type FigureModel = { parts: Part[]; chest: Vec3; top: number };

/** A flat detail on the plane y = at, facing you: a disc of `n` points, or a rectangle. */
function front(at: number, pts: readonly Vec2[], col: string): Part {
  const v = pts.map(([x, z]): Vec3 => [x, at, z]);
  const c: Vec3 = [pts.reduce((s, p) => s + p[0], 0) / pts.length, at, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const d: Decal = { v, col, n: [0, 1, 0] };
  return part([], c, Math.min(...pts.map((p) => p[1])), [d]);
}
/** A round dot: `r` across in grid units, as tall in px as it is wide on screen. */
const dot = (at: number, x: number, z: number, r: number, col = INK): Part => front(at, disc(x, z, r, r * 125, 8), col);
const rect = (at: number, x0: number, x1: number, z0: number, z1: number, col: string): Part => front(at, [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], col);
/** Two eyes and a small mouth on a face whose front plane is y = at, centred at height z. */
const eyes = (at: number, z: number, gap = 0.045, col = INK): Part[] => [dot(at, -gap, z, 0.018, col), dot(at, gap, z, 0.018, col)];
const legs = (col: string): Part[] => [box(-0.1, -0.045, -0.025, 0.045, 0, 9, col), box(0.025, -0.045, 0.1, 0.045, 0, 9, col)];

const MAKERS: Readonly<Record<FigureId, (p: FigurePalette) => FigureModel>> = {
  // A boxy robot: a screen face and an antenna with a lit tip.
  robot: (p) => ({
    parts: [
      ...legs(p.dark),
      box(-0.15, -0.09, 0.15, 0.09, 9, 31, p.body, p.light),
      box(-0.19, -0.04, -0.15, 0.04, 14, 29, p.dark), box(0.15, -0.04, 0.19, 0.04, 14, 29, p.dark),
      box(-0.12, -0.09, 0.12, 0.09, 32, 51, p.light, p.light),
      rect(0.093, -0.09, 0.09, 36, 47, "#1f2a3a"),
      ...eyes(0.096, 42, 0.045, "#6fe3ff"),
      cyl(0, 0, 0.012, 0.012, 51, 58, p.dark, 4),
      box(-0.02, -0.02, 0.02, 0.02, 58, 62, p.accent),
    ],
    chest: [0, 0.092, 21], top: 62,
  }),
  // A space suit: a round helmet with a dark visor and a pack behind.
  astronaut: (p) => ({
    parts: [
      ...legs(mix(WHITE, p.light, 0.45)),
      box(-0.11, -0.16, 0.11, -0.08, 12, 30, p.dark),
      cyl(0, 0, 0.15, 0.13, 9, 31, mix(WHITE, p.light, 0.45), 12),
      cyl(0, 0, 0.13, 0.13, 31, 52, WHITE, 12, 0, WHITE),
      front(0.131, disc(0, 42, 0.09, 6.5, 10), "#26344d"),
      dot(0.134, 0.04, 45, 0.016, "#9fd8ff"),
      box(-0.15, -0.02, 0.15, 0.02, 24, 27, p.body),
    ],
    chest: [0, 0.14, 19], top: 52,
  }),
  // A wizard: a long robe, a wide brim and a tall pointed hat.
  wizard: (p) => ({
    parts: [
      cyl(0, 0, 0.125, 0.085, 0, 33, p.body, 12),
      cyl(0, 0, 0.09, 0.09, 33, 45, SKIN, 10),
      ...eyes(0.092, 39, 0.035),
      cyl(0, 0, 0.16, 0.16, 45, 47, p.dark, 12),
      cyl(0, 0, 0.1, 0, 47, 66, p.body, 10),
      dot(0.06, 0, 55, 0.02, p.accent),
    ],
    chest: [0, 0.135, 17], top: 66,
  }),
  // A round bear: ears on top and a light snout.
  bear: (p) => ({
    parts: [
      ...legs(p.dark),
      cyl(0, 0, 0.15, 0.14, 9, 31, p.body, 12),
      cyl(0, 0, 0.13, 0.12, 31, 49, p.body, 12),
      cyl(-0.08, 0, 0.04, 0.04, 46, 54, p.dark, 8), cyl(0.08, 0, 0.04, 0.04, 46, 54, p.dark, 8),
      front(0.123, disc(0, 36, 0.05, 3.6, 8), p.light),
      dot(0.126, 0, 37.5, 0.014),
      ...eyes(0.124, 43, 0.05),
    ],
    chest: [0, 0.145, 20], top: 54,
  }),
  // A knight: steel, a coloured tabard, a slit visor and a plume.
  knight: (p) => ({
    parts: [
      ...legs("#7c8794"),
      box(-0.14, -0.09, 0.14, 0.09, 9, 31, "#aab4bf", "#c4ccd5"),
      rect(0.093, -0.08, 0.08, 10, 30, p.body),
      box(-0.11, -0.09, 0.11, 0.09, 31, 50, "#97a2ae", "#b6bfc9"),
      rect(0.093, -0.075, 0.075, 40, 43, INK),
      box(-0.015, -0.08, 0.015, 0.05, 50, 60, p.accent),
    ],
    chest: [0, 0.095, 22], top: 60,
  }),
  // A television head on a small body, two antennas up.
  tv: (p) => ({
    parts: [
      ...legs(p.dark),
      box(-0.11, -0.07, 0.11, 0.07, 9, 29, p.body, p.light),
      box(-0.17, -0.1, 0.17, 0.1, 29, 52, p.dark, p.body),
      rect(0.103, -0.13, 0.13, 32, 49, p.light),
      ...eyes(0.106, 42, 0.05),
      rect(0.106, -0.03, 0.03, 36, 37.5, INK),
      cyl(-0.07, 0, 0.01, 0.01, 52, 61, INK, 4), cyl(0.07, 0, 0.01, 0.01, 52, 61, INK, 4),
    ],
    chest: [0, 0.075, 19], top: 61,
  }),
  // A cook: a white coat with buttons and a tall puffed hat.
  chef: (p) => ({
    parts: [
      ...legs(p.dark),
      cyl(0, 0, 0.15, 0.13, 9, 31, mix(WHITE, p.light, 0.55), 12),
      dot(0.135, 0, 17, 0.012, p.dark), dot(0.132, 0, 25, 0.012, p.dark),
      box(-0.15, -0.02, 0.15, 0.02, 29, 31, p.body),
      cyl(0, 0, 0.1, 0.1, 31, 45, SKIN, 10),
      ...eyes(0.102, 39, 0.04),
      cyl(0, 0, 0.1, 0.11, 45, 55, WHITE, 10),
      cyl(0, 0, 0.125, 0.115, 55, 60, WHITE, 10),
    ],
    chest: [0, 0.14, 20], top: 60,
  }),
  // A cat: pointed ears and a tail curling up behind.
  cat: (p) => ({
    parts: [
      box(-0.03, -0.2, 0.03, -0.12, 8, 34, p.dark),
      ...legs(p.dark),
      cyl(0, 0, 0.14, 0.13, 8, 30, p.body, 12),
      cyl(0, 0, 0.13, 0.13, 30, 47, p.body, 12),
      cyl(-0.08, 0, 0.05, 0, 44, 57, p.body, 4, Math.PI / 4), cyl(0.08, 0, 0.05, 0, 44, 57, p.body, 4, Math.PI / 4),
      front(0.131, disc(0, 35, 0.045, 3, 8), p.light),
      ...eyes(0.133, 41, 0.05, "#2c7a3a"),
    ],
    chest: [0, 0.135, 19], top: 57,
  }),
};

/** A figure's model; built once per shape and colour. */
export function figureModel(id: FigureId, palette: FigurePalette, cache: Map<string, FigureModel>): FigureModel {
  const key = `${id}:${palette.body}`;
  let m = cache.get(key);
  if (!m) cache.set(key, (m = MAKERS[id](palette)));
  return m;
}

/** The turn every figure is drawn at: its face to you, a little of its right side showing. */
export const FIGURE_TURN = -28;
/**
 * Where a figure's feet are in its own picture box (the front of its footprint reaches a few px
 * lower), and how much smaller it is drawn than a building's grid.
 */
export const FIGURE_FOOT: Vec2 = [29, 57];
const FIGURE_SCALE = 0.82;

export type DrawnFigure = { faces: DrawnFace[]; chest: Vec2; top: number };

/** A figure as polygons in its own picture box (feet at FIGURE_FOOT), parts painted back to front. */
export function drawFigure(model: FigureModel, L: Light): DrawnFigure {
  const { ex, ey } = axes(FIGURE_TURN);
  const k = FIGURE_SCALE;
  const at = (v: Vec3): Vec2 => [FIGURE_FOOT[0] + k * (v[0] * ex[0] + v[1] * ey[0]), FIGURE_FOOT[1] + k * (v[0] * ex[1] + v[1] * ey[1] - v[2])];
  const order = model.parts.map((pt) => ({ pt, key: pt.c[0] * ex[1] + pt.c[1] * ey[1] + 0.6 * pt.z0 })).sort((a, b) => a.key - b.key);
  const faces: DrawnFace[] = [];
  for (const { pt } of order) {
    for (const f of pt.faces) {
      const q = f.v.map(at);
      let area = 0;
      for (let i = 0; i < q.length; i++) {
        const a = q[i]!, b = q[(i + 1) % q.length]!;
        area += a[0] * b[1] - b[0] * a[1];
      }
      if (area <= 0.05) continue;
      const fill = faceColor(f, L, false, false);
      faces.push({ pts: q.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "), fill, stroke: mix(fill, NIGHT, 0.3) });
    }
  }
  return { faces, chest: at(model.chest), top: FIGURE_FOOT[1] - k * model.top };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Each character's shape and colour, by its key (a Bot's id, a subagent's): the same character
 * always gets the same ones on a map of the same company, and no two characters of one map share
 * a shape or a colour while there are any left.
 */
export function assignFigures(keys: readonly string[]): { figure: FigureId; palette: FigurePalette }[] {
  const shapes = new Set<FigureId>();
  const colours = new Set<number>();
  return keys.map((key) => {
    const h = hash(key);
    let s = h % FIGURE_IDS.length;
    for (let i = 0; i < FIGURE_IDS.length && shapes.has(FIGURE_IDS[s]!); i++) s = (s + 1) % FIGURE_IDS.length;
    if (shapes.size >= FIGURE_IDS.length) shapes.clear();
    shapes.add(FIGURE_IDS[s]!);
    let c = Math.floor(h / FIGURE_IDS.length) % FIGURE_PALETTES.length;
    for (let i = 0; i < FIGURE_PALETTES.length && colours.has(c); i++) c = (c + 1) % FIGURE_PALETTES.length;
    if (colours.size >= FIGURE_PALETTES.length) colours.clear();
    colours.add(c);
    return { figure: FIGURE_IDS[s]!, palette: FIGURE_PALETTES[c]! };
  });
}

