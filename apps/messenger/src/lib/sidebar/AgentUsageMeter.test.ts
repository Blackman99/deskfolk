import { expect, test } from "bun:test";
import type { AgentUsage, AgentUsageResponse } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { agentTokenText, agentUsageNames, agentWindowLabel } from "../settings/agent-usage.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { render } from "../test-render.ts";
import AgentUsageMeter from "./AgentUsageMeter.svelte";

const t = copyFor("zh");
const en = copyFor("en");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function item(over: Partial<AgentUsage> = {}): AgentUsage {
  return {
    runner: "grok", custom_id: null, label: "Grok", config_dir: null, available: false, reason: "no_plan", plan: null, windows: [], credits: null,
    today: { turns: 3, tokens: 12_345, estimated_usd: 0.12 }, checked_at: "2026-10-10T08:00:00.000Z", error: null, ...over,
  };
}

const codex = item({
  runner: "codex", label: "Codex", available: true, reason: null, plan: "plus",
  windows: [
    { minutes: 10080, percent: 91, resets_at: "2026-10-14T00:00:00.000Z" },
    { minutes: 300, percent: 18.4, resets_at: "2026-10-10T12:00:00.000Z" },
  ],
});

function open(options: { items?: AgentUsage[]; answer?: () => Promise<AgentUsageResponse>; copy?: typeof t } = {}) {
  // Kept outside the runtime: reading a reactive array between two asks would freeze it.
  const asked: boolean[] = [];
  const client = {
    agentUsage: (refresh = false) => {
      asked.push(refresh);
      return options.answer ? options.answer() : Promise.resolve({ items: options.items ?? [] });
    },
  };
  const runtime = reactive(fakeRuntime({}, { client }));
  const view = render(AgentUsageMeter, { runtime, t: options.copy ?? t });
  return { ...view, asked };
}

const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, " ").trim();

test("Codex's plan windows show what is left of each, rounded down, shortest first, with a bar as full as what is left", async () => {
  const view = open({ items: [codex] });
  await sleep(0);
  expect(view.asked).toEqual([false]);
  const windows = [...view.host.querySelectorAll("[data-agent-usage-window]")];
  expect(windows.map(text)).toEqual(["5 小时 剩81%", "7 天 剩9%"]);
  expect(windows.map((window) => window.getAttribute("data-agent-usage-window"))).toEqual(["300", "10080"]);
  expect(view.host.querySelector("[data-agent-usage-item] .agent-usage-name")?.textContent).toBe("Codex");
  // A bar of what is left; nine tenths gone reads as nearly out.
  expect(windows.map((window) => window.querySelector<HTMLElement>(".agent-usage-bar > span")?.style.width)).toEqual(["81.6%", "9%"]);
  expect(windows[0]!.classList.contains("is-normal")).toBe(true);
  expect(windows[1]!.classList.contains("is-danger")).toBe(true);
  // Plan windows, so no day's line.
  expect(view.host.querySelector("[data-agent-usage-today]")).toBeNull();
  view.close();
});

test("each line leads with its agent's own logo, your own ACP agent's the plain glyph, and the name beside it stays text", async () => {
  const view = open({ items: [codex, item(), item({ runner: "custom", custom_id: "ca-1", label: "my-agent" })] });
  await sleep(0);
  const names = [...view.host.querySelectorAll(".agent-usage-name")];
  expect(names.map((name) => name.querySelector("[data-agent-logo]")?.getAttribute("data-agent-logo"))).toEqual(["codex", "grok", "custom"]);
  // Before the name, inside the same cell, so the cell's tooltip and text are the name's.
  expect(names.map((name) => name.firstElementChild?.hasAttribute("data-agent-logo"))).toEqual([true, true, true]);
  expect(names.map((name) => name.querySelector(".agent-usage-label")?.textContent)).toEqual(["Codex", "Grok", "my-agent"]);
  expect(names.map((name) => name.textContent)).toEqual(["Codex", "Grok", "my-agent"]);
  expect(names.map((name) => name.getAttribute("title"))).toEqual(["Codex", "Grok", "my-agent"]);
  // A logo per line and nothing else drawn: the windows' bars are spans.
  expect(view.host.querySelectorAll("[data-agent-usage-item] svg")).toHaveLength(3);
  view.close();
});

