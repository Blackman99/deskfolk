import { expect, test } from "bun:test";
import { AGENT_KINDS, type AgentsStatusResponse, type BotRunner, type ClaudeCodeStatus, type ModelLadderRung, type Provider } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { click, fill, press, render } from "../test-render.ts";
import { settle } from "../test-async.ts";
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
function card(api: ModelLadderApi, claudeCode: (() => Promise<ClaudeCodeStatus>) | null = null, agents: (() => Promise<AgentsStatusResponse>) | null = null) {
  const ladder = new ModelLadder(() => api);
  void ladder.load();
  return render(ModelLadderCard, { ladder, providers, claudeCode, agents, t });
}

const names = (host: HTMLElement) => [...host.querySelectorAll(".ladder-name")].map((el) => el.textContent);

/** The value a picker row carries: the rung it adds, as JSON. */
const endpoint = (provider_id: string, model: string) => JSON.stringify({ provider_id, model });
const agent = (runner: string, model: string, custom_id?: string) => JSON.stringify({ runner, model, effort: null, config_dir: null, ...(custom_id ? { custom_id } : {}) });

const addTrigger = (host: HTMLElement) => host.querySelector(".ladder-add .real-select-trigger")!;
const rowLabel = (el: Element) => el.querySelector(".mp-row-label")?.textContent?.trim();
const rowFor = (host: HTMLElement, value: string) => [...host.querySelectorAll<HTMLElement>(".mp-row")].find((el) => el.dataset.value === value)!;
const sourceEl = (host: HTMLElement, sourceKey: string) => host.querySelector<HTMLElement>(`.mp-source[data-source-key="${sourceKey}"]`)!;
/** Points at one source of the open picker, as the pointer does, so its models are the rows. */
async function point(host: HTMLElement, sourceKey: string): Promise<void> {
  sourceEl(host, sourceKey).dispatchEvent(new MouseEvent("mouseenter"));
  await settle();
}
const rowsShown = (host: HTMLElement) => [...host.querySelectorAll(".mp-columns .mp-row")].map(rowLabel);
/** What the open picker offers, source by source: each one's name and the models it lists. */
async function offered(host: HTMLElement) {
  const found: Array<{ source: string; models: Array<string | undefined> }> = [];
  for (const sourceKey of [...host.querySelectorAll<HTMLElement>(".mp-source")].map((el) => el.dataset.sourceKey!)) {
    await point(host, sourceKey);
    found.push({ source: sourceEl(host, sourceKey).querySelector(".mp-source-label")!.textContent!, models: rowsShown(host) });
  }
  return found;
}
/** Adds the model with this value, from the source it is listed under. */
async function addModel(host: HTMLElement, sourceKey: string, value: string): Promise<void> {
  click(addTrigger(host));
  await settle();
  await point(host, sourceKey);
  click(rowFor(host, value));
  await settle();
}

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
  click(addTrigger(view.host));
  await settle();
  expect(await offered(view.host)).toEqual([
    { source: "Default", models: ["mid"] },
    { source: "Other", models: ["heavy"] },
  ]);
  click(rowFor(view.host, endpoint("p2", "heavy")));
  await settle();
  expect(saved).toEqual([[{ provider_id: "p1", model: "light" }, { provider_id: "p2", model: "heavy" }]]);
  // The picker reads "add a model" again, not the choice it just added.
  expect(view.host.querySelector(".ladder-add .real-select-value")?.textContent?.trim()).toBe(t.modelLadder.add);
  view.close();
});

