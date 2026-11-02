import { expect, mock, test } from "bun:test";
import { mockMonacoCss } from "../test-mocks.ts";

mockMonacoCss();
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

test("while the editor loads, a large file shows only its opening", () => {
  // The whole file in this layer held WebKit in one layout for minutes: a 13 MB novel, 96 s.
  const code = `第一章\n${"字".repeat(3_000_000)}`;
  const { host, close } = render(Harness, { code });
  const shown = host.querySelector(".artifact-cm-fallback")?.textContent ?? "";
  expect(shown.startsWith("第一章\n字字")).toBe(true);
  expect(shown.length).toBeLessThan(50_000);
  close();
});

test("while the editor loads, a small file shows whole", () => {
  const code = "const a = 1;\nconst b = 2;\n";
  const { host, close } = render(Harness, { code });
  expect(host.querySelector(".artifact-cm-fallback")?.textContent).toBe(code);
  close();
});
