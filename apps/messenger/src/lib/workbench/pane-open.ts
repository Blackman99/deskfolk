/**
 * Putting something into the arrangement.
 *
 * The rule everything here follows: **never rearrange the layout behind the person's back.** If a
 * pane already shows what is being asked for, that pane is focused and nothing else moves. Only
 * when nothing shows it does the active pane take it, and even then the layout's shape is
 * untouched — a tab is added or replaced, never a pane opened or closed.
 */
import type { NodeId, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { activateTab, addTab, closeTab, focusLeaf, leafById, tiledLeaves } from "./layout-tree.ts";
import { contentOfTab, contentsEqual, tabFor, type PaneContent } from "./pane-content.ts";

export type Located = { leafId: NodeId; tab: WorkbenchTab };

/** Where this content is already open, preferring the focused pane when it is in more than one. */
export function findContent(layout: WorkbenchLayout, content: PaneContent): Located | null {
  const leaves = [...tiledLeaves(layout.root), ...layout.floating.map((pane) => pane.leaf)];
  const ordered = [
    ...leaves.filter((leaf) => leaf.id === layout.focus.leafId),
    ...leaves.filter((leaf) => leaf.id !== layout.focus.leafId),
  ];
  for (const leaf of ordered) {
    for (const tab of leaf.tabs) {
      const its = contentOfTab(tab);
      if (its && contentsEqual(its, content)) return { leafId: leaf.id, tab };
    }
  }
  return null;
}

export type OpenOptions = {
  /** A fresh tab id, for when one has to be made. */
  id: () => string;
  /**
   * Replace the active pane's current tab rather than sitting beside it. What clicking a
   * conversation in the roster does: you asked to go there, not to collect tabs.
   */
  replaceActive?: boolean;
};

/**
 * Show this content. Focuses it where it already is, or puts it in the pane the keyboard is in.
 * Returns the layout it was given when nothing has to change.
 */
export function openContent(
  layout: WorkbenchLayout,
  content: PaneContent,
  opts: OpenOptions,
): WorkbenchLayout {
  const found = findContent(layout, content);
  if (found) {
    const focused = focusLeaf(layout, found.leafId);
    return activateTab(focused, found.leafId, found.tab.id);
  }

  const leafId = layout.focus.leafId;
  const leaf = leafById(layout, leafId);
  if (!leaf) return layout;

  const tab = tabFor(content, opts.id());
  if (opts.replaceActive && leaf.activeTabId) {
    const current = leaf.tabs.find((candidate) => candidate.id === leaf.activeTabId);
    const currentContent = current ? contentOfTab(current) : null;
    // Only a conversation gives way to another conversation. A terminal or the workspace in this
    // pane is something you put there on purpose, so it is kept and the new tab sits beside it.
    if (current && currentContent?.kind === content.kind && content.kind === "chat") {
      const withNew = addTab(layout, leafId, tab);
      return focusLeaf(closeTab(withNew, leafId, current.id, opts.id()), leafId);
    }
  }
  return focusLeaf(addTab(layout, leafId, tab), leafId);
}

/** The conversation the focused pane is showing, which is the one Stop and the URL follow. */
export function activeSessionId(layout: WorkbenchLayout): string | null {
  const leaf = leafById(layout, layout.focus.leafId);
  const tab = leaf?.tabs.find((candidate) => candidate.id === leaf.activeTabId);
  const content = tab ? contentOfTab(tab) : null;
  if (!content) return null;
  return "sessionId" in content ? content.sessionId : null;
}
