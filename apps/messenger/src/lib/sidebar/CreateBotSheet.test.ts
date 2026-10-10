import { expect, test } from "bun:test";
import { AGENT_KINDS, BOT_RUNNERS, type BotRunner, type Settings } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { noBuiltinModels } from "../settings/builtin-models.ts";
import { emptySnapshot } from "../snapshot.ts";
import { aProvider, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import CreateBotSheet from "./CreateBotSheet.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open() {
  const closed: true[] = [];
  const runtime = fakeRuntime();
  const view = render(CreateBotSheet, { runtime, bots: [], t, modelOptions: [], onClose: () => closed.push(true) });
  return { ...view, runtime, closed };
}

/**
 * The frame that turns this dialog into a page below 680px lives in `modals.css`; a dialog opts
 * into it with `page-on-phone` and by carrying the way back its ✕ is replaced with.
 */
test("the new-Bot form is a page on a phone, with a way back where a phone keeps it", () => {
  const { host, closed, close } = open();
  const backdrop = host.querySelector('.modal-backdrop');
  expect(backdrop?.classList.contains('page-on-phone')).toBe(true);
  const back = host.querySelector('.modal-head .modal-back');
  expect(back).not.toBeNull();
  // The ✕ stays for wider windows, where the dialog is still a dialog.
  expect(host.querySelector('.modal-head .modal-close')).not.toBeNull();
  click(back);
  expect(closed).toHaveLength(1);
  close();
});

/** ADR 0078: set up on Claude Code alone, a new Bot starts on Claude Agent; with an endpoint, on the app. */
test("the new-Bot form starts on Claude Agent when there is no endpoint a Bot could run on", () => {
  for (const [providers, runner] of [
    [[], t.sidebar.botRunnerClaude],
    [[aProvider({ key_set: false, base_url: "https://api.example.com/v1" })], t.sidebar.botRunnerClaude],
    [[aProvider({ key_set: false, base_url: "http://localhost:11434/v1" })], t.sidebar.botRunnerApp],
    [[aProvider({ key_set: true })], t.sidebar.botRunnerApp],
  ] as const) {
    const runtime = fakeRuntime({ providers: [...providers] });
    const view = render(CreateBotSheet, { runtime, bots: [], t, modelOptions: [], onClose: () => {} });
    expect(view.host.querySelector("#bot-runner")?.textContent?.trim()).toBe(runner);
    view.close();
  }
});

/** ADR 0079: set up on another local agent alone, a new Bot starts on that agent; with an endpoint, on the app. */
test("the new-Bot form starts on the agent the app was set up on when there is no endpoint, and on Claude Agent when it names none", () => {
  const setup = (reader: unknown) => ({ ...emptySnapshot().settings, builtin_models: { ...noBuiltinModels(), reader } }) as Settings;
  for (const [settings, providers, runner] of [
    [setup({ runner: "codex", model: "gpt-5.5", config_dir: null }), [], "Codex"],
    [setup({ runner: "custom", model: "m", config_dir: null, custom_id: "acp-1" }), [], "我的 ACP"],
    [setup(null), [], t.sidebar.botRunnerClaude],
    [setup({ runner: "codex", model: "gpt-5.5", config_dir: null }), [aProvider({ key_set: true })], t.sidebar.botRunnerApp],
  ] as const) {
    const runtime = fakeRuntime({ providers: [...providers], settings });
    (runtime as unknown as { client: unknown }).client = { agents: async () => ({ items: [], custom_agents: [{ id: "acp-1", name: "我的 ACP", command: "my-acp", args: [] }] }) };
    const view = render(CreateBotSheet, { runtime, bots: [], t, modelOptions: [], onClose: () => {} });
    // Before the daemon has said what it finds, the picker reads the runner's own name.
    expect(view.host.querySelector("#bot-runner")?.textContent?.trim()).toBe(runner === "我的 ACP" ? AGENT_KINDS.custom.label : runner);
    view.close();
  }
});

