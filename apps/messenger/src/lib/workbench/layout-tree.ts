/**
 * Structural operations on a workbench layout. Every function is pure: it returns a new layout,
 * or the one it was given when nothing changed, so a caller can skip a re-render on identity.
 *
 * The one rule the rest of the engine leans on is normalisation. After it runs, a branch never
 * contains a branch of its own axis, so axes strictly alternate down every path from the root.
 * That is what makes two-axis dragging well defined: at any junction exactly one divider runs
 * through it and the perpendicular ones end on it, never cross it.
 */
import type {
  Axis,
  BranchNode,
  FloatFrame,
  LayoutNode,
  LeafNode,
  NodeId,
  NodePath,
  TabId,
  WorkbenchLayout,
  WorkbenchTab,
} from "./layout-types.ts";
import { WORKBENCH_LAYOUT_VERSION } from "./layout-types.ts";

export type IdFactory = () => NodeId;

/** Ids only have to be unique within one layout; tests pass a counter instead of randomness. */
export const randomId: IdFactory = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

export function makeLeaf(id: NodeId, tabs: WorkbenchTab[] = []): LeafNode {
  return { id, type: "leaf", tabs, activeTabId: tabs[0]?.id ?? null };
}

export function makeBranch(id: NodeId, axis: Axis, children: LayoutNode[], weights?: number[]): BranchNode {
  return { id, type: "branch", axis, children, weights: renormalise(weights ?? children.map(() => 1)) };
}

export function emptyLayout(id: NodeId): WorkbenchLayout {
  const leaf = makeLeaf(id);
  return { version: WORKBENCH_LAYOUT_VERSION, root: leaf, floating: [], focus: { zone: "tiled", leafId: leaf.id } };
}

// ---------------------------------------------------------------------------- reading

export function isLeaf(node: LayoutNode): node is LeafNode {
  return node.type === "leaf";
}

export function findPath(root: LayoutNode, id: NodeId): NodePath | null {
  if (root.id === id) return [];
  if (isLeaf(root)) return null;
  for (let i = 0; i < root.children.length; i++) {
    const below = findPath(root.children[i]!, id);
    if (below) return [i, ...below];
  }
  return null;
}

export function nodeAt(root: LayoutNode, path: NodePath): LayoutNode | null {
  let node: LayoutNode = root;
  for (const index of path) {
    if (isLeaf(node)) return null;
    const next = node.children[index];
    if (!next) return null;
    node = next;
  }
  return node;
}

/** Left to right, top to bottom — the order a reader's eye takes, which is also focus order. */
export function tiledLeaves(root: LayoutNode): LeafNode[] {
  if (isLeaf(root)) return [root];
  return root.children.flatMap(tiledLeaves);
}

export function allLeaves(layout: WorkbenchLayout): LeafNode[] {
  return [...tiledLeaves(layout.root), ...layout.floating.map((pane) => pane.leaf)];
}

export function leafById(layout: WorkbenchLayout, id: NodeId): LeafNode | null {
  return allLeaves(layout).find((leaf) => leaf.id === id) ?? null;
}

export function isFloating(layout: WorkbenchLayout, id: NodeId): boolean {
  return layout.floating.some((pane) => pane.leaf.id === id);
}

export function findTab(layout: WorkbenchLayout, tabId: TabId): { leaf: LeafNode; tab: WorkbenchTab } | null {
  for (const leaf of allLeaves(layout)) {
    const tab = leaf.tabs.find((candidate) => candidate.id === tabId);
    if (tab) return { leaf, tab };
  }
  return null;
}

// ---------------------------------------------------------------------------- writing

export function replaceAt(root: LayoutNode, path: NodePath, next: LayoutNode): LayoutNode {
  if (path.length === 0) return next;
  if (isLeaf(root)) return root;
  const [index, ...rest] = path;
  const child = root.children[index!];
  if (!child) return root;
  const children = [...root.children];
  children[index!] = replaceAt(child, rest, next);
  return { ...root, children };
}

/** Sum to one, with anything absurd replaced by an equal share rather than throwing. */
export function renormalise(weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const safe = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const total = safe.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => 1 / weights.length);
  const scaled = safe.map((weight) => (weight > 0 ? weight / total : 0));
  // A zeroed entry would be a pane nobody can see, so it takes an equal share from the rest.
  if (scaled.some((weight) => weight === 0)) return weights.map(() => 1 / weights.length);
  return scaled;
}

