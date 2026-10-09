import { expect, test } from "bun:test";
import type { ClaudeCodeStatus, ModelLadderRung, Provider } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import ModelLadderCard from "./ModelLadderCard.svelte";
import { ModelLadder, type ModelLadderApi } from "./model-ladder.svelte.ts";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const providers = [
  { id: "p1", name: "Default", models: ["light", "mid"] },
  { id: "p2", name: "Other", models: ["heavy"] },
] as unknown as Provider[];

function fakeApi(items: ModelLadderRung[], opts: { available?: boolean; fail?: boolean } = {}) {
  const saved: ModelLadderRung[][] = [];
  return {
    saved,
    api: {
      modelLadder: async () => ({ items, available: opts.available ?? true }),
      setModelLadder: async (next: ModelLadderRung[]) => {
        saved.push(next);
        if (opts.fail) throw new Error("409");
        return { items: next, available: true };
      },
    },
  };
}

/** The card as Models shows it: the ladder read by the page that holds it. */
function card(api: ModelLadderApi, claudeCode: (() => Promise<ClaudeCodeStatus>) | null = null) {
  const ladder = new ModelLadder(() => api);
  void ladder.load();
  return render(ModelLadderCard, { ladder, providers, claudeCode, t });
}

const names = (host: HTMLElement) => [...host.querySelectorAll(".ladder-name")].map((el) => el.textContent);

test("nothing shows below level 7", async () => {
  const { api } = fakeApi([], { available: false });
  const view = card(api);
  await sleep(0);
  expect(view.host.querySelector("[data-model-ladder]")).toBeNull();
  view.close();
});

const grip = (host: HTMLElement, model: string) => host.querySelector<HTMLElement>(`[aria-label="${t.modelLadder.move(model)}"]`)!;
const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
const steps = (host: HTMLElement) => [...host.querySelectorAll(".ladder-step")].map((el) => el.textContent);

test("rungs read weaker to stronger, move by the grip's arrow keys and come off, each change saved in your order", async () => {
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }, { provider_id: "p1", model: "mid" }, { provider_id: "p2", model: "heavy" }]);
  const view = card(api);
  await sleep(0);
  expect(names(view.host)).toEqual(["light · Default", "mid · Default", "heavy · Other"]);
  // Already the weakest: up does nothing.
  key(grip(view.host, "light"), "ArrowUp");
  await sleep(0);
  expect(saved).toEqual([]);
  key(grip(view.host, "light"), "ArrowDown");
  await sleep(0);
  expect(names(view.host)).toEqual(["mid · Default", "light · Default", "heavy · Other"]);
  expect(document.activeElement).toBe(grip(view.host, "light"));
  click(view.host.querySelector(`[aria-label="${t.modelLadder.remove("heavy")}"]`)!);
  await sleep(0);
  expect(saved).toEqual([
    [{ provider_id: "p1", model: "mid" }, { provider_id: "p1", model: "light" }, { provider_id: "p2", model: "heavy" }],
    [{ provider_id: "p1", model: "mid" }, { provider_id: "p1", model: "light" }],
  ]);
  view.close();
});

test("each rung's colour runs from the weak end to the strong one by its place", async () => {
  const { api } = fakeApi([{ provider_id: "p1", model: "light" }, { provider_id: "p1", model: "mid" }, { provider_id: "p2", model: "heavy" }]);
  const view = card(api);
  await sleep(0);
  const rungs = [...view.host.querySelectorAll<HTMLElement>(".ladder-rung")];
  expect(rungs.map((rung) => rung.style.getPropertyValue("--rung-strength"))).toEqual(["0%", "50%", "100%"]);
  expect(view.host.querySelector(".ladder-scale")?.textContent?.replace(/\s+/g, "")).toBe(`${t.modelLadder.weaker}${t.modelLadder.stronger}`);
  view.close();
});

/** Three rungs 40 px tall, 8 px apart, as the drag reads them when it starts. */
function laidOut(host: HTMLElement) {
  [...host.querySelectorAll<HTMLElement>(".ladder-rung")].forEach((row, index) => {
    const top = index * 48;
    row.getBoundingClientRect = () => ({ top, bottom: top + 40, height: 40, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  });
}

const pointer = (target: EventTarget, type: string, clientY: number, pointerType = "touch") =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, clientX: 280, clientY, pointerType }));

