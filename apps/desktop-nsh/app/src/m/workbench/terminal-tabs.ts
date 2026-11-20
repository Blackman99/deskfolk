/**
 * Which terminal sessions a change to the layout took off the screen. Taking one off ends nothing
 * that runs: closing a tab, closing its pane, Close Others or a replace only puts the shell away,
 * to be reattached later, and 结束会话 in the tab's head is what ends one. A session whose shell has
 * already ended is different: nothing is left to carry on with, so once no tab shows it the
 * workbench forgets it rather than leave a finished row under 接回. Moving, floating, docking and
 * pulling a tab into another pane take nothing off the screen.
 */
import type { Terminal } from "@real-bot/protocol";
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

/** The sessions `before` showed and `after` no longer does. */
export function closedTerminals(before: WorkbenchLayout, after: WorkbenchLayout): string[] {
  if (before === after) return [];
  const kept = terminalIdsIn(after);
  return [...terminalIdsIn(before)].filter((id) => !kept.has(id));
}

/**
 * Of the sessions a commit took off the screen, the ones to forget: those the runtime's list says
 * have already ended. A running one runs on. Before the list has been read (`rows` null) nothing
 * is known to have ended, so nothing is forgotten.
 */
export function endedTerminalsClosed(before: WorkbenchLayout, after: WorkbenchLayout, rows: readonly Terminal[] | null): string[] {
  if (!rows) return [];
  const ended = new Set(rows.filter((row) => row.status !== "live").map((row) => row.id));
  return closedTerminals(before, after).filter((id) => ended.has(id));
}
