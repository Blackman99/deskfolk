/**
 * Where every pane, divider and junction actually is.
 *
 * The browser lays the panes out itself — each branch is a CSS grid whose tracks come from
 * `trackTemplate` — so nothing here is required for the layout to render correctly. What it is
 * required for is the things CSS cannot answer: where to put a junction handle, which pane is to
 * the left of this one, and what a drag is over. Those need numbers, and asking the DOM for them
 * every frame is both slow and unreliable (the browser used for UI verification never delivers
 * `ResizeObserver` callbacks), so they are computed from the tree instead.
 */
import type {
  Axis,
  BranchNode,
  LayoutNode,
  LeafNode,
  MinSizeLookup,
  NodeId,
  PaneMin,
  Rect,
  WorkbenchLayout,
} from "./layout-types.ts";
import { WB_SASH_PX } from "./layout-types.ts";
import { isLeaf, renormalise, tiledLeaves } from "./layout-tree.ts";

/** Two collinear dividers this close are treated as one cross rather than a near miss. */
export const WB_JUNCTION_SNAP_PX = 6;

export type SashRect = {
  /** `<branch id>#<index>`, stable across renders so a drag can be resumed by id. */
  id: string;
  branchId: NodeId;
  /** Which gap: between children `index - 1` and `index`, so one-based and below the count. */
  index: number;
  /** The branch's axis. A "row" branch is divided by vertical sashes. */
  axis: Axis;
  rect: Rect;
};

export type Junction = {
  id: string;
  point: { x: number; y: number };
  /** The one divider that runs through this point. */
  bar: { sashId: string; branchId: NodeId; index: number; axis: Axis };
  /** The dividers that end on it. One is a T; two or more is a cross. */
  stems: Array<{ sashId: string; branchId: NodeId; index: number }>;
};

export type LayoutGeometry = {
  viewport: Rect;
  leaves: Map<NodeId, Rect>;
  /** Every branch's rect, which a drag needs to turn a pixel delta into a weight. */
  branches: Map<NodeId, Rect>;
  sashes: SashRect[];
  junctions: Junction[];
};

const leafTab = (leaf: LeafNode) => leaf.tabs.find((tab) => tab.id === leaf.activeTabId) ?? leaf.tabs[0] ?? null;

/** What a subtree cannot be squeezed below, dividers included. */
export function minSize(node: LayoutNode, mins: MinSizeLookup): PaneMin {
  if (isLeaf(node)) return mins(leafTab(node));
  const parts = node.children.map((child) => minSize(child, mins));
  const gaps = WB_SASH_PX * (node.children.length - 1);
  if (node.axis === "row") {
    return {
      width: parts.reduce((total, part) => total + part.width, 0) + gaps,
      height: Math.max(...parts.map((part) => part.height)),
    };
  }
  return {
    width: Math.max(...parts.map((part) => part.width)),
    height: parts.reduce((total, part) => total + part.height, 0) + gaps,
  };
}

/**
 * Split `total` between weighted tracks that each refuse to go below their minimum.
 *
 * This is the same loop CSS Grid runs for `minmax(<min>px, <w>fr)`: hand out space by weight,
 * freeze anything that came out under its minimum, and share what is left among the rest. It is
 * reproduced here because the junction handles have to sit exactly where the browser put the
 * dividers — see the Playwright check that compares the two.
 */
export function allocate(total: number, weights: readonly number[], mins: readonly number[]): number[] {
  const count = weights.length;
  if (count === 0) return [];
  const share = renormalise(weights);
  const floor = mins.map((min) => Math.max(0, min));
  const minTotal = floor.reduce((a, b) => a + b, 0);

  if (minTotal >= total) {
    // Nothing fits. Shrink everyone in proportion to what they asked for rather than letting the
    // last track overflow the container and push the rest off screen.
    const scale = minTotal > 0 ? total / minTotal : 0;
    return roundToTotal(floor.map((min) => min * scale), total);
  }

  const frozen = new Array<boolean>(count).fill(false);
  const size = new Array<number>(count).fill(0);
  for (;;) {
    const freeWeight = share.reduce((sum, weight, i) => (frozen[i] ? sum : sum + weight), 0);
    const freeSpace = total - size.reduce((sum, value, i) => (frozen[i] ? sum + value : sum), 0);
    let froze = false;
    for (let i = 0; i < count; i++) {
      if (frozen[i]) continue;
      size[i] = freeWeight > 0 ? (freeSpace * share[i]!) / freeWeight : freeSpace / count;
      if (size[i]! < floor[i]!) {
        size[i] = floor[i]!;
        frozen[i] = true;
        froze = true;
      }
    }
    if (!froze) break;
  }
  return roundToTotal(size, total);
}

