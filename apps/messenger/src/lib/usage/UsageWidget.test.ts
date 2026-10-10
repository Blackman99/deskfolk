import { afterEach, beforeEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { UsageAgent, UsageResponse } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import UsagePage from "./UsagePage.svelte";
import UsageWidget from "./UsageWidget.svelte";
import { USAGE_WIDGET_DEFAULT, usageWidget } from "./usage-widget.svelte.ts";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, " ").trim();

const today = { turns: 0, tokens: 0, estimated_usd: 0 };
const claude: UsageAgent = {
  runner: "claude_code", custom_id: null, label: "Claude Agent", today: { turns: 31, tokens: 1_234_567, estimated_usd: 0 },
  accounts: [{
    config_dir: null, email: "a@example.com", available: true, reason: null, plan: "max", credits: null, checked_at: "2026-10-10T08:00:00.000Z", error: null,
    windows: [
      { minutes: 300, model: null, percent: 38, resets_at: null },
      { minutes: 10_080, model: null, percent: 19, resets_at: null },
      { minutes: 10_080, model: "Opus", percent: 45, resets_at: null },
    ],
  }],
};
const codex = (dir: string | null, percent: number) => ({
  config_dir: dir, email: null, available: true, reason: null, plan: "plus", credits: null, checked_at: null, error: null,
  windows: [{ minutes: 300, model: null, percent, resets_at: null }],
});
const grok: UsageAgent = { runner: "grok", custom_id: null, label: "Grok", today: { turns: 12, tokens: 340_000, estimated_usd: 0 }, accounts: [] };

function open(agents: UsageAgent[], component: typeof UsageWidget | typeof UsagePage = UsageWidget, props: Record<string, unknown> = {}) {
  const asked: boolean[] = [];
  const client = { usage: (refresh = false): Promise<UsageResponse> => { asked.push(refresh); return Promise.resolve({ agents }); } };
  const runtime = reactive(fakeRuntime({}, { client }));
  const view = render(component, { runtime, t, ...props });
  return { ...view, asked };
}

beforeEach(() => {
  window.localStorage.removeItem("real-bot-usage-widget");
  usageWidget.place = USAGE_WIDGET_DEFAULT;
  usageWidget.hidden = false;
  usageWidget.open = false;
});
afterEach(() => window.localStorage.removeItem("real-bot-usage-widget"));

const hover = (node: Element | null) => {
  node!.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  flushSync();
};

test("a ball by default; pointed at, it opens into a column of the agents, each ringed by its tightest window", async () => {
  const codexAgent: UsageAgent = { runner: "codex", custom_id: null, label: "Codex", today, accounts: [codex(null, 92), codex("/x/.codex-b", 10)] };
  const view = open([claude, codexAgent, grok]);
  await sleep(0);
  expect(view.asked).toEqual([false]);
  const widget = view.host.querySelector<HTMLElement>("[data-usage-widget]")!;
  expect(widget.dataset.expanded).toBe("no");
  // Docked top right by default, half tucked away.
  expect([widget.dataset.dock, widget.dataset.tucked]).toEqual(["right", "yes"]);
  // One nearly spent window anywhere: the ball's outline says so.
  expect(view.host.querySelector(".usage-shell")?.classList.contains("is-danger")).toBe(true);
  const bubbles = [...view.host.querySelectorAll<HTMLElement>("[data-usage-bubble]")];
  expect(bubbles.map((bubble) => bubble.dataset.usageBubble)).toEqual(["claude_code:", "codex:", "grok:"]);
  expect(bubbles.map((bubble) => [...bubble.classList].find((name) => name.startsWith("is-")))).toEqual(["is-normal", "is-danger", "is-today"]);
  expect(bubbles.map((bubble) => bubble.getAttribute("aria-label"))).toEqual(["Claude 剩55%", "Codex 剩8%", "Grok"]);
  hover(widget);
  expect(widget.dataset.expanded).toBe("yes");
  expect(widget.dataset.tucked).toBe("no");
  view.close();
});

