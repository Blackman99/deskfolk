/**
 * The shape of a desktop workbench layout.
 *
 * Types only, so nothing can cycle through this module and the geometry, tree and drag modules
 * can all lean on it. The layout engine never imports a content component: a tab says what kind
 * it is and carries string parameters, and the host renders it through a snippet. That is what
 * keeps Monaco and xterm out of this module graph entirely.
 */

import type { Snippet } from "svelte";

/** "row" lays children out side by side, so the dividers between them are vertical. */
export type Axis = "row" | "column";

export type NodeId = string;
export type TabId = string;

/**
 * One thing a pane can show. `kind` and `params` are opaque here — the runtime owns what they
 * mean, which is why a layout can be read, split and persisted without knowing about sessions.
 */
export type WorkbenchTab = {
  id: TabId;
  kind: string;
  params: Readonly<Record<string, string>>;
};

/**
 * Something a tab offers to do for what it shows: a conversation's settings, its flow board.
 * The host says what; the workbench only lists them, under the tab's ⋯ and at the top of a
 * right-click on the tab.
 */
export type TabAction = {
  id: string;
  label: string;
  /** Drawn at the start of the row. The host's picture: the workbench owns no icons. */
  icon?: Snippet;
  /** Already on — pinned, settings open. */
  active?: boolean;
  run: () => void;
};

/** A pane: one tab strip and whichever tab is active under it. */
export type LeafNode = {
  id: NodeId;
  type: "leaf";
  tabs: WorkbenchTab[];
  /** Always one of `tabs`, or null when there are none. */
  activeTabId: TabId | null;
};

/**
 * A division. `weights` runs parallel to `children`, every entry above zero, summing to one.
 *
 * Fractions rather than pixels because resizing the window must not lose what the person chose:
 * shrink until three panes are at their minimum and grow back, and pixel sizes cannot tell you
 * what the proportions were before they were clamped. Fractions also map straight onto the
 * `minmax(<min>px, <w>fr)` grid track that renders them.
 */
export type BranchNode = {
  id: NodeId;
  type: "branch";
  axis: Axis;
  /** Two or more once the tree is normalised. */
  children: LayoutNode[];
  weights: number[];
};

export type LayoutNode = LeafNode | BranchNode;

export type Rect = { x: number; y: number; width: number; height: number };
export type FloatFrame = Rect;

/** A pane lifted out of the tiled tree. Still inside the one window: this is not a second window. */
export type FloatingPane = { leaf: LeafNode; frame: FloatFrame };

export type FocusRef = { zone: "tiled" | "floating"; leafId: NodeId };

export type WorkbenchLayout = {
  version: 1;
  root: LayoutNode;
  /** Bottom to top. The array order **is** the z-order; focusing moves a pane to the end. */
  floating: FloatingPane[];
  focus: FocusRef;
};

/** Where a node sits, as indices from the root. No parent pointers, so a layout stays plain JSON. */
export type NodePath = readonly number[];

/** The smallest a kind of content stays usable at. Pixels, because a column of text is a real width. */
export type PaneMin = { width: number; height: number };
export type MinSizeLookup = (tab: WorkbenchTab | null) => PaneMin;

export const WORKBENCH_LAYOUT_VERSION = 1;

/** Thickness of a divider, matching the existing `.sidebar-split` / `.preview-split` handles. */
export const WB_SASH_PX = 8;
