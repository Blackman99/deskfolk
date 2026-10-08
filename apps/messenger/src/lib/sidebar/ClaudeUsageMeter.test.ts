import { expect, test } from "bun:test";
import type { ClaudeUsage } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { headlineWindows, usageAccountShortLabels, usageLevel, usagePercentText, usageResetText, usageWindowLabel } from "../settings/claude-usage.ts";
import { aBot, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import ClaudeUsageMeter from "./ClaudeUsageMeter.svelte";
import CreateFab from "./CreateFab.svelte";

const t = copyFor("zh");
const en = copyFor("en");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const usage: ClaudeUsage = {
  available: true, reason: null, plan: "pro", checked_at: "2026-10-08T11:00:00.000Z", error: null,
  windows: [
    { kind: "five_hour", model: null, percent: 2, resets_at: "2026-10-08T15:50:00.000Z" },
    { kind: "seven_day", model: null, percent: 91, resets_at: "2026-10-11T02:00:00.000Z" },
    { kind: "model", model: "Fable", percent: 4, resets_at: "2026-10-11T02:00:00.000Z" },
  ],
};

function open(options: { runner?: "claude_code" | null; answer?: () => Promise<ClaudeUsage> } = {}) {
  // Kept outside the runtime: reading a reactive array between two asks would freeze it.
  const asked: boolean[] = [];
  const client = {
    claudeUsage: (refresh = false) => {
      asked.push(refresh);
      return options.answer ? options.answer() : Promise.resolve(usage);
    },
  };
  const runtime = reactive(fakeRuntime({ bots: [aBot({ runner: options.runner === undefined ? "claude_code" : options.runner })] }, { client }));
  const view = render(ClaudeUsageMeter, { runtime, t });
  return { ...view, asked };
}

test("the plan's two windows at a glance; the model's own and the reset times once opened", async () => {
  const view = open();
  await sleep(0);
  expect(view.asked).toEqual([false]);
  const chips = [...view.host.querySelectorAll("[data-usage-chip]")].map((chip) => chip.textContent?.replace(/\s+/g, " ").trim());
  expect(chips).toEqual(["5小时 2%", "7天 91%"]);
  // Nine tenths gone reads as nearly out.
  expect(view.host.querySelector('[data-usage-chip="seven_day"]')?.classList.contains("is-danger")).toBe(true);
  expect(view.host.querySelector("[data-claude-usage-rows]")).toBeNull();

  const summary = view.host.querySelector<HTMLButtonElement>(".usage-summary")!;
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  click(summary);
  await sleep(0);
  const names = [...view.host.querySelectorAll(".usage-name")].map((name) => name.textContent);
  expect(names).toEqual(["5 小时", "7 天", "Fable · 7 天"]);
  expect(view.host.querySelectorAll(".usage-reset")).toHaveLength(3);

  // A refresh asks the daemon for a younger answer.
  click(view.host.querySelector<HTMLButtonElement>(".usage-foot button")!);
  await sleep(0);
  expect(view.asked).toEqual([false, true]);
  view.close();
});

test("nothing is asked or shown until a Bot runs on Claude Agent, nor when the plan has no windows", async () => {
  const none = open({ runner: null });
  await sleep(0);
  expect(none.asked).toEqual([]);
  expect(none.host.querySelector("[data-claude-usage]")).toBeNull();
  none.close();

  const noPlan = open({ answer: async () => ({ ...usage, available: false, reason: "no_plan", windows: [] }) });
  await sleep(0);
  expect(noPlan.asked).toEqual([false]);
  expect(noPlan.host.querySelector("[data-claude-usage]")).toBeNull();
  noPlan.close();

  // An older daemon without the route: no meter, no error.
  const old = open({ answer: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } });
  await sleep(0);
  expect(old.host.querySelector("[data-claude-usage]")).toBeNull();
  old.close();
});