test("a rung dragged by its grip, touch included, lands where it is let go, and the others make room on the way", async () => {
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }, { provider_id: "p1", model: "mid" }, { provider_id: "p2", model: "heavy" }]);
  const view = card(api);
  await sleep(0);
  laidOut(view.host);
  pointer(grip(view.host, "light"), "pointerdown", 20);
  pointer(window, "pointermove", 22);
  await sleep(0);
  // Under the threshold: nothing moves yet.
  expect(view.host.querySelector(".ladder-rung.is-held")).toBeNull();
  pointer(window, "pointermove", 80);
  await sleep(0);
  expect(view.host.querySelector(".ladder-rung.is-held")?.getAttribute("data-rung")).toBe("light");
  // Past mid's middle: light would be second, so the numbers already read in that order.
  expect(steps(view.host)).toEqual(["2", "1", "3"]);
  expect(saved).toEqual([]);
  pointer(window, "pointerup", 80);
  await sleep(0);
  expect(saved).toEqual([[{ provider_id: "p1", model: "mid" }, { provider_id: "p1", model: "light" }, { provider_id: "p2", model: "heavy" }]]);
  expect(names(view.host)).toEqual(["mid · Default", "light · Default", "heavy · Other"]);
  view.close();
});

test("a drag let go where it started, or put back with Escape, saves nothing", async () => {
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }, { provider_id: "p1", model: "mid" }, { provider_id: "p2", model: "heavy" }]);
  const view = card(api);
  await sleep(0);
  laidOut(view.host);
  pointer(grip(view.host, "heavy"), "pointerdown", 116, "mouse");
  pointer(window, "pointermove", 20, "mouse");
  await sleep(0);
  expect(steps(view.host)).toEqual(["2", "3", "1"]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await sleep(0);
  expect(steps(view.host)).toEqual(["1", "2", "3"]);
  pointer(window, "pointerup", 20, "mouse");
  pointer(grip(view.host, "mid"), "pointerdown", 68, "mouse");
  pointer(window, "pointermove", 74, "mouse");
  pointer(window, "pointerup", 74, "mouse");
  await sleep(0);
  expect(saved).toEqual([]);
  expect(names(view.host)).toEqual(["light · Default", "mid · Default", "heavy · Other"]);
  view.close();
});

test("a model is added at the strong end from what is listed and not on it yet", async () => {
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }]);
  const view = card(api);
  await sleep(0);
  click(view.host.querySelector(".ladder-add .real-select-trigger")!);
  await sleep(0);
  const options = [...view.host.querySelectorAll(".real-select-option")];
  expect(options.map((el) => el.textContent?.replace(/\s+/g, " ").trim())).toEqual(["mid Default", "heavy Other"]);
  click(options[1]!);
  await sleep(0);
  expect(saved).toEqual([[{ provider_id: "p1", model: "light" }, { provider_id: "p2", model: "heavy" }]]);
  view.close();
});

test("a change that is not saved goes back, and says so", async () => {
  const { api } = fakeApi([{ provider_id: "p1", model: "light" }, { provider_id: "p1", model: "mid" }], { fail: true });
  const view = card(api);
  await sleep(0);
  click(view.host.querySelector(`[aria-label="${t.modelLadder.remove("light")}"]`)!);
  await sleep(0);
  expect(names(view.host)).toEqual(["light · Default", "mid · Default"]);
  expect(view.host.querySelector(".ladder-error")?.textContent).toBe(t.modelLadder.failed);
  view.close();
});

test("each rung shows where its model comes from, as the picker that added it did", async () => {
  const marked = [
    { id: "p1", name: "小米", base_url: "https://token-plan-cn.xiaomimimo.com/v1", api_format: "openai", models: ["mimo"] },
    { id: "p2", name: "My CPA", base_url: "https://cpa.example.com/v1", api_format: "openai", models: ["grok"] },
  ] as unknown as Provider[];
  const { api } = fakeApi([{ provider_id: "p1", model: "mimo" }, { provider_id: "p2", model: "grok" }, { provider_id: "gone", model: "old" }]);
  const ladder = new ModelLadder(() => api);
  void ladder.load();
  const view = render(ModelLadderCard, { ladder, providers: marked, t });
  await sleep(0);
  const rungs = [...view.host.querySelectorAll(".ladder-rung")];
  expect(rungs.map((rung) => rung.querySelector("[data-model-source]")?.getAttribute("data-model-source") ?? null)).toEqual(["xiaomi", "custom", null]);
  expect(rungs[0]!.querySelector(".connector-logo.is-xiaomi")).toBeTruthy();
  // The mark is drawn, not written: the row still reads as the model and its endpoint.
  expect(names(view.host)).toEqual(["mimo · 小米", "grok · My CPA", "old · gone"]);
  view.close();
});

