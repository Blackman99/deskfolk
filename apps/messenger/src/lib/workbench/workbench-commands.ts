/**
 * What the keyboard does to a layout.
 *
 * Parsing is pure and separate from applying, so the bindings can be tested without a DOM and
 * the shell keeps one keydown listener rather than growing a second one. `Shell.svelte` stays
 * the single entry point because the order it unwinds Escape in is load-bearing.
 */
import type { Axis, MinSizeLookup, NodeId, PaneMin, Rect, WorkbenchLayout } from "./layout-types.ts";
import { canSplit, computeGeometry, neighbourLeaf, type Direction, type LayoutGeometry } from "./layout-geometry.ts";
import { activateTab, closeLeaf, closeTab, findPath, focusLeaf, leafById } from "./layout-tree.ts";
import { beginSashDrag, equalise, resizeSash } from "./layout-resize.ts";

/**
 * Where a keystroke belongs to whatever has focus rather than to the workbench.
 *
 * One string, exported, because the ⌘O handler in the shell tests the same thing and two copies
 * of this list would drift the first time someone adds an editor.
 */
export const TYPING_TARGETS =
  'input, textarea, [contenteditable="true"], .monaco-editor, .editor-widget.find-widget, .composer-input';

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.(TYPING_TARGETS));
}

/** How far a keyboard nudge moves a divider. The accessible equivalent of dragging one. */
export const WB_KEY_RESIZE_PX = 16;

/** The menu ids the window sends over, and what each one means here. */
export const MENU_COMMANDS: Readonly<Record<string, WorkbenchCommand>> = {
  "pane-split-right": { kind: "split", axis: "row", side: "after" },
  "pane-split-down": { kind: "split", axis: "column", side: "after" },
  "pane-close": { kind: "close-pane" },
  "pane-equalise": { kind: "equalise" },
  "pane-close-tab": { kind: "close-tab" },
};

/**
 * The side of a pane a split puts the new one on, in the axis and order the tree speaks. The
 * pane's right-click menu offers all four; ⌘\ and the native menu only right and down.
 */
export const SPLIT_TOWARDS: Readonly<Record<Direction, { axis: Axis; side: "before" | "after" }>> = {
  up: { axis: "column", side: "before" },
  down: { axis: "column", side: "after" },
  left: { axis: "row", side: "before" },
  right: { axis: "row", side: "after" },
};

export type WorkbenchCommand =
  | { kind: "split"; axis: Axis; side: "before" | "after" }
  | { kind: "close-tab" }
  | { kind: "close-pane" }
  | { kind: "focus"; dir: Direction }
  | { kind: "cycle-tab"; dir: 1 | -1 }
  | { kind: "resize"; dir: Direction; px: number }
  | { kind: "equalise" };

const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * The command a keystroke means, or null when it is not ours.
 *
 * `⌘W` is deliberately absent: closing the window is a native menu item, so it is answered from
 * the Rust side and routed in rather than guessed at here.
 */
export function matchWorkbenchKey(event: KeyboardEvent): WorkbenchCommand | null {
  if (isTypingTarget(event.target)) return null;
  const mod = event.metaKey || event.ctrlKey;

  if (event.key === "Tab" && event.ctrlKey) {
    return { kind: "cycle-tab", dir: event.shiftKey ? -1 : 1 };
  }
  if (!mod) return null;

  if (event.key === "\\" || event.code === "Backslash") {
    return event.shiftKey
      ? { kind: "split", axis: "column", side: "after" }
      : { kind: "split", axis: "row", side: "after" };
  }

  const dir = ARROWS[event.key];
  if (dir && event.altKey) {
    // Shift as well as the others means "move the edge", not "go there".
    if (event.shiftKey) return { kind: "resize", dir, px: WB_KEY_RESIZE_PX };
    return { kind: "focus", dir };
  }
  if (event.key === "0" && event.altKey) return { kind: "equalise" };
  return null;
}

export type CommandContext = {
  viewport: Rect;
  mins: MinSizeLookup;
  /** Ids for anything the command has to create. */
  ids: () => NodeId;
  /** What a new pane would need to be usable, so a split that cannot fit is refused. */
  newPaneMin: PaneMin;
};

