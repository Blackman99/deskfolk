import { afterEach, expect, test } from "bun:test";
import { AGENT_KINDS, BUILTIN_MODEL_ROLES, type AgentsStatusResponse, type BotRunner, type ClaudeCodeStatus, type Provider, type Settings, type SettingsPatch } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { emptySnapshot } from "../snapshot.ts";
import { click, fill, press, render } from "../test-render.ts";
import { settle } from "../test-async.ts";
import BuiltinModelsCard from "./BuiltinModelsCard.svelte";
import { noBuiltinModels } from "./builtin-models.ts";

const t = copyFor("zh");
const en = copyFor("en");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

const providers = [
  { id: "p1", name: "My CPA", models: ["grok-4.7-build-fast", "gemini-3.8-flash-high"] },
  { id: "p2", name: "阿里百炼", models: ["deepseek-v4.1-flash"] },
] as unknown as Provider[];

function fakePatch(opts: { fail?: boolean } = {}) {
  const sent: SettingsPatch[] = [];
  return { sent, patch: async (patch: SettingsPatch) => { sent.push(patch); return opts.fail ? { code: "conflict" } : null; } };
}

/** Settings from a daemon that reports every call; `chosen` are the ones set apart. */
const settingsOf = (chosen: Partial<NonNullable<Settings["builtin_models"]>> = {}): Settings => ({
  ...emptySnapshot().settings,
  builtin_models: { ...noBuiltinModels(), ...chosen },
});
/** Settings from a daemon older than ADR 0077: no `builtin_models`, the reading and organizing models in settings of their own. */
const legacySettings = (over: Partial<Settings> = {}): Settings => {
  const { builtin_models: _a, reader_model: _b, organizer_model: _c, ...rest } = emptySnapshot().settings;
  return { ...rest, ...over };
};

type Over = { settings?: Settings; patch?: (patch: SettingsPatch) => Promise<unknown | null>; claudeCode?: (() => Promise<ClaudeCodeStatus>) | null; agents?: (() => Promise<AgentsStatusResponse>) | null; defaultModel?: string | null };
const show = (over: Over = {}) =>
  render(BuiltinModelsCard, {
    providers,
    settings: over.settings ?? settingsOf(),
    defaultModel: over.defaultModel === undefined ? "grok-4.7-build-fast" : over.defaultModel,
    patch: over.patch ?? fakePatch().patch,
    claudeCode: over.claudeCode ?? null,
    agents: over.agents ?? null,
    t,
  });

const row = (host: HTMLElement, role: string) => host.querySelector<HTMLElement>(`[data-builtin-role="${role}"]`)!;
const trigger = (host: HTMLElement, role: string) => row(host, role).querySelector(".side-model-pick .real-select-trigger")!;
/** What a row or the closed picker reads: the model, then where it runs (an endpoint, or Claude Agent). */
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();
const claudeRow = (model: string) => `${model} ${t.claudeAgent.title}`;

/** The value a picker row carries: the model chosen, as JSON. */
const endpoint = (provider_id: string, model: string) => JSON.stringify({ provider_id, model });
const agent = (runner: string, model: string, custom_id?: string) => JSON.stringify({ runner, model, ...(custom_id ? { custom_id } : {}) });
const claude = (model: string) => agent("claude_code", model);

const rowLabel = (el: Element) => el.querySelector(".mp-row-label")?.textContent?.trim();
const rowFor = (host: HTMLElement, role: string, value: string) => [...row(host, role).querySelectorAll<HTMLElement>(".mp-row")].find((el) => el.dataset.value === value)!;
const sourceEl = (host: HTMLElement, role: string, sourceKey: string) => row(host, role).querySelector<HTMLElement>(`.mp-source[data-source-key="${sourceKey}"]`)!;
const sourceKeys = (host: HTMLElement, role: string) => [...row(host, role).querySelectorAll<HTMLElement>(".mp-source")].map((el) => el.dataset.sourceKey!);
const sourceNames = (host: HTMLElement, role: string) => [...row(host, role).querySelectorAll(".mp-source-label")].map((el) => el.textContent);
/** The rows that are not models, on top of the open picker. */
const specialsOf = (host: HTMLElement, role: string) => [...row(host, role).querySelectorAll(".mp-specials .mp-row")].map(rowLabel);

