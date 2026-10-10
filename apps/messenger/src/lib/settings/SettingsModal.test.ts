import { flushSync } from "svelte";
import { expect, test } from "bun:test";
import type { SpeechSettings } from "@real-bot/protocol";
import { flushSync, mount, unmount } from "svelte";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { aProvider, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import { updateChecker } from "../update-checker.svelte.ts";
import { IDLE_INSTALL, type UpdateInstallState } from "../updates.ts";
import SettingsModal from "./SettingsModal.svelte";
import { noBuiltinModels } from "./builtin-models.ts";
import { settle } from "../test-async.ts";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(over: { providers?: ReturnType<typeof aProvider>[]; client?: unknown; promptsTarget?: unknown; speech?: SpeechSettings; workbench?: boolean; builtinModels?: unknown } = {}) {
  const provider = over.providers?.[0] ?? aProvider();
  const runtime = fakeRuntime({
    providers: over.providers ?? [provider],
    settings: {
      workspace_path: "/Users/you/real-bot-workspace",
      endpoint_base_url: provider.base_url,
      endpoint_key_set: true,
      endpoint_models: provider.models,
      endpoint_model_catalog: provider.model_catalog,
      endpoint_default_model: provider.default_model,
      default_provider_id: provider.id,
      builtin_models: (over.builtinModels ?? noBuiltinModels()) as never,
      launch_at_login: true,
      locale: "zh",
      theme: "system",
      wizard_complete: true,
      ...(over.speech ? { speech: over.speech } : {}),
    },
  });
  runtime.settingsOpen = true;
  if (over.client) runtime.client = over.client as never;
  if (over.promptsTarget) runtime.promptsTarget = over.promptsTarget as never;
  const view = render(SettingsModal, {
    runtime,
    t,
    saveFailed: false,
    providerEditor: null,
    confirmingProvider: false,
    patchImmediate: async () => true,
    openDeleteProviderConfirm: () => {},
    closeSettings: () => {},
    workbench: over.workbench ?? false,
  });
  return { ...view, runtime, provider };
}

test("where windows open is a Behavior tab of its own, there only while the desktop workbench is on", () => {
  const wide = open({ workbench: true });
  // Not in General.
  expect(wide.host.querySelector(".settings-card-open-placement")).toBeNull();
  const tab = wide.host.querySelector<HTMLButtonElement>('[data-settings-tab="behavior"]');
  expect(tab?.textContent?.trim()).toBe(t.settings.tabBehavior);
  // Right after General.
  expect([...wide.host.querySelectorAll("[data-settings-tab]")].slice(0, 2).map((el) => el.getAttribute("data-settings-tab"))).toEqual([
    "general",
    "behavior",
  ]);
  click(tab);
  expect(wide.host.querySelector(".settings-card-open-placement")?.textContent).toContain(t.openPlacement.title);
  expect(wide.host.querySelector(".settings-main-head")?.textContent).toContain(t.settings.tabBehavior);
  wide.close();
  // A narrow window or a phone has no panes to place anything in, so no tab for it.
  const narrow = open();
  expect(narrow.host.querySelector('[data-settings-tab="behavior"]')).toBeNull();
  expect(narrow.host.querySelector(".settings-card-open-placement")).toBeNull();
  narrow.close();
});

test("the settings dialog has no save button", () => {
  const { host, close } = open();
  expect(host.textContent).toContain(t.sidebar.autoSaveHint);
  expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain(t.settings.save);
  close();
});

function openModels(host: HTMLElement): void {
  click(host.querySelector<HTMLButtonElement>('[data-settings-tab="models"]'));
}

/** Models, then its endpoints: on a phone that is the first row of Models' own list. */
function openEndpoints(host: HTMLElement): void {
  openModels(host);
  click(host.querySelector<HTMLButtonElement>('[data-section="endpoints"]'));
}

/** A client whose engine level has a model ladder, holding two rungs. */
const ladderClient = () => ({
  listLessons: async () => [],
  listPrompts: async () => [],
  claudeCode: async () => { throw new Error("404"); },
  modelLadder: async () => ({
    items: [{ provider_id: "prov-1", model: "gemini-3.8-flash" }, { provider_id: "prov-1", model: "grok-4.6" }],
    available: true,
  }),
  setModelLadder: async (items: unknown) => ({ items, available: true }),
});

const sectionTabs = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>('.section-tabs [role="tab"]')].map((tab) => tab.dataset.section);

test("Models shows its endpoints, model ladder and speech recognition as tabs over one page", async () => {
  const { host, close } = open({ client: ladderClient() });
  openModels(host);
  await sleep(0);
  flushSync();
  expect(sectionTabs(host)).toEqual(["endpoints", "ladder", "speech"]);
  expect(host.querySelector('[data-section="endpoints"]')?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('[data-section="ladder"] .section-tab-count')?.textContent).toBe("2");
  expect(host.querySelector(".provider-card")).toBeTruthy();
  expect(host.querySelector("[data-model-ladder]")).toBeNull();
  expect(host.querySelector("[data-speech-settings]")).toBeNull();
  click(host.querySelector('[data-section="ladder"]'));
  expect(host.querySelector(".provider-card")).toBeNull();
  expect([...host.querySelectorAll(".ladder-name")].map((el) => el.textContent)).toEqual(["gemini-3.8-flash", "grok-4.6"]);
  expect(host.querySelector(".models-intro")?.textContent).toBe(t.modelLadder.hint);
  // Speech recognition is a section of its own, not a card under the endpoints.
  click(host.querySelector('[data-section="speech"]'));
  expect(host.querySelector('[data-section="speech"]')?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("[data-speech-settings]")).toBeTruthy();
  expect(host.querySelector(".models-intro")?.textContent).toBe(t.speech.hint);
  // A wide window has no inner page here: the head still names Models.
  expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.settings.tabModels);
  close();
});