/** Integers that still add up to exactly `total`, so a row of panes has no seam at the end. */
function roundToTotal(sizes: readonly number[], total: number): number[] {
  const out: number[] = [];
  let carried = 0;
  let placed = 0;
  for (let i = 0; i < sizes.length; i++) {
    carried += sizes[i]!;
    const value = i === sizes.length - 1 ? total - placed : Math.round(carried) - placed;
    out.push(value);
    placed += value;
  }
  return out;
}

/**
 * How much each share is scaled by before it becomes an `fr`. The browser treats flexible
 * tracks whose factors add up to less than 1 as owed only that fraction of the free space, so
 * shares that sum to 1 stopped filling the branch the moment one pane sat at its minimum: the
 * rest came to less than 1 and left a strip of nothing at the far edge. Scaled up, any track
 * that is not a sliver keeps a factor of at least 1 and the tracks fill the branch again.
 */
const FR_SCALE = 1000;

/** The `grid-template-*` value for one branch: tracks with sashes between them. */
export function trackTemplate(branch: BranchNode, childMins: readonly number[]): string {
  const share = renormalise(branch.weights);
  const floors = branch.children.map((_, i) => Math.max(0, Math.round(childMins[i] ?? 0)));
  const total = floors.reduce((sum, floor) => sum + floor, 0);
  const gaps = WB_SASH_PX * (branch.children.length - 1);
  const tracks = floors.map((floor, i) => {
    // Match allocate's proportional shrink when the window is smaller than the minimums.
    const ratio = total > 0 ? floor / total : 0;
    const min = floor > 0
      ? `min(${floor}px, max(0px, calc(${(ratio * 100).toFixed(6)}% - ${(ratio * gaps).toFixed(6)}px)))`
      : "0px";
    return `minmax(${min}, ${(share[i]! * FR_SCALE).toFixed(3)}fr)`;
  });
  return tracks.join(` ${WB_SASH_PX}px `);
}

/** How much of `rect` the children divide up, once the dividers have taken theirs. */
export function contentExtent(branch: BranchNode, rect: Rect): number {
  const along = branch.axis === "row" ? rect.width : rect.height;
  return Math.max(0, along - WB_SASH_PX * (branch.children.length - 1));
}

export function computeGeometry(
  layout: WorkbenchLayout,
  viewport: Rect,
  mins: MinSizeLookup,
): LayoutGeometry {
  const leaves = new Map<NodeId, Rect>();
  const branches = new Map<NodeId, Rect>();
  const sashes: SashRect[] = [];

  const walk = (node: LayoutNode, rect: Rect): void => {
    if (isLeaf(node)) {
      leaves.set(node.id, rect);
      return;
    }
    branches.set(node.id, rect);
    const row = node.axis === "row";
    const childMins = node.children.map((child) => {
      const min = minSize(child, mins);
      return row ? min.width : min.height;
    });
    const sizes = allocate(contentExtent(node, rect), node.weights, childMins);
    let offset = row ? rect.x : rect.y;
    node.children.forEach((child, i) => {
      if (i > 0) {
        sashes.push({
          id: `${node.id}#${i}`,
          branchId: node.id,
          index: i,
          axis: node.axis,
          rect: row
            ? { x: offset, y: rect.y, width: WB_SASH_PX, height: rect.height }
            : { x: rect.x, y: offset, width: rect.width, height: WB_SASH_PX },
        });
        offset += WB_SASH_PX;
      }
      const size = sizes[i]!;
      walk(child, row
        ? { x: offset, y: rect.y, width: size, height: rect.height }
        : { x: rect.x, y: offset, width: rect.width, height: size });
      offset += size;
    });
  };

  walk(layout.root, viewport);
  return { viewport, leaves, branches, sashes, junctions: findJunctions(sashes) };
}

// ------------------------------------------------------------------ junctions

type Span = { sash: SashRect; vertical: boolean; offset: number; start: number; end: number };

function toSpan(sash: SashRect): Span {
  // A "row" branch is divided by vertical strips; a "column" branch by horizontal ones.
  const vertical = sash.axis === "row";
  return vertical
    ? { sash, vertical, offset: sash.rect.x + sash.rect.width / 2, start: sash.rect.y, end: sash.rect.y + sash.rect.height }
    : { sash, vertical, offset: sash.rect.y + sash.rect.height / 2, start: sash.rect.x, end: sash.rect.x + sash.rect.width };
}

/**
 * Find every point where one divider runs through and others end on it.
 *
 * Because the tree is normalised, a divider can never cross another: a branch's sash lies inside
 * that branch's rectangle and an ancestor's runs outside it. So at any meeting point exactly one
 * of the two is continuous, and which one is never ambiguous.
 */
