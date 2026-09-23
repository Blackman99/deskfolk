import { expect, test } from "bun:test";
import { createRawSnippet, flushSync } from "svelte";
import WorkbenchLeaf from "./WorkbenchLeaf.svelte";
import { copyFor } from "../copy.ts";
import { click, fill, press, render } from "../test-render.ts";
import { makeLeaf } from "./layout-tree.ts";
import type { WorkbenchTab } from "./layout-types.ts";

const t = copyFor("zh");
const tabBody = createRawSnippet((tab: () => WorkbenchTab) => ({ render: () => `<div>${tab().id}</div>` }));
const tabLabel = createRawSnippet((tab: () => WorkbenchTab) => ({ render: () => `<span>${tab().id}</span>` }));

/** Rows the way the shell writes them, marked with the pane they were rendered for. */
const menuActions = createRawSnippet((leafId: () => string) => ({
  render: () =>
    `<div data-leaf-id="${leafId()}">` +
    `<button type="button" class="wb-menu-row" role="menuitem">one</button>` +
    `<div class="wb-menu-section" role="presentation">section</div>` +
    `<button type="button" class="wb-menu-row" role="menuitem">two</button>` +
    `</div>`,
}));
const emptyActions = createRawSnippet(() => ({
  render: () => `<div><button type="button" class="pane-open">chip</button></div>`,
}));

function mountEmpty(props: Record<string, unknown>) {
  return render(WorkbenchLeaf as never, {
    leaf: makeLeaf("a", []),
    focused: true,
    t,
    tabBody,
    tabLabel,
    onFocus: () => {},
    onActivate: () => {},
    onCloseTab: () => {},
    ...props,
  } as never);
}

test("an empty pane lays out the + menu's list, filter and all, instead of a row of chips", () => {
  const { host, close } = mountEmpty({ menuActions, emptyActions });
  try {
    const card = host.querySelector<HTMLElement>(".wb-empty-card");
    expect(card).not.toBeNull();
    expect(card!.getAttribute("role")).toBe("menu");
    // The same classes the + menu styles, so the two cannot drift apart.
    expect(card!.querySelector(".wb-new-query input")).not.toBeNull();
    expect(card!.querySelectorAll(".wb-new-scroll .wb-menu-row")).toHaveLength(2);
    expect(host.querySelector(".pane-open")).toBeNull();
    expect(host.querySelector(".wb-empty-title")?.textContent).toBe(t.pane.empty);
    expect(host.querySelector(".wb-empty-hint")?.textContent).toBe(t.pane.emptyPick);
    expect(card!.querySelector("[data-leaf-id]")?.getAttribute("data-leaf-id")).toBe("a");
  } finally {
    close();
  }
});

test("typing in the empty pane's filter hands the text to the list", () => {
  // A raw snippet renders once, so the list reads the filter when a row is picked.
  const seen: string[] = [];
  const reading = createRawSnippet((_leafId: () => string, query: () => string) => ({
    render: () => `<div><button type="button" class="wb-menu-row" role="menuitem">one</button></div>`,
    setup: (node: Element) => {
      node.querySelector("button")!.addEventListener("click", () => seen.push(query()));
    },
  }));
  const { host, close } = mountEmpty({ menuActions: reading });
  try {
    fill(host.querySelector(".wb-empty-card input"), "workspace");
    click(host.querySelector(".wb-empty-card .wb-menu-row"));
    expect(seen).toEqual(["workspace"]);
  } finally {
    close();
  }
});

test("arrow keys move between the filter and the rows of the empty pane", () => {
  const { host, close } = mountEmpty({ menuActions });
  try {
    const input = host.querySelector<HTMLInputElement>(".wb-empty-card input")!;
    const rows = [...host.querySelectorAll<HTMLElement>(".wb-empty-card .wb-menu-row")];
    input.focus();
    press(input, "ArrowDown");
    expect(document.activeElement).toBe(rows[0]!);
    press(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]!);
    press(rows[1], "ArrowUp");
    expect(document.activeElement).toBe(rows[0]!);
    press(rows[0], "ArrowUp");
    expect(document.activeElement).toBe(input);
    // In the filter, Home and End are the caret's, not the list's.
    const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
    input.dispatchEvent(home);
    flushSync();
    expect(home.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  } finally {
    close();
  }
});

test("without a shaped list the empty pane still offers what it was given", () => {
  const { host, close } = mountEmpty({ emptyActions });
  try {
    expect(host.querySelector(".wb-empty-card")).toBeNull();
    expect(host.querySelector(".pane-open")?.textContent).toBe("chip");
  } finally {
    close();
  }
});

test("with nothing to offer it says what a pane can hold", () => {
  const { host, close } = mountEmpty({});
  try {
    expect(host.querySelector(".wb-empty-hint")?.textContent).toBe(t.pane.emptyHint);
  } finally {
    close();
  }
});