test("before setup is done, its banner shows on Models too, inside the page under the tabs", () => {
  const runtime = fakeRuntime({ providers: [aProvider()], settings: { wizard_complete: false } });
  runtime.settingsOpen = true;
  const { host, close } = render(SettingsModal, {
    runtime, t, saveFailed: false, providerEditor: null, confirmingProvider: false,
    patchImmediate: async () => true, openDeleteProviderConfirm: () => {}, closeSettings: () => {},
  });
  openModels(host);
  expect(host.querySelectorAll(".wizard-banner")).toHaveLength(1);
  expect(host.querySelector(".models-scroll > .wizard-banner")).toBeTruthy();
  click(host.querySelector('[data-section="speech"]'));
  expect(host.querySelector(".models-scroll > .wizard-banner")).toBeTruthy();
  // Roles shows it once too, over its map.
  click(host.querySelector<HTMLButtonElement>('[data-settings-tab="routing"]'));
  expect(host.querySelectorAll(".wizard-banner")).toHaveLength(1);
  expect(host.querySelector(".routing-top > .wizard-banner")).toBeTruthy();
  // Prompts shows it once too, over its search and tabs.
  click(host.querySelector<HTMLButtonElement>('[data-settings-tab="prompts"]'));
  expect(host.querySelectorAll(".wizard-banner")).toHaveLength(1);
  expect(host.querySelector(".prompts-top > .wizard-banner")).toBeTruthy();
  close();
});

test("an engine level without a ladder has no ladder tab, and with no endpoint only speech recognition is beside the endpoints", async () => {
  const withEndpoint = open();
  openModels(withEndpoint.host);
  await sleep(0);
  flushSync();
  expect(sectionTabs(withEndpoint.host)).toEqual(["endpoints", "speech"]);
  withEndpoint.close();
  const empty = open({ providers: [] });
  openModels(empty.host);
  await sleep(0);
  flushSync();
  expect(sectionTabs(empty.host)).toEqual(["endpoints", "speech"]);
  expect(empty.host.textContent).toContain(t.settings.providerEmpty);
  empty.close();
});

function openRouting(host: HTMLElement): void {
  click(host.querySelector<HTMLButtonElement>('[data-settings-tab="routing"]'));
}
const node = (host: HTMLElement, id: string) => host.querySelector<HTMLButtonElement>(`[data-routing-node="${id}"]`);

test("set up on a local agent with no endpoint, each call's model is there to change on Roles; with neither, only its prompts", async () => {
  const choice = { runner: "codex", model: "gpt-5.6", config_dir: null };
  const { host, close } = open({ providers: [], builtinModels: { reader: choice, organizer: choice, scribe: choice, judge: choice, composer: choice, judgement: choice, reflection: choice, retrospective: choice, compaction: choice } });
  openRouting(host);
  await sleep(0);
  flushSync();
  expect(node(host, "reader")?.textContent).toContain("gpt-5.6 · Codex");
  expect(host.querySelector('[data-routing-detail="reader"] [data-side-model="reader"]')).toBeTruthy();
  close();
  const none = open({ providers: [] });
  openRouting(none.host);
  expect(none.host.querySelector("[data-side-model]")).toBeNull();
  expect(none.host.querySelector('[data-routing-part="model"]')?.textContent).toContain(t.routing.noEndpoint);
  none.close();
});

const callPrompts = () => [
  promptRow("turn.system", "turn"),
  { ...promptRow("call.organizer", "call", "edited"), role: "organizer" },
  { ...promptRow("call.read_user_line", "call"), role: "reader" },
  { ...promptRow("call.read_bot_line", "call"), role: "reader" },
];

test("Roles sits after Models: a map of the app's own calls, each with its model and its prompts under it", async () => {
  const provider = aProvider();
  const { host, close } = open({
    providers: [provider],
    builtinModels: { ...noBuiltinModels(), scribe: { provider_id: provider.id, model: "grok-4.6" } },
    client: { listLessons: async () => [], listPrompts: async () => callPrompts(), claudeCode: async () => { throw new Error("404"); }, modelLadder: async () => ({ items: [], available: false }), agents: async () => { throw new Error("404"); } },
  });
  await sleep(10);
  flushSync();
  const tabs = [...host.querySelectorAll<HTMLButtonElement>(".settings-tab-btn")].map((tab) => tab.getAttribute("data-settings-tab"));
  expect(tabs.indexOf("routing")).toBe(tabs.indexOf("models") + 1);
  // Two calls changed: the scribe's model and the organizer's prompt.
  expect(host.querySelector('[data-settings-tab="routing"] .tab-count')?.textContent).toBe("2");
  openRouting(host);
  expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.routing.tab);
  expect([...host.querySelectorAll("[data-routing-lane]")].map((el) => el.getAttribute("data-routing-lane"))).toEqual(["line", "group", "accepted", "overturned", "compose"]);
  expect(host.querySelectorAll("[data-routing-node]")).toHaveLength(10);
  expect(node(host, "scribe")?.textContent).toContain("grok-4.6");
  expect(node(host, "composer")?.textContent).toContain(t.routing.follows.default);
  expect(node(host, "compaction")?.textContent).toContain(t.routing.follows.bot);
  // Reading is picked first: its model and its two prompts.
  expect(node(host, "reader")?.getAttribute("aria-pressed")).toBe("true");
  expect([...host.querySelectorAll('[data-routing-detail="reader"] [data-prompt]')].map((el) => el.getAttribute("data-prompt"))).toEqual(["call.read_user_line", "call.read_bot_line"]);
  click(node(host, "organizer"));
  expect(host.querySelector('[data-routing-detail="organizer"] [data-side-model="organizer"]')).toBeTruthy();
  // The call sits beside the map: the map and the call each scroll on their own, and ↓ walks on to the next call.
  expect(host.querySelector(".routing-map-col [data-routing-map]")).toBeTruthy();
  expect(host.querySelector(".routing-detail-col [data-routing-detail]")).toBeTruthy();
  node(host, "organizer")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  flushSync();
  expect(node(host, "judge")?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('[data-routing-detail="judge"]')).toBeTruthy();
  node(host, "judge")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  flushSync();
  expect(host.querySelector('[data-routing-detail="organizer"] [data-prompt="call.organizer"] .prompts-chip')).toBeTruthy();
  // The Bot's own turn is set elsewhere, and says where.
  click(node(host, "turn"));
  expect(host.querySelector('[data-routing-detail="turn"]')?.textContent).toContain(t.routing.turn.hint);
  click(host.querySelector('[data-routing-link="prompts"]'));
  expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.settings.tabPrompts);
  // Prompts keeps only what no call owns, counts only that, and points to Roles for the rest.
  expect(host.querySelector('[data-prompt="call.organizer"]')).toBeNull();
  expect(host.querySelector('[data-prompt="turn.system"]')).toBeTruthy();
  expect(host.querySelector('[data-settings-tab="prompts"] .tab-count')).toBeNull();
  click(host.querySelector("[data-prompts-moved] button"));
  expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.routing.tab);
  close();
});

