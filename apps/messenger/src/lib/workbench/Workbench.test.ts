import { expect, test } from "bun:test";
import { createRawSnippet, flushSync } from "svelte";
import Workbench from "./Workbench.svelte";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import type { MinSizeLookup, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { makeBranch, makeLeaf, tiledLeaves } from "./layout-tree.ts";

const t = copyFor("zh");
const flatMins: MinSizeLookup = () => ({ width: 100, height: 100 });
const aTab = (id: string, kind = "chat"): WorkbenchTab => ({ id, kind, params: {} });

/** The host renders a tab's content; the workbench itself never imports a content component. */
const tabBody = createRawSnippet((tab: () => WorkbenchTab) => ({
  render: () => `<div data-body="${tab().id}">${tab().kind}</div>`,
}));
const tabLabel = createRawSnippet((tab: () => WorkbenchTab) => ({
  render: () => `<span>${tab().id}</span>`,
}));

function layoutOf(root: Parameters<typeof tiledLeaves>[0], focusId?: string): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: focusId ?? tiledLeaves(root)[0]!.id } };
}

function mountWorkbench(layout: WorkbenchLayout, wide = true) {
  const state = reactive({ layout, seen: [] as WorkbenchLayout[] });
  const { host, close } = render(Workbench as never, {
    get layout() { return state.layout; },
    mins: flatMins,
    t,
    wide,
    tabBody,
    tabLabel,
    onLayout: (next: WorkbenchLayout) => {
      state.seen.push(next);
      state.layout = next;
    },
    onActivate: () => {},
    onCloseTab: () => {},
  } as never);
  return { host, close, state };
}

test("one pane per leaf, and only the active tab's content is mounted", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1"), aTab("t2")]),
    makeLeaf("b", [aTab("t3")]),
  ]));
  const { host, close } = mountWorkbench(layout);
  try {
    expect(host.querySelectorAll('[data-testid="wb-leaf"]')).toHaveLength(2);
    // Two tabs in the first pane, but one body: the other is not mounted at all.
    expect(host.querySelectorAll('[data-body]')).toHaveLength(2);
    expect(host.querySelector('[data-body="t1"]')).not.toBeNull();
    expect(host.querySelector('[data-body="t2"]')).toBeNull();
  } finally {
    close();
  }
});

test("dividing shows a divider between the panes", () => {
  const { host, close } = mountWorkbench(layoutOf(makeLeaf("a", [aTab("t1")])));
  try {
    expect(host.querySelectorAll('[data-sash]')).toHaveLength(0);
  } finally {
    close();
  }

  const divided = mountWorkbench(layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")]),
  ])));
  try {
    expect(divided.host.querySelectorAll('[data-sash]')).toHaveLength(1);
  } finally {
    divided.close();
  }
});

test("the tab strip carries the roles a reader needs", () => {
  const { host, close } = mountWorkbench(layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2")])));
  try {
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    const tabs = [...host.querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("false");
    // Roving tabindex: only the active tab is in the tab order.
    expect(tabs[0]!.getAttribute("tabindex")).toBe("0");
    expect(tabs[1]!.getAttribute("tabindex")).toBe("-1");
    expect(tabs[0]!.getAttribute("aria-controls")).toBe("wb-panel-a");
    expect(host.querySelector('[role="tabpanel"]')!.id).toBe("wb-panel-a");
  } finally {
    close();
  }
});

test("the close control is a sibling of the tab, not nested inside it", () => {
  // A button inside a button is invalid, and it is also what makes the close target unreachable.
  const { host, close } = mountWorkbench(layoutOf(makeLeaf("a", [aTab("t1")])));
  try {
    const tab = host.querySelector('[role="tab"]')!;
    expect(tab.querySelector("button")).toBeNull();
    expect(tab.parentElement!.querySelector(".wb-tab-close")).not.toBeNull();
  } finally {
    close();
  }
});

test("a pane with no tabs says so rather than showing a blank rectangle", () => {
  const { host, close } = mountWorkbench(layoutOf(makeLeaf("a", [])));
  try {
    expect(host.textContent).toContain(t.pane.empty);
    expect(host.querySelectorAll("[data-body]")).toHaveLength(0);
  } finally {
    close();
  }
});

test("the focused pane is marked by more than colour", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")]),
  ]), "b");
  const { host, close } = mountWorkbench(layout);
  try {
    const focused = host.querySelector('.wb-leaf.is-focused')!;
    expect(focused.getAttribute("data-leaf")).toBe("b");
    expect(host.querySelectorAll('.wb-leaf.is-focused')).toHaveLength(1);
  } finally {
    close();
  }
});

test("clicking inside a pane moves focus to it", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")]),
  ]), "a");
  const { host, close, state } = mountWorkbench(layout);
  try {
    const target = host.querySelector('[data-leaf="b"] .wb-body') as HTMLElement;
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(state.seen.at(-1)!.focus.leafId).toBe("b");
  } finally {
    close();
  }
});

test("a narrow window draws only the focused pane and leaves the tree alone", () => {
  const layout = layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]), makeLeaf("b", [aTab("t2")]),
  ]), "b");
  const { host, close, state } = mountWorkbench(layout, false);
  try {
    expect(host.querySelectorAll('[data-testid="wb-leaf"]')).toHaveLength(1);
    expect(host.querySelector('[data-leaf="b"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-sash]')).toHaveLength(0);
    // Nothing was written: widening brings the arrangement back exactly as it was.
    expect(state.seen).toHaveLength(0);
    expect(state.layout).toEqual(layout);
  } finally {
    close();
  }
});

test("closing a tab is reported rather than applied behind the host's back", () => {
  let closed: Array<[string, string]> = [];
  const state = reactive({ layout: layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2")])) });
  const { host, close } = render(Workbench as never, {
    get layout() { return state.layout; },
    mins: flatMins,
    t,
    wide: true,
    tabBody,
    tabLabel,
    onLayout: () => {},
    onCloseTab: (leafId: string, tabId: string) => closed.push([leafId, tabId]),
  } as never);
  try {
    click(host.querySelector(".wb-tab-close"));
    expect(closed).toEqual([["a", "t1"]]);
  } finally {
    close();
  }
});
