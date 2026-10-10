import { expect, test } from "bun:test";
import type { UsageAccount, UsageAgent } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { UsageFeed } from "./usage-feed.svelte.ts";
import {
  usageAccountName,
  usageCreditsText,
  usageFromLegacy,
  usageLeftText,
  usageLevel,
  usageMeterEntries,
  usageResetText,
  usageSpan,
  usageSummary,
  usageTokenText,
  usageWindowLabel,
  usageWindowsSorted,
} from "./usage.ts";
import { usageDrop } from "./usage-widget.svelte.ts";

const t = copyFor("zh");
const en = copyFor("en");

function account(over: Partial<UsageAccount> = {}): UsageAccount {
  return { config_dir: null, email: null, available: true, reason: null, plan: null, windows: [], credits: null, checked_at: null, error: null, ...over };
}

function agent(over: Partial<UsageAgent> = {}): UsageAgent {
  return { runner: "codex", custom_id: null, label: "Codex", today: { turns: 0, tokens: 0, estimated_usd: 0 }, accounts: [], ...over };
}

test("windows are named from their length, after their model for a model's own", () => {
  expect([300, 10_080, 43_200, 90, null].map((minutes) => usageSpan(minutes, t))).toEqual(["5 小时", "7 天", "30 天", "90 分钟", "额度"]);
  expect([300, 10_080].map((minutes) => usageSpan(minutes, en, true))).toEqual(["5h", "7d"]);
  expect(usageWindowLabel({ minutes: 10_080, model: "Opus", percent: 3, resets_at: null }, t)).toBe("Opus · 7 天");
});

test("the plan's windows come shortest first, each model's after them; the summary has the plan's only", () => {
  const windows = [
    { minutes: 10_080, model: "Opus", percent: 95, resets_at: null },
    { minutes: 10_080, model: null, percent: 19, resets_at: null },
    { minutes: 300, model: null, percent: 38.6, resets_at: null },
  ];
  expect(usageWindowsSorted(windows).map((window) => window.model ?? window.minutes)).toEqual([300, 10_080, "Opus"]);
  expect(usageSummary(account({ windows }), t)).toBe("5h 61% · 7d 81%");
  // Only model groups (Antigravity): each group's windows together, and the summary by group.
  const groups = [
    { minutes: 10_080, model: "Gemini Models", percent: 2, resets_at: null },
    { minutes: 300, model: "Gemini Models", percent: 3, resets_at: null },
    { minutes: 10_080, model: "Claude and GPT models", percent: 13, resets_at: null },
    { minutes: 300, model: "Claude and GPT models", percent: 0, resets_at: null },
  ];
  expect(usageWindowsSorted(groups).map((window) => `${window.model} ${window.minutes}`)).toEqual([
    "Gemini Models 300", "Gemini Models 10080", "Claude and GPT models 300", "Claude and GPT models 10080",
  ]);
  expect(usageSummary(account({ windows: groups }), t)).toBe("Gemini Models 97% · Claude and GPT models 87%");
});

test("what is left reads rounded down, a sliver as <1%; levels from three quarters and nine tenths", () => {
  expect([18.4, 99.5, 100, 0].map(usageLeftText)).toEqual(["81%", "<1%", "0%", "100%"]);
  expect([74, 75, 89, 90].map(usageLevel)).toEqual(["normal", "warn", "warn", "danger"]);
  expect([950, 12_345, 999_950, 1_234_567].map(usageTokenText)).toEqual(["950", "12.3k", "1M", "1.2M"]);
  expect(["62453.8865125000", "12", "unlimited"].map((credits) => usageCreditsText(credits, "en-US"))).toEqual(["62,453.89", "12", "unlimited"]);
});

test("a window resets in so long within a day, on a weekday and time after that", () => {
  const now = Date.parse("2026-10-10T08:00:00.000Z");
  expect(usageResetText("2026-10-10T08:00:30.000Z", now, t, "zh-CN")).toBe("即将重置");
  expect(usageResetText("2026-10-10T12:20:00.000Z", now, t, "zh-CN")).toBe("4 小时 20 分后重置");
  expect(usageResetText("2026-10-13T08:00:00.000Z", now, en, "en-US")).toMatch(/^Resets \w+ \d\d:\d\d$/);
  expect(usageResetText(null, now, t, "zh-CN")).toBeNull();
});

