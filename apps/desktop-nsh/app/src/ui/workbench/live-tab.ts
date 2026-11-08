/**
 * A tab the host's render props can keep: one object for as long as the tab is in the pane, whose
 * fields follow the layout. A Svelte snippet got a reactive `tab`; a render function is called once
 * per tab, so what it reads off this object inside its own reactive code stays current (a preview
 * whose file changed keeps its pane instead of being mounted again).
 */
import type { LeafNode, WorkbenchTab } from "../../m/workbench/layout-types.ts";

export function liveTab(leaf: () => LeafNode, id: string): WorkbenchTab {
  let last: WorkbenchTab | undefined;
  const current = (): WorkbenchTab => {
    const found = leaf().tabs.find((tab) => tab.id === id);
    if (found) last = found;
    return last ?? { id, kind: "", params: {} };
  };
  return {
    get id() {
      return id;
    },
    get kind() {
      return current().kind;
    },
    get params() {
      return current().params;
    },
  };
}

/**
 * The pane's active tab, followed: the tab a conversation's body is handed when every conversation
 * the pane shows is drawn by one stage (`WorkbenchLeaf`). Picking another conversation replaces the
 * tab, with a new id; the stage stays and turns to it.
 */
export function liveActiveTab(leaf: () => LeafNode): WorkbenchTab {
  let last: WorkbenchTab | undefined;
  const current = (): WorkbenchTab => {
    const l = leaf();
    const found = l.tabs.find((tab) => tab.id === l.activeTabId);
    if (found) last = found;
    return last ?? { id: "", kind: "", params: {} };
  };
  return {
    get id() {
      return current().id;
    },
    get kind() {
      return current().kind;
    },
    get params() {
      return current().params;
    },
  };
}
