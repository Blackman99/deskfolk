import { expect, test } from "bun:test";
import { createRawSnippet, flushSync } from "svelte";
import Workbench from "./Workbench.svelte";
import { copyFor } from "../copy.ts";
import { click, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import type { LayoutNode, MinSizeLookup, TabAction, WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import { makeBranch, makeLeaf, tiledLeaves } from "./layout-tree.ts";
import { registerPaneEdit } from "./pane-edit.ts";

const t = copyFor("zh");
const flatMins: MinSizeLookup = () => ({ width: 100, height: 100 });
const aTab = (id: string): WorkbenchTab => ({ id, kind: "chat", params: {} });

const tabBody = createRawSnippet((tab: () => WorkbenchTab) => ({
  render: () => `<div data-body="${tab().id}">${tab().kind}</div>`,
}));
const tabLabel = createRawSnippet((tab: () => WorkbenchTab) => ({
  render: () => `<span>${tab().id}</span>`,
}));

function layoutOf(root: LayoutNode, focusId?: string): WorkbenchLayout {
  return { version: 1, root, floating: [], focus: { zone: "tiled", leafId: focusId ?? tiledLeaves(root)[0]!.id } };
}

function box(width: number, height: number): DOMRect {
  return {
    x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height,
    toJSON() { return {}; },
  } as DOMRect;
}

/** happy-dom has no layout, so the workbench is handed the size a split is judged against. */
function mountSized(
  layout: WorkbenchLayout,
  size = { width: 1200, height: 800 },
  body = tabBody,
  tabActions?: (leafId: string, tab: WorkbenchTab) => TabAction[],
) {
  const state = reactive({ layout, seen: [] as WorkbenchLayout[] });
  const mounted = render(Workbench as never, {
    get layout() { return state.layout; },
    mins: flatMins,
    t,
    wide: true,
    tabBody: body,
    tabLabel,
    tabActions,
    onLayout: (next: WorkbenchLayout) => {
      state.seen.push(next);
      state.layout = next;
    },
    onActivate: () => {},
    onCloseTab: () => {},
  } as never);
  const root = mounted.host.querySelector(".wb-root") as HTMLElement;
  root.getBoundingClientRect = () => box(size.width, size.height);
  window.dispatchEvent(new Event("resize"));
  flushSync();
  return { ...mounted, state };
}

function rightClick(el: Element | null, at: MouseEventInit = { clientX: 120, clientY: 40 }): MouseEvent {
  if (!el) throw new Error("rightClick: no element");
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at });
  el.dispatchEvent(event);
  flushSync();
  return event;
}

const menu = () => document.querySelector<HTMLElement>('[data-testid="wb-context-menu"]');
const item = (dir: string) => menu()?.querySelector<HTMLButtonElement>(`[data-split="${dir}"]`) ?? null;

test("right-clicking anywhere in a pane offers a split in each of the four directions", () => {
  const { host, close } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])));
  try {
    const event = rightClick(host.querySelector('[data-body="t1"]'));
    // The webview's own menu does not open on top of it.
    expect(event.defaultPrevented).toBe(true);
    // Lifted out of the pane: a floating pane's transform would otherwise place a `fixed` menu.
    expect(menu()?.parentElement).toBe(document.body);
    const labels = [...menu()!.querySelectorAll('[role="menuitem"]')].map((row) =>
      row.querySelector(".wb-context-label")?.textContent);
    expect(labels).toEqual([t.pane.splitUp, t.pane.splitDown, t.pane.splitLeft, t.pane.splitRight]);
    for (const dir of ["up", "down", "left", "right"]) expect(item(dir)?.disabled).toBe(false);
    expect(menu()!.style.left).toBe("120px");
    expect(menu()!.style.top).toBe("40px");
  } finally {
    close();
  }
  expect(menu()).toBeNull();
});

test("each direction puts a new, empty, current pane on that side", () => {
  const cases = [
    { dir: "up", axis: "column", newFirst: true },
    { dir: "down", axis: "column", newFirst: false },
    { dir: "left", axis: "row", newFirst: true },
    { dir: "right", axis: "row", newFirst: false },
  ] as const;
  for (const { dir, axis, newFirst } of cases) {
    const { host, close, state } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])));
    try {
      rightClick(host.querySelector(".wb-tab-button"));
      click(item(dir));
      expect(menu()).toBeNull();
      expect(state.seen).toHaveLength(1);
      const root = state.layout.root;
      expect(root.type).toBe("branch");
      if (root.type !== "branch") continue;
      expect(root.axis).toBe(axis);
      const [first, second] = root.children;
      const fresh = newFirst ? first! : second!;
      const kept = newFirst ? second! : first!;
      expect(kept.id).toBe("a");
      expect(fresh.type === "leaf" && fresh.tabs.length === 0).toBe(true);
      expect(state.layout.focus.leafId).toBe(fresh.id);
    } finally {
      close();
    }
  }
});

