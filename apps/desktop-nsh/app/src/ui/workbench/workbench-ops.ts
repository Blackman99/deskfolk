/**
 * What the workbench does to its layout on request (the functions between `startPaneDrag` and the
 * template of `Workbench.svelte`): floating a tab, docking a pane, splitting towards a side, closing
 * a pane or some of a pane's tabs, naming what a drag carries, and the keyboard's commands. All of
 * the layout logic is the messenger's own modules under `src/m/workbench/`.
 */
import { keymap } from "nsh";
import { copy } from "../../runtime";
import type { FloatFrame, LeafNode, MinSizeLookup, Rect, TabCloseScope, WorkbenchLayout } from "../../m/workbench/layout-types.ts";
import { canSplit, type Direction, type LayoutGeometry } from "../../m/workbench/layout-geometry.ts";
import { closeLeaf, closeTabs, focusLeaf, leafById, setFloatFrame, splitLeaf, tabsClosedBy, tiledLeaves } from "../../m/workbench/layout-tree.ts";
import { dropZoneAt, type DropZone } from "../../m/workbench/drop-zones.ts";
import { applyDrop, beginTabDrag, dockFloating } from "../../m/workbench/tab-drag.ts";
import { WB_FALLBACK_MIN } from "../../m/workbench/pane-mins.ts";
import { SPLIT_TOWARDS, applyCommand, type WorkbenchCommand } from "../../m/workbench/workbench-commands.ts";
import type { TabClosing, WorkbenchTab } from "./types";

export type OpsContext = {
  layout: () => WorkbenchLayout;
  mins: MinSizeLookup;
  viewport: () => Rect;
  geometry: () => LayoutGeometry | null;
  wide: () => boolean;
  freshId: () => string;
  commit: (next: WorkbenchLayout) => void;
  tabName?: (tab: WorkbenchTab) => string;
  onFloatAdjusted?: (leafId: string, frame: FloatFrame) => void;
  onCloseTab?: (leafId: string, tabId: string) => void;
  onCloseTabs?: (leafId: string, tabIds: string[]) => void;
  onClosePane?: (leafId: string) => void;
};

