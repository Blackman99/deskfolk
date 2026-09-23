/**
 * Keeping a layout across restarts.
 *
 * On this machine only: `localStorage`, never the daemon, never the URL. That is the rule every
 * other piece of remembered geometry in the app already follows — the sidebar width, the preview
 * width, the trace window's frame — and a layout is per-machine by nature. A 27-inch arrangement
 * restored onto a laptop would be wrong; a layout pushed to a paired phone would be nonsense.
 *
 * Bad data is discarded whole rather than repaired in part. A half-mended layout is how you get a
 * workbench that is wrong in a way nobody can describe.
 */
import type {
  FloatFrame,
  LayoutNode,
  LeafNode,
  NodeId,
  Rect,
  WorkbenchLayout,
  WorkbenchTab,
} from "./layout-types.ts";
import { WORKBENCH_LAYOUT_VERSION } from "./layout-types.ts";
import { emptyLayout, isLeaf, makeLeaf, normalise, pickActiveAfterClose, renormalise, tiledLeaves } from "./layout-tree.ts";
import { clampFrame, isFrame } from "./float-frame.ts";
import type { PaneMin } from "./layout-types.ts";

const STORAGE_KEY = "real-bot-workbench-layout";

/** What the runtime still knows about, so a layout can drop what has gone away. */
export type LiveRefs = {
  sessionIds: ReadonlySet<string>;
  terminalIds: ReadonlySet<string>;
  /** Kinds this build understands. An older build reading a newer layout drops what it cannot draw. */
  knownKinds: ReadonlySet<string>;
};

// ------------------------------------------------------------------ parsing

function parseTab(value: unknown): WorkbenchTab | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Partial<WorkbenchTab>;
  if (typeof tab.id !== "string" || !tab.id) return null;
  if (typeof tab.kind !== "string" || !tab.kind) return null;
  const params: Record<string, string> = {};
  if (tab.params && typeof tab.params === "object") {
    for (const [key, entry] of Object.entries(tab.params)) {
      if (typeof entry === "string") params[key] = entry;
    }
  }
  return { id: tab.id, kind: tab.kind, params };
}

function parseNode(value: unknown, seen: Set<NodeId>, tabIds: Set<string>, depth = 0): LayoutNode | null {
  // A layout deep enough to blow the stack is corrupt whatever else it says.
  if (depth > 64 || !value || typeof value !== "object") return null;
  // Read as loose fields rather than `Partial<Branch & Leaf>`: intersecting the two makes `type`
  // both "branch" and "leaf" at once, which collapses the whole shape to `never`.
  const node = value as {
    id?: unknown;
    type?: unknown;
    tabs?: unknown;
    activeTabId?: unknown;
    axis?: unknown;
    children?: unknown;
    weights?: unknown;
  };
  if (typeof node.id !== "string" || !node.id || seen.has(node.id)) return null;
  seen.add(node.id);

  if (node.type === "leaf") {
    if (!Array.isArray(node.tabs)) return null;
    const tabs: WorkbenchTab[] = [];
    for (const raw of node.tabs) {
      const tab = parseTab(raw);
      if (!tab) return null;
      // Unique across the whole layout, not just this pane: a drag addresses a tab by id, and
      // two panes claiming the same one has no sensible answer.
      if (tabIds.has(tab.id)) return null;
      tabIds.add(tab.id);
      tabs.push(tab);
    }
    const active = typeof node.activeTabId === "string" ? node.activeTabId : null;
    return {
      id: node.id,
      type: "leaf",
      tabs,
      activeTabId: tabs.some((tab) => tab.id === active) ? active : (tabs[0]?.id ?? null),
    };
  }

  if (node.type !== "branch") return null;
  if (node.axis !== "row" && node.axis !== "column") return null;
  if (!Array.isArray(node.children) || !Array.isArray(node.weights)) return null;
  if (node.children.length !== node.weights.length || node.children.length < 2) return null;
  const children: LayoutNode[] = [];
  for (const raw of node.children) {
    const child = parseNode(raw, seen, tabIds, depth + 1);
    if (!child) return null;
    children.push(child);
  }
  const weights = node.weights as unknown[];
  if (weights.some((weight) => typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0)) {
    return null;
  }
  return { id: node.id, type: "branch", axis: node.axis, children, weights: renormalise(weights as number[]) };
}

