import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, type AgentStatus, type Bot } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { settle } from "../test-async.ts";
import { aBot, aBotDirect, aDirect, aGroup, aProvider, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import Composer from "./Composer.svelte";
import { forgetClaudeOptions } from "./project-agent-options.svelte.ts";

/**
 * A Bot's direct picks the Bot's model in its composer, as a project session's does: the endpoint,
 * model and level of a Bot on the app's own loop, the account, model and effort of one on Claude
 * Code, the model and effort of one on another agent. Each pick is one PATCH of the Bot.
 */
const t = copyFor("zh");

const endpoints = [
  aProvider({ id: "p1", name: "Alpha" }),
  aProvider({
    id: "p2",
    name: "Beta",
    models: ["m-b"],
    model_catalog: [{ name: "m-b", price: 1, thinking_levels: ["low", "high"], strengths: [] }],
  }),
];

function open(bot: Partial<Bot> = {}, options: { client?: unknown; stubs?: Record<string, unknown> } = {}) {
  forgetClaudeOptions();
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1", ...bot })], sessions: [selected], providers: endpoints }, options.stubs ?? {}));
  if (options.client) (runtime as unknown as { client: unknown }).client = options.client;
  runtime.selectedId = selected.id;
  const view = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
  return { ...view, runtime };
}

const trigger = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-bot-tune] .tune-trigger");
const rows = (host: HTMLElement, level: string) => [...host.querySelectorAll<HTMLElement>(`[data-tune-column="${level}"] [role=option]`)];
const labels = (host: HTMLElement, level: string) => rows(host, level).map((row) => row.querySelector(".tune-row-label")?.textContent?.trim());
const row = (host: HTMLElement, level: string, label: string) => rows(host, level).find((el) => el.querySelector(".tune-row-label")?.textContent?.trim() === label) ?? null;
const patches = (runtime: ReturnType<typeof fakeRuntime>) => runtime.calls.filter((c) => c.name === "patchBot").map((c) => c.args);

test("a direct's tool row has the Bot's model after attach; a group, a Bot↔Bot direct and the file conversation have none", () => {
  const { host, close } = open();
  const order = [...host.querySelector(".composer-row")!.children].filter((el) => el.tagName !== "INPUT").map((el) => el.classList[0]);
  expect(order.slice(0, 3)).toEqual(["attach-btn", "composer-tune", "composer-editor-wrap"]);
  expect(host.querySelector(".composer-row")!.classList.contains("has-tune")).toBe(true);
  close();

  for (const selected of [aGroup(), aBotDirect(), aDirect({ id: FILE_DROP_SESSION_ID })]) {
    const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" }), aBot({ id: "bot-2", name: "Writer" })], sessions: [selected], providers: endpoints }));
    runtime.selectedId = selected.id;
    const other = render(Composer, { runtime, t, selected, onSend: async () => true, onPickPrompt: () => {} });
    expect(other.host.querySelector("[data-bot-tune]")).toBeNull();
    expect(other.host.querySelector(".composer-row")?.classList.contains("has-tune") ?? false).toBe(false);
    other.close();
  }
});

test("a Bot on the app's own loop goes endpoint, model, level; the pick pins all three in one change", () => {
  const { host, runtime, close } = open();
  expect(trigger(host)?.textContent).toContain(t.sidebar.botModelDefault);
  click(trigger(host));
  expect(labels(host, "endpoint")).toEqual([t.sidebar.botModelDefault, "Alpha", "Beta"]);
  expect(row(host, "endpoint", t.sidebar.botModelDefault)?.getAttribute("aria-selected")).toBe("true");
  expect(row(host, "endpoint", t.sidebar.botModelDefault)?.querySelector(".tune-more")).toBeNull();
  expect(row(host, "endpoint", "Beta")?.querySelector(".tune-more")).not.toBeNull();
  expect(host.querySelector('[data-tune-column="model"]')).toBeNull();

  click(row(host, "endpoint", "Beta"));
  expect(labels(host, "model")).toEqual(["m-b"]);
  click(row(host, "model", "m-b"));
  expect(labels(host, "thinking")).toEqual(["低", "高"]);
  // Pinned without a level, a model runs at the one the app would pick for it.
  expect(row(host, "thinking", "低")?.getAttribute("aria-selected")).toBe("true");
  click(row(host, "thinking", "高"));

  expect(patches(runtime)).toEqual([["bot-1", { model: "m-b", provider_id: "p2", thinking_level: "high" }]]);
  expect(host.querySelector("[data-tune-column]")).toBeNull();
  close();
});