/** Which divider a pane's edge in that direction belongs to, or null when it has none. */
export function sashTowards(geo: LayoutGeometry, leafId: NodeId, dir: Direction): { sashId: string; sign: 1 | -1 } | null {
  const rect = geo.leaves.get(leafId);
  if (!rect) return null;
  const wantVertical = dir === "left" || dir === "right";
  let best: { sashId: string; sign: 1 | -1; overlap: number } | null = null;
  for (const sash of geo.sashes) {
    const vertical = sash.axis === "row";
    if (vertical !== wantVertical) continue;
    const touching = dir === "left" ? Math.abs(sash.rect.x + sash.rect.width - rect.x) <= 1
      : dir === "right" ? Math.abs(sash.rect.x - (rect.x + rect.width)) <= 1
      : dir === "up" ? Math.abs(sash.rect.y + sash.rect.height - rect.y) <= 1
      : Math.abs(sash.rect.y - (rect.y + rect.height)) <= 1;
    if (!touching) continue;
    const overlap = vertical
      ? Math.min(sash.rect.y + sash.rect.height, rect.y + rect.height) - Math.max(sash.rect.y, rect.y)
      : Math.min(sash.rect.x + sash.rect.width, rect.x + rect.width) - Math.max(sash.rect.x, rect.x);
    if (overlap <= 0) continue;
    // Growing this pane means pushing the divider away from it.
    const sign: 1 | -1 = dir === "right" || dir === "down" ? 1 : -1;
    if (!best || overlap > best.overlap) best = { sashId: sash.id, sign, overlap };
  }
  return best ? { sashId: best.sashId, sign: best.sign } : null;
}

export function applyCommand(
  layout: WorkbenchLayout,
  command: WorkbenchCommand,
  ctx: CommandContext,
  split: (layout: WorkbenchLayout, leafId: NodeId, axis: Axis, side: "before" | "after") => WorkbenchLayout,
): WorkbenchLayout {
  const leafId = layout.focus.leafId;
  const leaf = leafById(layout, leafId);
  if (!leaf) return layout;
  const geo = computeGeometry(layout, ctx.viewport, ctx.mins);

  switch (command.kind) {
    case "split": {
      if (!canSplit(layout, leafId, command.axis, ctx.viewport, ctx.mins, ctx.newPaneMin)) return layout;
      return split(layout, leafId, command.axis, command.side);
    }
    case "close-tab": {
      if (!leaf.activeTabId) return closeLeaf(layout, leafId, ctx.ids());
      return closeTab(layout, leafId, leaf.activeTabId, ctx.ids());
    }
    case "close-pane":
      return closeLeaf(layout, leafId, ctx.ids());
    case "focus": {
      const next = neighbourLeaf(geo, leafId, command.dir);
      return next ? focusLeaf(layout, next) : layout;
    }
    case "cycle-tab": {
      if (leaf.tabs.length < 2) return layout;
      const index = leaf.tabs.findIndex((tab) => tab.id === leaf.activeTabId);
      const next = leaf.tabs[(index + command.dir + leaf.tabs.length) % leaf.tabs.length]!;
      return activateTab(layout, leafId, next.id);
    }
    case "resize": {
      const towards = sashTowards(geo, leafId, command.dir);
      if (!towards) return layout;
      const drag = beginSashDrag(layout, geo, towards.sashId, ctx.mins);
      if (!drag) return layout;
      return resizeSash(layout, drag, command.px * towards.sign);
    }
    case "equalise": {
      // The division this pane is part of, not the whole tree: one gesture undoes one lopsided
      // drag rather than flattening arrangements elsewhere that nobody complained about.
      const path = findPath(layout.root, leafId);
      if (!path || path.length === 0) return layout;
      const parent = nodeAtPath(layout, path.slice(0, -1));
      return parent ? equalise(layout, parent) : layout;
    }
  }
}

/** The id of the branch at `path`, or null when the path does not lead to one. */
function nodeAtPath(layout: WorkbenchLayout, path: readonly number[]): NodeId | null {
  let node = layout.root;
  for (const index of path) {
    if (node.type === "leaf") return null;
    const next = node.children[index];
    if (!next) return null;
    node = next;
  }
  return node.type === "branch" ? node.id : null;
}
