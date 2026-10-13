import { afterEach, expect, test } from "bun:test";
import Button from "./Button.svelte";
import Icon from "./Icon.svelte";
import IconButton from "./IconButton.svelte";
import ToastHost from "./ToastHost.svelte";
import { ICONS } from "./icons.ts";
import { TOAST_LEAVE_MS, showToast, toasts } from "./toast.svelte.ts";
import { click, render } from "./test-render.ts";
import { flushSync } from "svelte";

afterEach(() => {
  toasts.current = null;
});

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
  const { host, close } = render(ToastHost, {});
  showToast("已复制", { ms: 20 });
  flushSync();
  expect(host.querySelector(".toast-host")?.textContent).toContain("已复制");
  await new Promise((resolve) => setTimeout(resolve, 20 + TOAST_LEAVE_MS + 40));
  flushSync();
  expect(host.querySelector(".toast-host")).toBeNull();
  close();
});

test("a newer toast replaces the one showing, and an action runs and dismisses", () => {
  const { host, close } = render(ToastHost, {});
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
