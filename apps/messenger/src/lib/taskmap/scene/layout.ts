/**
 * Labels on the map: head badges first (their sides and lifts), then plates around them like map labels.
 * Boxes are `[x0, y0, x1, y1]` in picture px. A faithful port of the Project prototype.
 */
import type { Vec2 } from "./geometry.ts";

export type LabelBox = readonly [number, number, number, number];

/** What the width and place of a character's head badge depend on. */
export interface BadgeActor {
  /** The name on the badge. */
  short: string;
  hasModel: boolean;
  /** The model's short name, shown as a tag after the name when `hasModel`. */
  modelShort: string;
  x: number;
  y: number;
  badgeTop: number;
  /** -1 grows left from the head, 1 right, 0 is centred. Set by `assignBadges`. */
  side: number;
  /** How many levels the badge has risen to clear another (0 to 2). Set by `assignBadges`. */
  lift: number;
}

/** A character on the map. */
export interface PlacedActor extends BadgeActor {
  /** Index among the characters, the tie-break when two stand at the same x. */
  b: number;
  present: boolean;
  walking: boolean;
}

/** What a place's plate needs; `plateY` is where it wants to sit and is moved by `layoutPlates`. */
export interface PlateBlock {
  /** Paint order of the building; plates are placed front to back. */
  z: number;
  px: number;
  plateY: number;
  name: string;
  /** The visit count, or '' for none. */
  n: number | string;
  flag: boolean;
  lines: ReadonlyArray<{ text: string; model: string }>;
}

/** Width in "em-ish" units: a CJK character counts 1, anything narrower 0.55. */
function textWidth(s: string): number {
  return [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 1 : 0.55), 0);
}

export function badgeBox(a: BadgeActor, zoom: number): LabelBox {
  const cw = textWidth(a.short);
  const tag = a.hasModel ? [...a.modelShort].length * 6.2 + 4 : 0;
  const bw = (cw * 11 + 38 + tag) / zoom;
  const bh = 28 / zoom;
  const mid = a.x + 29;
  const half = 14.5 / zoom;
  const y1 = a.y + a.badgeTop - (a.lift * 28) / zoom;
  if (a.side < 0) return [mid + half - bw, y1 - bh, mid + half, y1];
  if (a.side > 0) return [mid - half, y1 - bh, mid - half + bw, y1];
  return [mid - bw / 2, y1 - bh, mid + bw / 2, y1];
}

/**
 * Badges: left half grow left, right half grow right, the middle one centred; a badge that would cover
 * another rises a level, up to two. One that would reach past `minX` (the town's left edge, where the
 * view clips it) grows right instead. Sets `side` and `lift` on every actor (a character not on the map
 * gets 1 and 0).
 */
export function assignBadges(actors: ReadonlyArray<PlacedActor>, zoom: number, minX = -Infinity): void {
  const shown = actors.filter((a) => a.present).sort((a, c) => a.x - c.x || a.b - c.b);
  shown.forEach((a, j) => {
    const m = shown.length;
    const mid = (m - 1) / 2;
    a.side = m === 1 ? 1 : j < mid ? -1 : j > mid ? 1 : 0;
    a.lift = 0;
    if (a.side <= 0 && badgeBox(a, zoom)[0] < minX) a.side = 1;
  });
  const taken: LabelBox[] = [];
  for (const a of shown) {
    a.lift = 0;
    for (;;) {
      const bx = badgeBox(a, zoom);
      const hit = taken.some((o) => Math.min(bx[2], o[2]) - Math.max(bx[0], o[0]) > 1 && Math.min(bx[3], o[3]) - Math.max(bx[1], o[1]) > 1);
      if (!hit || a.lift >= 2) {
        taken.push(bx);
        break;
      }
      a.lift++;
    }
  }
  for (const a of actors) {
    if (!a.present) {
      a.side = 1;
      a.lift = 0;
    }
  }
}

/**
 * Settles every plate's `plateY`: front plates first, each tries its wish and then the gaps above and below
 * the boxes already placed, nearest first, and takes the one that covers least. Never lower than its building's
 * floor (`at[k][1] - 12`), never further than 150px from its wish. Characters' heads and badges count as obstacles.
 * `at` is each building's picture point, by the same index as `blocks`.
 */
export function layoutPlates(blocks: PlateBlock[], actors: ReadonlyArray<PlacedActor>, at: ReadonlyArray<Vec2>, zoom: number): void {
  // [x0, y0, x1, y1, weight]: a plate costs less to cover than a head or a badge.
  const placed: Array<readonly [number, number, number, number, number]> = [];
  for (const a of actors) {
    if (!a.present || a.walking) continue;
    placed.push([a.x + 6, a.y + a.badgeTop, a.x + 52, a.y + 60, 1]);
    placed.push([...badgeBox(a, zoom), 1]);
  }
  const touch = 1.5 / zoom;
  const cost = (b: LabelBox): number => {
    let s = 0;
    for (const o of placed) {
      const ox = Math.min(b[2], o[2]) - Math.max(b[0], o[0]);
      const oy = Math.min(b[3], o[3]) - Math.max(b[1], o[1]);
      if (ox > touch && oy > touch) s += ox * oy * o[4];
    }
    return s;
  };
  const order = blocks.map((_, k) => k).sort((i, j) => blocks[j].z - blocks[i].z);
  for (const k of order) {
    const b = blocks[k];
    const lineW = Math.max(0, ...b.lines.map((l) => textWidth(l.text + l.model) * 10 + 15));
    const w = Math.min(150, Math.max(textWidth(b.name) * 12 + 12 + String(b.n).length * 6.5 + 4, lineW) + 18) / zoom;
    const hgt = (23 + b.lines.length * 13.5 + (b.flag ? 26 : 0)) / zoom;
    const gap = 3 / zoom;
    const x0 = b.px - w / 2;
    const x1 = b.px + w / 2;
    const base = b.plateY;
    const floor = at[k][1] - 12;
    const boxAt = (y: number): LabelBox => [x0, y - hgt, x1, y];
    const tries = [base];
    for (const o of placed) if (Math.min(x1, o[2]) - Math.max(x0, o[0]) > 2) tries.push(o[1] - gap, o[3] + hgt + gap);
    const ok = tries.filter((t) => t <= floor && Math.abs(t - base) <= 150).sort((a, c) => Math.abs(a - base) - Math.abs(c - base));
    let best = base;
    let bestCost = Infinity;
    for (const t of ok) {
      const s = cost(boxAt(t));
      if (s < bestCost - 1e-6) {
        best = t;
        bestCost = s;
      }
      if (s === 0) break;
    }
    b.plateY = Math.round(best);
    placed.push([...boxAt(b.plateY), 4]);
  }
}
