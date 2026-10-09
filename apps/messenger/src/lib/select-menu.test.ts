import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import Select from "./Select.svelte";
import { click, render } from "./test-render.ts";

/**
 * The menu of a narrow field near the window's right edge: in the top layer, as wide as its rows
 * (here 400px), never narrower than the field, slid left to keep 8px from the edge, under the field.
 */
test("an open menu is placed against the window, as wide as its rows, and kept inside it", () => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = { show: proto.showPopover, hide: proto.hidePopover, width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth") };
  const shown: string[] = [];
  proto.showPopover = function (this: HTMLElement) { shown.push(this.className); };
  proto.hidePopover = function () {};
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("real-select-menu") ? 400 : 0; },
  });
  try {
    const view = render(Select, { value: "a", options: [{ value: "a", label: "gemini-3.8-flash-high", hint: "My CPA" }] });
    const trigger = view.host.querySelector<HTMLButtonElement>(".real-select-trigger")!;
    trigger.getBoundingClientRect = () => ({ left: 800, right: 950, top: 100, bottom: 130, width: 150, height: 30, x: 800, y: 100, toJSON: () => ({}) });
    click(trigger);
    flushSync();
    const menu = view.host.querySelector<HTMLElement>(".real-select-menu")!;
    expect(shown).toHaveLength(1);
    expect(menu.getAttribute("popover")).toBe("manual");
    expect(menu.style.minWidth).toBe("150px");
    expect(menu.style.maxWidth).toBe("420px");
    const viewport = document.documentElement.clientWidth || window.innerWidth;
    expect(menu.style.left).toBe(`${viewport - 8 - 400}px`);
    expect(menu.style.top).toBe("134px");
    click(trigger);
    flushSync();
    expect(view.host.querySelector(".real-select-menu")).toBeNull();
    view.close();
  } finally {
    for (const [name, value] of [["showPopover", saved.show], ["hidePopover", saved.hide]] as const) {
      if (value === undefined) delete proto[name];
      else proto[name] = value;
    }
    // Put back what was there, or take ours off so the inherited getter shows through again.
    if (saved.width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", saved.width);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
  }
});