export function findJunctions(sashes: readonly SashRect[], snap = WB_JUNCTION_SNAP_PX): Junction[] {
  const spans = sashes.map(toSpan);
  const junctions: Junction[] = [];

  for (const bar of spans) {
    // Group the stems that end on this bar by where along it they land, so two collinear ones
    // from opposite sides become one cross rather than two handles on top of each other.
    const groups: Array<{ offset: number; stems: Span[] }> = [];
    for (const stem of spans) {
      if (stem.vertical === bar.vertical) continue;
      const touchesStart = Math.abs(stem.start - bar.offset) <= snap + WB_SASH_PX / 2;
      const touchesEnd = Math.abs(stem.end - bar.offset) <= snap + WB_SASH_PX / 2;
      if (!touchesStart && !touchesEnd) continue;
      // A stem meeting the bar at the bar's own end belongs to the junction an ancestor owns.
      if (stem.offset < bar.start + WB_SASH_PX || stem.offset > bar.end - WB_SASH_PX) continue;
      const group = groups.find((candidate) => Math.abs(candidate.offset - stem.offset) <= snap);
      if (group) group.stems.push(stem);
      else groups.push({ offset: stem.offset, stems: [stem] });
    }
    for (const group of groups) {
      const offset = group.stems.reduce((sum, stem) => sum + stem.offset, 0) / group.stems.length;
      junctions.push({
        id: `${bar.sash.id}@${Math.round(offset)}`,
        point: bar.vertical ? { x: bar.offset, y: offset } : { x: offset, y: bar.offset },
        bar: { sashId: bar.sash.id, branchId: bar.sash.branchId, index: bar.sash.index, axis: bar.sash.axis },
        stems: group.stems.map((stem) => ({
          sashId: stem.sash.id,
          branchId: stem.sash.branchId,
          index: stem.sash.index,
        })),
      });
    }
  }
  return junctions;
}

// ------------------------------------------------------------------ navigation

export type Direction = "left" | "right" | "up" | "down";

/**
 * The pane next door in that direction: of those whose facing edge touches ours, the one sharing
 * the most of it. Sharing the most is what gets a four-pane pinwheel right, where two candidates
 * touch but only one is really beside you.
 */
export function neighbourLeaf(geo: LayoutGeometry, from: NodeId, dir: Direction): NodeId | null {
  const source = geo.leaves.get(from);
  if (!source) return null;
  const horizontal = dir === "left" || dir === "right";
  let best: { id: NodeId; overlap: number; gap: number } | null = null;

  for (const [id, rect] of geo.leaves) {
    if (id === from) continue;
    const gap = dir === "left" ? source.x - (rect.x + rect.width)
      : dir === "right" ? rect.x - (source.x + source.width)
      : dir === "up" ? source.y - (rect.y + rect.height)
      : rect.y - (source.y + source.height);
    // Touching, allowing for the divider between them; anything further is not next door.
    if (gap < -1 || gap > WB_SASH_PX + 1) continue;
    const overlap = horizontal
      ? Math.min(source.y + source.height, rect.y + rect.height) - Math.max(source.y, rect.y)
      : Math.min(source.x + source.width, rect.x + rect.width) - Math.max(source.x, rect.x);
    if (overlap <= 0) continue;
    if (!best || overlap > best.overlap || (overlap === best.overlap && gap < best.gap)) {
      best = { id, overlap, gap };
    }
  }
  return best?.id ?? null;
}

/**
 * Whether the window is too small to divide at all, so only the focused pane is drawn.
 *
 * The tree is not touched when this is true — widening the window brings the arrangement back
 * exactly as it was, because nothing wrote to it.
 */
export function shouldGoSolo(
  layout: WorkbenchLayout,
  viewport: Rect,
  mins: MinSizeLookup,
  narrowWidth = 680,
): boolean {
  if (viewport.width <= narrowWidth) return true;
  const needed = minSize(layout.root, mins);
  return needed.width > viewport.width || needed.height > viewport.height;
}

/** Whether a split would ask for more room than there is. The only operation that can. */
export function canSplit(
  layout: WorkbenchLayout,
  leafId: NodeId,
  axis: Axis,
  viewport: Rect,
  mins: MinSizeLookup,
  extra: PaneMin,
): boolean {
  const leaf = tiledLeaves(layout.root).find((candidate) => candidate.id === leafId);
  if (!leaf) return false;
  const current = minSize(layout.root, mins);
  const own = mins(leafTab(leaf));
  const grown = axis === "row"
    ? { width: current.width + extra.width + WB_SASH_PX, height: Math.max(current.height, extra.height) }
    : { width: Math.max(current.width, extra.width), height: current.height + extra.height + WB_SASH_PX };
  // Only the axis being divided grows; the other keeps whatever the tree already demanded.
  void own;
  return grown.width <= viewport.width && grown.height <= viewport.height;
}