async function openPicker(host: HTMLElement, role: string): Promise<void> {
  click(trigger(host, role));
  await settle();
}
/** Points at one source of the open picker, as the pointer does, so its models are the rows. */
async function point(host: HTMLElement, role: string, sourceKey: string): Promise<void> {
  sourceEl(host, role, sourceKey).dispatchEvent(new MouseEvent("mouseenter"));
  await settle();
}
/** What the open picker offers, source by source: each one's name and the models it lists. */
async function offered(host: HTMLElement, role: string) {
  const found: Array<{ source: string; models: Array<string | undefined> }> = [];
  for (const sourceKey of sourceKeys(host, role)) {
    await point(host, role, sourceKey);
    found.push({ source: sourceEl(host, role, sourceKey).querySelector(".mp-source-label")!.textContent!, models: [...row(host, role).querySelectorAll(".mp-columns .mp-row")].map(rowLabel) });
  }
  return found;
}
/** Opens a row's picker and picks the row with this value, from the source it is under (none: one of the rows that are not models). */
async function pick(host: HTMLElement, role: string, value: string, sourceKey?: string): Promise<void> {
  await openPicker(host, role);
  if (sourceKey) await point(host, role, sourceKey);
  click(rowFor(host, role, value));
  await settle();
}

test("the groups come in order, each with its own calls under their names", () => {
  const { host, close } = show();
  expect([...host.querySelectorAll("[data-builtin-group]")].map((el) => el.getAttribute("data-builtin-group"))).toEqual(["reading", "organizing", "composing", "asBot"]);
  const groups = (["reading", "organizing", "composing", "asBot"] as const).map((key) => {
    const group = host.querySelector(`[data-builtin-group="${key}"]`)!;
    return {
      title: group.querySelector(".builtin-group-title")?.textContent,
      roles: [...group.querySelectorAll("[data-builtin-role]")].map((el) => el.getAttribute("data-builtin-role")),
    };
  });
  expect(groups).toEqual([
    { title: "读你的话", roles: ["reader"] },
    { title: "整理与检查", roles: ["organizer", "scribe", "judge"] },
    { title: "输入", roles: ["composer"] },
    { title: "以 Bot 身份", roles: ["judgement", "reflection", "retrospective", "compaction"] },
  ]);
  // Every call is a row once, with its name and what it does, and one picker of its own.
  expect([...host.querySelectorAll("[data-builtin-role]")].map((el) => el.getAttribute("data-builtin-role"))).toEqual([...BUILTIN_MODEL_ROLES]);
  for (const role of BUILTIN_MODEL_ROLES) {
    expect(row(host, role).querySelector(".builtin-row-name")?.textContent).toBe(t.builtinModels.roles[role].name);
    expect(row(host, role).textContent).toContain(t.builtinModels.roles[role].hint);
    expect(row(host, role).querySelectorAll("[data-side-model]")).toHaveLength(1);
    expect(row(host, role).querySelector(`[data-side-model="${role}"]`)).toBeTruthy();
  }
  expect(host.querySelector('[data-builtin-group="asBot"]')?.textContent).toContain(t.builtinModels.groups.asBot.hint);
  expect(host.querySelector('[data-builtin-group="organizing"]')?.textContent).toContain(t.builtinModels.groups.organizing.hint);
  close();
});

test("a call left unset follows the default model, and a call made as a Bot follows that Bot's own", () => {
  const { host, close } = show();
  for (const role of ["reader", "organizer", "scribe", "judge", "composer"]) {
    expect(text(trigger(host, role))).toBe(t.builtinModels.followDefault("grok-4.7-build-fast"));
  }
  for (const role of ["judgement", "reflection", "retrospective", "compaction"]) {
    expect(text(trigger(host, role))).toBe(t.builtinModels.followBot);
  }
  close();
  const none = show({ defaultModel: null });
  expect(text(trigger(none.host, "composer"))).toBe(t.builtinModels.followDefault(null));
  none.close();
});

