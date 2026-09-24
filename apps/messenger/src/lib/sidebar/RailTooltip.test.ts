import { expect, test } from "bun:test";
import { createRawSnippet, flushSync } from "svelte";
import { click, press, render } from "../test-render.ts";
import RailTooltip from "./RailTooltip.svelte";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tip = () => document.querySelector<HTMLElement>('[data-rail-tip="rail-tip-spec"] .rail-tooltip');

function pointer(type: string, pointerType: string) {
  return new PointerEvent(type, { bubbles: true, pointerType, cancelable: true });
}

function hover(el: HTMLElement, type: "mouseenter" | "mouseleave", at?: { x: number; y: number }): void {
  // mouseenter does not bubble. Dispatch it on the node the listener is on.
  const box = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent(type, {
    bubbles: false,
    clientX: at?.x ?? box.left + box.width / 2,
    clientY: at?.y ?? box.top + box.height / 2,
  }));
  flushSync();
}

const glyph = createRawSnippet(() => ({ render: () => `<span class="tip-child">avatar</span>` }));

function mount(label: string | string[] = ["Video crew", "Waiting 2"], enabled = true) {
  let clicks = 0;
  let keys = 0;
  const view = render(RailTooltip, {
    label,
    describedBy: "rail-tip-spec",
    enabled,
    class: "rail-item",
    "data-session": "sess-1",
    onclick: () => (clicks += 1),
    onkeydown: () => (keys += 1),
    children: glyph,
  });
  const button = view.host.querySelector("button")!;
  return { ...view, button, clicks: () => clicks, keys: () => keys };
}

test("hover waits, focus does not, and resize dismisses the anchored tip", async () => {
  const view = mount();
  view.button.getBoundingClientRect = () => ({ left: 12, right: 60, top: 40, bottom: 88, width: 48, height: 48, x: 12, y: 40, toJSON() { return {}; } }) as DOMRect;
  hover(view.button, "mouseenter");
  await wait(120);
  expect(tip()).toBeNull();
  await wait(120);
  flushSync();
  const shown = tip()!;
  expect(shown.style.left).toBe("68px");
  expect(shown.getAttribute("popover")).toBe("manual");
  expect([...shown.querySelectorAll(".rail-tooltip-line")].map((line) => line.textContent)).toEqual(["Video crew", "Waiting 2"]);
  expect(view.button.getAttribute("aria-describedby")).toBe("rail-tip-spec");
  expect(view.button.getAttribute("aria-label")).toBe("Video crew");
  expect(view.button.hasAttribute("title")).toBe(false);
  window.dispatchEvent(new Event("resize")); flushSync();
  expect(tip()).toBeNull();

  hover(view.button, "mouseenter"); await wait(220); flushSync();
  hover(view.button, "mouseleave", { x: 400, y: 400 });
  // A short grace period lets the pointer cross the gap to the tooltip.
  await wait(160); flushSync();
  expect(tip()).toBeNull();
  expect(view.button.hasAttribute("aria-describedby")).toBe(false);

  view.button.focus();
  flushSync();
  expect(document.activeElement).toBe(view.button);
  expect(tip()).not.toBeNull();
  press(view.button, "Escape");
  expect(tip()).toBeNull();
  expect(document.activeElement).toBe(view.button);
  view.close();
});

test("the pointer can rest on the tip, Escape stops at the tip, and a disabled control still explains itself", async () => {
  const view = mount("Search (⌘K)", false);
  view.button.focus();
  flushSync();
  const shown = tip()!;
  shown.getBoundingClientRect = () => ({ left: 80, right: 180, top: 40, bottom: 76, width: 100, height: 36, x: 80, y: 40, toJSON() { return {}; } }) as DOMRect;
  view.button.getBoundingClientRect = () => ({ left: 12, right: 60, top: 40, bottom: 88, width: 48, height: 48, x: 12, y: 40, toJSON() { return {}; } }) as DOMRect;
  // Leaving the button for the tip's box keeps it; leaving that box closes it.
  hover(view.button, "mouseleave", { x: 100, y: 50 });
  view.button.blur();
  flushSync();
  expect(tip()).not.toBeNull();
  hover(shown, "mouseleave", { x: 0, y: 0 });
  expect(tip()).toBeNull();

  view.button.focus();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  view.button.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(escape.cancelBubble).toBe(true);
  expect(tip()).toBeNull();
  expect(view.keys()).toBe(0);

  click(view.button);
  expect(view.clicks()).toBe(0);
  expect(view.button.getAttribute("aria-disabled")).toBe("true");
  view.close();
  expect(document.querySelector('[data-rail-tip="rail-tip-spec"]')).toBeNull();
});

test("a touch never opens a tip, a click and a scroll close one, and unmount drops a pending hover", async () => {
  const view = mount();
  view.button.dispatchEvent(pointer("pointerdown", "touch"));
  hover(view.button, "mouseenter");
  view.button.focus();
  await wait(250);
  expect(tip()).toBeNull();
  click(view.button);
  expect(view.clicks()).toBe(1);

  hover(view.button, "mouseenter");
  view.close();
  await wait(250);
  expect(document.querySelector('[data-rail-tip="rail-tip-spec"]')).toBeNull();

  const again = mount();
  again.button.focus();
  flushSync();
  expect(tip()).not.toBeNull();
  document.dispatchEvent(new Event("scroll", { bubbles: true }));
  flushSync();
  expect(tip()).toBeNull();
  again.button.focus();
  click(again.button);
  expect(tip()).toBeNull();
  expect(again.clicks()).toBe(1);
  again.close();
});
