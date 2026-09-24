import { expect, test } from "bun:test";
import { render } from "../test-render.ts";
import { PANE_KINDS } from "./pane-content.ts";
import PaneTabLabel from "./PaneTabLabel.svelte";

test("every kind of tab carries a picture of its own before its name", () => {
  const pictures = new Set<string>();
  for (const kind of PANE_KINDS) {
    const { host, close } = render(PaneTabLabel, { kind, title: "日程" });
    try {
      const icon = host.querySelector(".wb-tab-icon");
      // Marked for the strip, which shows it only once the pane is narrow.
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.getAttribute("data-kind")).toBe(kind);
      const svg = icon?.querySelector("svg")?.innerHTML ?? "";
      expect(svg).not.toBe("");
      pictures.add(svg);
      expect(host.querySelector(".pane-tab-name")?.textContent).toBe("日程");
      expect(host.querySelector(".pane-tab")?.getAttribute("title")).toBe("日程");
    } finally {
      close();
    }
  }
  expect(pictures.size).toBe(PANE_KINDS.length);
});

test("a tab this build cannot read keeps its bare name", () => {
  const { host, close } = render(PaneTabLabel, { kind: null, title: "窗格" });
  try {
    expect(host.querySelector(".wb-tab-icon")).toBeNull();
    expect(host.querySelector(".pane-tab-name")?.textContent).toBe("窗格");
  } finally {
    close();
  }
});