test("a card about one of the calls' prompts opens Roles at that call, with the prompt's history open", async () => {
  const client = {
    listPrompts: () => new Promise((resolve) => setTimeout(() => resolve(callPrompts()), 20)),
    listLessons: async () => [],
    getPrompt: () => new Promise(() => {}),
    modelLadder: async () => ({ items: [], available: false }),
    claudeCode: async () => { throw new Error("404"); },
    agents: async () => { throw new Error("404"); },
  };
  const { host, runtime, close } = open({ client, promptsTarget: { prompt: { id: "call.organizer", locale: "zh", revisionId: "rev-1" } } });
  await sleep(60);
  flushSync();
  expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.routing.tab);
  expect(runtime.promptsTarget).toBeNull();
  expect(node(host, "organizer")?.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".prompt-editor-modal h2")?.textContent).toBe("标题 call.organizer");
  expect(document.activeElement?.classList.contains("prompt-editor-backdrop")).toBe(true);
  close();
});

test("editing an endpoint name saves itself a moment later", async () => {
  const { host, runtime, close } = open();
  openModels(host);
  click(host.querySelector(".btn-provider-edit"));
  fill(host.querySelector("#provider-prov-1-name"), "CPA");
  expect(runtime.calls.filter((c) => c.name === "patchProvider")).toHaveLength(0);
  await sleep(750);
  const saves = runtime.calls.filter((c) => c.name === "patchProvider");
  expect(saves).toHaveLength(1);
  expect(saves[0]!.args).toEqual(["prov-1", { name: "CPA" }]);
  expect(host.querySelector(".provider-editor-modal .modal-foot")).toBeNull();
  close();
});

test("an incomplete add draft does not POST", async () => {
  const { host, runtime, close } = open({ providers: [] });
  openModels(host);
  click(buttonByText(host, t.settings.providerAdd));
  click([...host.querySelectorAll(".connector-pick")].find((tile) => tile.classList.contains("is-custom")));
  fill(host.querySelector("#provider-add-name"), "CPA");
  await sleep(750);
  expect(runtime.calls.filter((c) => c.name === "createProvider")).toHaveLength(0);
  close();
});

test("each endpoint picks its default from its enabled models in one picker", async () => {
  const { host, runtime, close } = open();
  openModels(host);
  const picker = host.querySelector<HTMLElement>(".provider-card .provider-default-select")!;
  expect(picker.querySelector(".real-select-value")?.textContent?.trim()).toBe("grok-4.6");
  click(picker.querySelector(".real-select-trigger"));
  await sleep(0);
  // One endpoint, one source: just its enabled models, in a popover with a search.
  const options = [...picker.querySelectorAll<HTMLElement>(".mp-row")];
  expect(options.map((row) => row.dataset.value)).toEqual(["grok-4.6", "gemini-3.8-flash"]);
  expect(picker.querySelector(".mp-search input")).not.toBeNull();
  click(options[1]);
  await sleep(20);
  expect(runtime.calls.filter((c) => c.name === "patchProvider")).toEqual([
    { name: "patchProvider", args: ["prov-1", { default_model: "gemini-3.8-flash" }] },
  ]);
  close();
});

test("the model list and the connection open as separate editors", () => {
  const { host, close } = open();
  openModels(host);
  click(host.querySelector(".provider-model-manage"));
  expect(host.querySelector(".provider-editor-modal h2")?.textContent).toContain(t.settings.providerModels);
  expect(host.querySelector("#provider-prov-1-name")).toBeNull();
  expect(host.querySelector(".provider-editor-modal .model-picker")).toBeTruthy();
  click(host.querySelector(".provider-editor-modal .modal-close"));
  click(host.querySelector(".btn-provider-edit"));
  expect(host.querySelector(".provider-editor-modal h2")?.textContent).toContain(t.settings.providerConnection);
  expect(host.querySelector("#provider-prov-1-name")).toBeTruthy();
  expect(host.querySelector(".provider-editor-modal .model-picker")).toBeNull();
  close();
});

test("closing the endpoint editor before the debounce still sends the edit", async () => {
  const { host, runtime, close } = open();
  openModels(host);
  click(host.querySelector(".btn-provider-edit"));
  fill(host.querySelector("#provider-prov-1-name"), "只打了一半");
  click(host.querySelector(".provider-editor-modal .modal-close"));
  await sleep(50);
  const saves = runtime.calls.filter((c) => c.name === "patchProvider");
  expect(saves).toHaveLength(1);
  expect((saves[0]!.args[1] as { name: string }).name).toBe("只打了一半");
  close();
});

test("leaving settings with the endpoint editor's debounce pending still sends the edit", async () => {
  const { host, runtime, close } = open();
  openModels(host);
  click(host.querySelector(".btn-provider-edit"));
  fill(host.querySelector("#provider-prov-1-name"), "只打了一半");
  close();
  await sleep(50);
  const saves = runtime.calls.filter((c) => c.name === "patchProvider");
  expect(saves).toHaveLength(1);
  expect((saves[0]!.args[1] as { name: string }).name).toBe("只打了一半");
});

test("an endpoint edit the server refuses says so in the editor's head", async () => {
  const { host, runtime, close } = open();
  (runtime as unknown as { patchProvider: unknown }).patchProvider = async () => ({ message: "boom" });
  openModels(host);
  click(host.querySelector(".btn-provider-edit"));
  fill(host.querySelector("#provider-prov-1-name"), "改名");
  await sleep(750);
  const label = host.querySelector(".provider-editor-modal .settings-save-state");
  expect(label?.textContent?.trim()).toBe(t.settings.saveFailed);
  expect(label?.classList.contains("is-error")).toBe(true);
  close();
});