const own = { logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "me@example.com" };
function claudeStatus(accounts: NonNullable<ClaudeCodeStatus["accounts"]> = [{ config_dir: null, config_directory: null, ...own, error: null, login_command: "claude auth login" }]): ClaudeCodeStatus {
  return {
    path: "/u/claude", source: "path", version: "2.1.294", sdk_version: "2.1.289", outdated: false, ...own, base_url_set: false,
    proxy: null, proxy_source: null, checked_at: "2026-10-08T00:00:00.000Z", error: null, accounts,
  };
}
const optionTexts = (host: HTMLElement) => [...host.querySelectorAll(".real-select-option")].map((el) => el.textContent?.replace(/\s+/g, " ").trim());

test("with Claude Code signed in, the Claude models Agent settings offer can be added (ADR 0076), at the default effort on the default account", async () => {
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }]);
  const view = card(api, async () => claudeStatus());
  await sleep(0);
  click(view.host.querySelector(".ladder-add .real-select-trigger")!);
  await sleep(0);
  expect([...view.host.querySelectorAll(".real-select-group")].at(-1)?.textContent).toBe(t.sidebar.botRunnerClaude);
  expect(optionTexts(view.host).slice(-4)).toEqual(["sonnet", "opus", "haiku", "fable"].map((model) => `${model} ${t.claudeAgent.title}`));
  click([...view.host.querySelectorAll(".real-select-option")].at(-3)!);
  await sleep(0);
  expect(saved).toEqual([[{ provider_id: "p1", model: "light" }, { runner: "claude_code", model: "opus", effort: null, config_dir: null }]]);
  view.close();

  // No Claude Code to ask (the phone), or not signed in: none are offered.
  for (const status of [async () => { throw new Error("404"); }, async () => claudeStatus([{ config_dir: null, config_directory: null, ...own, logged_in: false, error: null, login_command: "x" }])]) {
    const none = card(fakeApi([]).api, status);
    await sleep(0);
    click(none.host.querySelector(".ladder-add .real-select-trigger")!);
    await sleep(0);
    expect(optionTexts(none.host)).toEqual(["light Default", "mid Default", "heavy Other"]);
    none.close();
  }
});

test("a Claude rung picks its own effort, and its account when there is more than one; each change saved in place", async () => {
  const opus = { runner: "claude_code" as const, model: "opus", effort: null, config_dir: null };
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }, opus]);
  const view = card(api, async () => claudeStatus([
    { config_dir: null, config_directory: null, ...own, error: null, login_command: "claude auth login" },
    { config_dir: "/opt/claude-b", config_directory: "/opt/claude-b", ...own, email: "b@example.com", error: null, login_command: "x" },
  ]));
  await sleep(0);
  expect(names(view.host)).toEqual(["light · Default", "opus"]);
  const tune = view.host.querySelector("[data-rung-claude]")!;
  expect(view.host.querySelector('[data-rung="opus"] [data-model-source]')?.getAttribute("data-model-source")).toBe("claude-agent");
  const [effort, account] = [...tune.querySelectorAll<HTMLElement>(".real-select-trigger")];
  expect(effort!.textContent).toContain(t.modelLadder.effort(t.sidebar.botAgentEffortDefault));
  click(effort!);
  await sleep(0);
  click([...tune.querySelectorAll(".real-select-option")].at(-1)!);
  await sleep(0);
  expect(saved.at(-1)).toEqual([{ provider_id: "p1", model: "light" }, { ...opus, effort: "max" }]);
  click(view.host.querySelector("[data-rung-claude]")!.querySelectorAll<HTMLElement>(".real-select-trigger")[1]!);
  await sleep(0);
  click([...view.host.querySelector("[data-rung-claude]")!.querySelectorAll(".real-select-option")].at(-1)!);
  await sleep(0);
  expect(saved.at(-1)).toEqual([{ provider_id: "p1", model: "light" }, { ...opus, effort: "max", config_dir: "/opt/claude-b" }]);
  expect(account).toBeDefined();
  view.close();

  // One account only: no account to pick.
  const single = card(fakeApi([opus]).api, async () => claudeStatus());
  await sleep(0);
  expect(single.host.querySelectorAll("[data-rung-claude] .real-select-trigger")).toHaveLength(1);
  single.close();
});