test("an account is named by its agent and plan, then which account where that tells it apart", () => {
  const claude = agent({ runner: "claude_code", label: "Claude Agent", accounts: [account({ plan: "claude max", email: "a@example.com" })] });
  expect(usageAccountName(claude, claude.accounts[0]!, t)).toBe("Claude Max · a@example.com");
  const one = agent({ accounts: [account({ plan: "plus" })] });
  expect(usageAccountName(one, one.accounts[0]!, t)).toBe("Codex Plus");
  const two = agent({ accounts: [account({ plan: "plus" }), account({ config_dir: "/Users/you/.codex-b" })] });
  expect(two.accounts.map((entry) => usageAccountName(two, entry, t))).toEqual(["Codex Plus · 默认账号", "Codex · .codex-b"]);
});

test("the pill shows each account with windows, its tightest window; not the ones without", () => {
  const windows = [{ minutes: 300, model: null, percent: 10, resets_at: null }, { minutes: 10_080, model: null, percent: 80, resets_at: null }];
  const entries = usageMeterEntries([
    agent({ runner: "claude_code", accounts: [account({ windows }), account({ available: false, reason: "signed_out", config_dir: "/x" })] }),
    agent({ runner: "grok", label: "Grok" }),
  ]);
  expect(entries.map((entry) => [entry.agent.runner, entry.tightest.percent])).toEqual([["claude_code", 80]]);
});

test("a widget dropped near an edge docks to it; elsewhere it floats where it was let go", () => {
  expect(usageDrop(10, 360, 120, 28, 1280, 800)).toEqual({ dock: "left", top: 360 / 772 });
  expect(usageDrop(1280 - 120 - 20, 0, 120, 28, 1280, 800)).toEqual({ dock: "right", top: 0 });
  expect(usageDrop(580, 772, 120, 28, 1280, 800)).toEqual({ dock: null, left: 580 / 1160, top: 1 });
});

test("from a daemon before the one route, the two older answers are put together the same way", () => {
  const response = usageFromLegacy(
    {
      available: true, reason: null, plan: "max", checked_at: null, error: null, windows: [],
      accounts: [{
        available: true, reason: null, plan: "max", checked_at: null, error: null, config_dir: null, email: "a@example.com",
        windows: [{ kind: "five_hour", model: null, percent: 5, resets_at: null }, { kind: "model", model: "Opus", percent: 7, resets_at: null }],
      }],
    },
    {
      items: [
        { runner: "codex", custom_id: null, label: "Codex", config_dir: null, available: true, reason: null, plan: "plus", windows: [{ minutes: 300, percent: 9, resets_at: null }], credits: null, today: { turns: 1, tokens: 2, estimated_usd: 0 }, checked_at: null, error: null },
        { runner: "grok", custom_id: null, label: "Grok", config_dir: null, available: false, reason: "no_plan", plan: null, windows: [], credits: null, today: { turns: 3, tokens: 4, estimated_usd: 0 }, checked_at: null, error: null },
      ],
    },
  );
  expect(response.agents.map((entry) => [entry.runner, entry.accounts.length])).toEqual([["claude_code", 1], ["codex", 1], ["grok", 0]]);
  expect(response.agents[0]!.accounts[0]!.windows).toEqual([
    { minutes: 300, model: null, percent: 5, resets_at: null },
    { minutes: 10_080, model: "Opus", percent: 7, resets_at: null },
  ]);
  // Nothing in use on Claude: no Claude at all.
  expect(usageFromLegacy({ available: false, reason: "unused", plan: null, windows: [], checked_at: null, error: null }, null).agents).toEqual([]);
});

test("the feed asks the one route, and a daemon that answers 404 there is asked the two older ones from then on", async () => {
  const asked: string[] = [];
  const api = {
    usage: async () => { asked.push("usage"); throw Object.assign(new Error("not found"), { status: 404 }); },
    claudeUsage: async () => { asked.push("claude"); return { available: false, reason: "unused" as const, plan: null, windows: [], checked_at: null, error: null }; },
    agentUsage: async () => { asked.push("agents"); return { items: [] }; },
  };
  const feed = new UsageFeed();
  await feed.load(api);
  await feed.load(api, true);
  expect(asked).toEqual(["usage", "claude", "agents", "claude", "agents"]);
  expect(feed.agents).toEqual([]);
  expect(feed.failed).toBe(false);

  const failing = new UsageFeed();
  await failing.load({ usage: async () => { throw Object.assign(new Error("down"), { status: 502 }); } });
  expect([failing.agents, failing.failed]).toEqual([null, true]);
});