test("Claude Agent has a category of its own, Agent, and is no longer under models", async () => {
  const { host, runtime, close } = open();
  const status = {
    path: "/Users/you/.local/bin/claude", source: "known", version: "2.1.289", sdk_version: "2.1.289", outdated: false,
    logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "you@example.com", base_url_set: false,
    proxy: null, proxy_source: null, checked_at: "2026-10-06T00:00:00.000Z", error: null,
  };
  runtime.client = { claudeCode: async () => status, detectClaudeCode: async () => status, setClaudeCodePath: async () => status } as never;
  openModels(host);
  expect(host.querySelector("[data-claude-agent]")).toBeNull();
  click(host.querySelector<HTMLButtonElement>('[data-settings-tab="agents"]'));
  await sleep(0);
  expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.settings.tabAgents);
  // A line that says how it is signed in; opened, its card with the account.
  expect(host.querySelector('[data-agent-row="claude_code"] .agent-row-summary')?.textContent).toContain("you@example.com");
  click(host.querySelector('[data-agent-row="claude_code"] .agent-row-head'));
  await sleep(0);
  expect(host.querySelector("[data-claude-agent] [data-claude-account]")?.textContent).toContain("you@example.com");
  close();
});

test("the Agent tab asks for the other local agents once it opens: a line for Claude and each agent found, your own ACP agents, the rest folded", async () => {
  const claude = {
    path: "/Users/you/.local/bin/claude", source: "known", version: "2.1.289", sdk_version: "2.1.289", outdated: false,
    logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "you@example.com", base_url_set: false,
    proxy: null, proxy_source: null, checked_at: "2026-10-06T00:00:00.000Z", error: null,
  };
  const codex = {
    runner: "codex", custom_id: null, label: "Codex", path: "/usr/local/bin/codex", source: "path", version: "0.130.0", logged_in: true, auth: "ChatGPT Plus",
    login_command: "codex login", models: [], default_model: null, proxy: null, proxy_source: null, checked_at: "2026-10-10T00:00:00.000Z", error: null, accounts: [],
  };
  const grok = { ...codex, runner: "grok", label: "Grok", path: null, source: null, version: null, logged_in: null, auth: null, login_command: null };
  let asked = 0;
  const { host, close } = open({
    client: {
      claudeCode: async () => claude, detectClaudeCode: async () => claude, setClaudeCodePath: async () => claude,
      agents: async () => { asked += 1; return { items: [codex, grok], custom_agents: [] }; },
      listPrompts: async () => [], listLessons: async () => [],
    },
  });
  expect(asked).toBe(0);
  click(host.querySelector<HTMLButtonElement>('[data-settings-tab="agents"]'));
  await sleep(0);
  expect(asked).toBe(1);
  const rows = [...host.querySelectorAll<HTMLElement>(".agents-list:not(.is-missing) > [data-agent-row]")].map((row) => row.dataset.agentRow);
  expect(rows).toEqual(["claude_code", "codex", "custom-agents"]);
  expect(host.querySelector("[data-agents-missing-toggle]")?.textContent?.trim()).toBe(t.agents.list.missingGroup(1));
  close();
});

test("built-in prompts have a tab of their own, before About, counting what you edited", async () => {
  const client = {
    listPrompts: async () => [
      { id: "turn.system", group: "turn", title: { zh: "系统指令", en: "System instructions" }, summary: { zh: "守则", en: "Rules" },
        locales: [{ locale: "zh", state: "edited", last_actor: "user", last_bot_id: null, updated_at: null, parse_failures: null }] },
    ],
    listLessons: async () => [],
  };
  const { host, close } = open({ client });
  await sleep(10);
  flushSync();
  const tabs = [...host.querySelectorAll<HTMLButtonElement>(".settings-tab-btn")].map((tab) => tab.getAttribute("data-settings-tab"));
  expect(tabs).toContain("prompts");
  expect(tabs.indexOf("prompts")).toBe(tabs.indexOf("mcp") + 1);
  expect(tabs.at(-1)).toBe("about");
  click(host.querySelector<HTMLButtonElement>('[data-settings-tab="prompts"]'));
  expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.settings.tabPrompts);
  expect(host.querySelector('[data-settings-tab="prompts"] .tab-count')?.textContent).toBe("1");
  expect(host.querySelector('[data-prompt="turn.system"]')).toBeTruthy();
  close();
});

test("asked from a card, settings open on the prompts tab and leave the prompt to it", async () => {
  const client = {
    // The list arrives a moment after settings open, as it does over the wire.
    listPrompts: () => new Promise((resolve) => setTimeout(() => resolve([
      { id: "turn.system", group: "turn", title: { zh: "系统指令", en: "System instructions" }, summary: { zh: "守则", en: "Rules" },
        locales: [{ locale: "zh", state: "edited", last_actor: "bot", last_bot_id: null, updated_at: null, parse_failures: null }] },
    ]), 20)),
    listLessons: async () => [],
    getPrompt: () => new Promise(() => {}),
  };
  const { host, runtime, close } = open({ client, promptsTarget: { prompt: { id: "turn.system", locale: "zh", revisionId: null } } });
  await sleep(60);
  flushSync();
  expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.settings.tabPrompts);
  expect(runtime.promptsTarget).toBeNull();
  expect(document.querySelector(".prompt-editor-modal h2")?.textContent).toBe("系统指令");
  // The list came in after settings opened; focus still reached the editor once it showed.
  expect(document.activeElement?.classList.contains("prompt-editor-backdrop")).toBe(true);
  close();
});

function openAbout(host: HTMLElement): void {
  const tabs = host.querySelectorAll<HTMLButtonElement>(".settings-tab-btn");
  click(tabs[tabs.length - 1]);
}

function withMobileViewport(run: () => void | Promise<void>): void | Promise<void> {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 720px)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const result = run();
    if (result) return result.finally(() => { window.matchMedia = previousMatchMedia; });
  } catch (error) {
    window.matchMedia = previousMatchMedia;
    throw error;
  }
  window.matchMedia = previousMatchMedia;
}

const promptRow = (id: string, group: string, state: "default" | "edited" | "conflict" = "default") => ({
  id, group, title: { zh: `标题 ${id}`, en: `Title ${id}` }, summary: { zh: `说明 ${id}`, en: `About ${id}` },
  locales: [{ locale: "zh", state, last_actor: state === "default" ? null : "user", last_bot_id: null, updated_at: null, parse_failures: null }],
});

