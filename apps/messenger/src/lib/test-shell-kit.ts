/** What several Shell test files share: loading a mounted Shell, terminal rows, stored tabs, menu rows. */
import { mock } from "bun:test";
import { mockMonacoCss, mockXtermAddons } from "./test-mocks.ts";

/**
 * The Shell, loaded after mocking what it pulls in that happy-dom cannot run. Call it once at the
 * top of a test file, before anything renders a Shell.
 */
export async function loadShell() {
  // Monaco's Vite-only stylesheet alias is unrelated to the mounted confirmation surfaces.
  mockMonacoCss();
  // A terminal tab mounts xterm, which draws to a canvas happy-dom does not have.
  mock.module("@xterm/xterm", () => ({
    Terminal: class {
      rows = 24; cols = 80; options = {}; unicode = { activeVersion: "6" };
      _core: { viewport?: { scrollBarWidth: number } } = {};
      parser = { registerCsiHandler: () => ({ dispose() {} }), registerDcsHandler: () => ({ dispose() {} }), registerOscHandler: () => ({ dispose() {} }) };
      loadAddon() {}
      open() { this._core.viewport = { scrollBarWidth: 15 }; }
      onData() {} attachCustomKeyEventHandler() {} reset() {} clear() {} resize() {} focus() {} dispose() {}
      write(_data: unknown, done?: () => void) { done?.(); }
      hasSelection() { return false; } getSelection() { return ""; } paste() {}
    },
  }));
  mockXtermAddons();
  mock.module("@xterm/addon-search", () => ({ SearchAddon: class { onDidChangeResults() {} findNext() { return false; } findPrevious() { return false; } clearDecorations() {} } }));
  return (await import("./Shell.svelte")).default;
}

export function aTerminal(id: string, created_at: string) {
  return { id, title: "real-bot", cwd: "/fixture", rows: 24, cols: 80, created_at, status: "live" as const, exit_code: null, stream_end: 0 };
}

type StoredNode = { tabs?: Array<{ kind: string; params: Record<string, string> }>; children?: StoredNode[] };

/** Every tab the saved layout holds, pane by pane in reading order, floating panes last. */
export function storedTabs() {
  const saved = JSON.parse(localStorage.getItem("real-bot-workbench-layout")!);
  const walk = (node: StoredNode): StoredNode[] => (node.children ? node.children.flatMap(walk) : [node]);
  const leaves = [...walk(saved.root), ...saved.floating.map((pane: { leaf: StoredNode }) => pane.leaf)];
  return leaves.flatMap((leaf) => leaf.tabs ?? []);
}

/** A row of the portaled new-tab menu, by the name it shows. */
export function menuRow(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>(".wb-new-menu .wb-menu-row")].find(
    (row) => row.querySelector(".wb-menu-name")?.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no menu row labelled ${name}`);
  return found;
}