test("the pane that was right-clicked is the one divided, not the one that was current", () => {
  const { host, close, state } = mountSized(layoutOf(makeBranch("r", "row", [
    makeLeaf("a", [aTab("t1")]),
    makeLeaf("b", [aTab("t2")]),
  ]), "a"));
  try {
    rightClick(host.querySelector('[data-leaf="b"] .wb-strip'));
    click(item("down"));
    const root = state.layout.root;
    if (root.type !== "branch") throw new Error("expected a branch");
    expect(root.children[0]!.id).toBe("a");
    const right = root.children[1]!;
    expect(right.type).toBe("branch");
    if (right.type === "branch") {
      expect(right.axis).toBe("column");
      expect(right.children[0]!.id).toBe("b");
    }
  } finally {
    close();
  }
});

test("an empty pane answers a right-click anywhere in it", () => {
  const { host, close, state } = mountSized(layoutOf(makeLeaf("a")));
  try {
    rightClick(host.querySelector(".wb-empty"));
    click(item("left"));
    expect(tiledLeaves(state.layout.root)).toHaveLength(2);
  } finally {
    close();
  }
});

test("the tab strip opens the same menu as the content under it", () => {
  const { host, close, state } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])));
  try {
    rightClick(host.querySelector(".wb-strip"));
    click(item("right"));
    expect(tiledLeaves(state.layout.root)).toHaveLength(2);
  } finally {
    close();
  }
});

/** Content with a menu of its own, the way a message is: it answers the right-click first. */
const withOwnMenu = createRawSnippet((tab: () => WorkbenchTab) => ({
  render: () => `<div data-body="${tab().id}"><p class="message">hi</p><p class="gap">gap</p></div>`,
  setup: (node: Element) => {
    node.querySelector(".message")!.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  },
}));

test("a menu inside the pane that answered the right-click keeps it", () => {
  const { host, close } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])), undefined, withOwnMenu);
  try {
    const onMessage = rightClick(host.querySelector(".message"));
    expect(onMessage.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    // Beside it, in the same content, the pane's menu is back.
    rightClick(host.querySelector(".gap"));
    expect(menu()).not.toBeNull();
  } finally {
    close();
  }
});

/** Content with a text field in it, and a terminal, whose field is xterm's hidden textarea. */
const withFields = createRawSnippet((tab: () => WorkbenchTab) => ({
  render: () => `<div data-body="${tab().id}">
    <input class="field" />
    <div class="composer" contenteditable="true"><span class="chip" contenteditable="false">@a</span></div>
    <div class="locked" contenteditable="false">read only</div>
    <div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
  </div>`,
}));

test("a text field keeps its own menu, where paste is; the terminal's does not count", () => {
  const { host, close } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])), undefined, withFields);
  try {
    for (const selector of [".field", ".composer", ".chip"]) {
      const event = rightClick(host.querySelector(selector));
      expect({ selector, prevented: event.defaultPrevented, menu: menu() !== null })
        .toEqual({ selector, prevented: false, menu: false });
    }
    rightClick(host.querySelector(".locked"));
    expect(menu()).not.toBeNull();
    press(item("up"), "Escape");
    rightClick(host.querySelector(".xterm-helper-textarea"));
    expect(menu()).not.toBeNull();
  } finally {
    close();
  }
});

/** A terminal's host, registered the way TerminalView registers its own. */
function terminalBody(edit: { selected: boolean; calls: string[] }) {
  return createRawSnippet((tab: () => WorkbenchTab) => ({
    render: () => `<div data-body="${tab().id}">
      <p class="elsewhere">header</p>
      <div class="terminal-host"><div class="xterm"><div class="xterm-screen"></div></div></div>
    </div>`,
    setup: (node: Element) =>
      registerPaneEdit(node.querySelector<HTMLElement>(".terminal-host")!, {
        canCopy: () => edit.selected,
        copy: () => edit.calls.push("copy"),
        paste: () => edit.calls.push("paste"),
      }),
  }));
}