test("every listed model can be chosen for a call, and the choice is saved for that call only", async () => {
  const { sent, patch } = fakePatch();
  const { host, close } = show({ patch });
  await openPicker(host, "scribe");
  expect(specialsOf(host, "scribe")).toEqual([t.builtinModels.followDefault("grok-4.7-build-fast")]);
  expect(await offered(host, "scribe")).toEqual([
    { source: "My CPA", models: ["grok-4.7-build-fast", "gemini-3.8-flash-high"] },
    { source: "阿里百炼", models: ["deepseek-v4.1-flash"] },
  ]);
  click(rowFor(host, "scribe", endpoint("p2", "deepseek-v4.1-flash")));
  await settle();
  expect(sent).toEqual([{ builtin_models: { scribe: { provider_id: "p2", model: "deepseek-v4.1-flash" } } }]);
  // A call made as a Bot opens on the same models, its first row following the Bot instead.
  await openPicker(host, "retrospective");
  expect(specialsOf(host, "retrospective")).toEqual([t.builtinModels.followBot]);
  expect((await offered(host, "retrospective")).flatMap((found) => found.models)).toHaveLength(3);
  close();
});

test("a chosen model shows as chosen on its row only, and following the default again saves null", async () => {
  const { sent, patch } = fakePatch();
  const { host, close } = show({ patch, settings: settingsOf({ judge: { provider_id: "p2", model: "deepseek-v4.1-flash" } }) });
  expect(text(trigger(host, "judge"))).toBe("deepseek-v4.1-flash 阿里百炼");
  // Neither endpoint is a built-in one, so the closed picker marks the chosen model Custom.
  expect(trigger(host, "judge").querySelector("[data-model-source]")?.getAttribute("data-model-source")).toBe("custom");
  expect(text(trigger(host, "scribe"))).toBe(t.builtinModels.followDefault("grok-4.7-build-fast"));
  await openPicker(host, "judge");
  expect(row(host, "judge").querySelector(".mp-row.is-selected")?.getAttribute("data-value")).toBe(endpoint("p2", "deepseek-v4.1-flash"));
  click(rowFor(host, "judge", ""));
  await settle();
  expect(sent).toEqual([{ builtin_models: { judge: null } }]);
  close();
});

test("a model the endpoint no longer lists stays shown, as the one chosen", async () => {
  const { host, close } = show({ settings: settingsOf({ judge: { provider_id: "p1", model: "gone-model" } }) });
  expect(text(trigger(host, "judge"))).toBe("gone-model");
  await openPicker(host, "judge");
  expect(specialsOf(host, "judge")).toEqual([t.builtinModels.followDefault("grok-4.7-build-fast"), "gone-model"]);
  expect(row(host, "judge").querySelector(".mp-row.is-selected")?.getAttribute("data-value")).toBe(endpoint("p1", "gone-model"));
  close();
});

test("on a phone the picker is a sheet headed by the call's name, with the follow row on top and one level per source", async () => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width"), media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  const { sent, patch } = fakePatch();
  const { host, close } = show({ patch });
  await openPicker(host, "scribe");
  expect(row(host, "scribe").querySelector(".mp-sheet-title")?.textContent).toBe(t.builtinModels.roles.scribe.name);
  expect([...row(host, "scribe").querySelectorAll(".mp-row")].map(rowLabel)).toEqual([t.builtinModels.followDefault("grok-4.7-build-fast")]);
  click(row(host, "scribe").querySelector('.mp-sheet-nav[data-source-key="endpoint:p2"]'));
  await settle();
  click(rowFor(host, "scribe", endpoint("p2", "deepseek-v4.1-flash")));
  await settle();
  expect(sent).toEqual([{ builtin_models: { scribe: { provider_id: "p2", model: "deepseek-v4.1-flash" } } }]);
  close();
});

test("a choice that is not saved says so on its own row only", async () => {
  const { patch } = fakePatch({ fail: true });
  const { host, close } = show({ patch });
  await pick(host, "composer", endpoint("p1", "grok-4.7-build-fast"));
  expect(host.querySelectorAll(".side-model-error")).toHaveLength(1);
  expect(row(host, "composer").querySelector(".side-model-error")?.textContent).toBe(t.builtinModels.failed);
  expect(row(host, "scribe").querySelector(".side-model-error")).toBeNull();
  close();
});

const own = { logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "me@example.com" };
function claudeStatus(over: Partial<ClaudeCodeStatus> = {}): ClaudeCodeStatus {
  return {
    path: "/u/claude", source: "path", version: "2.1.294", sdk_version: "2.1.289", outdated: false, ...own, base_url_set: false,
    proxy: null, proxy_source: null, checked_at: "2026-10-08T00:00:00.000Z", error: null,
    accounts: [{ config_dir: null, config_directory: null, ...own, error: null, login_command: "claude auth login" }],
    ...over,
  };
}
const statusOf = (status: ClaudeCodeStatus | Error) => async () => {
  if (status instanceof Error) throw status;
  return status;
};

