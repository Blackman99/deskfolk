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

test("the pill shows a ring and what is left of the tightest window for each account with windows, three at most", async () => {
  const many = { ...claude, accounts: [...claude.accounts] };
  const codexAgent: UsageAgent = { runner: "codex", custom_id: null, label: "Codex", today, accounts: [codex(null, 92), codex("/x/.codex-b", 10), codex("/x/.codex-c", 5)] };
  const view = open([many, codexAgent, grok]);
  await sleep(0);
  expect(view.asked).toEqual([false]);
  const items = [...view.host.querySelectorAll("[data-usage-pill-item]")];
  expect(items.map(text)).toEqual(["55%", "8%", "90%"]);
  expect(text(view.host.querySelector(".usage-pill-more"))).toBe("+1");
  // One window nearly gone: the pill is outlined in its colour.
  expect(view.host.querySelector("[data-usage-widget]")?.classList.contains("is-danger")).toBe(true);
  // Docked top right by default, tucked away until pointed at.
  expect(view.host.querySelector("[data-usage-widget]")?.getAttribute("data-dock")).toBe("right");
  expect(view.host.querySelector("[data-usage-widget]")?.getAttribute("data-tucked")).toBe("yes");
  view.close();
});

test("a click opens the panel: each account's windows, the agent's day, then the agents with today's records only", async () => {
  const view = open([claude, grok]);
  await sleep(0);
  click(view.host.querySelector(".usage-pill"));
  flushSync();
  const panel = view.host.querySelector("[data-usage-panel]")!;
  expect(panel).not.toBeNull();
  expect(view.host.querySelector("[data-usage-widget]")?.getAttribute("data-tucked")).toBe("no");
  const rows = [...panel.querySelectorAll("[data-usage-agent='claude_code'] .usage-row")];
  expect(rows.map((row) => text(row.querySelector(".usage-name")))).toEqual(["5 小时", "7 天", "Opus · 7 天"]);
  expect(rows.map((row) => text(row.querySelector(".usage-percent")))).toEqual(["剩62%", "剩81%", "剩55%"]);
  expect(text(panel.querySelector("[data-usage-agent='claude_code'] .usage-account-name"))).toBe("Max · a@example.com");
  expect(text(panel.querySelector(".usage-agent-today"))).toBe("今天 31 轮 · 1.2M token");
  // An agent with no plan to report: its day only, set apart, never a percentage.
  const quiet = panel.querySelector("[data-usage-today-only]")!;
  expect(text(quiet.querySelector("[data-usage-agent='grok']"))).toBe("Grok 今天 12 轮 · 340k token");
  expect(quiet.querySelector(".usage-row")).toBeNull();
  // Refresh asks for a younger answer; Escape closes the panel.
  click(panel.querySelector(".usage-refresh"));
  await sleep(0);
  expect(view.asked).toEqual([false, true]);
  panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(view.host.querySelector("[data-usage-panel]")).toBeNull();
  view.close();
});

test("its context menu hides it, and showing it again opens the panel; it stays away with nothing in use", async () => {
  const view = open([claude]);
  await sleep(0);
  view.host.querySelector(".usage-pill")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 900, clientY: 60 }));
  flushSync();
  click(view.host.querySelector(".usage-menu-item"));
  flushSync();
  expect(view.host.querySelector("[data-usage-widget]")).toBeNull();
  expect(JSON.parse(window.localStorage.getItem("real-bot-usage-widget")!).hidden).toBe(true);
  flushSync(() => usageWidget.show());
  expect(view.host.querySelector("[data-usage-widget]")).not.toBeNull();
  expect(view.host.querySelector("[data-usage-panel]")).not.toBeNull();
  view.close();

  const none = open([]);
  await sleep(0);
  expect(none.host.querySelector("[data-usage-widget]")).toBeNull();
  // Tools › Usage with nothing in use still opens the panel, to say so.
  flushSync(() => usageWidget.show());
  expect(text(none.host.querySelector("[data-usage-panel] .usage-empty"))).toBe(t.usage.empty);
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