const agentStatus = (runner: BotRunner, over: Record<string, unknown> = {}) => ({
  runner, custom_id: null, label: AGENT_KINDS[runner].label, path: `/usr/local/bin/${runner}`, source: "path", version: "1", logged_in: true, auth: null,
  login_command: null, models: [], default_model: null, proxy: null, proxy_source: null, checked_at: "2026-10-10T00:00:00.000Z", error: null, ...over,
});
const found = (over: Partial<Record<BotRunner, Record<string, unknown>>> = {}) => ({
  items: [
    ...BOT_RUNNERS.filter((runner) => runner !== "claude_code" && runner !== "custom").map((runner) => agentStatus(runner, over[runner])),
    agentStatus("custom", { custom_id: "acp-1", label: "我的 ACP", source: "custom" }),
  ],
  custom_agents: [{ id: "acp-1", name: "我的 ACP", command: "my-acp", args: [] }],
});
const rowText = (el: Element) => el.textContent?.replace(/\s+/g, " ").trim();

function openWithAgents(agents: unknown) {
  const runtime = fakeRuntime({ providers: [aProvider({ key_set: true })] });
  (runtime as unknown as { client: unknown }).client = { agents: async () => agents };
  const view = render(CreateBotSheet, { runtime, bots: [], t, modelOptions: [], onClose: () => {} });
  return { ...view, runtime };
}

const create = (host: HTMLElement) => click([...host.querySelectorAll<HTMLButtonElement>(".modal-foot button")].find((el) => el.textContent?.trim() === t.sidebar.create) ?? null);
const fillIn = (host: HTMLElement) => {
  for (const [id, value] of [["bot-name", "Researcher"], ["bot-duties", "read"], ["bot-boundaries", "stay"]] as const) {
    const el = host.querySelector<HTMLInputElement>(`#${id}`)!;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
};

test("the runner picker offers every local agent the daemon finds, and the form creates a Bot on the one picked", async () => {
  const { host, runtime, close } = openWithAgents(found({ grok: { path: null } }));
  await sleep(30);
  click(host.querySelector("#bot-runner"));
  const rows = [...host.querySelectorAll("#bot-runner-listbox [role=option]")];
  expect(rows.map(rowText)).toEqual([t.sidebar.botRunnerApp, t.sidebar.botRunnerClaude, "Codex", "Grok 没装", "OpenCode", "DSH", "Antigravity", "ZCode", "我的 ACP"]);
  click(rows.find((row) => rowText(row) === "Codex") ?? null);
  await sleep(0);
  expect(host.textContent).toContain(t.sidebar.botRunnerAgentCreateHint("Codex"));
  // The endpoint's model is the app's own loop's: gone once another agent runs the Bot.
  expect(host.querySelector("#bot-model")).toBeNull();
  fillIn(host);
  create(host);
  await sleep(0);
  expect(runtime.calls.find((call) => call.name === "createBot")?.args[0]).toMatchObject({ runner: "codex" });
  close();
});

test("one of your own ACP agents is created as runner custom with its id; Antigravity is told it cannot use Deskfolk's tools", async () => {
  const { host, runtime, close } = openWithAgents(found());
  await sleep(30);
  click(host.querySelector("#bot-runner"));
  click([...host.querySelectorAll("#bot-runner-listbox [role=option]")].find((row) => rowText(row) === "我的 ACP") ?? null);
  await sleep(0);
  fillIn(host);
  create(host);
  await sleep(0);
  expect(runtime.calls.find((call) => call.name === "createBot")?.args[0]).toMatchObject({ runner: "custom", agent_custom_id: "acp-1" });
  click(host.querySelector("#bot-runner"));
  click([...host.querySelectorAll("#bot-runner-listbox [role=option]")].find((row) => rowText(row) === "Antigravity") ?? null);
  await sleep(0);
  expect(host.querySelector("[data-runner-note]")?.textContent).toBe(t.sidebar.botRunnerNoAppTools("Antigravity"));
  close();
});

test("an agent not signed in says how to sign it in; the phone, which cannot ask, offers the app and Claude only", async () => {
  const { host, close } = openWithAgents(found({ codex: { logged_in: false, login_command: "codex login" } }));
  await sleep(30);
  click(host.querySelector("#bot-runner"));
  const rows = [...host.querySelectorAll("#bot-runner-listbox [role=option]")];
  expect(rows.map(rowText)).toContain("Codex 没登录");
  close();
  const runtime = fakeRuntime({ providers: [aProvider({ key_set: true })] });
  const phone = render(CreateBotSheet, { runtime, bots: [], t, modelOptions: [], onClose: () => {} });
  await sleep(30);
  click(phone.host.querySelector("#bot-runner"));
  expect([...phone.host.querySelectorAll("#bot-runner-listbox [role=option]")].map(rowText)).toEqual([t.sidebar.botRunnerApp, t.sidebar.botRunnerClaude]);
  phone.close();
});