test("a window resets in so long within a day, on a weekday and time after that", () => {
  const now = Date.parse("2026-10-08T11:00:00.000Z");
  expect(usageResetText("2026-10-08T15:50:00.000Z", now, t, "zh-CN")).toBe("4 小时 50 分后重置");
  expect(usageResetText("2026-10-08T11:20:00.000Z", now, en, "en-US")).toBe("Resets in 20 min");
  expect(usageResetText("2026-10-08T11:00:30.000Z", now, t, "zh-CN")).toBe("即将重置");
  expect(usageResetText("2026-10-11T02:00:00.000Z", now, t, "zh-CN")).toMatch(/^周. \d\d:\d\d 重置$/);
  expect(usageResetText("2026-10-11T01:59:59.984805+00:00", now, t, "zh-CN")).toBe(usageResetText("2026-10-11T02:00:00+00:00", now, t, "zh-CN"));
  expect(usageResetText(null, now, t, "zh-CN")).toBeNull();
  expect(usageResetText("soon", now, t, "zh-CN")).toBeNull();
});

test("labels, percents and levels", () => {
  expect(headlineWindows(usage).map((window) => window.kind)).toEqual(["five_hour", "seven_day"]);
  expect(usageWindowLabel(usage.windows[2]!, en)).toBe("Fable · 7-day");
  expect(usagePercentText(0)).toBe("0%");
  expect(usagePercentText(0.4)).toBe("<1%");
  expect(usagePercentText(26.96)).toBe("27%");
  expect([usageLevel(74), usageLevel(75), usageLevel(89.9), usageLevel(90)]).toEqual(["normal", "warn", "warn", "danger"]);
});

test("Bots on two Claude accounts: a line for each, named by its email, and each account's windows once opened", async () => {
  const first = { ...usage, config_dir: null, email: "pro@example.com" };
  const second = { ...usage, plan: "team", config_dir: "/Users/you/.claude-b", email: "team@example.com",
    windows: [{ kind: "five_hour" as const, model: null, percent: 80, resets_at: null }, { kind: "seven_day" as const, model: null, percent: 30, resets_at: null }] };
  const view = open({ answer: async () => ({ ...usage, accounts: [first, second] }) });
  await sleep(0);
  const lines = [...view.host.querySelectorAll(".usage-line")].map((line) =>
    [line.querySelector(".usage-title"), ...line.querySelectorAll("[data-usage-chip]")].map((part) => part?.textContent?.replace(/\s+/g, " ").trim()).join(" "));
  // Their plans tell them apart, so the plans name them; the opened meter has the emails.
  expect(lines).toEqual(["Pro 5小时 2% 7天 91%", "Team 5小时 80% 7天 30%"]);
  expect(view.host.querySelector('[data-usage-account="/Users/you/.claude-b"] [data-usage-chip="five_hour"]')?.classList.contains("is-warn")).toBe(true);
  click(view.host.querySelector<HTMLButtonElement>(".usage-summary")!);
  await sleep(0);
  expect([...view.host.querySelectorAll(".usage-detail-account")].map((label) => label.textContent)).toEqual(["pro@example.com", "team@example.com"]);
  expect(view.host.querySelectorAll(".usage-foot button")).toHaveLength(1);
  view.close();
});

test("two accounts on the same plan are named by their emails before the @", () => {
  const a = { ...usage, config_dir: null, email: "me@home.example" };
  const b = { ...usage, config_dir: "/Users/you/.claude-b", email: "me.work@corp.example" };
  expect(usageAccountShortLabels([a, b], t)).toEqual(["me", "me.work"]);
  expect(usageAccountShortLabels([{ ...a, plan: "pro" }, { ...b, plan: "Claude Max", email: null }], t)).toEqual(["Pro", "Max"]);
  expect(usageAccountShortLabels([{ ...a, email: null }, { ...b, email: null }], t)).toEqual([t.claudeAgent.usage.own, ".claude-b"]);
});

test("on the phone the + button stands over the usage strip, as far up as the strip is tall", () => {
  const view = render(CreateFab, { t, lift: 44, onCreateBot: () => {}, onCreateGroup: () => {} });
  expect(view.host.querySelector<HTMLElement>(".fab-wrap")?.style.getPropertyValue("--fab-lift")).toBe("44px");
  view.close();
});