test("an agent that reports no windows shows today's turns and tokens, with no percentage", async () => {
  const view = open({ items: [item(), item({ runner: "opencode", label: "OpenCode", today: { turns: 0, tokens: 0, estimated_usd: 0 } })] });
  await sleep(0);
  const lines = [...view.host.querySelectorAll("[data-agent-usage-item]")].map((row) => [row.querySelector(".agent-usage-name")?.textContent, text(row.querySelector("[data-agent-usage-today]"))]);
  expect(lines).toEqual([["Grok", "今天 3 轮 · 12.3k token"], ["OpenCode", "今天 0 轮 · 0 token"]]);
  expect(view.host.querySelector("[data-agent-usage-window]")).toBeNull();
  expect(view.host.querySelector(".agent-usage-bar")).toBeNull();
  expect(view.host.textContent).not.toContain("%");
  view.close();

  const english = open({ items: [item()], copy: en });
  await sleep(0);
  expect(text(english.host.querySelector("[data-agent-usage-today]"))).toBe("Today 3 turns · 12.3k tokens");
  english.close();
});

test("Codex without windows (no plan limits, signed out, not found) falls back to today's line like the others", async () => {
  for (const reason of ["no_plan", "signed_out", "missing", "failed"] as const) {
    const view = open({ items: [item({ runner: "codex", label: "Codex", reason, windows: [] })] });
    await sleep(0);
    expect(text(view.host.querySelector("[data-agent-usage-today]"))).toBe("今天 3 轮 · 12.3k token");
    view.close();
  }
  // Windows that the agent did not say are available are not shown either.
  const hidden = open({ items: [item({ runner: "codex", label: "Codex", available: false, windows: [{ minutes: 300, percent: 10, resets_at: null }] })] });
  await sleep(0);
  expect(hidden.host.querySelector("[data-agent-usage-window]")).toBeNull();
  expect(hidden.host.querySelector("[data-agent-usage-today]")).not.toBeNull();
  hidden.close();
});

test("Codex windows and other agents' days share the strip, one line each", async () => {
  const view = open({ items: [codex, item()] });
  await sleep(0);
  expect([...view.host.querySelectorAll("[data-agent-usage-item]")].map((row) => row.getAttribute("data-agent-usage-item"))).toEqual(["codex", "grok"]);
  expect(view.host.querySelectorAll("[data-agent-usage]")).toHaveLength(1);
  expect(view.host.querySelector("[data-agent-usage]")?.getAttribute("aria-label")).toBe(t.agents.usage.title);
  view.close();
});

test("nothing is shown when there is nothing to show, nor when the daemon is older than the route or fails", async () => {
  const none = open({ items: [] });
  await sleep(0);
  expect(none.asked).toEqual([false]);
  expect(none.host.querySelector("[data-agent-usage]")).toBeNull();
  expect(none.host.textContent?.trim()).toBe("");
  none.close();

  const old = open({ answer: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } });
  await sleep(0);
  expect(old.host.querySelector("[data-agent-usage]")).toBeNull();
  old.close();

  const failing = open({ answer: async () => { throw new Error("down"); } });
  await sleep(0);
  expect(failing.host.querySelector("[data-agent-usage]")).toBeNull();
  failing.close();
});

test("one agent on two accounts: each line names its account, the config directory's last part or the default", async () => {
  const view = open({ items: [{ ...codex, config_dir: null }, { ...codex, config_dir: "/Users/you/.codex-b" }, item()] });
  await sleep(0);
  expect([...view.host.querySelectorAll(".agent-usage-name")].map((name) => name.textContent)).toEqual(["Codex · 默认账号", "Codex · .codex-b", "Grok"]);
  view.close();
});

test("window names come from their length: 5 hours, 7 days, 30 days, otherwise as many days or hours or minutes", () => {
  expect([300, 10080, 43200, 2880, 120, 90].map((minutes) => agentWindowLabel(minutes, t))).toEqual(["5 小时", "7 天", "30 天", "2 天", "2 小时", "90 分钟"]);
  expect([300, 10080, 43200].map((minutes) => agentWindowLabel(minutes, en))).toEqual(["5-hour", "7-day", "30-day"]);
  expect(agentWindowLabel(null, t)).toBe("额度");
  expect(agentWindowLabel(0, t)).toBe("额度");
});

test("tokens are said short, and accounts are told apart only when one agent has several", () => {
  expect([0, 950, 1000, 12_345, 120_000, 999_949, 999_999, 1_250_000].map(agentTokenText)).toEqual(["0", "950", "1k", "12.3k", "120k", "999.9k", "1M", "1.3M"]);
  expect(agentUsageNames([item(), codex], t)).toEqual(["Grok", "Codex"]);
});