test("with Claude Code signed in, every call offers its models as a source of their own, haiku first, and choosing one saves it on the default account", async () => {
  const { sent, patch } = fakePatch();
  const { host, close } = show({ patch, claudeCode: statusOf(claudeStatus()) });
  await sleep(0);
  // Nothing about Claude's plan on rows that do not run on it.
  expect(host.querySelector("[data-side-model-claude-note]")).toBeNull();
  await openPicker(host, "scribe");
  expect(await offered(host, "scribe")).toEqual([
    { source: "My CPA", models: ["grok-4.7-build-fast", "gemini-3.8-flash-high"] },
    { source: "阿里百炼", models: ["deepseek-v4.1-flash"] },
    { source: t.claudeAgent.title, models: ["haiku", "sonnet", "opus", "fable"] },
  ]);
  const marks = sourceKeys(host, "scribe").map((key) => sourceEl(host, "scribe", key).querySelector("[data-model-source]")?.getAttribute("data-model-source") ?? null);
  expect(marks).toEqual(["custom", "custom", "claude-agent"]);
  click(rowFor(host, "scribe", claude("haiku")));
  await settle();
  expect(sent).toEqual([{ builtin_models: { scribe: { runner: "claude_code", model: "haiku", config_dir: null } } }]);
  // A call made as a Bot takes one too.
  await pick(host, "compaction", claude("sonnet"), "agent:claude_code");
  expect(sent.at(-1)).toEqual({ builtin_models: { compaction: { runner: "claude_code", model: "sonnet", config_dir: null } } });
  close();
  // A row that runs on a Claude model says what it spends, and only that row.
  const chosen = show({ claudeCode: statusOf(claudeStatus()), settings: settingsOf({ scribe: { runner: "claude_code", model: "opus", config_dir: null } }) });
  await sleep(0);
  expect(row(chosen.host, "scribe").querySelector("[data-side-model-claude-note]")?.textContent).toBe(t.builtinModels.claudeNote);
  expect(chosen.host.querySelectorAll("[data-side-model-claude-note]")).toHaveLength(1);
  chosen.close();
});

test("the Claude status is asked for once for the whole card, not once per row", async () => {
  let asked = 0;
  const claudeCode = async () => { asked += 1; return claudeStatus(); };
  const { host, close } = show({ claudeCode });
  await sleep(0);
  expect(asked).toBe(1);
  // Every row offers the Claude source from that one answer.
  for (const role of ["reader", "judge", "retrospective"]) {
    await openPicker(host, role);
    expect(sourceNames(host, role)).toEqual(["My CPA", "阿里百炼", t.claudeAgent.title]);
    click(trigger(host, role));
  }
  close();
  // Nothing is asked where the phone cannot ask.
  const phone = show({ claudeCode: null });
  await sleep(0);
  await openPicker(phone.host, "judge");
  expect(sourceNames(phone.host, "judge")).toEqual(["My CPA", "阿里百炼"]);
  phone.close();
  expect(asked).toBe(1);
});

test("no Claude source while Claude Code is missing, signed out, or cannot be asked, unless a Claude model is already chosen", async () => {
  for (const status of [claudeStatus({ path: null, accounts: [] }), claudeStatus({ logged_in: false, accounts: [{ config_dir: null, config_directory: null, ...own, logged_in: false, error: null, login_command: "claude auth login" }] }), new Error("404")]) {
    const { host, close } = show({ claudeCode: statusOf(status) });
    await sleep(0);
    await openPicker(host, "judge");
    expect(sourceNames(host, "judge")).toEqual(["My CPA", "阿里百炼"]);
    expect(host.querySelector("[data-side-model-claude-note]")).toBeNull();
    close();
  }
  // On the phone, which cannot ask: the model chosen on the Mac stays shown, and can be swapped for another.
  const phone = show({
    settings: settingsOf({ reflection: { runner: "claude_code", model: "haiku", config_dir: "/opt/claude-b" } }),
    claudeCode: statusOf(new Error("404")),
  });
  await sleep(0);
  expect(text(trigger(phone.host, "reflection"))).toBe(claudeRow("haiku"));
  expect(trigger(phone.host, "reflection").querySelector("[data-model-source]")?.getAttribute("data-model-source")).toBe("claude-agent");
  expect(row(phone.host, "reflection").querySelector("[data-side-model-account]")).toBeNull();
  phone.close();
});

