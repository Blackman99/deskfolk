/**
 * On the desktop a terminal tab is its shell: closing the tab ends the session, the way closing a
 * window of Terminal.app does. The layout is what says which sessions are still shown, so the
 * sessions to end are the ones a commit took out of it — whichever gesture did it (the tab's ×, a
 * pane closed, Close Others, a replace), and none for a tab only moved, floated, docked or pulled
 * into another pane.
 */
import type { WorkbenchLayout } from "./layout-types.ts";
import { allLeaves } from "./layout-tree.ts";

/** The terminal sessions the layout's tabs name, tiled and floating. */
export function terminalIdsIn(layout: WorkbenchLayout): Set<string> {
  const ids = new Set<string>();
  for (const leaf of allLeaves(layout)) {
    for (const tab of leaf.tabs) {
      const id = tab.kind === "terminal" ? tab.params.terminalId : undefined;
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** The sessions `before` showed and `after` no longer does: the ones to end. */
export function closedTerminals(before: WorkbenchLayout, after: WorkbenchLayout): string[] {
  if (before === after) return [];
  const kept = terminalIdsIn(after);
  return [...terminalIdsIn(before)].filter((id) => !kept.has(id));
}
