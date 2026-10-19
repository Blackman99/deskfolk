import { expect, test } from "bun:test";
import { applyWindowChromeAttribute, scrollbarIsNotDrag, syncWindowTheme, windowChrome, windowTheme } from "./window-chrome.ts";

test("only the desktop window on macOS draws its own frame", () => {
  expect(windowChrome(true, "mac")).toBe("mac");
  expect(windowChrome(true, "windows")).toBe("system");
  expect(windowChrome(false, "mac")).toBe("system");
});

test("the root says which frame the page draws", () => {
  applyWindowChromeAttribute("mac");
  expect(document.documentElement.dataset.chrome).toBe("mac");
  applyWindowChromeAttribute("system");
  expect(document.documentElement.dataset.chrome).toBe("system");
});

test("a chosen theme pins the window; following the system leaves it to the system", () => {
  expect(windowTheme("dark", "dark")).toBe("dark");
  expect(windowTheme("light", "light")).toBe("light");
  expect(windowTheme("system", "dark")).toBeNull();
  expect(windowTheme("system", "light")).toBeNull();
});

test("the window is told the page's theme, and a browser tab is left alone", async () => {
  const calls: unknown[][] = [];
  const g = globalThis as { __TAURI_INTERNALS__?: unknown };
  syncWindowTheme("dark", "dark");
  expect(calls).toHaveLength(0);
  g.__TAURI_INTERNALS__ = { invoke: async (...args: unknown[]) => void calls.push(args) };
  try {
    syncWindowTheme("dark", "dark");
    syncWindowTheme("system", "light");
    await Promise.resolve();
    expect(calls).toEqual([
      ["plugin:window|set_theme", { label: "main", value: "dark" }],
      ["plugin:window|set_theme", { label: "main", value: null }],
    ]);
  } finally {
    delete g.__TAURI_INTERNALS__;
  }
});

test("a press on a drag region's scrollbar does not move the window; one on its empty space does", async () => {
  const node = document.createElement("div");
  node.setAttribute("data-tauri-drag-region", "");
  // A 200×300 list whose classic scrollbar takes the right 15px.
  Object.defineProperty(node, "clientWidth", { value: 185 });
  Object.defineProperty(node, "clientHeight", { value: 300 });
  node.getBoundingClientRect = () => ({ left: 10, top: 20, right: 210, bottom: 320, width: 200, height: 300, x: 10, y: 20, toJSON() {} }) as DOMRect;
  document.body.append(node);
  const seen: (string | null)[] = [];
  const onDoc = () => seen.push(node.getAttribute("data-tauri-drag-region"));
  document.addEventListener("mousedown", onDoc);
  const action = scrollbarIsNotDrag(node);
  try {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 200 }));
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 205, clientY: 200 }));
    // What Tauri's document listener reads: empty space drags, the scrollbar does not.
    expect(seen).toEqual(["", "false"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(node.getAttribute("data-tauri-drag-region")).toBe("");
    // A press on a row inside the list is left to Tauri's own check.
    const row = document.createElement("button");
    node.append(row);
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 205, clientY: 200 }));
    expect(seen.at(-1)).toBe("");
  } finally {
    action.destroy();
    document.removeEventListener("mousedown", onDoc);
    node.remove();
  }
});