test("with several accounts listed a row has an account select; changing it re-saves the chosen Claude model, and picking an endpoint model saves that", async () => {
  const { sent, patch } = fakePatch();
  const status = claudeStatus({
    accounts: [
      { config_dir: null, config_directory: null, ...own, error: null, login_command: "claude auth login" },
      { config_dir: "/opt/claude-b", config_directory: "/opt/claude-b", ...own, email: "b@example.com", error: null, login_command: "x" },
    ],
  });
  const { host, close } = show({ patch, claudeCode: statusOf(status), settings: settingsOf({ composer: { runner: "claude_code", model: "sonnet", config_dir: null } }) });
  await sleep(0);
  expect(text(trigger(host, "composer"))).toBe(claudeRow("sonnet"));
  const accountTrigger = (role: string) => row(host, role).querySelector("[data-side-model-account] .real-select-trigger")!;
  expect(accountTrigger("composer").textContent).toContain(t.sidebar.botAgentAccountDefault);
  click(accountTrigger("composer"));
  await sleep(0);
  const accounts = [...row(host, "composer").querySelectorAll("[data-side-model-account] .real-select-option")];
  expect(accounts).toHaveLength(2);
  click(accounts[1]!);
  await sleep(0);
  expect(sent).toEqual([{ builtin_models: { composer: { runner: "claude_code", model: "sonnet", config_dir: "/opt/claude-b" } } }]);
  // A row with no Claude model has no account to pick: a model chosen there goes on the computer's default account.
  expect(row(host, "scribe").querySelector("[data-side-model-account]")).toBeNull();
  await pick(host, "scribe", claude("haiku"), "agent:claude_code");
  expect(sent.at(-1)).toEqual({ builtin_models: { scribe: { runner: "claude_code", model: "haiku", config_dir: null } } });
  // Back to an endpoint's model.
  await pick(host, "composer", endpoint("p1", "grok-4.7-build-fast"), "endpoint:p1");
  expect(sent.at(-1)).toEqual({ builtin_models: { composer: { provider_id: "p1", model: "grok-4.7-build-fast" } } });
  close();
});

test("from an older daemon only the reading and organizing models are there, saved in the settings of their own", async () => {
  const { sent, patch } = fakePatch();
  const { host, close } = show({ patch, settings: legacySettings({ reader_model: null, organizer_model: { provider_id: "p1", model: "gemini-3.8-flash-high" } }) });
  expect([...host.querySelectorAll("[data-builtin-group]")].map((el) => el.getAttribute("data-builtin-group"))).toEqual(["reading", "organizing"]);
  expect([...host.querySelectorAll("[data-builtin-role]")].map((el) => el.getAttribute("data-builtin-role"))).toEqual(["reader", "organizer"]);
  expect(text(trigger(host, "organizer"))).toBe("gemini-3.8-flash-high My CPA");
  expect(text(trigger(host, "reader"))).toBe(t.builtinModels.followDefault("grok-4.7-build-fast"));
  await pick(host, "reader", endpoint("p2", "deepseek-v4.1-flash"), "endpoint:p2");
  expect(sent).toEqual([{ reader_model: { provider_id: "p2", model: "deepseek-v4.1-flash" } }]);
  await pick(host, "organizer", "");
  expect(sent.at(-1)).toEqual({ organizer_model: null });
  await pick(host, "organizer", endpoint("p1", "gemini-3.8-flash-high"));
  expect(sent.at(-1)).toEqual({ organizer_model: { provider_id: "p1", model: "gemini-3.8-flash-high" } });
  close();
  // Only one of the two settings: only that call.
  const reading = show({ settings: legacySettings({ reader_model: null }) });
  expect([...reading.host.querySelectorAll("[data-builtin-role]")].map((el) => el.getAttribute("data-builtin-role"))).toEqual(["reader"]);
  expect(reading.host.querySelector('[data-builtin-group="organizing"]')).toBeNull();
  reading.close();
});

