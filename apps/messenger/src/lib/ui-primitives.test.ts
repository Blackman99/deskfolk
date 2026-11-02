import { afterEach, expect, test } from "bun:test";
import Button from "./Button.svelte";
import Icon from "./Icon.svelte";
import IconButton from "./IconButton.svelte";
import ToastHost from "./ToastHost.svelte";
import { ICONS } from "./icons.ts";
import { TOAST_LEAVE_MS, TOAST_MS, showToast, toasts } from "./toast.svelte.ts";
import { copyFor } from "./copy.ts";
import { click, render } from "./test-render.ts";
import { flushSync } from "svelte";

afterEach(() => {
  toasts.dismiss();
  toasts.current = null;
});

const t = copyFor("zh");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("every icon draws at least one shape", () => {
  for (const name of Object.keys(ICONS) as (keyof typeof ICONS)[]) {
    const { host, close } = render(Icon, { name });
    expect(host.querySelector("svg")?.children.length ?? 0).toBeGreaterThan(0);
    close();
  }
});

test("an icon without a label is hidden from readers; with one it is an image", () => {
  const plain = render(Icon, { name: "pin" });
  expect(plain.host.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  plain.close();
  const labelled = render(Icon, { name: "pin", label: "置顶" });
  expect(labelled.host.querySelector("svg")?.getAttribute("role")).toBe("img");
  expect(labelled.host.querySelector("svg")?.getAttribute("aria-label")).toBe("置顶");
  labelled.close();
});

test("a button says its kind and size in its classes and passes clicks through", () => {
  let clicks = 0;
  const { host, close } = render(Button, { variant: "primary", size: "lg", icon: "check", onclick: () => clicks++ });
  const button = host.querySelector("button");
  expect(button?.className).toContain("is-primary");
  expect(button?.className).toContain("is-lg");
  expect(button?.getAttribute("type")).toBe("button");
  expect(host.querySelector("svg[data-icon='check']")).not.toBeNull();
  click(button);
  expect(clicks).toBe(1);
  close();
});

test("an icon button is named by its label, and a toggle says whether it is pressed", () => {
  const { host, close } = render(IconButton, { icon: "pin", label: "置顶", pressed: true });
  const button = host.querySelector("button");
  expect(button?.getAttribute("aria-label")).toBe("置顶");
  expect(button?.getAttribute("title")).toBe("置顶");
  expect(button?.getAttribute("aria-pressed")).toBe("true");
  expect(button?.classList.contains("is-on")).toBe(true);
  close();
});

test("a toast shows, then leaves on its own", async () => {
  const { host, close } = render(ToastHost, { t });
  showToast("已复制", { ms: 20 });
  flushSync();
  expect(host.querySelector(".toast-host")?.textContent).toContain("已复制");
  await new Promise((resolve) => setTimeout(resolve, 20 + TOAST_LEAVE_MS + 40));
  flushSync();
  expect(host.querySelector(".toast-host")).toBeNull();
  close();
});

test("a newer toast replaces the one showing, and an action runs and dismisses", () => {
  const { host, close } = render(ToastHost, { t });
  let retried = 0;
  showToast("已复制");
  showToast("没发出去", { tone: "error", action: { label: "重试", run: () => retried++ } });
  flushSync();
  expect(host.querySelectorAll(".toast-host").length).toBe(1);
  expect(host.querySelector(".toast-host")?.classList.contains("is-error")).toBe(true);
  click(host.querySelector(".toast-act"));
  expect(retried).toBe(1);
  expect(toasts.current?.leaving).toBe(true);
  close();
});

test("a toast carries its countdown, and ✕ closes it before the time is up", () => {
  const { host, close } = render(ToastHost, { t });
  showToast("在项目目录里没找到 a.tsx", { tone: "info" });
  flushSync();
  const card = host.querySelector<HTMLElement>(".toast-host");
  expect(card?.classList.contains("is-info")).toBe(true);
  expect(card?.style.getPropertyValue("--toast-ms")).toBe(`${TOAST_MS}ms`);
  expect(host.querySelector(".toast-ring-left")).not.toBeNull();
  const closeButton = host.querySelector(".toast-close");
  expect(closeButton?.getAttribute("aria-label")).toBe(t.common.close);
  expect(closeButton?.getAttribute("title")).toBe(t.common.close);
  click(closeButton);
  expect(toasts.current?.leaving).toBe(true);
  close();
});

test("held, a toast stops its countdown; let go, it goes on from where it stopped", async () => {
  const { host, close } = render(ToastHost, { t });
  showToast("已复制", { ms: 600 });
  flushSync();
  await wait(150);
  host.querySelector(".toast-host")?.dispatchEvent(new Event("pointerenter"));
  flushSync();
  expect(toasts.current?.paused).toBe(true);
  expect(host.querySelector(".toast-host")?.classList.contains("is-paused")).toBe(true);
  const left = toasts.remaining();
  expect(left).toBeGreaterThan(250);
  expect(left).toBeLessThanOrEqual(460);
  await wait(250);
  expect(toasts.current?.leaving).toBe(false);
  expect(toasts.remaining()).toBe(left);
  host.querySelector(".toast-host")?.dispatchEvent(new Event("pointerleave"));
  flushSync();
  expect(toasts.current?.paused).toBe(false);
  // The rest of the countdown, not a fresh one: well before 600ms it is on its way out.
  await wait(left + 80);
  expect(toasts.current?.leaving).toBe(true);
  close();
});

test("focus in a toast holds it as well, and the pointer leaving does not let go of it", () => {
  showToast("没发出去", { tone: "error", action: { label: "重试", run: () => {} } });
  toasts.hold("pointer");
  toasts.hold("focus");
  toasts.release("pointer");
  expect(toasts.current?.paused).toBe(true);
  toasts.release("focus");
  expect(toasts.current?.paused).toBe(false);
});