/**
 * Collapse what a split or a close left behind: branches with one child disappear into it, and a
 * branch inside a branch of the same axis is spliced in. Returns null when nothing is left.
 */
export function normalise(node: LayoutNode): LayoutNode | null {
  if (isLeaf(node)) return node;
  const children: LayoutNode[] = [];
  const weights: number[] = [];
  node.children.forEach((child, index) => {
    const normalised = normalise(child);
    if (!normalised) return;
    const weight = node.weights[index] ?? 1 / node.children.length;
    if (!isLeaf(normalised) && normalised.axis === node.axis) {
      // Flattening is what creates four-way crosses; without it there are only T-junctions.
      const inner = renormalise(normalised.weights);
      normalised.children.forEach((grandchild, j) => {
        children.push(grandchild);
        weights.push(weight * (inner[j] ?? 0));
      });
      return;
    }
    children.push(normalised);
    weights.push(weight);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children, weights: renormalise(weights) };
}

function withRoot(layout: WorkbenchLayout, root: LayoutNode | null, fallbackId: NodeId): WorkbenchLayout {
  // The tiled side is never empty: an emptied tree becomes one pane with no tabs, which is a
  // place to open something rather than a hole with nothing to click.
  const next = root ?? makeLeaf(fallbackId);
  return { ...layout, root: next };
}

function repairFocus(layout: WorkbenchLayout): WorkbenchLayout {
  if (leafById(layout, layout.focus.leafId)) {
    const zone = isFloating(layout, layout.focus.leafId) ? "floating" : "tiled";
    return zone === layout.focus.zone ? layout : { ...layout, focus: { zone, leafId: layout.focus.leafId } };
  }
  const fallback = layout.floating.at(-1)?.leaf ?? tiledLeaves(layout.root)[0];
  if (!fallback) return layout;
  const zone = isFloating(layout, fallback.id) ? "floating" : "tiled";
  return { ...layout, focus: { zone, leafId: fallback.id } };
}

/** Replace one leaf wherever it lives — tiled or floating — leaving everything else alone. */
function mapLeaf(
  layout: WorkbenchLayout,
  leafId: NodeId,
  change: (leaf: LeafNode) => LeafNode,
): WorkbenchLayout {
  const path = findPath(layout.root, leafId);
  if (path) {
    const node = nodeAt(layout.root, path);
    if (!node || !isLeaf(node)) return layout;
    const next = change(node);
    if (next === node) return layout;
    return { ...layout, root: replaceAt(layout.root, path, next) };
  }
  const index = layout.floating.findIndex((pane) => pane.leaf.id === leafId);
  if (index < 0) return layout;
  const pane = layout.floating[index]!;
  const next = change(pane.leaf);
  if (next === pane.leaf) return layout;
  const floating = [...layout.floating];
  floating[index] = { ...pane, leaf: next };
  return { ...layout, floating };
}

/** Which tab a pane should show once `tabId` is gone: the one to its right, else the last. */
export function pickActiveAfterClose(tabs: readonly WorkbenchTab[], closedIndex: number): TabId | null {
  if (tabs.length === 0) return null;
  return (tabs[closedIndex] ?? tabs[tabs.length - 1])!.id;
}

export function activateTab(layout: WorkbenchLayout, leafId: NodeId, tabId: TabId): WorkbenchLayout {
  return mapLeaf(layout, leafId, (leaf) =>
    leaf.activeTabId === tabId || !leaf.tabs.some((tab) => tab.id === tabId)
      ? leaf
      : { ...leaf, activeTabId: tabId },
  );
}

export function addTab(
  layout: WorkbenchLayout,
  leafId: NodeId,
  tab: WorkbenchTab,
  index?: number,
): WorkbenchLayout {
  return mapLeaf(layout, leafId, (leaf) => {
    if (leaf.tabs.some((existing) => existing.id === tab.id)) return leaf;
    const tabs = [...leaf.tabs];
    tabs.splice(index ?? tabs.length, 0, tab);
    return { ...leaf, tabs, activeTabId: tab.id };
  });
}

export function reorderTab(
  layout: WorkbenchLayout,
  leafId: NodeId,
  tabId: TabId,
  toIndex: number,
): WorkbenchLayout {
  return mapLeaf(layout, leafId, (leaf) => {
    const from = leaf.tabs.findIndex((tab) => tab.id === tabId);
    if (from < 0) return leaf;
    const target = Math.max(0, Math.min(leaf.tabs.length - 1, toIndex));
    if (from === target) return leaf;
    const tabs = [...leaf.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(target, 0, moved!);
    return { ...leaf, tabs };
  });
}

/** Raise a floating pane as well as point focus at it: the array order is the z-order. */
export function focusLeaf(layout: WorkbenchLayout, leafId: NodeId): WorkbenchLayout {
  if (!leafById(layout, leafId)) return layout;
  const index = layout.floating.findIndex((pane) => pane.leaf.id === leafId);
  const focused: WorkbenchLayout =
    layout.focus.leafId === leafId && layout.focus.zone === (index >= 0 ? "floating" : "tiled")
      ? layout
      : { ...layout, focus: { zone: index >= 0 ? "floating" : "tiled", leafId } };
  if (index < 0 || index === layout.floating.length - 1) return focused;
  const floating = [...focused.floating];
  const [pane] = floating.splice(index, 1);
  floating.push(pane!);
  return { ...focused, floating };
}

export function closeLeaf(layout: WorkbenchLayout, leafId: NodeId, fallbackId: NodeId): WorkbenchLayout {
  const floatingIndex = layout.floating.findIndex((pane) => pane.leaf.id === leafId);
  if (floatingIndex >= 0) {
    const floating = layout.floating.filter((_, i) => i !== floatingIndex);
    return repairFocus({ ...layout, floating });
  }
  const path = findPath(layout.root, leafId);
  if (!path) return layout;
  if (path.length === 0) {
    // The last tiled pane: it stays, emptied, rather than leaving nothing to aim at.
    return repairFocus(withRoot(layout, makeLeaf(fallbackId), fallbackId));
  }
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1]!;
  const parent = nodeAt(layout.root, parentPath);
  if (!parent || isLeaf(parent)) return layout;
  const children = parent.children.filter((_, i) => i !== index);
  // Dropping the entry and renormalising is a proportional hand-back: the survivors keep their
  // relative sizes. Giving it all to one neighbour would drift the layout that way over time.
  const weights = parent.weights.filter((_, i) => i !== index);
  const pruned = replaceAt(layout.root, parentPath, { ...parent, children, weights: renormalise(weights) });
  return repairFocus(withRoot(layout, normalise(pruned), fallbackId));
}

export function closeTab(
  layout: WorkbenchLayout,
  leafId: NodeId,
  tabId: TabId,
  fallbackId: NodeId,
): WorkbenchLayout {
  const leaf = leafById(layout, leafId);
  if (!leaf) return layout;
  const index = leaf.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return layout;
  if (leaf.tabs.length === 1) return closeLeaf(layout, leafId, fallbackId);
  const tabs = leaf.tabs.filter((tab) => tab.id !== tabId);
  const activeTabId = leaf.activeTabId === tabId ? pickActiveAfterClose(tabs, index) : leaf.activeTabId;
  return mapLeaf(layout, leafId, (current) => ({ ...current, tabs, activeTabId }));
}

export function splitLeaf(
  layout: WorkbenchLayout,
  leafId: NodeId,
  axis: Axis,
  side: "before" | "after",
  tabs: WorkbenchTab[],
  ids: { leaf: NodeId; branch: NodeId },
): WorkbenchLayout {
  const path = findPath(layout.root, leafId);
  // Splitting a floating pane is not offered: dock it first, which is one explicit motion.
  if (!path) return layout;
  const target = nodeAt(layout.root, path);
  if (!target || !isLeaf(target)) return layout;
  const fresh = makeLeaf(ids.leaf, tabs);

  const parentPath = path.slice(0, -1);
  const parent = path.length === 0 ? null : nodeAt(layout.root, parentPath);
  if (parent && !isLeaf(parent) && parent.axis === axis) {
    // Already divided this way: join the row rather than nesting a second one inside it, so the
    // divider between these two moves only these two.
    const index = path[path.length - 1]!;
    const share = parent.weights[index] ?? 1 / parent.children.length;
    const children = [...parent.children];
    const weights = [...parent.weights];
    const at = side === "before" ? index : index + 1;
    children.splice(at, 0, fresh);
    weights.splice(at, 0, share / 2);
    weights[side === "before" ? index + 1 : index] = share / 2;
    const root = replaceAt(layout.root, parentPath, { ...parent, children, weights: renormalise(weights) });
    return focusLeaf(repairFocus({ ...layout, root }), fresh.id);
  }

  const pair = side === "before" ? [fresh, target] : [target, fresh];
  const branch = makeBranch(ids.branch, axis, pair, [0.5, 0.5]);
  const root = replaceAt(layout.root, path, branch);
  return focusLeaf(repairFocus({ ...layout, root }), fresh.id);
}

/** Lift a tiled pane out into a floating one, at the frame the caller worked out. */
export function floatLeaf(layout: WorkbenchLayout, leafId: NodeId, frame: FloatFrame, fallbackId: NodeId): WorkbenchLayout {
  const path = findPath(layout.root, leafId);
  if (!path) return layout;
  const leaf = nodeAt(layout.root, path);
  if (!leaf || !isLeaf(leaf)) return layout;
  // The last tiled pane stays put: floating it would leave the tiled side with nothing at all.
  if (path.length === 0) return layout;
  const detached = closeLeaf(layout, leafId, fallbackId);
  const floated: WorkbenchLayout = { ...detached, floating: [...detached.floating, { leaf, frame }] };
  return focusLeaf(floated, leafId);
}

export function setFloatFrame(layout: WorkbenchLayout, leafId: NodeId, frame: FloatFrame): WorkbenchLayout {
  const index = layout.floating.findIndex((pane) => pane.leaf.id === leafId);
  if (index < 0) return layout;
  const current = layout.floating[index]!;
  if (
    current.frame.x === frame.x && current.frame.y === frame.y &&
    current.frame.width === frame.width && current.frame.height === frame.height
  ) {
    return layout;
  }
  const floating = [...layout.floating];
  floating[index] = { ...current, frame };
  return { ...layout, floating };
}

/** Thrown only by `assertInvariants`, which tests call; nothing in the app catches it. */
export class LayoutInvariantError extends Error {}

export function assertInvariants(layout: WorkbenchLayout): void {
  const seen = new Set<NodeId>();
  const walk = (node: LayoutNode, parentAxis: Axis | null): void => {
    if (seen.has(node.id)) throw new LayoutInvariantError(`duplicate node id ${node.id}`);
    seen.add(node.id);
    if (isLeaf(node)) {
      if (node.tabs.length === 0) {
        if (node.activeTabId !== null) throw new LayoutInvariantError(`empty leaf ${node.id} has an active tab`);
        return;
      }
      if (!node.tabs.some((tab) => tab.id === node.activeTabId)) {
        throw new LayoutInvariantError(`leaf ${node.id} has no active tab among its tabs`);
      }
      const tabIds = new Set(node.tabs.map((tab) => tab.id));
      if (tabIds.size !== node.tabs.length) throw new LayoutInvariantError(`leaf ${node.id} repeats a tab`);
      return;
    }
    if (node.children.length < 2) throw new LayoutInvariantError(`branch ${node.id} has ${node.children.length} children`);
    if (node.children.length !== node.weights.length) {
      throw new LayoutInvariantError(`branch ${node.id} has ${node.weights.length} weights for ${node.children.length} children`);
    }
    if (node.axis === parentAxis) throw new LayoutInvariantError(`branch ${node.id} repeats its parent's axis`);
    const total = node.weights.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > 1e-9) throw new LayoutInvariantError(`branch ${node.id} weights sum to ${total}`);
    if (node.weights.some((weight) => !(weight > 0))) throw new LayoutInvariantError(`branch ${node.id} has a weight at or below zero`);
    for (const child of node.children) walk(child, node.axis);
  };
  walk(layout.root, null);
  for (const pane of layout.floating) walk(pane.leaf, null);
  if (!leafById(layout, layout.focus.leafId)) {
    throw new LayoutInvariantError(`focus points at ${layout.focus.leafId}, which is not a pane`);
  }
  const zone = isFloating(layout, layout.focus.leafId) ? "floating" : "tiled";
  if (zone !== layout.focus.zone) throw new LayoutInvariantError(`focus says ${layout.focus.zone} but the pane is ${zone}`);
}

/** Change what a tab points at without moving it. Used when a pane settles on what it is showing. */
export function replaceTabParams(
  layout: WorkbenchLayout,
  leafId: NodeId,
  tabId: TabId,
  params: Readonly<Record<string, string>>,
): WorkbenchLayout {
  return mapLeaf(layout, leafId, (leaf) => {
    const index = leaf.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return leaf;
    const current = leaf.tabs[index]!;
    const same =
      Object.keys(params).length === Object.keys(current.params).length &&
      Object.entries(params).every(([key, value]) => current.params[key] === value);
    if (same) return leaf;
    const tabs = [...leaf.tabs];
    tabs[index] = { ...current, params };
    return { ...leaf, tabs };
  });
}