test("from an older daemon a Claude model is offered for reading and not for the organizer", async () => {
  const { sent, patch } = fakePatch();
  const { host, close } = show({ patch, settings: legacySettings({ reader_model: null, organizer_model: null }), claudeCode: statusOf(claudeStatus()) });
  await sleep(0);
  await openPicker(host, "organizer");
  expect(sourceNames(host, "organizer")).toEqual(["My CPA", "阿里百炼"]);
  expect((await offered(host, "organizer")).flatMap((found) => found.models)).toHaveLength(3);
  await openPicker(host, "reader");
  expect(sourceNames(host, "reader")).toEqual(["My CPA", "阿里百炼", t.claudeAgent.title]);
  await point(host, "reader", "agent:claude_code");
  click(rowFor(host, "reader", claude("haiku")));
  await settle();
  expect(sent).toEqual([{ reader_model: { runner: "claude_code", model: "haiku", config_dir: null } }]);
  close();
});

test("the copy names the section in both languages, and says what the groups and the calls are for", () => {
  expect(t.builtinModels.title).toBe("内置模型");
  expect(en.builtinModels.title).toBe("Built-in models");
  expect(t.builtinModels.groups.organizing.hint).toContain("输入 20k、输出 6k token");
  expect(en.builtinModels.groups.organizing.hint).toContain("20k tokens in and 6k out");
  expect(t.builtinModels.roles.organizer.name).toBe("整理器");
  expect(en.builtinModels.roles.organizer.name).toBe("Organizer");
  expect(en.builtinModels.followDefault("m")).toBe("Follow the default model (m)");
  expect(en.builtinModels.followBot).toBe("Follow the Bot's own model");
  expect(t.builtinModels.chosenSummary(2)).toBe("单独设了 2 项");
  expect(en.builtinModels.chosenSummary(1)).toBe("1 set apart");
  expect(en.builtinModels.chosenSummary(3)).toBe("3 set apart");
  // Every call has a name and a hint in both languages.
  for (const role of BUILTIN_MODEL_ROLES) {
    for (const copy of [t, en]) {
      expect(copy.builtinModels.roles[role].name.length).toBeGreaterThan(0);
      expect(copy.builtinModels.roles[role].hint.length).toBeGreaterThan(0);
    }
  }
});

/** One of your other local agents as the daemon reports it (ADR 0079). */
function agentStatus(runner: BotRunner, over: Record<string, unknown> = {}) {
  return {
    runner, custom_id: null, label: AGENT_KINDS[runner].label, path: `/usr/local/bin/${runner}`, source: "path", version: "1", logged_in: true, auth: null,
    login_command: null, models: [], default_model: null, proxy: null, proxy_source: null, checked_at: "2026-10-10T00:00:00.000Z", error: null, ...over,
  };
}
const listed = (...ids: string[]) => ids.map((id) => ({ id, name: id, efforts: [] }));
const agentsOf = (...items: ReturnType<typeof agentStatus>[]) => async () => ({ items, custom_agents: [] }) as unknown as AgentsStatusResponse;
const marksOf = (host: HTMLElement, role: string) => sourceKeys(host, role).map((key) => sourceEl(host, role, key).querySelector("[data-model-source]")?.getAttribute("data-model-source") ?? null);