test("on a phone, Prompts lists its groups with how many each holds, and Back walks out of a prompt one level at a time", async () => {
  await withMobileViewport(async () => {
    const runtime = fakeRuntime({ providers: [aProvider()] });
    runtime.settingsOpen = true;
    runtime.client = {
      listLessons: async () => [],
      listPrompts: async () => [
        promptRow("turn.system", "turn", "edited"), promptRow("turn.memory", "turn"),
        promptRow("call.scribe", "call", "conflict"), promptRow("tool.shell", "tool"),
      ],
      getPrompt: () => new Promise(() => {}),
    } as never;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = mount(SettingsModal, { target: host, props: {
      runtime, t, saveFailed: false, providerEditor: null,
      confirmingProvider: false, confirmingIndependent: false,
      patchImmediate: async () => true, openDeleteProviderConfirm: () => {},
      closeSettings: () => {},
    } });
    flushSync();
    try {
      const title = () => host.querySelector(".settings-main-title")?.textContent;
      click(host.querySelector<HTMLButtonElement>('[data-settings-tab="prompts"]'));
      await sleep(10);
      flushSync();
      expect(host.querySelector(".section-tabs")).toBeNull();
      const rows = [...host.querySelectorAll<HTMLButtonElement>(".section-list-row")];
      expect(rows.map((row) => row.dataset.section)).toEqual(["turn", "call", "tool"]);
      expect(rows.map((row) => row.querySelector(".section-list-summary")?.textContent)).toEqual([
        t.prompts.groupSummary(2, 1, false),
        t.prompts.groupSummary(1, 1, true),
        t.prompts.groupSummary(1, 0, false),
      ]);
      // The search is on the list of groups, over all of them.
      expect(host.querySelector(".prompts-search")).toBeTruthy();
      expect(host.querySelector("[data-prompt]")).toBeNull();
      click(rows[1]);
      expect(title()).toContain(t.prompts.groups.call);
      expect(host.querySelector(".section-list")).toBeNull();
      expect(host.querySelector(".prompts-search")).toBeNull();
      expect(host.querySelector('[data-prompt-group="call"] [data-prompt="call.scribe"]')).toBeTruthy();
      click(host.querySelector('[data-prompt="call.scribe"]'));
      await sleep(10);
      flushSync();
      expect(document.querySelector(".prompt-editor-modal")).toBeTruthy();
      // Back: out of the prompt to its group, then to the groups, then to Settings.
      expect(app.backWithinSettings()).toBe(true);
      await sleep(10);
      flushSync();
      expect(document.querySelector(".prompt-editor-modal")).toBeNull();
      expect(title()).toContain(t.prompts.groups.call);
      click(host.querySelector(".settings-mobile-back"));
      expect(title()).toContain(t.settings.tabPrompts);
      expect(host.querySelectorAll(".section-list-row")).toHaveLength(3);
      expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeTruthy();
      // A search shows what it finds straight away, by group, in place of the list of groups.
      fill(host.querySelector(".prompts-search"), "memory");
      expect(host.querySelector(".section-list")).toBeNull();
      expect([...host.querySelectorAll("[data-prompt]")].map((el) => el.getAttribute("data-prompt"))).toEqual(["turn.memory"]);
      fill(host.querySelector(".prompts-search"), "");
      expect(app.backWithinSettings()).toBe(true);
      flushSync();
      expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeNull();
    } finally {
      void unmount(app);
      flushSync();
      host.remove();
    }
  });
});

test("on a phone, Models lists its sections with what each is set to, and opens one a level deeper", async () => {
  await withMobileViewport(async () => {
    const provider = aProvider();
    const runtime = fakeRuntime({ providers: [provider], settings: { default_provider_id: provider.id } });
    runtime.settingsOpen = true;
    runtime.client = ladderClient() as never;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = mount(SettingsModal, { target: host, props: {
      runtime, t, saveFailed: false, providerEditor: null,
      confirmingProvider: false, confirmingIndependent: false,
      patchImmediate: async () => true, openDeleteProviderConfirm: () => {},
      closeSettings: () => {},
    } });
    flushSync();
    try {
      const title = () => host.querySelector(".settings-main-title")?.textContent;
      openModels(host);
      await sleep(0);
      flushSync();
      expect(host.querySelector(".section-tabs")).toBeNull();
      const rows = [...host.querySelectorAll<HTMLButtonElement>(".section-list-row")];
      expect(rows.map((row) => row.dataset.section)).toEqual(["endpoints", "ladder", "speech"]);
      expect(rows.map((row) => row.querySelector(".section-list-summary")?.textContent)).toEqual([
        t.settings.modelsEndpointsSummary(1, "Default"),
        "gemini-3.8-flash → grok-4.6",
        t.speech.unset,
      ]);
      expect(host.querySelector(".provider-card")).toBeNull();
      click(rows[1]);
      expect(title()).toContain(t.modelLadder.title);
      expect(host.querySelector(".section-list")).toBeNull();
      expect(host.querySelector("[data-model-ladder]")).toBeTruthy();
      // Back from a section goes to Models' list, then to the settings list.
      click(host.querySelector(".settings-mobile-back"));
      expect(title()).toContain(t.settings.tabModels);
      expect(host.querySelectorAll(".section-list-row")).toHaveLength(3);
      expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeTruthy();
      expect(app.backWithinSettings()).toBe(true);
      flushSync();
      expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeNull();
    } finally {
      void unmount(app);
      flushSync();
      host.remove();
    }
  });
});

test("on a phone, Roles is the map alone; a call opens as a page of its own, and Back walks out to the map, then settings", async () => {
  await withMobileViewport(async () => {
    const runtime = fakeRuntime({ providers: [aProvider()] });
    runtime.settingsOpen = true;
    runtime.client = { listLessons: async () => [], listPrompts: async () => callPrompts(), getPrompt: () => new Promise(() => {}), modelLadder: async () => ({ items: [], available: false }), claudeCode: async () => { throw new Error("404"); }, agents: async () => { throw new Error("404"); } } as never;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = mount(SettingsModal, { target: host, props: {
      runtime, t, saveFailed: false, providerEditor: null,
      confirmingProvider: false, confirmingIndependent: false,
      patchImmediate: async () => true, openDeleteProviderConfirm: () => {},
      closeSettings: () => {},
    } });
    flushSync();
    try {
      const title = () => host.querySelector(".settings-main-title")?.textContent;
      openRouting(host);
      await sleep(10);
      flushSync();
      expect(host.querySelector(".routing-map.is-vertical")).toBeTruthy();
      expect(host.querySelector("[data-routing-detail]")).toBeNull();
      click(node(host, "reader"));
      expect(title()).toContain(t.builtinModels.roles.reader.name);
      expect(host.querySelector("[data-routing-map]")).toBeNull();
      click(host.querySelector('[data-prompt="call.read_user_line"]'));
      await sleep(10);
      flushSync();
      expect(document.querySelector(".prompt-editor-modal")).toBeTruthy();
      // Back: out of the prompt, then the call, then Roles.
      expect(app.backWithinSettings()).toBe(true);
      await sleep(10);
      flushSync();
      expect(document.querySelector(".prompt-editor-modal")).toBeNull();
      expect(title()).toContain(t.builtinModels.roles.reader.name);
      click(host.querySelector(".settings-mobile-back"));
      expect(title()).toContain(t.routing.tab);
      expect(host.querySelector("[data-routing-map]")).toBeTruthy();
      expect(app.backWithinSettings()).toBe(true);
      flushSync();
      expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeNull();
    } finally {
      void unmount(app);
      flushSync();
      host.remove();
    }
  });
});

