/**
 * Keeps the layout's objects while they say the same. Each commit hands the workbench a fresh copy
 * of the whole layout (the shell's `snapshot`), and a divider in hand makes a new one on every
 * move. A pane, a tab or a tab's params made anew have everything that reads them work again (the
 * tab's content, its bar, its label, a map that read its conversation anew), though only a weight
 * changed. The sharer gives back, for each node, tab and floating pane that is the same as the one
 * it handed out last, that object; only what changed, and what holds it, is new.
 */
import type { FloatingPane, LayoutNode, WorkbenchLayout, WorkbenchTab } from "../../m/workbench/layout-types.ts";

export function createLayoutSharer(): (next: WorkbenchLayout) => WorkbenchLayout {
  let nodes = new Map<string, LayoutNode>();
  let tabs = new Map<string, WorkbenchTab>();
  let floats = new Map<string, FloatingPane>();
  let last: WorkbenchLayout | null = null;

  return (next) => {
    if (next === last) return next;
    const seenNodes = new Map<string, LayoutNode>();
    const seenTabs = new Map<string, WorkbenchTab>();
    const seenFloats = new Map<string, FloatingPane>();

    const tab = (t: WorkbenchTab): WorkbenchTab => {
      const before = tabs.get(t.id);
      const keep = before && sameTab(before, t) ? before : t;
      seenTabs.set(t.id, keep);
      return keep;
    };
    const node = (n: LayoutNode): LayoutNode => {
      const before = nodes.get(n.id);
      let keep: LayoutNode;
      if (n.type === "leaf") {
        const shared = n.tabs.map(tab);
        keep = before?.type === "leaf" && before.activeTabId === n.activeTabId && sameItems(before.tabs, shared) ? before : { ...n, tabs: shared };
      } else {
        const shared = n.children.map(node);
        keep =
          before?.type === "branch" && before.axis === n.axis && sameItems(before.weights, n.weights) && sameItems(before.children, shared)
            ? before
            : { ...n, children: shared };
      }
      seenNodes.set(n.id, keep);
      return keep;
    };
    const float = (pane: FloatingPane): FloatingPane => {
      const leaf = node(pane.leaf) as FloatingPane["leaf"];
      const before = floats.get(pane.leaf.id);
      const keep = before && before.leaf === leaf && sameFrame(before.frame, pane.frame) ? before : { ...pane, leaf };
      seenFloats.set(pane.leaf.id, keep);
      return keep;
    };

    const root = node(next.root);
    const floating = next.floating.map(float);
    nodes = seenNodes;
    tabs = seenTabs;
    floats = seenFloats;
    const out =
      last &&
      last.version === next.version &&
      last.root === root &&
      sameItems(last.floating, floating) &&
      last.focus.zone === next.focus.zone &&
      last.focus.leafId === next.focus.leafId
        ? last
        : { ...next, root, floating };
    last = out;
    return out;
  };
}

function sameTab(a: WorkbenchTab, b: WorkbenchTab): boolean {
  if (a.kind !== b.kind) return false;
  const ka = Object.keys(a.params);
  const kb = Object.keys(b.params);
  return ka.length === kb.length && ka.every((key) => a.params[key] === b.params[key]);
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameFrame(a: FloatingPane["frame"], b: FloatingPane["frame"]): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