test("with other local agents found and signed in, every call offers each one's models as a source of its own, and choosing one saves it with its runner", async () => {
  const { sent, patch } = fakePatch();
  const agents = agentsOf(
    agentStatus("codex", { models: listed("gpt-5.5", "gpt-5.5-mini") }),
    agentStatus("grok", { path: null, models: listed("grok-4.7") }),
    agentStatus("antigravity", { logged_in: false, models: listed("gemini-3.8-flash-high") }),
    agentStatus("custom", { custom_id: "acp-1", label: "我的 ACP", models: listed("fast") }),
  );
  const { host, close } = show({ patch, agents, claudeCode: statusOf(claudeStatus()) });
  await sleep(0);
  await openPicker(host, "scribe");
  // Claude's source first, then the others in the daemon's order; not found or signed out, none.
  expect(await offered(host, "scribe")).toEqual([
    { source: "My CPA", models: ["grok-4.7-build-fast", "gemini-3.8-flash-high"] },
    { source: "阿里百炼", models: ["deepseek-v4.1-flash"] },
    { source: t.claudeAgent.title, models: ["haiku", "sonnet", "opus", "fable"] },
    { source: "Codex", models: ["gpt-5.5", "gpt-5.5-mini"] },
    { source: "我的 ACP", models: ["fast"] },
  ]);
  expect(marksOf(host, "scribe")).toEqual(["custom", "custom", "claude-agent", "agent", "agent"]);
  // The agent's logo, never a text chip.
  expect(sourceEl(host, "scribe", "agent:codex").querySelector('[data-agent-logo="codex"]')).not.toBeNull();
  expect(sourceEl(host, "scribe", "agent:codex").querySelector(".model-source-custom")).toBeNull();
  await point(host, "scribe", "agent:codex");
  click(rowFor(host, "scribe", agent("codex", "gpt-5.5-mini")));
  await settle();
  expect(sent).toEqual([{ builtin_models: { scribe: { runner: "codex", model: "gpt-5.5-mini", config_dir: null } } }]);
  // A call made as a Bot takes one too, and your own ACP agent's goes with its id.
  await pick(host, "compaction", agent("custom", "fast", "acp-1"), "agent:custom:acp-1");
  expect(sent.at(-1)).toEqual({ builtin_models: { compaction: { runner: "custom", model: "fast", config_dir: null, custom_id: "acp-1" } } });
  close();
});

test("an agent that lists no model takes one typed into the search, as the agent spells it", async () => {
  const { sent, patch } = fakePatch();
  const { host, close } = show({ patch, agents: agentsOf(agentStatus("zcode"), agentStatus("opencode", { default_model: "openai/gpt-5.5" })) });
  await sleep(0);
  await openPicker(host, "scribe");
  expect(await offered(host, "scribe")).toEqual([
    { source: "My CPA", models: ["grok-4.7-build-fast", "gemini-3.8-flash-high"] },
    { source: "阿里百炼", models: ["deepseek-v4.1-flash"] },
    { source: "ZCode", models: [] },
    // An agent that names a default model offers it.
    { source: "OpenCode", models: ["openai/gpt-5.5"] },
  ]);
  await point(host, "scribe", "agent:zcode");
  expect(sourceEl(host, "scribe", "agent:zcode").querySelector(".mp-source-note")?.textContent).toBe(t.modelPicker.typeShort);
  const search = row(host, "scribe").querySelector<HTMLInputElement>(".mp-search input")!;
  fill(search, "glm-5.3");
  press(search, "Enter");
  await settle();
  expect(sent).toEqual([{ builtin_models: { scribe: { runner: "zcode", model: "glm-5.3", config_dir: null } } }]);
  close();
});

test("a row on another agent's model says whose plan it spends, and its account is picked there when the agent has several", async () => {
  const { sent, patch } = fakePatch();
  const accounts = [
    { config_dir: null, logged_in: true, auth: "ChatGPT Plus", error: null, login_command: "codex login" },
    { config_dir: "/opt/codex-b", logged_in: true, auth: "ChatGPT Pro", error: null, login_command: "x" },
  ];
  const agents = agentsOf(agentStatus("codex", { models: listed("gpt-5.5"), accounts }));
  const { host, close } = show({ patch, agents, claudeCode: statusOf(claudeStatus()), settings: settingsOf({ composer: { runner: "codex", model: "gpt-5.5", config_dir: null } }) });
  await sleep(0);
  expect(text(trigger(host, "composer"))).toBe("gpt-5.5 Codex");
  expect(trigger(host, "composer").querySelector('[data-agent-logo="codex"]')).not.toBeNull();
  expect(host.querySelectorAll("[data-side-model-agent-note]")).toHaveLength(1);
  expect(row(host, "composer").querySelector("[data-side-model-agent-note]")?.textContent).toBe(t.builtinModels.agentNote("Codex"));
  // It is not Claude's row: no Claude note, and Claude's models are not offered with Codex's one appended.
  expect(host.querySelector("[data-side-model-claude-note]")).toBeNull();
  await openPicker(host, "composer");
  const everything = (await offered(host, "composer")).flatMap((found) => found.models);
  expect(everything.filter((label) => label === "gpt-5.5")).toHaveLength(1);
  click(trigger(host, "composer"));
  const label = row(host, "composer").querySelector("[data-side-model-account] .side-model-account-label")?.textContent;
  expect(label).toBe(t.sidebar.botAgentAccountOf("Codex"));
  click(row(host, "composer").querySelector("[data-side-model-account] .real-select-trigger")!);
  await sleep(0);
  const options = [...row(host, "composer").querySelectorAll("[data-side-model-account] .real-select-option")];
  expect(options.map(text)).toEqual([`${t.sidebar.botAgentAccountDefault} · ChatGPT Plus`, "ChatGPT Pro · /opt/codex-b"]);
  click(options[1]!);
  await sleep(0);
  expect(sent).toEqual([{ builtin_models: { composer: { runner: "codex", model: "gpt-5.5", config_dir: "/opt/codex-b" } } }]);
  close();
});