test("on a phone with no endpoint yet, Models lists the endpoints and speech recognition", () => {
  withMobileViewport(() => {
    const { host, close } = open({ providers: [] });
    openModels(host);
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".section-list-row")];
    expect(rows.map((row) => row.dataset.section)).toEqual(["endpoints", "speech"]);
    expect(rows.map((row) => row.querySelector(".section-list-summary")?.textContent)).toEqual([t.settings.providerEmpty, t.speech.unset]);
    click(rows[0]);
    expect(host.querySelector(".section-list")).toBeNull();
    expect(host.textContent).toContain(t.settings.providerEmpty);
    click(host.querySelector(".settings-mobile-back"));
    expect(host.querySelectorAll(".section-list-row")).toHaveLength(2);
    click(host.querySelector(".settings-mobile-back"));
    expect(host.querySelector(".settings-modal")?.classList.contains("is-mobile-detail")).toBe(false);
    close();
  });
});

test("on a phone, speech recognition's row names the service and model, or what it still needs", () => {
  withMobileViewport(() => {
    const groq: SpeechSettings = {
      enabled: true,
      preset: "groq",
      format: "openai",
      base_url: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      language: null,
      key_set: false,
    };
    const summary = (speech: SpeechSettings) => {
      const { host, close } = open({ speech });
      openModels(host);
      const text = host.querySelector('[data-section="speech"] .section-list-summary')?.textContent;
      close();
      return text;
    };
    expect(summary(groq)).toBe(t.speech.missingKey);
    expect(summary({ ...groq, key_set: true })).toBe("Groq · whisper-large-v3-turbo");
    expect(summary({ ...groq, key_set: true, enabled: false })).toBe(t.speech.offShort);
  });
});

test("mobile settings use a root list and drill into a detail screen", () => {
  withMobileViewport(() => {
    const { host, close } = open();
    const modal = host.querySelector(".settings-modal");
    expect(modal?.classList.contains("is-mobile-detail")).toBe(false);
    openModels(host);
    expect(modal?.classList.contains("is-mobile-detail")).toBe(true);
    expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.settings.tabModels);
    click(host.querySelector(".settings-mobile-back"));
    expect(modal?.classList.contains("is-mobile-detail")).toBe(false);
    close();
  });
});

test("mobile provider editing opens a full settings subpage with list and settings exits", () => {
  withMobileViewport(() => {
    const { host, close } = open();
    openEndpoints(host);
    click(host.querySelector(".btn-provider-edit"));
    const editor = host.querySelector(".provider-editor-modal");
    expect(editor?.classList.contains("settings-subpage")).toBe(true);
    expect(editor?.querySelector(".settings-subpage-back")).toBeTruthy();
    expect(editor?.querySelector(".settings-subpage-close")).toBeTruthy();
    click(editor?.querySelector(".settings-subpage-back"));
    expect(host.querySelector(".provider-editor-modal")).toBeNull();
    expect(host.querySelector(".settings-modal")?.classList.contains("is-mobile-detail")).toBe(true);
    close();
  });
});

test("mobile history back unwinds editors and categories before leaving settings", () => {
  withMobileViewport(() => {
    const runtime = fakeRuntime({ providers: [aProvider()] });
    runtime.settingsOpen = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    let closed = 0;
    const app = mount(SettingsModal, { target: host, props: {
      runtime, t, saveFailed: false, providerEditor: null,
      confirmingProvider: false, confirmingIndependent: false,
      patchImmediate: async () => true, openDeleteProviderConfirm: () => {},
      closeSettings: () => { closed++; },
    } });
    flushSync();
    try {
      const back = () => {
        const handled = app.backWithinSettings();
        flushSync();
        return handled;
      };
      expect(back()).toBe(false);
      for (const tab of host.querySelectorAll<HTMLButtonElement>(".settings-tab-btn")) {
        click(tab);
        expect(back()).toBe(true);
        expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeNull();
      }
      openEndpoints(host);
      click(host.querySelector(".btn-provider-edit"));
      expect(back()).toBe(true);
      expect(host.querySelector(".provider-editor-modal")).toBeNull();
      expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeTruthy();
      click(host.querySelector(".btn-provider-add"));
      expect(back()).toBe(true);
      // Out of the endpoints, to Models' list of sections.
      expect(back()).toBe(true);
      expect(host.querySelector(".section-list")).toBeTruthy();
      expect(back()).toBe(true);
      click(host.querySelector('[data-settings-tab="mcp"]'));
      click(host.querySelector(".btn-mcp-add"));
      expect(back()).toBe(true);
      expect(host.querySelector(".mcp-editor-modal")).toBeNull();
      expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeTruthy();
      expect(back()).toBe(true);
      expect(back()).toBe(false);
      expect(closed).toBe(0);
    } finally {
      void unmount(app);
      flushSync();
      host.remove();
    }
  });
});

type Invoked = { cmd: string; args?: Record<string, unknown> };

/** The About card only appears inside the window, so the test has to be one. */
function fakeWindow(
  handler: (cmd: string, args?: Record<string, unknown>) => unknown = () => undefined,
): { calls: Invoked[]; restore: () => void } {
  const calls: Invoked[] = [];
  const holder = globalThis as { __TAURI_INTERNALS__?: unknown };
  const previous = holder.__TAURI_INTERNALS__;
  holder.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return handler(cmd, args);
    },
  };
  return {
    calls,
    restore: () => {
      holder.__TAURI_INTERNALS__ = previous;
    },
  };
}

const OFFERED_DMG =
  "https://github.com/Blackman99/deskfolk/releases/download/v0.1.0-rc.5/Deskfolk_0.1.0-rc.5_aarch64.dmg";