test("an endpoint with nothing left to add drops out of the picker, and with nothing left anywhere so does the picker", async () => {
  const { api } = fakeApi([{ provider_id: "p2", model: "heavy" }]);
  const view = card(api);
  await sleep(0);
  click(addTrigger(view.host));
  await settle();
  // One endpoint left: no list of sources, only its models.
  expect(view.host.querySelector(".mp-source")).toBeNull();
  expect(rowsShown(view.host)).toEqual(["light", "mid"]);
  view.close();
  const full = card(fakeApi([{ provider_id: "p1", model: "light" }, { provider_id: "p1", model: "mid" }, { provider_id: "p2", model: "heavy" }]).api);
  await sleep(0);
  expect(full.host.querySelector(".ladder-add")).toBeNull();
  full.close();
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
const claude = (model: string) => agent("claude_code", model);

test("with Claude Code signed in, the Claude models Agent settings offer can be added (ADR 0076), at the default effort on the default account", async () => {
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }]);
  const view = card(api, async () => claudeStatus());
  await sleep(0);
  click(addTrigger(view.host));
  await settle();
  expect(await offered(view.host)).toEqual([
    { source: "Default", models: ["mid"] },
    { source: "Other", models: ["heavy"] },
    { source: t.claudeAgent.title, models: ["sonnet", "opus", "haiku", "fable"] },
  ]);
  expect(sourceEl(view.host, "agent:claude_code").querySelector("[data-model-source]")?.getAttribute("data-model-source")).toBe("claude-agent");
  click(rowFor(view.host, claude("opus")));
  await settle();
  expect(saved).toEqual([[{ provider_id: "p1", model: "light" }, { runner: "claude_code", model: "opus", effort: null, config_dir: null }]]);
  view.close();

  // No Claude Code to ask (the phone), or not signed in: none are offered.
  for (const status of [async () => { throw new Error("404"); }, async () => claudeStatus([{ config_dir: null, config_directory: null, ...own, logged_in: false, error: null, login_command: "x" }])]) {
    const none = card(fakeApi([]).api, status);
    await sleep(0);
    click(addTrigger(none.host));
    await settle();
    expect(await offered(none.host)).toEqual([
      { source: "Default", models: ["light", "mid"] },
      { source: "Other", models: ["heavy"] },
    ]);
    none.close();
  }
});

