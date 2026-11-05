/**
 * The panes scene's arithmetic: a binary split tree of panes (each holding one tab), the edits the
 * app lets you make to it, where its panes sit in a box, which edge of a pane a pointer is
 * aiming at, and the scripted layout the scene builds by itself as the reader scrolls. Plain
 * functions, so the scene's components stay about drawing and the numbers are tested here.
 */

export type Edge = 'left' | 'right' | 'top' | 'bottom';

export type Leaf = { kind: 'leaf'; id: string; tab: number };
export type Split = { kind: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: Tree; b: Tree };
export type Tree = Leaf | Split;

export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

/** A divider's thickness, and the smallest and largest share one side of a split may take. */
export const DIVIDER = 6;
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

export const leaf = (id: string, tab: number): Leaf => ({ kind: 'leaf', id, tab });

export const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

/**
 * Split the pane `leafId` at one of its edges: the new pane (showing `tab`) takes that side and the
 * old one keeps the other, half and half. Left and right split across (a row), top and bottom
 * split down (a column). An unknown pane leaves the tree as it was.
 */
export function split(tree: Tree, leafId: string, edge: Edge, tab: number, newId: string): Tree {
  if (tree.kind === 'leaf') {
    if (tree.id !== leafId) return tree;
    const fresh = leaf(newId, tab);
    const first = edge === 'left' || edge === 'top';
    return {
      kind: 'split',
      id: `s-${newId}`,
      dir: edge === 'left' || edge === 'right' ? 'row' : 'col',
      ratio: 0.5,
      a: first ? fresh : tree,
      b: first ? tree : fresh
    };
  }
  const a = split(tree.a, leafId, edge, tab, newId);
  const b = a === tree.a ? split(tree.b, leafId, edge, tab, newId) : tree.b;
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

/** Move a divider: the share of the first side, kept between 0.2 and 0.8. */
export function resize(tree: Tree, splitId: string, ratio: number): Tree {
  if (tree.kind === 'leaf') return tree;
  if (tree.id === splitId) return { ...tree, ratio: clampRatio(ratio) };
  const a = resize(tree.a, splitId, ratio);
  const b = a === tree.a ? resize(tree.b, splitId, ratio) : tree.b;
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

/** Close a pane: its sibling takes the whole space. Closing the only pane leaves nothing (null). */
export function remove(tree: Tree, leafId: string): Tree | null {
  if (tree.kind === 'leaf') return tree.id === leafId ? null : tree;
  if (tree.a.kind === 'leaf' && tree.a.id === leafId) return tree.b;
  if (tree.b.kind === 'leaf' && tree.b.id === leafId) return tree.a;
  const a = remove(tree.a, leafId);
  const b = a === tree.a ? remove(tree.b, leafId) : tree.b;
  if (a === tree.a && b === tree.b) return tree;
  return a && b ? { ...tree, a, b } : (a ?? b);
}

/** Show another tab in a pane (dropping on a pane's centre). */
export function retab(tree: Tree, leafId: string, tab: number): Tree {
  if (tree.kind === 'leaf') return tree.id === leafId && tree.tab !== tab ? { ...tree, tab } : tree;
  const a = retab(tree.a, leafId, tab);
  const b = a === tree.a ? retab(tree.b, leafId, tab) : tree.b;
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

/** The panes, first side before second, so left to right and top to bottom. */
export function leaves(tree: Tree): Leaf[] {
  return tree.kind === 'leaf' ? [tree] : [...leaves(tree.a), ...leaves(tree.b)];
}

/** Which splits are in the tree, for dividers. */
export function splits(tree: Tree): Split[] {
  return tree.kind === 'leaf' ? [] : [tree, ...splits(tree.a), ...splits(tree.b)];
}

/** Changes whenever panes come or go or a split changes direction, but not when a divider moves. */
export function structureKey(tree: Tree): string {
  return tree.kind === 'leaf'
    ? `${tree.id}:${tree.tab}`
    : `(${tree.id}${tree.dir === 'row' ? '|' : '-'}${structureKey(tree.a)} ${structureKey(tree.b)})`;
}

/** Where each pane sits inside `box`, leaving `divider` px between the two sides of every split. */
export function layoutRects(tree: Tree, box: Rect, divider = DIVIDER): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (t: Tree, r: Rect) => {
    if (t.kind === 'leaf') {
      out.set(t.id, r);
      return;
    }
    if (t.dir === 'row') {
      const avail = Math.max(0, r.w - divider);
      const aw = avail * t.ratio;
      walk(t.a, { x: r.x, y: r.y, w: aw, h: r.h });
      walk(t.b, { x: r.x + aw + divider, y: r.y, w: avail - aw, h: r.h });
    } else {
      const avail = Math.max(0, r.h - divider);
      const ah = avail * t.ratio;
      walk(t.a, { x: r.x, y: r.y, w: r.w, h: ah });
      walk(t.b, { x: r.x, y: r.y + ah + divider, w: r.w, h: avail - ah });
    }
  };
  walk(tree, box);
  return out;
}

export const contains = (r: Rect, pt: Pt) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;

/** The pane under a point, if any (the gap between two panes is no pane). */
export function paneAt(rects: Map<string, Rect>, pt: Pt): string | null {
  for (const [id, r] of rects) if (contains(r, pt)) return id;
  return null;
}

/**
 * Which edge of a pane a pointer is aiming at: the nearest edge when the pointer is inside that
 * edge's band (the outer `band` share of the pane's width or height), else the centre, which
 * replaces the pane's tab. Outside the pane: null.
 */
export function edgeAt(rect: Rect, pt: Pt, band = 0.3): Edge | 'center' | null {
  if (!contains(rect, pt) || rect.w <= 0 || rect.h <= 0) return null;
  const fx = (pt.x - rect.x) / rect.w;
  const fy = (pt.y - rect.y) / rect.h;
  const near: [Edge, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy]
  ];
  let best: [Edge, number] = near[0];
  for (const n of near) if (n[1] < best[1]) best = n;
  return best[1] <= band ? best[0] : 'center';
}

/** The half of a pane a drop on `edge` would take (the whole pane for the centre). */
export function zoneRect(rect: Rect, edge: Edge | 'center'): Rect {
  const { x, y, w, h } = rect;
  if (edge === 'left') return { x, y, w: w / 2, h };
  if (edge === 'right') return { x: x + w / 2, y, w: w / 2, h };
  if (edge === 'top') return { x, y, w, h: h / 2 };
  if (edge === 'bottom') return { x, y: y + h / 2, w, h: h / 2 };
  return rect;
}

/** The lowest-numbered tab among `count` that is not in `open`, or null when all are open. */
export function nextTab(open: Iterable<number>, count: number): number | null {
  const taken = new Set(open);
  for (let i = 0; i < count; i++) if (!taken.has(i)) return i;
  return null;
}

/* The scripted layout: what the scene builds by itself as the chapter is scrolled. */

export type Who = 'mochi' | 'pudding';

export type Beat = {
  who: Who;
  tab: number;
  /** The id of the pane the drop makes. */
  id: string;
  /** Starts carrying the tab, drops it, and is back on its feet. */
  from: number;
  drop: number;
  back: number;
  /** Where the tab is dropped; null floats it instead. */
  at: { leafId: string; edge: Edge } | null;
};

export const BEATS: readonly Beat[] = [
  { who: 'pudding', tab: 1, id: 'b', from: 0.15, drop: 0.3, back: 0.38, at: { leafId: 'a', edge: 'right' } },
  { who: 'mochi', tab: 2, id: 'c', from: 0.4, drop: 0.55, back: 0.6, at: { leafId: 'b', edge: 'bottom' } },
  { who: 'pudding', tab: 3, id: 'd', from: 0.62, drop: 0.75, back: 0.8, at: { leafId: 'a', edge: 'bottom' } },
  { who: 'mochi', tab: 4, id: 'f', from: 0.82, drop: 0.9, back: 0.98, at: null }
];

/** Where the floating window lands, as shares of the pane area, and when the ⌥ badge flashes. */
export const FLOAT_AT = { fx: 0.52, fy: 0.14 };
export const KEYCAP = { from: 0.84, to: 0.95 };

/** The layouts the script goes through, one per split dropped so far (built once, shared). */
const TREES: Tree[] = (() => {
  const out: Tree[] = [leaf('a', 0)];
  for (const beat of BEATS) {
    if (!beat.at) continue;
    out.push(split(out[out.length - 1], beat.at.leafId, beat.at.edge, beat.tab, beat.id));
  }
  return out;
})();

/** How many splits the script has dropped by `p`. */
export function treeStep(p: number): number {
  let n = 0;
  for (const b of BEATS) if (b.at && p >= b.drop) n++;
  return n;
}

export const treeAt = (step: number): Tree => TREES[Math.min(Math.max(step, 0), TREES.length - 1)];

/** Is the scripted floating window out at `p`? */
export const floatOut = (p: number) => p >= BEATS[BEATS.length - 1].drop;

export const keycapOn = (p: number) => p >= KEYCAP.from && p < KEYCAP.to;

export type Actor = {
  tab: number;
  /** Carrying the tab to its drop, or walking back after it. */
  phase: 'out' | 'back';
  /** How far through that phase, 0 to 1. */
  t: number;
  at: Beat['at'];
  /** The layout the tab is being dropped into. */
  before: Tree;
};

/** What each companion is doing at `p`. Nobody listed is standing by. */
export function actorsAt(p: number): Partial<Record<Who, Actor>> {
  const out: Partial<Record<Who, Actor>> = {};
  let step = 0;
  for (const b of BEATS) {
    const before = treeAt(step);
    if (b.at) step++;
    if (p >= b.from && p < b.drop) out[b.who] = { tab: b.tab, phase: 'out', t: (p - b.from) / (b.drop - b.from), at: b.at, before };
    else if (p >= b.drop && p < b.back) out[b.who] = { tab: b.tab, phase: 'back', t: (p - b.drop) / (b.back - b.drop), at: b.at, before };
  }
  return out;
}