/** A stored layout, or null when it is from another version, malformed, or self-contradictory. */
export function parseWorkbenchLayout(raw: unknown): WorkbenchLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const stored = raw as Partial<WorkbenchLayout>;
  // One version today. When there is a second, this is where a v1 blob is upgraded.
  if (stored.version !== WORKBENCH_LAYOUT_VERSION) return null;
  const seen = new Set<NodeId>();
  const tabIds = new Set<string>();
  const root = parseNode(stored.root, seen, tabIds);
  if (!root) return null;

  const floating: WorkbenchLayout["floating"] = [];
  if (stored.floating !== undefined) {
    if (!Array.isArray(stored.floating)) return null;
    for (const entry of stored.floating) {
      if (!entry || typeof entry !== "object") return null;
      const pane = entry as { leaf?: unknown; frame?: unknown };
      const leaf = parseNode(pane.leaf, seen, tabIds);
      if (!leaf || !isLeaf(leaf) || !isFrame(pane.frame)) return null;
      floating.push({ leaf, frame: pane.frame as FloatFrame });
    }
  }

  const focus = stored.focus;
  const leafIds = new Set([...tiledLeaves(root).map((leaf) => leaf.id), ...floating.map((pane) => pane.leaf.id)]);
  if (!focus || typeof focus !== "object") return null;
  const ref = focus as Partial<WorkbenchLayout["focus"]>;
  if (typeof ref.leafId !== "string" || !leafIds.has(ref.leafId)) return null;
  if (ref.zone !== "tiled" && ref.zone !== "floating") return null;

  const normalised = normalise(root);
  if (!normalised) return null;
  return { version: WORKBENCH_LAYOUT_VERSION, root: normalised, floating, focus: { zone: ref.zone, leafId: ref.leafId } };
}

export function loadWorkbenchLayout(): WorkbenchLayout | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return parseWorkbenchLayout(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveWorkbenchLayout(layout: WorkbenchLayout): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // A window that refuses storage still keeps the arrangement for this run.
  }
}

export function clearWorkbenchLayout(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the next save overwrites it anyway.
  }
}

// ------------------------------------------------------------------ healing

/** Which of a tab's references must still exist for it to be worth drawing. */
function tabIsLive(tab: WorkbenchTab, live: LiveRefs): boolean {
  if (!live.knownKinds.has(tab.kind)) return false;
  const sessionId = tab.params.sessionId;
  if (sessionId !== undefined && !live.sessionIds.has(sessionId)) return false;
  const terminalId = tab.params.terminalId;
  if (terminalId !== undefined && !live.terminalIds.has(terminalId)) return false;
  return true;
}

function healLeaf(leaf: LeafNode, live: LiveRefs): LeafNode | null {
  const tabs = leaf.tabs.filter((tab) => tabIsLive(tab, live));
  if (tabs.length === leaf.tabs.length) return leaf;
  if (tabs.length === 0) return null;
  const activeStillThere = tabs.some((tab) => tab.id === leaf.activeTabId);
  if (activeStillThere) return { ...leaf, tabs };
  const closedIndex = leaf.tabs.findIndex((tab) => tab.id === leaf.activeTabId);
  const index = Math.max(0, leaf.tabs.slice(0, closedIndex).filter((tab) => tabIsLive(tab, live)).length);
  return { ...leaf, tabs, activeTabId: pickActiveAfterClose(tabs, index) };
}

function healNode(node: LayoutNode, live: LiveRefs): LayoutNode | null {
  if (isLeaf(node)) return healLeaf(node, live);
  const children: LayoutNode[] = [];
  const weights: number[] = [];
  node.children.forEach((child, index) => {
    const healed = healNode(child, live);
    if (!healed) return;
    children.push(healed);
    weights.push(node.weights[index] ?? 1 / node.children.length);
  });
  if (children.length === 0) return null;
  return { ...node, children, weights: renormalise(weights) };
}

/**
 * Drop what is no longer there and put the layout back in order.
 *
 * Returns the layout it was given when nothing changed, so the effect that runs this on every
 * snapshot does not rebuild the workbench each time a message arrives.
 */
export function healLayout(
  layout: WorkbenchLayout,
  live: LiveRefs,
  viewport: Rect,
  floatMin: PaneMin,
  fallbackId: NodeId,
): WorkbenchLayout {
  const healedRoot = healNode(layout.root, live);
  const root = healedRoot ? normalise(healedRoot) : null;

  const floating: WorkbenchLayout["floating"] = [];
  for (const pane of layout.floating) {
    const leaf = healLeaf(pane.leaf, live);
    if (!leaf) continue;
    const frame = clampFrame(pane.frame, floatMin, viewport);
    floating.push(leaf === pane.leaf && sameFrame(frame, pane.frame) ? pane : { leaf, frame });
  }

  const nextRoot = root ?? makeLeaf(fallbackId);
  const leafIds = new Set([...tiledLeaves(nextRoot).map((leaf) => leaf.id), ...floating.map((pane) => pane.leaf.id)]);
  let focus = layout.focus;
  if (!leafIds.has(focus.leafId)) {
    const fallback = floating.at(-1)?.leaf.id ?? tiledLeaves(nextRoot)[0]!.id;
    focus = { zone: floating.some((pane) => pane.leaf.id === fallback) ? "floating" : "tiled", leafId: fallback };
  }

  const unchanged =
    nextRoot === layout.root &&
    focus === layout.focus &&
    floating.length === layout.floating.length &&
    floating.every((pane, i) => pane === layout.floating[i]);
  // The same object back means the caller can skip the work entirely.
  return unchanged ? layout : { ...layout, root: nextRoot, floating, focus };
}

function sameFrame(a: FloatFrame, b: FloatFrame): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** The arrangement a first run gets: one pane, holding whatever the app was already showing. */
export function defaultLayout(id: NodeId, tabs: WorkbenchTab[] = []): WorkbenchLayout {
  const base = emptyLayout(id);
  return tabs.length === 0 ? base : { ...base, root: makeLeaf(id, tabs) };
}