function offerUpdate(over: Partial<UpdateInstallState> = {}, canInstall = true): void {
  updateChecker.status = "ok";
  updateChecker.version = "0.1.0-rc.4";
  updateChecker.ignoredVersion = null;
  updateChecker.canInstall = canInstall;
  updateChecker.install = { ...IDLE_INSTALL, ...over };
  updateChecker.result = {
    current: "0.1.0-rc.4",
    latest: "0.1.0-rc.5",
    updateAvailable: true,
    releaseUrl: "https://github.com/Blackman99/deskfolk/releases/tag/v0.1.0-rc.5",
    downloadUrl: OFFERED_DMG,
    publishedAt: null,
    notes: null,
  };
}

function forgetUpdate(): void {
  updateChecker.status = "idle";
  updateChecker.result = null;
  updateChecker.canInstall = false;
  updateChecker.install = IDLE_INSTALL;
}

test("the update button downloads and installs in place, not in the browser", async () => {
  const tauri = fakeWindow((cmd) =>
    cmd === "start_update_install" ? { ...IDLE_INSTALL, phase: "downloading", version: "0.1.0-rc.5" } : undefined,
  );
  offerUpdate();
  const { host, close } = open();
  openAbout(host);
  click(buttonByText(host, t.settings.updateInstall));
  await sleep(10);
  expect(tauri.calls).toContainEqual({
    cmd: "start_update_install",
    args: { url: OFFERED_DMG, version: "0.1.0-rc.5" },
  });
  expect(tauri.calls.some((call) => call.cmd === "open_external_url")).toBe(false);
  expect(updateChecker.install.phase).toBe("downloading");
  await updateChecker.cancelInstall();
  close();
  forgetUpdate();
  tauri.restore();
});

test("a running download draws how far along it is and can be cancelled", async () => {
  const tauri = fakeWindow(() => IDLE_INSTALL);
  offerUpdate({ phase: "downloading", downloaded: 45_088_768, total: 90_177_536, version: "0.1.0-rc.5" });
  const { host, close } = open();
  openAbout(host);
  const bar = host.querySelector<HTMLElement>(".about-progress-fill");
  expect(bar?.style.width).toBe("50%");
  expect(host.querySelector(".about-progress")?.getAttribute("aria-valuenow")).toBe("50");
  expect(host.textContent).toContain(t.settings.updateDownloading);
  expect(host.textContent).toContain("43.0 MB / 86.0 MB");
  // Nothing else to press while it runs — no second download, no browser.
  expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain(
    t.settings.updateInstall,
  );

  click(buttonByText(host, t.settings.updateInstallCancel));
  await sleep(10);
  expect(tauri.calls).toContainEqual({ cmd: "cancel_update_install", args: undefined });
  close();
  forgetUpdate();
  tauri.restore();
});

test("the swap phases fill the bar and stop offering a cancel", () => {
  const tauri = fakeWindow();
  offerUpdate({ phase: "installing", downloaded: 90_177_536, total: 90_177_536, version: "0.1.0-rc.5" });
  const { host, close } = open();
  openAbout(host);
  expect(host.querySelector<HTMLElement>(".about-progress-fill")?.style.width).toBe("100%");
  expect(host.textContent).toContain(t.settings.updateInstalling);
  expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain(
    t.settings.updateInstallCancel,
  );
  close();
  forgetUpdate();
  tauri.restore();
});

test("a failed install says why, keeps the detail, and still offers the browser", () => {
  const tauri = fakeWindow();
  offerUpdate({
    phase: "failed",
    version: "0.1.0-rc.5",
    error: "read-only",
    detail: "/Applications/Deskfolk.app is not writable",
  });
  const { host, close } = open();
  openAbout(host);
  expect(host.textContent).toContain(t.settings.updateInstallFailedReadOnly);
  expect(host.querySelector(".about-install-detail")?.textContent).toContain("not writable");
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(labels).toContain(t.settings.updateInstallRetry);
  expect(labels).toContain(t.settings.updateDownload);
  expect(host.querySelector(".about-progress")).toBeNull();
  close();
  forgetUpdate();
  tauri.restore();
});

test("a copy that cannot replace itself only offers the browser download", () => {
  const tauri = fakeWindow();
  offerUpdate({}, false);
  const { host, close } = open();
  openAbout(host);
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(labels).not.toContain(t.settings.updateInstall);
  expect(labels).toContain(t.settings.updateDownload);
  expect(host.textContent).not.toContain(t.settings.updateInstallHint);
  close();
  forgetUpdate();
  tauri.restore();
});


test("the phone default picker sends only the chosen model", async () => {
  await withMobileViewport(async () => {
    const provider = aProvider();
    const runtime = reactive(fakeRuntime({
      providers: [provider],
      settings: {
        workspace_path: "/Users/you/real-bot-workspace",
        endpoint_base_url: provider.base_url,
        endpoint_key_set: true,
        endpoint_models: provider.models,
        endpoint_model_catalog: provider.model_catalog,
        endpoint_default_model: provider.default_model,
        default_provider_id: provider.id,
        launch_at_login: true,
        locale: "zh",
        theme: "system",
        wizard_complete: true,
      },
    }));
    runtime.settingsOpen = true;
    const { host, close } = render(SettingsModal, {
      runtime,
      t,
      saveFailed: false,
      providerEditor: null,
      confirmingProvider: false,
      patchImmediate: async () => true,
      openDeleteProviderConfirm: () => {},
      closeSettings: () => {},
    });
    openEndpoints(host);
    // The phone's picker is a sheet from the bottom, opened straight on the endpoint's models.
    click(host.querySelector("#default-model-prov-1"));
    await settle();
    expect(host.querySelector(".mp-sheet")).not.toBeNull();
    expect([...host.querySelectorAll(".mp-sheet .mp-row")].map((row) => (row as HTMLElement).dataset.value)).toEqual(["grok-4.6", "gemini-3.8-flash"]);
    click(host.querySelector('.mp-sheet .mp-row[data-value="gemini-3.8-flash"]'));
    await settle();
    expect(runtime.calls.filter((call) => call.name === "patchProvider")).toEqual([
      { name: "patchProvider", args: ["prov-1", { default_model: "gemini-3.8-flash" }] },
    ]);
    close();
  });
});

