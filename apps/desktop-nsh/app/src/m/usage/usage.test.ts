import "../../platform/install";
import { expect, test } from "nsh/test";
import { snapshot } from "../../lib/reactive.ts";
import type { UsageAccount, UsageAgent } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { UsageFeed } from "./usage-feed.svelte.ts";
import {
  usageAccountName,
  usageAccountNote,
  usageAccountWaiting,
  usageCreditsText,
  usageFromLegacy,
  usageLevel,
  usageMeterEntries,
  usageQuery,
  usageResetText,
  usageSpan,
  usageSummary,
  usageTokenText,
  usageUsedText,
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
  expect(usageSummary(account({ windows }), t)).toBe("5h 38% · 7d 19%");
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
  expect(usageSummary(account({ windows: groups }), t)).toBe("Gemini Models 3% · Claude and GPT models 13%");
});

test("what is used reads rounded down, a sliver as <1%; levels from three quarters and nine tenths", () => {
  expect([18.4, 99.5, 100, 0, 0.4, 104].map(usageUsedText)).toEqual(["18%", "99%", "100%", "0%", "<1%", "100%"]);
  expect([74, 75, 89, 90].map(usageLevel)).toEqual(["normal", "warn", "warn", "danger"]);
  expect([950, 12_345, 999_950, 1_234_567].map(usageTokenText)).toEqual(["950", "12.3k", "1M", "1.2M"]);
  expect(["62453.8865125000", "12", "unlimited"].map((credits) => usageCreditsText(credits, "en-US"))).toEqual(["62,453.89", "12", "unlimited"]);
});

test("a window resets in so long within a day, on a weekday and time after that", () => {
  const now = Date.parse("2026-10-10T08:00:00.000Z");
  expect(usageResetText("2026-10-10T08:00:30.000Z", now, t, "zh-CN")).toBe("即将重置");
  expect(usageResetText("2026-10-10T12:20:00.000Z", now, t, "zh-CN")).toBe("4 小时 20 分后重置");
  expect(usageResetText("2026-10-13T08:00:00.000Z", now, en, "en-US")).toMatch(/^Resets \w+,? \d\d:\d\d$/);
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
  expect(snapshot(feed.agents)).toEqual([]);
  expect(feed.failed).toBe(false);

  const failing = new UsageFeed();
  await failing.load({ usage: async () => { throw Object.assign(new Error("down"), { status: 502 }); } });
  expect([failing.agents, failing.failed]).toEqual([null, true]);
});

test("an account still being asked waits with nothing, or keeps its numbers; its note says it is being checked", () => {
  const waiting = account({ available: false, pending: true });
  expect(usageAccountWaiting(waiting)).toBe(true);
  expect(usageAccountNote(waiting, t)).toBe("正在查用量…");
  // Refreshed behind numbers it already has: those stay, and no note covers them.
  const refreshing = account({ pending: true, checked_at: "2026-10-10T08:00:00.000Z", windows: [{ minutes: 300, model: null, percent: 5, resets_at: null }] });
  expect([usageAccountWaiting(refreshing), usageAccountNote(refreshing, t)]).toEqual([false, null]);
  // Signed out last time and asked again: not "signed out" until it says so again.
  expect(usageAccountNote(account({ available: false, reason: "signed_out", pending: true, checked_at: "2026-10-10T08:00:00.000Z" }), t)).toBe("正在查用量…");
  expect([usageQuery(false, false), usageQuery(true, false), usageQuery(false, true), usageQuery(true, true)]).toEqual(["", "?refresh=1", "?wait=0", "?refresh=1&wait=0"]);
});

test("the feed shows what is known at once, then asks again until every account has answered, one card at a time", async () => {
  const windows = [{ minutes: 300, model: null, percent: 20, resets_at: null }];
  const pending = account({ available: false, pending: true });
  const answered = (dir: string | null) => account({ config_dir: dir, windows, checked_at: "2026-10-10T08:00:00.000Z", pending: false });
  const steps = [
    [{ ...pending }, { ...pending, config_dir: "/b" }],
    [{ ...pending }, { ...pending, config_dir: "/b" }],
    [{ ...pending }, answered("/b")],
    [answered(null), answered("/b")],
  ];
  const asked: Array<[boolean | undefined, boolean | undefined]> = [];
  const seen: Array<unknown> = [];
  const feed = new UsageFeed();
  const api = {
    usage: async (refresh?: boolean, quick?: boolean) => {
      seen.push(feed.agents);
      const accounts = steps[Math.min(asked.length, steps.length - 1)]!;
      asked.push([refresh, quick]);
      return { agents: [agent({ accounts })] };
    },
  };
  const loading = feed.load(api, true);
  expect(feed.busy).toBe(true);
  await loading;
  // Asked at once with the refresh, then without it while some account was still being asked.
  expect(asked).toEqual([[true, true], [false, true], [false, true], [false, true]]);
  // The same answer again changed nothing on screen; the next one did.
  expect(seen[2]).toBe(seen[1]);
  expect(seen[3]).not.toBe(seen[2]);
  expect(snapshot(feed.agents)![0]!.accounts.map((item) => [item.config_dir, item.pending])).toEqual([[null, false], ["/b", false]]);
  expect([feed.busy, feed.failed]).toEqual([false, false]);
});

test("a phone's daemon that refuses wait=0 is asked for its whole answer from then on", async () => {
  const asked: Array<boolean | undefined> = [];
  const api = {
    usage: async (_refresh?: boolean, quick?: boolean) => {
      asked.push(quick);
      if (quick) throw Object.assign(new Error("invalid remote properties"), { status: 422 });
      return { agents: [agent({ accounts: [account({ windows: [{ minutes: 300, model: null, percent: 1, resets_at: null }] })] })] };
    },
  };
  const feed = new UsageFeed();
  await feed.load(api);
  await feed.load(api);
  expect(asked).toEqual([true, false, false]);
  expect([snapshot(feed.agents)!.length, feed.failed]).toEqual([1, false]);
});

test("following stops when the daemon stops answering: an account with no answer says it could not be read", async () => {
  let calls = 0;
  const api = {
    usage: async () => {
      calls += 1;
      if (calls > 1) throw Object.assign(new Error("gone"), { status: 502 });
      return { agents: [agent({ accounts: [account({ available: false, pending: true }), account({ config_dir: "/b", pending: true, checked_at: "2026-10-10T08:00:00.000Z", windows: [{ minutes: 300, model: null, percent: 1, resets_at: null }] })] })] };
    },
  };
  const feed = new UsageFeed();
  await feed.load(api);
  expect(calls).toBe(4);
  expect(snapshot(feed.agents)![0]!.accounts.map((item) => [item.pending, item.reason, item.windows.length])).toEqual([[false, "failed", 0], [false, null, 1]]);
  expect([feed.busy, feed.failed]).toEqual([false, true]);
});
