import { expect, mock, test } from "bun:test";

mock.module("monaco-editor-css", () => ({}));
mock.module("monaco-editor/esm/vs/platform/hover/browser/hover.css", () => ({}));
mock.module("monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css", () => ({}));
const { default: Harness } = await import("./ArtifactCodeEditorHarness.svelte");
import { click, render } from "../test-render.ts";

/**
 * Monaco itself does not load under bun (its ESM subpaths do not resolve here), so each time the
 * editor is set up is counted by the resize watcher that setup starts on the editor's host.
 */
function countEditorSetups(): { setups: () => number; restore: () => void } {
  const Real = globalThis.ResizeObserver;
  const watched: Element[] = [];
  globalThis.ResizeObserver = class {
    observe(target: Element) {
      watched.push(target);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return {
    setups: () => watched.filter((el) => el.classList.contains("artifact-cm")).length,
    restore: () => {
      globalThis.ResizeObserver = Real;
    },
  };
}

test("the editor is not rebuilt when the object naming its file is remade for the same file", () => {
  const count = countEditorSetups();
  try {
    const { host, close } = render(Harness, { code: "const a = 1;\n" });
    expect(count.setups()).toBe(1);

    click(host.querySelector("[data-remake]"));
    click(host.querySelector("[data-remake]"));
    expect(count.setups()).toBe(1);

    click(host.querySelector("[data-other]"));
    expect(count.setups()).toBe(2);
    close();
  } finally {
    count.restore();
  }
});