test("the Claude models and the other agents' already on the ladder are not offered again", async () => {
  const { api } = fakeApi([{ runner: "claude_code", model: "opus", effort: null, config_dir: null }, { runner: "grok", model: "grok-4.7", effort: null, config_dir: null }]);
  const view = card(api, async () => claudeStatus(), agentsOf(agentStatus("grok", { models: models("grok-4.7", "grok-4.7-fast") })));
  await sleep(0);
  click(addTrigger(view.host));
  await settle();
  expect(await offered(view.host)).toEqual([
    { source: "Default", models: ["light", "mid"] },
    { source: "Other", models: ["heavy"] },
    { source: t.claudeAgent.title, models: ["sonnet", "haiku", "fable"] },
    { source: "Grok", models: ["grok-4.7-fast"] },
  ]);
  view.close();
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

/** One of your other local agents as the daemon reports it (ADR 0079). */
function agentStatus(runner: BotRunner, over: Record<string, unknown> = {}) {
  return {
    runner, custom_id: null, label: AGENT_KINDS[runner].label, path: `/usr/local/bin/${runner}`, source: "path", version: "1", logged_in: true, auth: null,
    login_command: null, models: [], default_model: null, proxy: null, proxy_source: null, checked_at: "2026-10-10T00:00:00.000Z", error: null, ...over,
  };
}
const models = (...ids: string[]) => ids.map((id) => ({ id, name: id, efforts: [] }));
const agentsOf = (...items: ReturnType<typeof agentStatus>[]) => async () => ({ items, custom_agents: [] }) as unknown as AgentsStatusResponse;

test("the models of the other local agents found and signed in can be rungs, a source each by the agent's name and logo", async () => {
  const { api, saved } = fakeApi([{ provider_id: "p1", model: "light" }]);
  const acp = agentStatus("custom", { custom_id: "acp-1", label: "我的 ACP", models: models("fast") });
  const view = card(api, null, agentsOf(
    agentStatus("grok", { models: models("grok-4.7", "grok-4.7-fast") }),
    agentStatus("codex", { path: null, models: models("gpt-5.5") }),
    agentStatus("antigravity", { logged_in: false, models: models("gemini-3.8-flash-high") }),
    agentStatus("opencode", { models: [], default_model: "openai/gpt-5.5" }),
    acp,
  ));
  await sleep(0);
  click(addTrigger(view.host));
  await settle();
  // Not found, or signed out: none of theirs. An agent that lists no models offers the default one it named.
  expect(await offered(view.host)).toEqual([
    { source: "Default", models: ["mid"] },
    { source: "Other", models: ["heavy"] },
    { source: "Grok", models: ["grok-4.7", "grok-4.7-fast"] },
    { source: "OpenCode", models: ["openai/gpt-5.5"] },
    { source: "我的 ACP", models: ["fast"] },
  ]);
  const marks = ["grok", "opencode", "custom"].map((runner) => sourceEl(view.host, runner === "custom" ? "agent:custom:acp-1" : `agent:${runner}`).querySelector("[data-model-source]")?.getAttribute("data-model-source"));
  expect(marks).toEqual(["agent", "agent", "agent"]);
  expect(sourceEl(view.host, "agent:grok").querySelector('[data-agent-logo="grok"]')).not.toBeNull();
  // The agent's logo, not a text chip.
  expect(sourceEl(view.host, "agent:grok").querySelector(".model-source-custom")).toBeNull();
  await point(view.host, "agent:opencode");
  click(rowFor(view.host, agent("opencode", "openai/gpt-5.5")));
  await settle();
  expect(saved).toEqual([[{ provider_id: "p1", model: "light" }, { runner: "opencode", model: "openai/gpt-5.5", effort: null, config_dir: null }]]);
  view.close();
  // Your own ACP agent's rung names it by id.
  const own = fakeApi([]);
  const custom = card(own.api, null, agentsOf(acp));
  await sleep(0);
  await addModel(custom.host, "agent:custom:acp-1", agent("custom", "fast", "acp-1"));
  expect(own.saved).toEqual([[{ runner: "custom", custom_id: "acp-1", model: "fast", effort: null, config_dir: null }]]);
  custom.close();
});

test("an agent that lists no model and names no default takes one typed into the search, and it joins the ladder once", async () => {
  const { api, saved } = fakeApi([{ runner: "zcode", model: "glm-5.3", effort: null, config_dir: null }]);
  const view = card(api, null, agentsOf(agentStatus("zcode")));
  await sleep(0);
  click(addTrigger(view.host));
  await settle();
  await point(view.host, "agent:zcode");
  expect(sourceEl(view.host, "agent:zcode").querySelector(".mp-source-note")?.textContent).toBe(t.modelPicker.typeShort);
  expect(view.host.querySelector(".mp-empty")?.textContent).toContain(t.modelPicker.noModels);
  // One already on the ladder is not added twice.
  const search = view.host.querySelector<HTMLInputElement>(".mp-search input")!;
  fill(search, "glm-5.3");
  press(search, "Enter");
  await settle();
  expect(saved).toEqual([]);
  click(addTrigger(view.host));
  await settle();
  await point(view.host, "agent:zcode");
  fill(view.host.querySelector<HTMLInputElement>(".mp-search input"), "glm-5.3-air");
  press(view.host.querySelector<HTMLInputElement>(".mp-search input"), "Enter");
  await settle();
  expect(saved).toEqual([[{ runner: "zcode", model: "glm-5.3", effort: null, config_dir: null }, { runner: "zcode", model: "glm-5.3-air", effort: null, config_dir: null }]]);
  view.close();
});

test("a rung of another agent offers that agent's efforts (none for one that has none) and its accounts when there are several; each change saved in place", async () => {
  const grok = { runner: "grok" as const, model: "grok-4.7", effort: null, config_dir: null };
  const opencode = { runner: "opencode" as const, model: "openai/gpt-5.5", effort: null, config_dir: null };
  const codex = { runner: "codex" as const, model: "gpt-5.5", effort: null, config_dir: null };
  const accounts = [
    { config_dir: null, logged_in: true, auth: "ChatGPT Plus", error: null, login_command: "codex login" },
    { config_dir: "/opt/codex-b", logged_in: true, auth: "ChatGPT Pro", error: null, login_command: "x" },
  ];
  const { api, saved } = fakeApi([grok, opencode, codex]);
  const view = card(api, null, agentsOf(agentStatus("grok"), agentStatus("opencode"), agentStatus("codex", { accounts })));
  await sleep(0);
  // Every rung says whose it is, as text; the title carries the model and the agent.
  expect(names(view.host)).toEqual(["grok-4.7", "openai/gpt-5.5", "gpt-5.5"]);
  expect([...view.host.querySelectorAll(".ladder-name")].map((el) => el.getAttribute("title"))).toEqual(["grok-4.7 · Grok", "openai/gpt-5.5 · OpenCode", "gpt-5.5 · Codex"]);
  expect([...view.host.querySelectorAll(".ladder-rung")].map((rung) => rung.querySelector("[data-model-source]")?.getAttribute("data-runner"))).toEqual(["grok", "opencode", "codex"]);
  expect(view.host.querySelector('[data-rung-claude]')).toBeNull();
  // OpenCode takes no effort, so its rung has nothing to tune; Codex has an account too, since there are two.
  expect(view.host.querySelector('[data-rung="openai/gpt-5.5"] [data-rung-agent]')).toBeNull();
  expect(view.host.querySelectorAll('[data-rung="gpt-5.5"] [data-rung-agent] .real-select-trigger')).toHaveLength(2);
  expect(view.host.querySelectorAll('[data-rung="grok-4.7"] [data-rung-agent] .real-select-trigger')).toHaveLength(1);
  // Grok's efforts end at extra high.
  const effort = view.host.querySelector<HTMLElement>('[data-rung="grok-4.7"] [data-rung-agent] .real-select-trigger')!;
  click(effort);
  await sleep(0);
  const levels = [...view.host.querySelectorAll('[data-rung="grok-4.7"] .real-select-option')].map((el) => el.textContent?.trim());
  expect(levels).toEqual([t.modelLadder.effort(t.sidebar.botAgentEffortDefault), ...["低", "中", "高", "极高"].map((level) => t.modelLadder.effort(level))]);
  click([...view.host.querySelectorAll('[data-rung="grok-4.7"] .real-select-option')].at(-1)!);
  await sleep(0);
  expect(saved.at(-1)).toEqual([{ ...grok, effort: "xhigh" }, opencode, codex]);
  click(view.host.querySelectorAll<HTMLElement>('[data-rung="gpt-5.5"] [data-rung-agent] .real-select-trigger')[1]!);
  await sleep(0);
  const options = [...view.host.querySelectorAll('[data-rung="gpt-5.5"] .real-select-option')];
  expect(options.map((el) => el.textContent?.trim())).toEqual([`${t.sidebar.botAgentAccountDefault} · ChatGPT Plus`, "ChatGPT Pro · /opt/codex-b"]);
  click(options.at(-1)!);
  await sleep(0);
  expect(saved.at(-1)).toEqual([{ ...grok, effort: "xhigh" }, opencode, { ...codex, config_dir: "/opt/codex-b" }]);
  view.close();
});

test("rungs of agents that cannot be asked (the phone) still read with the agent's name, and two of your ACP agents with one model name are two rungs", async () => {
  const { api } = fakeApi([
    { runner: "codex", model: "gpt-5.5", effort: "high", config_dir: null },
    { runner: "custom", custom_id: "a", model: "m", effort: null, config_dir: null },
    { runner: "custom", custom_id: "b", model: "m", effort: null, config_dir: null },
  ]);
  const view = card(api, null, async () => { throw new Error("404"); });
  await sleep(0);
  expect(view.host.querySelectorAll(".ladder-rung")).toHaveLength(3);
  expect([...view.host.querySelectorAll(".ladder-name")].map((el) => el.getAttribute("title"))).toEqual(["gpt-5.5 · Codex", `m · ${AGENT_KINDS.custom.label}`, `m · ${AGENT_KINDS.custom.label}`]);
  // Codex's rung keeps the effort it has.
  expect(view.host.querySelector('[data-rung="gpt-5.5"] [data-rung-agent] .real-select-trigger')?.textContent).toContain(t.modelLadder.effort("高"));
  view.close();
  // The names you gave them, once the daemon is asked.
  const named = card(fakeApi([
    { runner: "custom", custom_id: "a", model: "m", effort: null, config_dir: null },
    { runner: "custom", custom_id: "b", model: "m", effort: null, config_dir: null },
  ]).api, null, async () => ({ items: [], custom_agents: [{ id: "a", name: "甲", command: "a", args: [] }, { id: "b", name: "乙", command: "b", args: [] }] }));
  await sleep(0);
  expect([...named.host.querySelectorAll(".ladder-name")].map((el) => el.getAttribute("title"))).toEqual(["m · 甲", "m · 乙"]);
  named.close();
});