test("pointing at an agent opens its card with every account; another agent's replaces it", async () => {
  const codexAgent: UsageAgent = { runner: "codex", custom_id: null, label: "Codex", today, accounts: [codex(null, 92), codex("/x/.codex-b", 10)] };
  const view = open([claude, codexAgent, grok]);
  await sleep(0);
  hover(view.host.querySelector("[data-usage-widget]"));
  hover(view.host.querySelector('[data-usage-bubble="claude_code:"]'));
  let card = view.host.querySelector<HTMLElement>("[data-usage-card]")!;
  expect(card.dataset.usageCard).toBe("claude_code:");
  const rows = [...card.querySelectorAll(".usage-row")];
  expect(rows.map((row) => text(row.querySelector(".usage-name")))).toEqual(["5 小时", "7 天", "Opus · 7 天"]);
  expect(rows.map((row) => text(row.querySelector(".usage-percent")))).toEqual(["剩62%", "剩81%", "剩55%"]);
  expect(text(card.querySelector(".usage-account-name"))).toBe("Max · a@example.com");
  expect(text(card.querySelector(".usage-agent-today"))).toBe("今天 31 轮 · 1.2M token");
  hover(view.host.querySelector('[data-usage-bubble="codex:"]'));
  await sleep(200);
  card = view.host.querySelector<HTMLElement>('[data-usage-card="codex:"]')!;
  expect([...card.querySelectorAll(".usage-account-name")].map(text)).toEqual(["Plus · 默认账号", "Plus · .codex-b"]);
  // An agent with today's records only: its day and why there is nothing more.
  hover(view.host.querySelector('[data-usage-bubble="grok:"]'));
  await sleep(200);
  card = view.host.querySelector<HTMLElement>('[data-usage-card="grok:"]')!;
  expect(text(card.querySelector(".usage-agent-today"))).toBe("今天 12 轮 · 340k token");
  expect(text(card.querySelector(".usage-card-note"))).toBe(t.usage.todayOnlyHint);
  expect(card.querySelector(".usage-row")).toBeNull();
  // Refresh asks for a younger answer.
  click(card.querySelector(".usage-card-refresh"));
  await sleep(0);
  expect(view.asked).toEqual([false, true]);
  // Let the card finish growing: happy-dom throws on an animation cut short by unmounting.
  await sleep(320);
  view.close();
});

test("a click pins it open, Escape folds it; Tools › Usage opens it on the first agent's card", async () => {
  const view = open([claude, grok]);
  await sleep(0);
  const widget = view.host.querySelector<HTMLElement>("[data-usage-widget]")!;
  click(view.host.querySelector(".usage-ball"));
  flushSync();
  expect(widget.dataset.expanded).toBe("yes");
  widget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(widget.dataset.expanded).toBe("no");
  flushSync(() => usageWidget.show());
  await sleep(50);
  flushSync();
  expect(widget.dataset.expanded).toBe("yes");
  expect(view.host.querySelector<HTMLElement>("[data-usage-card]")?.dataset.usageCard).toBe("claude_code:");
  await sleep(320);
  view.close();
});

test("its context menu hides it, and showing it again opens it; with nothing connected Tools says so", async () => {
  const view = open([claude]);
  await sleep(0);
  view.host.querySelector(".usage-ball")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 900, clientY: 60 }));
  flushSync();
  click(view.host.querySelector(".usage-menu-item"));
  flushSync();
  expect(view.host.querySelector("[data-usage-widget]")).toBeNull();
  expect(JSON.parse(window.localStorage.getItem("real-bot-usage-widget")!).hidden).toBe(true);
  flushSync(() => usageWidget.show());
  expect(view.host.querySelector("[data-usage-widget]")?.getAttribute("data-expanded")).toBe("yes");
  view.close();

  usageWidget.open = false;
  const none = open([]);
  await sleep(0);
  expect(none.host.querySelector("[data-usage-widget]")).toBeNull();
  flushSync(() => usageWidget.show());
  expect(text(none.host.querySelector('[data-usage-card="empty"] .usage-empty'))).toBe(t.usage.empty);
  none.close();
});

test("a phone's page holds what the panel holds, with Back", async () => {
  let back = 0;
  const view = open([claude, grok], UsagePage, { onBack: () => (back += 1) });
  await sleep(0);
  expect(view.host.querySelectorAll("[data-usage-page] [data-usage-agent='claude_code'] .usage-row")).toHaveLength(3);
  expect(view.host.querySelector("[data-usage-page] [data-usage-today-only]")).not.toBeNull();
  click(view.host.querySelector(".usage-page-back"));
  expect(back).toBe(1);
  view.close();
});