test("inside a terminal, Copy and Paste lead the menu and act on that terminal", () => {
  const edit = { selected: false, calls: [] as string[] };
  const { host, close } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])), undefined, terminalBody(edit));
  try {
    rightClick(host.querySelector(".xterm-screen"));
    const labels = [...menu()!.querySelectorAll('[role="menuitem"]')].map((row) =>
      row.querySelector(".wb-context-label")?.textContent);
    expect(labels).toEqual([t.pane.copy, t.pane.paste, t.pane.splitUp, t.pane.splitDown, t.pane.splitLeft, t.pane.splitRight]);
    // Nothing selected: Copy is there but off, and the keyboard lands on Paste.
    const copy = () => menu()!.querySelector<HTMLButtonElement>('[data-edit="copy"]')!;
    const paste = () => menu()!.querySelector<HTMLButtonElement>('[data-edit="paste"]')!;
    expect(copy().disabled).toBe(true);
    click(paste());
    expect(edit.calls).toEqual(["paste"]);
    expect(menu()).toBeNull();

    edit.selected = true;
    rightClick(host.querySelector(".xterm-screen"));
    expect(copy().disabled).toBe(false);
    click(copy());
    expect(edit.calls).toEqual(["paste", "copy"]);

    // Outside the terminal the pane's menu is only the splits.
    rightClick(host.querySelector(".elsewhere"));
    expect(menu()!.querySelector("[data-edit]")).toBeNull();
  } finally {
    close();
  }
});

test("holding Option asks for the webview's own menu", () => {
  const { host, close } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])));
  try {
    // Inspect Element lives there, and copy for a selection.
    const event = rightClick(host.querySelector('[data-body="t1"]'), { clientX: 120, clientY: 40, altKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  } finally {
    close();
  }
});

test("a floating pane opens its menu from anywhere in it", () => {
  const layout: WorkbenchLayout = {
    version: 1,
    root: makeLeaf("a", [aTab("t1")]),
    floating: [{ leaf: makeLeaf("f", [aTab("t2")]), frame: { x: 20, y: 20, width: 300, height: 200 } }],
    focus: { zone: "floating", leafId: "f" },
  };
  const { host, close } = mountSized(layout);
  try {
    rightClick(host.querySelector('[data-body="t2"]'));
    expect(menu()?.querySelector("[data-dock]")).not.toBeNull();
  } finally {
    close();
  }
});

test("a direction without room is shown but cannot be picked", () => {
  // A new pane needs 240 across: 100 + 8 + 240 does not fit in 300, one under the other does.
  const { host, close, state } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])), { width: 300, height: 800 });
  try {
    rightClick(host.querySelector(".wb-strip"));
    expect(item("left")?.disabled).toBe(true);
    expect(item("right")?.disabled).toBe(true);
    expect(item("left")?.title).toBe(t.pane.tooSmall);
    expect(item("up")?.disabled).toBe(false);
    expect(item("down")?.disabled).toBe(false);
    click(item("left"));
    expect(state.seen).toHaveLength(0);
  } finally {
    close();
  }
});

test("a floating pane is offered docking, since it does not divide in place", () => {
  const layout: WorkbenchLayout = {
    version: 1,
    root: makeLeaf("a", [aTab("t1")]),
    floating: [{ leaf: makeLeaf("f", [aTab("t2")]), frame: { x: 20, y: 20, width: 300, height: 200 } }],
    focus: { zone: "floating", leafId: "f" },
  };
  const { host, close, state } = mountSized(layout);
  try {
    rightClick(host.querySelector('[data-float="f"] .wb-float-bar'));
    for (const dir of ["up", "down", "left", "right"]) {
      expect(item(dir)?.disabled).toBe(true);
      expect(item(dir)?.title).toBe(t.pane.dockToSplit);
    }
    click(menu()!.querySelector("[data-dock]"));
    expect(menu()).toBeNull();
    expect(state.layout.floating).toHaveLength(0);
    // Docked the way a double click on its bar docks it: its tab is back in the tiled tree.
    expect(tiledLeaves(state.layout.root).flatMap((leaf) => leaf.tabs.map((tab) => tab.id))).toContain("t2");
  } finally {
    close();
  }
});

test("Escape closes the menu without reaching the shell's own Escape handling", () => {
  const { host, close, state } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])));
  let reachedWindow = 0;
  const onWindowKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") reachedWindow += 1;
  };
  window.addEventListener("keydown", onWindowKey);
  try {
    rightClick(host.querySelector(".wb-strip"));
    press(item("up"), "Escape");
    expect(menu()).toBeNull();
    expect(reachedWindow).toBe(0);
    expect(state.seen.every((next) => tiledLeaves(next.root).length === 1)).toBe(true);
  } finally {
    window.removeEventListener("keydown", onWindowKey);
    close();
  }
});

