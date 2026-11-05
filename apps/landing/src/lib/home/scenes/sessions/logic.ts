import { clamp, lerp, span, type Point } from '../../motion';

/**
 * The numbers behind the "sessions" scene: how much of the terminal is typed, which beat the
 * scene is on, where the flying session card is, what the transcript folds into, and the path of
 * the fork. Plain functions of the effective progress `ep` (the scroll position, or the user's
 * own progress once they have taken over), so the scene scrubs both ways.
 */

/** One transcript line; `who` is 'you', 'claude' or 'tool'. */
export type Line = { who: string; text: string };
export type Rect = { x: number; y: number; w: number; h: number };

/** Where each beat of the scene sits in 0..1. */
export const MARK = { typed: 0.3, sheet: 0.45, fly: 0.65, conv: 0.9 } as const;
/** The first chat item appears here and each following one a step later. */
export const ITEM_AT = 0.66;
export const ITEM_STEP = 0.04;
/** The two lines of the session carrying on appear here. */
export const NEXT_AT = [0.83, 0.88] as const;

export type Beats = {
  /** 0..1, linear: how much of the transcript is typed. */
  typed: number;
  /** The import sheet coming in. */
  sheet: number;
  /** The card flying to the sidebar. */
  fly: number;
  /** The sheet giving way to the conversation. */
  sheetOut: number;
  /** The fork drawing in, and the badge on the terminal. */
  fork: number;
};

export function beats(ep: number): Beats {
  return {
    typed: clamp(ep / MARK.typed),
    sheet: span(ep, MARK.typed, MARK.sheet),
    fly: span(ep, MARK.sheet, MARK.fly),
    sheetOut: span(ep, MARK.fly, MARK.fly + 0.05),
    fork: span(ep, 0.62, 0.9)
  };
}

/** How many characters of each line are typed once `typed` (0..1) of the whole transcript is. */
export function typedPerLine(lines: Line[], typed: number): number[] {
  const total = lines.reduce((n, l) => n + l.text.length, 0);
  let left = Math.round(total * clamp(typed));
  return lines.map((l) => {
    const n = Math.min(l.text.length, left);
    left -= n;
    return n;
  });
}

export type Item =
  | { kind: 'you' | 'claude'; text: string; src: number }
  | { kind: 'fold'; n: number; src: number };

/** The transcript as chat items: your lines and Claude's text as they are, a run of tool lines as one. */
export function foldTranscript(lines: Line[]): Item[] {
  const items: Item[] = [];
  lines.forEach((l, i) => {
    if (l.who === 'tool') {
      const last = items[items.length - 1];
      if (last?.kind === 'fold') last.n++;
      else items.push({ kind: 'fold', n: 1, src: i });
    } else items.push({ kind: l.who === 'you' ? 'you' : 'claude', text: l.text, src: i });
  });
  return items;
}

/** How far chat item `i` has appeared (0..1) at progress `ep`. */
export function itemShown(ep: number, i: number): number {
  const at = ITEM_AT + i * ITEM_STEP;
  return span(ep, at, at + ITEM_STEP);
}

/** The card's box on its way from the import row to the sidebar slot, lifted a little on the way. */
export function cardAt(from: Rect, to: Rect, fly: number): Rect {
  return {
    x: lerp(from.x, to.x, fly),
    y: lerp(from.y, to.y, fly) - Math.sin(Math.PI * fly) * 22,
    w: lerp(from.w, to.w, fly),
    h: lerp(from.h, to.h, fly)
  };
}

/** Where Mochi's spot (a `size` square) is when it walks beside the card, its feet at the card's foot. */
export function beside(card: Rect, size: number): Point {
  return { x: Math.max(0, card.x - size * 0.85), y: card.y + card.h + 18 - size };
}

export type Fork = {
  stem: string;
  /** The branch that goes to the app's conversation. */
  into: string;
  /** The short stub where the original carries on without it. */
  kept: string;
  label: Point;
  /** Where the stem splits. */
  dot: Point;
};

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
  };
}

const f = (v: number) => Math.round(v * 10) / 10;
const pt = (p: Point) => `${f(p.x)} ${f(p.y)}`;

/**
 * The fork between the terminal's last line `s` and the app's conversation `t`: one stem that
 * splits into two branches, one into the app and one that stops short, the original left as it was.
 * It runs sideways when the windows stand side by side and downward when they are stacked.
 */
export function forkPath(s: Point, t: Point): Fork {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const sideways = Math.abs(dx) >= Math.abs(dy);
  if (sideways) {
    const fp = { x: s.x + dx * 0.4, y: s.y };
    const c1 = { x: fp.x + dx * 0.3, y: fp.y };
    const c2 = { x: t.x - dx * 0.3, y: t.y };
    // The stub leaves on the side the branch into the app does not take.
    const k = dy > 20 ? -1 : 1;
    const end = { x: fp.x + 8, y: fp.y + k * 34 };
    return {
      stem: `M${pt(s)} L${pt(fp)}`,
      into: `M${pt(fp)} C${pt(c1)} ${pt(c2)} ${pt(t)}`,
      kept: `M${pt(fp)} C${pt({ x: fp.x + 10, y: fp.y })} ${pt({ x: end.x, y: fp.y + k * 10 })} ${pt(end)}`,
      dot: fp,
      label: { x: (s.x + t.x) / 2, y: k > 0 ? Math.min(s.y, t.y) - 18 : Math.max(s.y, t.y) + 18 }
    };
  }
  const fp = { x: s.x, y: s.y + dy * 0.4 };
  const c1 = { x: fp.x, y: fp.y + dy * 0.3 };
  const c2 = { x: t.x, y: t.y - dy * 0.3 };
  const side = -1;
  const end = { x: fp.x + side * 26, y: fp.y + 10 };
  return {
    stem: `M${pt(s)} L${pt(fp)}`,
    into: `M${pt(fp)} C${pt(c1)} ${pt(c2)} ${pt(t)}`,
    kept: `M${pt(fp)} C${pt({ x: fp.x, y: fp.y + 8 })} ${pt({ x: fp.x + side * 14, y: end.y })} ${pt(end)}`,
    dot: fp,
    label: { x: fp.x + 52, y: fp.y }
  };
}