test("a pinned Bot reads its model and level on the picker, and automatic takes all three off", () => {
  const { host, runtime, close } = open({ model: "grok-4.6", provider_id: "p1", thinking_level: "low" });
  const text = trigger(host)?.textContent ?? "";
  expect(text).toContain("grok-4.6");
  expect(text).toContain("低");
  // Two endpoints list models: which one it is on comes after, quieter.
  expect(text).toContain("Alpha");
  click(trigger(host));
  expect(row(host, "endpoint", "Alpha")?.getAttribute("aria-selected")).toBe("true");
  // It opens on the endpoints alone; the one it is on opens its models with the pin checked.
  expect(host.querySelector('[data-tune-column="model"]')).toBeNull();
  click(row(host, "endpoint", "Alpha"));
  expect(row(host, "model", "grok-4.6")?.getAttribute("aria-selected")).toBe("true");
  expect(row(host, "model", "gemini-3.8-flash")?.getAttribute("aria-selected")).toBe("false");
  click(row(host, "endpoint", t.sidebar.botModelDefault));
  expect(patches(runtime)).toEqual([["bot-1", { model: null, provider_id: null, thinking_level: null }]]);
  close();
});

test("a Bot on Claude Code picks its account, model and effort as a project session does, into the Bot's own fields", async () => {
  const client = {
    claudeCode: async () => ({ email: "me@a.com", accounts: [{ config_dir: null, email: "me@a.com" }, { config_dir: "/Users/a/.claude-b", email: "team@b.com" }] }),
    claudeCodeModels: async (dir: string | null) => ({ config_dir: dir, checked_at: "t", error: null, models: [
      { value: "default", display_name: "Default (recommended)", description: "Opus 5.5", resolved_model: "claude-opus-5-5", efforts: ["low", "high"] },
      { value: "haiku", display_name: "Haiku 5.5", description: "Fastest", resolved_model: "claude-haiku-5-5", efforts: [] },
    ] }),
  };
  const { host, runtime, close } = open({ runner: "claude_code", agent_model: "haiku", agent_effort: null, agent_config_dir: null }, { client });
  await settle();
  await settle();
  expect(trigger(host)?.textContent).toContain("Haiku 5.5");
  click(trigger(host));
  expect(labels(host, "account")).toEqual(["me@a.com", "team@b.com"]);
  click(row(host, "account", "team@b.com"));
  await settle();
  click(row(host, "model", "Default (recommended)"));
  expect(labels(host, "effort")).toEqual([t.project.effortDefault, "低", "高"]);
  click(row(host, "effort", "高"));
  expect(patches(runtime)).toEqual([["bot-1", { agent_config_dir: "/Users/a/.claude-b", agent_model: null, agent_effort: "high" }]]);
  close();
});

test("a Bot on another agent picks among what it lists, with the levels that agent takes", async () => {
  const grok: AgentStatus = {
    runner: "grok", custom_id: null, label: "Grok", path: "/usr/local/bin/grok", source: "path", version: "1", logged_in: true, auth: null,
    login_command: null, models: [{ id: "grok-5", name: "Grok 5", efforts: [] }], default_model: "grok-5", proxy: null, proxy_source: null, checked_at: "t", error: null,
  };
  const opencode: AgentStatus = { ...grok, runner: "opencode", label: "OpenCode", models: [{ id: "anthropic/sonnet", name: "anthropic/sonnet", efforts: [] }], default_model: null };
  const client = { agents: async () => ({ items: [grok, opencode], custom_agents: [] }) };

  const onGrok = open({ runner: "grok", agent_model: null, agent_effort: null }, { client });
  await settle();
  click(trigger(onGrok.host));
  expect(labels(onGrok.host, "model")).toEqual([t.project.modelDefault, "Grok 5"]);
  click(row(onGrok.host, "model", "Grok 5"));
  // Grok takes up to 极高, never 最大.
  expect(labels(onGrok.host, "effort")).toEqual([t.project.effortDefault, "低", "中", "高", "极高"]);
  click(row(onGrok.host, "effort", "中"));
  expect(patches(onGrok.runtime)).toEqual([["bot-1", { agent_model: "grok-5", agent_effort: "medium" }]]);
  onGrok.close();

  // OpenCode takes no level: a model is the pick.
  const onOpenCode = open({ runner: "opencode", agent_model: null, agent_effort: null }, { client });
  await settle();
  click(trigger(onOpenCode.host));
  expect(row(onOpenCode.host, "model", "anthropic/sonnet")?.querySelector(".tune-more")).toBeNull();
  click(row(onOpenCode.host, "model", "anthropic/sonnet"));
  expect(onOpenCode.host.querySelector('[data-tune-column="effort"]')).toBeNull();
  expect(patches(onOpenCode.runtime)).toEqual([["bot-1", { agent_model: "anthropic/sonnet" }]]);
  onOpenCode.close();
});

test("a pick the Mac refuses says so under the box, in that Bot's direct", async () => {
  const { host, close } = open({}, { stubs: { patchBot: async () => ({ status: 422, message: "model must be one of endpoint_models" }) } });
  click(trigger(host));
  click(row(host, "endpoint", "Beta"));
  click(row(host, "model", "m-b"));
  click(row(host, "thinking", "高"));
  await settle();
  expect(host.querySelector(".composer-refused")?.textContent).toBe(t.composer.tuneFailed);
  close();
});