test("leaving the model list flushes a cleared default before the page closes", async () => {
  await withMobileViewport(async () => {
    const provider = aProvider();
    const runtime = reactive(fakeRuntime({ providers: [provider] }));
    runtime.settingsOpen = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = mount(SettingsModal, {
      target: host,
      props: {
        runtime, t, saveFailed: false, providerEditor: null,
        confirmingProvider: false, confirmingIndependent: false,
        patchImmediate: async () => true, openDeleteProviderConfirm: () => {},
        closeSettings: () => {},
      },
    });
    flushSync();
    try {
      openEndpoints(host);
      click(host.querySelector(".provider-model-manage"));
      click(host.querySelector('.model-row-toggle[aria-label="grok-4.6"]'));
      const back = () => {
        const handled = app.backWithinSettings();
        flushSync();
        return handled;
      };
      expect(back()).toBe(true);
      await settle();
      expect(host.querySelector(".provider-editor-modal")).toBeNull();
      const saves = runtime.calls.filter((call) => call.name === "patchProvider");
      expect(saves.at(-1)?.args[1]).toMatchObject({ default_model: "" });
      expect(saves.at(-1)?.args[1]).not.toHaveProperty("name");
    } finally {
      void unmount(app);
      flushSync();
      host.remove();
    }
  });
});

test("phone back walks attributes, the model list, the endpoints, model services, then settings", () => {
  withMobileViewport(() => {
    const runtime = fakeRuntime({ providers: [aProvider()] });
    runtime.settingsOpen = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    let closed = 0;
    const app = mount(SettingsModal, {
      target: host,
      props: {
        runtime, t, saveFailed: false, providerEditor: null,
        confirmingProvider: false, confirmingIndependent: false,
        patchImmediate: async () => true, openDeleteProviderConfirm: () => {},
        closeSettings: () => { closed++; },
      },
    });
    flushSync();
    try {
      const back = () => {
        const handled = app.backWithinSettings();
        flushSync();
        return handled;
      };
      openEndpoints(host);
      click(host.querySelector(".provider-model-manage"));
      click(host.querySelector(".model-row-attrs"));
      expect(host.querySelector(".provider-editor-modal h2")?.textContent).toContain(t.settings.modelSettings);
      expect(back()).toBe(true);
      expect(host.querySelector(".model-attributes-page")).toBeNull();
      expect(host.querySelector(".provider-editor-modal .model-picker")).toBeTruthy();
      expect(back()).toBe(true);
      expect(host.querySelector(".provider-editor-modal")).toBeNull();
      expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.settings.modelsSectionEndpoints);
      expect(back()).toBe(true);
      expect(host.querySelector(".settings-main-title")?.textContent).toContain(t.settings.tabModels);
      expect(back()).toBe(true);
      expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeNull();
      expect(closed).toBe(0);
      expect(back()).toBe(false);
    } finally {
      void unmount(app);
      flushSync();
      host.remove();
    }
  });
});

test("the default picker waits for a closing list save to finish", async () => {
  await withMobileViewport(async () => {
    let finish!: () => void;
    const runtime = reactive(fakeRuntime({ providers: [aProvider()] }, {
      patchProvider: () => new Promise<null>((resolve) => { finish = () => resolve(null); }),
    }));
    runtime.settingsOpen = true;
    const { host, close } = render(SettingsModal, {
      runtime, t, saveFailed: false, providerEditor: null, confirmingProvider: false,
      patchImmediate: async () => true, openDeleteProviderConfirm: () => {}, closeSettings: () => {},
    });
    try {
      openEndpoints(host);
      click(host.querySelector(".provider-model-manage"));
      click(host.querySelector('.model-row-toggle[aria-label="claude-opus-5"]'));
      click(host.querySelector(".settings-subpage-back"));
      expect(host.querySelector<HTMLButtonElement>(".provider-default-select .real-select-trigger")?.disabled).toBe(true);
      finish();
      await settle();
      expect(host.querySelector<HTMLButtonElement>(".provider-default-select .real-select-trigger")?.disabled).toBe(false);
    } finally {
      close();
    }
  });
});

test("a failed model-list save can be sent again", async () => {
  await withMobileViewport(async () => {
    let fail = true;
    let attempts = 0;
    const provider = aProvider();
    const runtime = reactive(fakeRuntime({ providers: [provider] }, {
      patchProvider: async () => {
        attempts++;
        return fail ? new ApiError(409, "conflict", "try again") : null;
      },
    }));
    runtime.settingsOpen = true;
    const { host, close } = render(SettingsModal, {
      runtime,
      t,
      saveFailed: false,
      providerEditor: null,
      confirmingProvider: false,
      patchImmediate: async () => true,
      openDeleteProviderConfirm: () => {},
      closeSettings: () => {},
    });
    openEndpoints(host);
    click(host.querySelector(".provider-model-manage"));
    click(host.querySelector('.model-row-toggle[aria-label="claude-opus-5"]'));
    await sleep(650);
    await settle();
    const retry = host.querySelector<HTMLButtonElement>(".provider-mobile-status button");
    expect(retry?.textContent).toContain(t.settings.retry);
    expect(host.querySelector(".provider-mobile-status")?.classList.contains("is-error")).toBe(true);
    fail = false;
    click(retry);
    await settle();
    expect(host.querySelector(".provider-mobile-status button")).toBeNull();
    expect(attempts).toBe(2);
    close();
  });
});

test("✕ closes the page it sits on, not the settings behind it", () => {
  withMobileViewport(() => {
    const { host, close } = open();
    openEndpoints(host);
    const modal = host.querySelector(".settings-modal");
    // Inside the endpoint editor: ✕ leaves the editor, the endpoints stay.
    click(host.querySelector(".btn-provider-edit"));
    click(host.querySelector(".settings-subpage-close"));
    expect(host.querySelector(".provider-editor-modal")).toBeNull();
    expect(modal?.classList.contains("is-mobile-detail")).toBe(true);
    // On the endpoints: ✕ goes back to Models' list of sections.
    click(host.querySelector(".settings-main-head > .modal-close"));
    expect(host.querySelector(".section-list")).toBeTruthy();
    expect(modal?.classList.contains("is-mobile-detail")).toBe(true);
    // On that list: ✕ goes back to the list of settings.
    click(host.querySelector(".settings-main-head > .modal-close"));
    expect(modal?.classList.contains("is-mobile-detail")).toBe(false);
    expect(host.querySelector(".settings-modal")).not.toBeNull();
    close();
  });
});
