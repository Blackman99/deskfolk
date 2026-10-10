import { afterEach, beforeEach, expect, test } from "bun:test";
import type { UsageAgent, UsageResponse } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import UsageTab from "./UsageTab.svelte";
import { usageWidget } from "./usage-widget.svelte.ts";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, " ").trim();

const account = (email: string, plan: string, windows: Array<[number, string | null, number]>) => ({
  config_dir: email, email, available: true, reason: null, plan, credits: null, checked_at: "2026-10-10T08:00:00.000Z", error: null,
  windows: windows.map(([minutes, model, percent]) => ({ minutes, model, percent, resets_at: null })),
});
const claude: UsageAgent = {
  runner: "claude_code", custom_id: null, label: "Claude Agent", today: { turns: 31, tokens: 1_234_567, estimated_usd: 0 },
  accounts: [
    account("a@example.com", "pro", [[300, null, 6], [10_080, null, 97], [10_080, "Fable", 4]]),
    account("b@example.com", "team", [[300, null, 10], [10_080, null, 100]]),
  ],
};
const grok: UsageAgent = { runner: "grok", custom_id: null, label: "Grok", today: { turns: 12, tokens: 340_000, estimated_usd: 0 }, accounts: [] };

function open(agents: UsageAgent[]) {
  const asked: boolean[] = [];
  const client = { usage: (refresh = false): Promise<UsageResponse> => { asked.push(refresh); return Promise.resolve({ agents }); } };
  const runtime = reactive(fakeRuntime({}, { client }));
  return { ...render(UsageTab, { runtime, t }), asked };
}

beforeEach(() => {
  window.localStorage.removeItem("real-bot-usage-widget");
  usageWidget.hidden = false;
});
afterEach(() => window.localStorage.removeItem("real-bot-usage-widget"));

test("the tab lays out a card per account, each window a bar, the agents with today's records only as chips", async () => {
  const view = open([claude, grok]);
  await sleep(0);
  const cards = [...view.host.querySelectorAll(".usage-board-account")];
  expect(cards.map((card) => text(card.querySelector(".usage-account-plan")))).toEqual(["Pro", "Team"]);
  const first = [...cards[0]!.querySelectorAll(".usage-meter")];
  expect(first.map((gauge) => text(gauge.querySelector(".usage-percent")))).toEqual(["剩94%", "剩3%", "剩96%"]);
  expect(cards[0]!.querySelector(".usage-gauge")).toBeNull();
  // A model's window on one line: its model, then the length.
  expect(first.map((gauge) => text(gauge.querySelector(".usage-gauge-span")))).toEqual(["5 小时", "7 天", "7 天"]);
  expect(first[2]!.querySelector(".usage-gauge-name")!.contains(first[2]!.querySelector(".usage-gauge-model"))).toBe(true);
  expect(text(first[2]!.querySelector(".usage-gauge-model"))).toBe("Fable");
  expect(first[1]!.classList.contains("is-danger")).toBe(true);
  expect(text(view.host.querySelector('.usage-board-chip[data-usage-agent="grok"]'))).toBe("Grok 今天 12 轮 · 340k token");
  expect(text(view.host.querySelector(".usage-checked"))).toContain("查的");
  view.close();
});

test("Refresh asks for a younger answer; a hidden ball comes back from the bar", async () => {
  usageWidget.hidden = true;
  const view = open([claude]);
  await sleep(0);
  click(view.host.querySelector(".usage-refresh"));
  await sleep(0);
  expect(view.asked).toEqual([false, true]);
  click(view.host.querySelector(".usage-tab-widget"));
  await sleep(0);
  expect(usageWidget.hidden).toBe(false);
  expect(view.host.querySelector(".usage-tab-widget")).toBeNull();
  view.close();
});

test("a phone's dials: up to three a row, two a row from four", async () => {
  const { default: UsagePage } = await import("./UsagePage.svelte");
  const antigravity: UsageAgent = {
    runner: "antigravity", custom_id: null, label: "Antigravity", today: { turns: 0, tokens: 0, estimated_usd: 0 },
    accounts: [account("g@example.com", "", [[300, "Gemini Models", 0], [10_080, "Gemini Models", 1], [300, "Claude and GPT models", 0], [10_080, "Claude and GPT models", 13]])],
  };
  const asked: boolean[] = [];
  const client = { usage: (refresh = false): Promise<UsageResponse> => { asked.push(refresh); return Promise.resolve({ agents: [claude, antigravity] }); } };
  const view = render(UsagePage, { runtime: reactive(fakeRuntime({}, { client })), t, onBack: () => {} });
  await sleep(0);
  const columns = [...view.host.querySelectorAll<HTMLElement>(".usage-board-gauges")].map((ul) => ul.style.getPropertyValue("--usage-windows"));
  expect(columns).toEqual(["3", "2", "2"]);
  view.close();
});
