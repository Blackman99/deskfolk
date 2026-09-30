import { expect, test } from "bun:test";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { buttonByText, click, press, render } from "../test-render.ts";
import StopMenu from "./StopMenu.svelte";
import type { StopMenuItem } from "./stop-menu.ts";

const t = copyFor("zh");
const items: StopMenuItem[] = [
  { key: "bot:bot-1", label: "停下视频导演的全部工作", choice: { scope: "bot", id: "bot-1" } },
  { key: "global", label: "停下所有 Bot", choice: { scope: "global", id: null } },
];

test("opens its choices, hands the one picked to its owner, and closes", () => {
  const picked: StopMenuItem[] = [];
  const { host, close } = render(StopMenu, { items, t, onPick: (item: StopMenuItem) => void picked.push(item) });
  const trigger = host.querySelector(".stop-menu-trigger") as HTMLButtonElement;
  expect(host.querySelector('[role="menu"]')).toBeNull();
  click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["停下视频导演的全部工作", "停下所有 Bot"]);
  click(buttonByText(host, "停下所有 Bot"));
  expect(picked.map((item) => item.choice)).toEqual([{ scope: "global", id: null }]);
  expect(host.querySelector('[role="menu"]')).toBeNull();
  close();
});

test("Escape closes it without picking, and gives focus back to its button", () => {
  const picked: StopMenuItem[] = [];
  const { host, close } = render(StopMenu, { items, t, onPick: (item: StopMenuItem) => void picked.push(item) });
  const trigger = host.querySelector(".stop-menu-trigger") as HTMLButtonElement;
  click(trigger);
  press(host.querySelector('[role="menu"]'), "Escape");
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(picked).toEqual([]);
  close();
});

test("a stop refused by the daemon is said by its button until the next click", async () => {
  const { host, close } = render(StopMenu, { items, t, onPick: async () => ({ status: 422 }) });
  const trigger = host.querySelector(".stop-menu-trigger") as HTMLButtonElement;
  click(trigger);
  click(buttonByText(host, "停下所有 Bot"));
  await tick();
  flushSync();
  expect(host.querySelector(".stop-menu-error")?.textContent).toBe("没做成，再试一次");
  click(document.body);
  expect(host.querySelector(".stop-menu-error")).toBeNull();
  close();
});