test("pressing anywhere outside the menu dismisses it", () => {
  const { host, close } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])));
  try {
    rightClick(host.querySelector(".wb-strip"));
    expect(menu()).not.toBeNull();
    host.querySelector('[data-body="t1"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(menu()).toBeNull();
  } finally {
    close();
  }
});

test("arrow keys walk the directions that can be picked", async () => {
  const { host, close } = mountSized(layoutOf(makeLeaf("a", [aTab("t1")])), { width: 300, height: 800 });
  try {
    rightClick(host.querySelector(".wb-strip"));
    await Promise.resolve();
    // Left and right have no room, so the keyboard only lands on up and down.
    expect(document.activeElement).toBe(item("up"));
    press(item("up"), "ArrowDown");
    expect(document.activeElement).toBe(item("down"));
    press(item("down"), "ArrowDown");
    expect(document.activeElement).toBe(item("up"));
  } finally {
    close();
  }
});

/** What a host hands the workbench for a tab: here, one action on the first tab only. */
function offering(ran: string[]) {
  return (leafId: string, tab: WorkbenchTab): TabAction[] =>
    tab.id === "t1" ? [{ id: "settings", label: "设置", active: true, run: () => ran.push(`${leafId}/${tab.id}`) }] : [];
}

test("right-clicking a tab puts what it offers above the splits", () => {
  const ran: string[] = [];
  const { host, close } = mountSized(
    layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2")])), undefined, undefined, offering(ran));
  try {
    rightClick(host.querySelector('[data-tab="t1"] [role="tab"]'));
    const rows = [...menu()!.querySelectorAll('[role="menuitem"]')];
    expect(rows.map((row) => row.querySelector(".wb-context-label")?.textContent))
      .toEqual(["设置", t.pane.splitUp, t.pane.splitDown, t.pane.splitLeft, t.pane.splitRight]);
    expect(rows[0]!.classList.contains("is-active")).toBe(true);
    expect(menu()!.querySelectorAll('[role="separator"]')).toHaveLength(1);
    click(menu()!.querySelector('[data-action="settings"]'));
    expect(ran).toEqual(["a/t1"]);
    expect(menu()).toBeNull();

    // A tab with nothing to offer, and the strip beside the tabs, keep the plain menu.
    rightClick(host.querySelector('[data-tab="t2"] [role="tab"]'));
    expect(menu()!.querySelector("[data-action]")).toBeNull();
    expect(menu()!.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
    press(item("up"), "Escape");
    rightClick(host.querySelector('[data-body="t1"]'));
    expect(menu()!.querySelector("[data-action]")).toBeNull();
    press(item("up"), "Escape");
  } finally {
    close();
  }
});

test("a tab's ⋯ holds only what the tab offers, and a second press on it closes it", async () => {
  const ran: string[] = [];
  const { host, close } = mountSized(
    layoutOf(makeLeaf("a", [aTab("t1"), aTab("t2")])), undefined, undefined, offering(ran));
  try {
    // Beside the tab, never inside it: a button inside a button is invalid.
    const more = host.querySelector<HTMLButtonElement>('[data-tab="t1"] > .wb-tab-more');
    expect(more).not.toBeNull();
    expect(host.querySelector('[role="tab"] .wb-tab-more')).toBeNull();
    expect(host.querySelector('[data-tab="t2"] .wb-tab-more')).toBeNull();
    expect(more!.getAttribute("aria-label")).toBe(t.pane.tabActions);

    click(more);
    expect(more!.getAttribute("aria-expanded")).toBe("true");
    expect(menu()?.parentElement).toBe(document.body);
    expect(menu()!.getAttribute("aria-label")).toBe(t.pane.tabActions);
    expect([...menu()!.querySelectorAll('[role="menuitem"]')].map((row) => row.getAttribute("data-action")))
      .toEqual(["settings"]);
    expect(menu()!.querySelector('[role="separator"]')).toBeNull();

    // The press that lands on the ⋯ is the ⋯'s: it closes, rather than closing and reopening.
    more!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    click(more);
    expect(menu()).toBeNull();
    expect(more!.getAttribute("aria-expanded")).toBe("false");

    click(more);
    await Promise.resolve();
    press(document.activeElement, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(more);

    click(more);
    click(menu()!.querySelector('[data-action="settings"]'));
    expect(ran).toEqual(["a/t1"]);
    expect(menu()).toBeNull();
  } finally {
    close();
  }
});