test("the model chosen on an agent stays shown when the agent no longer lists it, is signed out, or cannot be asked", async () => {
  const listedAgent = show({
    agents: agentsOf(agentStatus("codex", { models: listed("gpt-5.5") })),
    settings: settingsOf({ composer: { runner: "codex", model: "gpt-old", config_dir: null } }),
  });
  await sleep(0);
  expect(text(trigger(listedAgent.host, "composer"))).toBe("gpt-old Codex");
  await openPicker(listedAgent.host, "composer");
  expect((await offered(listedAgent.host, "composer")).find((found) => found.source === "Codex")?.models).toEqual(["gpt-5.5", "gpt-old"]);
  listedAgent.close();
  const signedOut = show({
    agents: agentsOf(agentStatus("codex", { logged_in: false, models: listed("gpt-5.5") })),
    settings: settingsOf({ composer: { runner: "codex", model: "gpt-5.5", config_dir: null } }),
  });
  await sleep(0);
  expect(text(trigger(signedOut.host, "composer"))).toBe("gpt-5.5 Codex");
  await openPicker(signedOut.host, "composer");
  // Signed out, it offers no other model; the one chosen is all that is there.
  expect((await offered(signedOut.host, "composer")).find((found) => found.source === "Codex")?.models).toEqual(["gpt-5.5"]);
  signedOut.close();
});

test("the agents are asked once for the whole card; none is offered where they cannot be asked, and the one chosen on the Mac stays shown", async () => {
  let asked = 0;
  const agents = async () => { asked += 1; return { items: [agentStatus("codex", { models: listed("gpt-5.5") })], custom_agents: [] } as unknown as AgentsStatusResponse; };
  const { host, close } = show({ agents });
  await sleep(0);
  expect(asked).toBe(1);
  for (const role of ["reader", "judge", "retrospective"]) {
    await openPicker(host, role);
    expect(sourceNames(host, role)).toEqual(["My CPA", "阿里百炼", "Codex"]);
    click(trigger(host, role));
  }
  close();
  const phone = show({
    agents: async () => { throw new Error("404"); },
    settings: settingsOf({ reflection: { runner: "grok", model: "grok-4.7", config_dir: null } }),
  });
  await sleep(0);
  expect(text(trigger(phone.host, "reflection"))).toBe("grok-4.7 Grok");
  expect(trigger(phone.host, "reflection").querySelector('[data-agent-logo="grok"]')).not.toBeNull();
  expect(row(phone.host, "reflection").querySelector("[data-side-model-account]")).toBeNull();
  await openPicker(phone.host, "judge");
  expect(sourceNames(phone.host, "judge")).toEqual(["My CPA", "阿里百炼"]);
  phone.close();
});

test("from an older daemon an agent's model is offered for reading and not for the organizer", async () => {
  const { sent, patch } = fakePatch();
  const agents = agentsOf(agentStatus("codex", { models: listed("gpt-5.5") }));
  const { host, close } = show({ patch, settings: legacySettings({ reader_model: null, organizer_model: null }), agents });
  await sleep(0);
  await openPicker(host, "organizer");
  expect(sourceNames(host, "organizer")).toEqual(["My CPA", "阿里百炼"]);
  await openPicker(host, "reader");
  expect(sourceNames(host, "reader")).toEqual(["My CPA", "阿里百炼", "Codex"]);
  await point(host, "reader", "agent:codex");
  click(rowFor(host, "reader", agent("codex", "gpt-5.5")));
  await settle();
  expect(sent).toEqual([{ reader_model: { runner: "codex", model: "gpt-5.5", config_dir: null } }]);
  close();
});
