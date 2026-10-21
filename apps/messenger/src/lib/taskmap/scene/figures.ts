/**
 * The characters of the map (ADR 0097): Pudding and Mochi's own folk, dressed for work. Every
 * character is the folk avatar's body in a flavour of its own, with what it wears and holds —
 * Pudding's antenna, Mochi's beanie and mug, headphones and a clipboard, a beret and a brush… —
 * rendered in Blender from the map's camera (scripts/map-figures), so no two characters of one map
 * look alike and every one is plainly one of the app's mascots. A figure stacks its layers: body,
 * face, what sits over the face, the pin with its Bot's avatar, then its arms, which turn about the
 * shoulders. A Bot whose avatar is a folk wears that folk's eyes and mouth here too. The layers are
 * HTML images placed in % of the actor box, so the map can lay a figure out at its size on screen.
 */
import { folkHash, folkLook } from "@real-bot/protocol";
import type { LightLevel } from "./draw.ts";
import { FIGURE_GEOMETRY, FIGURE_LAYERS, type FigureLayer } from "./figure-assets.ts";
import { NIGHT, rgb, type Vec2 } from "./geometry.ts";

export const FIGURE_IDS = ["pudding", "mochi", "taro", "sakura", "matcha", "caramel", "sesame", "blueberry"] as const;
export type FigureId = (typeof FIGURE_IDS)[number];

export type FigureFace = { eyes: "dot" | "happy" | "wink"; mouth: "smile" | "open" | "cat" };

/** A folk avatar's eyes and mouth; Pudding's own (dot eyes, a smile) for any other avatar or none. */
export function figureFace(avatar: string | null | undefined): FigureFace {
  const hash = folkHash(avatar);
  if (hash === null) return { eyes: "dot", mouth: "smile" };
  const { eyes, mouth } = folkLook(hash);
  return { eyes, mouth };
}

/**
 * Where a figure stands in its actor box (58 × 64; seen from above, the front of its feet is ~10 px lower),
 * and the side of the square its picture is drawn in.
 */
export const FIGURE_FOOT: Vec2 = [29, 57];
export const FIGURE_SIZE = 80;

const S = FIGURE_SIZE;
const OX = FIGURE_FOOT[0] - FIGURE_GEOMETRY.feet[0] * S;
const OY = FIGURE_FOOT[1] - FIGURE_GEOMETRY.feet[1] * S;
const at = ([x, y]: readonly [number, number]): Vec2 => [OX + x * S, OY + y * S];

/** A layer in the actor box (px), and the same as CSS in % of the box (`left`, `top`, `width`, `height`). */
export type FigureImage = { href: string; x: number; y: number; w: number; h: number; box: string };

/** A figure in its actor box: its layers, where its arms turn and its mouth flips, and its pin. */
export type DrawnFigure = {
  figure: FigureId;
  body: FigureImage;
  front: FigureImage | null;
  eyes: FigureImage;
  blink: FigureImage;
  mouth: FigureImage;
  talk: FigureImage;
  pin: FigureImage;
  armL: FigureImage;
  armR: FigureImage;
  shoulderL: Vec2;
  shoulderR: Vec2;
  mouthAt: Vec2;
  /** The pin's face, where the Bot's avatar goes: its centre and radius, and the avatar's box as CSS. */
  chest: Vec2;
  chestR: number;
  avatarBox: string;
  /** Where a badge over its head stands: a little above the top of its hat. */
  top: number;
};

const hrefs = new Map<FigureLayer, string>();

function image(name: FigureLayer): FigureImage {
  const layer = FIGURE_LAYERS[name];
  let href = hrefs.get(name);
  if (!href) hrefs.set(name, (href = `data:image/webp;base64,${layer.webp}`));
  const [x, y, w, h] = layer.box;
  return place(href, OX + x * S, OY + y * S, w * S, h * S);
}

const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`;
function place(href: string, x: number, y: number, w: number, h: number): FigureImage {
  return { href, x, y, w, h, box: `left:${pct(x, 58)};top:${pct(y, 64)};width:${pct(w, 58)};height:${pct(h, 64)}` };
}

/** A point of the actor box as a CSS `transform-origin` in % of the box. */
export const figureOrigin = ([x, y]: Vec2): string => `${pct(x, 58)} ${pct(y, 64)}`;

const drawn = new Map<string, DrawnFigure>();

/** A character's figure with a face; the same picture every time it is asked for. */
export function drawFigure(figure: FigureId, face: FigureFace): DrawnFigure {
  const key = `${figure}:${face.eyes}:${face.mouth}`;
  let d = drawn.get(key);
  if (d) return d;
  const front = `${figure}-front`;
  d = {
    figure,
    body: image(`${figure}-body`),
    front: front in FIGURE_LAYERS ? image(front as FigureLayer) : null,
    eyes: image(`eyes-${face.eyes}`),
    blink: image("eyes-closed"),
    mouth: image(`mouth-${face.mouth}`),
    talk: image("mouth-open"),
    pin: image("pin"),
    armL: image(`${figure}-arm-l`),
    armR: image(`${figure}-arm-r`),
    shoulderL: at(FIGURE_GEOMETRY.shoulderL),
    shoulderR: at(FIGURE_GEOMETRY.shoulderR),
    mouthAt: at(FIGURE_GEOMETRY.mouth),
    chest: at(FIGURE_GEOMETRY.pin),
    chestR: FIGURE_GEOMETRY.pinR * S,
    avatarBox: (() => {
      const [cx, cy] = at(FIGURE_GEOMETRY.pin);
      const r = FIGURE_GEOMETRY.pinR * S;
      return place("", cx - r, cy - r, 2 * r, 2 * r).box;
    })(),
    top: Math.round(OY + FIGURE_GEOMETRY.top[figure] * S - 2),
  };
  drawn.set(key, d);
  return d;
}

/**
 * The hour's light on the figures: what `faceColor` does to a building's wall (a little warmer at
 * golden hour, sunk toward the night colour after dark), as one colour laid over the figure at an
 * opacity, masked by its own pictures; null by day. Not an SVG filter: WebKit draws a filtered
 * picture at the zoom it first had and stretches it as the map zooms in.
 */
export function figureTint(L: LightLevel): { color: string; alpha: number } | null {
  if (!L.w && !L.n) return null;
  const aw = 0.12 * L.w;
  const an = 0.36 * L.n;
  // Warm then night: c·k + o, the same as mixing toward o / (1 − k) by 1 − k.
  const alpha = 1 - (1 - aw) * (1 - an);
  const warm = rgb("#ffb070");
  const night = rgb(NIGHT);
  const color = [0, 1, 2].map((i) => Math.round((warm[i]! * aw * (1 - an) + night[i]! * an) / alpha));
  return { color: `rgb(${color.join(", ")})`, alpha: Number(alpha.toFixed(4)) };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Each character's figure, by its key (a Bot's id, a subagent's): the same character always gets the
 * same one on a map of the same company, and no two characters of one map share one while there are
 * any left.
 */
export function assignFigures(keys: readonly string[]): FigureId[] {
  const taken = new Set<FigureId>();
  return keys.map((key) => {
    let s = hash(key) % FIGURE_IDS.length;
    for (let i = 0; i < FIGURE_IDS.length && taken.has(FIGURE_IDS[s]!); i++) s = (s + 1) % FIGURE_IDS.length;
    if (taken.size >= FIGURE_IDS.length) taken.clear();
    taken.add(FIGURE_IDS[s]!);
    return FIGURE_IDS[s]!;
  });
}
