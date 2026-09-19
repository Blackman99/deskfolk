/**
 * Mount a component into a throwaway host. Svelte 5 batches, so every helper here flushes before
 * returning — a test asserts on the DOM right after the interaction, not a tick later.
 */
import { flushSync, mount, unmount, type Component } from "svelte";

export function render<P extends Record<string, unknown>>(
  component: Component<P, Record<string, never>, string>,
  props: P,
): { host: HTMLElement; close: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = mount(component as never, { target: host, props: props as never });
  flushSync();
  return {
    host,
    close: () => {
      void unmount(app);
      flushSync();
      host.remove();
    },
  };
}

export function click(el: Element | null | undefined): void {
  if (!el) throw new Error("click: no element");
  (el as HTMLElement).click();
  flushSync();
}

export function fill(el: Element | null | undefined, value: string): void {
  if (!el) throw new Error("fill: no element");
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

/** A field that opens on `mousedown` — a menu, a picker — never sees a plain `click`. */
export function mouseDown(el: Element | null | undefined): void {
  if (!el) throw new Error("mouseDown: no element");
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  flushSync();
}

export function press(el: Element | null | undefined, key: string, init: KeyboardEventInit = {}): void {
  if (!el) throw new Error("press: no element");
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  flushSync();
}

/** Text of every `.field-error` currently rendered, which is how these panes report a bad field. */
export function fieldErrors(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".field-error")].map((e) => e.textContent?.trim() ?? "");
}

export function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button labelled ${text}`);
  return found as HTMLButtonElement;
}