export function createOps(ctx: OpsContext) {
  const leafOf = (leafId: string): LeafNode | null =>
    tiledLeaves(ctx.layout().root).find((candidate) => candidate.id === leafId) ?? ctx.layout().floating.find((pane) => pane.leaf.id === leafId)?.leaf ?? null;

  function focus(leafId: string): void {
    const next = focusLeaf(ctx.layout(), leafId);
    if (next !== ctx.layout()) ctx.commit(next);
  }

  /**
   * Lift one tab out into a floating pane of its own, a little smaller than the pane it came from,
   * centred on it, so it visibly comes away. The pane's other tabs stay where they are; a pane left
   * with none closes up, or, as the only tiled one, stays behind empty.
   */
  function floatTab(leafId: string, tabId: string): void {
    const layout = ctx.layout();
    const tab = leafById(layout, leafId)?.tabs.find((candidate) => candidate.id === tabId);
    const source = ctx.geometry()?.leaves.get(leafId) ?? layout.floating.find((pane) => pane.leaf.id === leafId)?.frame;
    if (!tab || !source) return;
    const centre = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
    const next = applyDrop(layout, beginTabDrag(leafId, tabId, centre), { kind: "float", point: centre }, { node: ctx.freshId, viewport: ctx.viewport(), floatMin: ctx.mins(tab), sourceRect: source });
    if (next !== layout) ctx.commit(next);
  }

  /** What floating a tab does, or null where it would change nothing: the only tab of a pane that already floats. */
  function tabFloating(leafId: string, tabId: string | null): (() => void) | null {
    const layout = ctx.layout();
    const leaf = tabId ? leafById(layout, leafId) : null;
    if (!leaf || !tabId || !leaf.tabs.some((tab) => tab.id === tabId)) return null;
    const floating = layout.floating.some((pane) => pane.leaf.id === leafId);
    if (floating && leaf.tabs.length === 1) return null;
    return () => floatTab(leafId, tabId);
  }

  function onFloatFrame(leafId: string, frame: FloatFrame): void {
    const next = setFloatFrame(ctx.layout(), leafId, frame);
    if (next !== ctx.layout()) ctx.commit(next);
    ctx.onFloatAdjusted?.(leafId, frame);
  }

  function onDock(leafId: string): void {
    const viewport = ctx.viewport();
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };
    const geometry = ctx.geometry();
    const zone = geometry ? dropZoneAt(geometry, centre) : ({ kind: "none" } as DropZone);
    const next = dockFloating(ctx.layout(), leafId, zone, { node: ctx.freshId, viewport, floatMin: WB_FALLBACK_MIN });
    if (next !== ctx.layout()) ctx.commit(next);
  }

  /**
   * What the chip that follows the pointer says. An id would tell nobody anything. A pane dragged by
   * its strip takes every tab along, so the chip says so rather than naming the one in front.
   */
  function nameOf(leafId: string, tabId: string | null): string {
    const t = copy().pane;
    const leaf = leafOf(leafId);
    if (!tabId && leaf && leaf.tabs.length > 1) return t.wholePane(leaf.tabs.length);
    const tab = tabId ? leaf?.tabs.find((candidate) => candidate.id === tabId) : leaf?.tabs.find((candidate) => candidate.id === leaf.activeTabId);
    if (!tab) return t.title;
    return ctx.tabName?.(tab) ?? tab.kind;
  }

  function fitsFor(leafId: string): { row: boolean; column: boolean } {
    const room = (axis: "row" | "column") => canSplit(ctx.layout(), leafId, axis, ctx.viewport(), ctx.mins, WB_FALLBACK_MIN);
    return { row: room("row"), column: room("column") };
  }

  const splitFn = (current: WorkbenchLayout, id: string, axis: "row" | "column", side: "before" | "after") =>
    splitLeaf(current, id, axis, side, [], { leaf: ctx.freshId(), branch: ctx.freshId() });

  /** The same split ⌘\ makes, aimed at the pane that was right-clicked and in any direction. */
  function splitTowards(leafId: string, dir: Direction): void {
    const next = applyCommand(
      focusLeaf(ctx.layout(), leafId),
      { kind: "split", ...SPLIT_TOWARDS[dir] },
      { viewport: ctx.viewport(), mins: ctx.mins, ids: ctx.freshId, newPaneMin: WB_FALLBACK_MIN },
      splitFn,
    );
    if (next !== ctx.layout()) ctx.commit(next);
  }

  function closePane(leafId: string): void {
    if (ctx.onClosePane) ctx.onClosePane(leafId);
    else ctx.commit(closeLeaf(ctx.layout(), leafId, ctx.freshId()));
  }

  /** A close from a tab's menu. The tab alone goes the way its × does. */
  function closeFrom(leafId: string, tabId: string, scope: TabCloseScope): void {
    if (scope === "tab") {
      ctx.onCloseTab?.(leafId, tabId);
      return;
    }
    const leaf = leafById(ctx.layout(), leafId);
    const ids = leaf ? tabsClosedBy(leaf, tabId, scope) : [];
    if (ids.length === 0) return;
    if (ctx.onCloseTabs) ctx.onCloseTabs(leafId, ids);
    else ctx.commit(closeTabs(ctx.layout(), leafId, ids, ctx.freshId()));
  }

  /** What a tab's menu (its ⋯, a right click on it) offers to close. Nothing off a tab. */
  function closingOf(leafId: string, tabId: string | null): TabClosing | null {
    const leaf = tabId ? leafById(ctx.layout(), leafId) : null;
    if (!leaf || !tabId || !leaf.tabs.some((tab) => tab.id === tabId)) return null;
    return {
      others: tabsClosedBy(leaf, tabId, "others").length > 0,
      right: tabsClosedBy(leaf, tabId, "right").length > 0,
      onClose: (scope) => closeFrom(leafId, tabId, scope),
    };
  }

  /** A command from the keyboard, aimed at the current pane. */
  function run(command: WorkbenchCommand): void {
    if (!ctx.wide() || !ctx.geometry()) return;
    const next = applyCommand(ctx.layout(), command, { viewport: ctx.viewport(), mins: ctx.mins, ids: ctx.freshId, newPaneMin: WB_FALLBACK_MIN }, splitFn);
    if (next !== ctx.layout()) ctx.commit(next);
  }

  return { leafOf, focus, floatTab, tabFloating, onFloatFrame, onDock, nameOf, fitsFor, splitTowards, closePane, closeFrom, closingOf, run };
}

/** How far a keyboard nudge moves a divider (`WB_KEY_RESIZE_PX`). */
const KEY_RESIZE_PX = 16;

/**
 * The keys of `matchWorkbenchKey` as `keymap` bindings (the messenger heard keydown itself):
 * ⌘\ and ⇧⌘\ split, Ctrl+Tab / Ctrl+Shift+Tab walk the tabs, ⌘⌥ arrows move to the pane beside,
 * with Shift they move the edge, ⌘⌥0 evens the division out. None fires while a text field has the
 * keyboard (`isTypingTarget`). Bound while the component renders and unbound with it.
 */
export function bindWorkbenchKeys(run: (command: WorkbenchCommand) => void): void {
  const dirs: Direction[] = ["left", "right", "up", "down"];
  const bindings: Record<string, () => void> = {
    "mod+\\": () => run({ kind: "split", axis: "row", side: "after" }),
    "mod+shift+\\": () => run({ kind: "split", axis: "column", side: "after" }),
    "ctrl+tab": () => run({ kind: "cycle-tab", dir: 1 }),
    "ctrl+shift+tab": () => run({ kind: "cycle-tab", dir: -1 }),
    "mod+alt+0": () => run({ kind: "equalise" }),
  };
  for (const dir of dirs) {
    bindings[`mod+alt+${dir}`] = () => run({ kind: "focus", dir });
    bindings[`mod+alt+shift+${dir}`] = () => run({ kind: "resize", dir, px: KEY_RESIZE_PX });
  }
  // One keystroke the platform keeps must not take the others down with it.
  for (const [keystroke, handler] of Object.entries(bindings)) {
    try {
      keymap.bind(keystroke, handler, { when: "notEditing" });
    } catch {
      // Not bindable on this platform.
    }
  }
}
