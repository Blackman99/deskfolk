/**
 * Roles as a page of its own (ADR 0083; the map itself is ADR 0082's): opened from Tools or from a
 * step on the flow, at the call it was asked for, reading the built-in prompts itself.
 */
import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aProvider, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import RolesPage from "./RolesPage.svelte";
import { closeMessageText, messageTextOpen } from "../chat/message-text-pages.ts";
import { noBuiltinModels } from "./builtin-models.ts";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const promptRow = (id: string, group: string, state: "default" | "edited" | "conflict" = "default") => ({
  id, group, title: { zh: `标题 ${id}`, en: `Title ${id}` }, summary: { zh: `说明 ${id}`, en: `About ${id}` },
  locales: [{ locale: "zh", state, last_actor: state === "default" ? null : "user", last_bot_id: null, updated_at: null, parse_failures: null }],
});
const callPrompts = () => [
  promptRow("turn.system", "turn"),
  { ...promptRow("call.organizer", "call", "edited"), role: "organizer" },
  { ...promptRow("call.read_user_line", "call"), role: "reader" },
  { ...promptRow("call.read_bot_line", "call"), role: "reader" },
];
const quietClient = (over: Record<string, unknown> = {}) => ({
  listPrompts: async () => callPrompts(),
  getPrompt: () => new Promise(() => {}),
  modelLadder: async () => ({ items: [], available: false }),
  claudeCode: async () => { throw new Error("404"); },
  agents: async () => { throw new Error("404"); },
  ...over,
});
const ladderClient = () => quietClient({
  modelLadder: async () => ({
    available: true,
    items: [
      { provider_id: "prov-1", model: "gemini-3.8-flash", available: true },
      { provider_id: "prov-1", model: "grok-4.6", available: true },
    ],
  }),
});

function open(over: { providers?: ReturnType<typeof aProvider>[]; client?: unknown; builtinModels?: unknown; host?: "pane" | "page"; onBack?: () => void } = {}) {
  const provider = over.providers?.[0] ?? aProvider({ models: ["gemini-3.8-flash", "grok-4.6"] });
  const runtime = fakeRuntime({
    providers: over.providers ?? [provider],
    settings: {
      endpoint_default_model: provider.default_model,
      default_provider_id: provider.id,
      builtin_models: (over.builtinModels ?? noBuiltinModels()) as never,
      locale: "zh",
      wizard_complete: true,
    } as never,
  });
  runtime.client = (over.client ?? quietClient()) as never;
  const view = render(RolesPage, { runtime, t, host: over.host ?? "pane", onBack: over.onBack ?? (() => {}) });
  return { ...view, runtime, provider };
}

const node = (host: HTMLElement, id: string) => host.querySelector<HTMLButtonElement>(`[data-routing-node="${id}"]`);

test("a map of the app's own calls, each with its model and its prompts beside it", async () => {
  const provider = aProvider();
  const { host, runtime, close } = open({
    providers: [provider],
    builtinModels: { ...noBuiltinModels(), scribe: { provider_id: provider.id, model: "grok-4.6" } },
  });
  await sleep(10);
  flushSync();
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
  node(host, "organizer")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  flushSync();
  expect(node(host, "judge")?.getAttribute("aria-pressed")).toBe("true");
  // A Bot's every turn has its prompts on Settings › Prompts, which the link opens.
  click(node(host, "turn"));
  expect(host.querySelector('[data-routing-detail="turn"]')?.textContent).toContain(t.routing.turn.hint);
  click(host.querySelector('[data-routing-link="prompts"]'));
  expect(runtime.calls.filter((call) => call.name === "openPromptSettings")).toEqual([{ name: "openPromptSettings", args: [null] }]);
  close();
});

test("the model ladder is set on a Bot's turn; the turn's node names its rungs", async () => {
  const { host, close } = open({ client: ladderClient() });
  click(node(host, "turn"));
  await sleep(0);
  flushSync();
  expect(node(host, "turn")?.textContent).toContain(t.routing.turn.ladder("gemini-3.8-flash → grok-4.6"));
  const part = host.querySelector('[data-routing-detail="turn"] [data-routing-part="ladder"]')!;
  expect([...part.querySelectorAll(".ladder-name")].map((el) => el.textContent)).toEqual(["gemini-3.8-flash", "grok-4.6"]);
  close();
  const off = open();
  click(node(off.host, "turn"));
  await sleep(0);
  flushSync();
  expect(off.host.querySelector('[data-routing-part="ladder"]')?.textContent).toContain(t.routing.turn.ladderOff);
  off.close();
});

test("set up on a local agent with no endpoint, each call's model is there to change; with neither, only its prompts", async () => {
  const choice = { runner: "codex", model: "gpt-5.6", config_dir: null };
  const { host, close } = open({ providers: [], builtinModels: { reader: choice, organizer: choice, scribe: choice, judge: choice, composer: choice, judgement: choice, reflection: choice, retrospective: choice, compaction: choice } });
  await sleep(0);
  flushSync();
  expect(node(host, "reader")?.textContent).toContain("gpt-5.6 · Codex");
  expect(host.querySelector('[data-routing-detail="reader"] [data-side-model="reader"]')).toBeTruthy();
  close();
  const none = open({ providers: [] });
  expect(none.host.querySelector("[data-side-model]")).toBeNull();
  expect(none.host.querySelector('[data-routing-part="model"]')?.textContent).toContain(t.routing.noEndpoint);
  none.close();
});

test("asked for a call — from a step on the flow, or a card about one of its prompts — it opens there", async () => {
  const runtime = fakeRuntime({ providers: [aProvider()] });
  runtime.client = quietClient() as never;
  runtime.rolesTarget = { role: "judgement" };
  const view = render(RolesPage, { runtime, t });
  flushSync();
  expect(node(view.host, "judgement")?.getAttribute("aria-pressed")).toBe("true");
  expect(runtime.rolesTarget).toBeNull();
  view.close();

  const carded = fakeRuntime({ providers: [aProvider()] });
  carded.client = quietClient({ listPrompts: () => new Promise((resolve) => setTimeout(() => resolve(callPrompts()), 20)) }) as never;
  carded.promptsTarget = { prompt: { id: "call.organizer", locale: "zh", revisionId: "rev-1" } } as never;
  const page = render(RolesPage, { runtime: carded, t });
  await sleep(60);
  flushSync();
  expect(carded.promptsTarget).toBeNull();
  expect(node(page.host, "organizer")?.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".prompt-editor-modal h2")?.textContent).toBe("标题 call.organizer");
  page.close();
});

test("as a page, Back steps out of a prompt, then a call, then the page", async () => {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 720px)", media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  let left = 0;
  const { host, close } = open({ host: "page", onBack: () => (left += 1) });
  try {
    await sleep(10);
    flushSync();
    const title = () => host.querySelector(".roles-page-title")?.textContent;
    expect(title()).toBe(t.routing.tab);
    expect(host.querySelector(".routing-map.is-vertical")).toBeTruthy();
    expect(host.querySelector("[data-routing-detail]")).toBeNull();
    click(node(host, "reader"));
    expect(title()).toBe(t.builtinModels.roles.reader.name);
    click(host.querySelector('[data-prompt="call.read_user_line"]'));
    await sleep(10);
    flushSync();
    expect(document.querySelector(".prompt-editor-modal")).toBeTruthy();
    click(host.querySelector(".roles-page-back"));
    await sleep(10);
    flushSync();
    expect(document.querySelector(".prompt-editor-modal")).toBeNull();
    expect(title()).toBe(t.builtinModels.roles.reader.name);
    click(host.querySelector(".roles-page-back"));
    expect(title()).toBe(t.routing.tab);
    expect(left).toBe(0);
    click(host.querySelector(".roles-page-back"));
    expect(left).toBe(1);
  } finally {
    close();
    window.matchMedia = previous;
  }
});

test("on a phone, the system's Back steps out of a call's page before it leaves the page", async () => {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 720px)", media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  let left = 0;
  const { host, close } = open({ host: "page", onBack: () => (left += 1) });
  try {
    await sleep(10);
    flushSync();
    // On the map, Back is the shell's: it leaves the page, which is in the URL.
    expect(messageTextOpen()).toBe(false);
    click(node(host, "reader"));
    expect(messageTextOpen()).toBe(true);
    expect(closeMessageText()).toBe(true);
    flushSync();
    expect(host.querySelector(".roles-page-title")?.textContent).toBe(t.routing.tab);
    expect(messageTextOpen()).toBe(false);
    expect(left).toBe(0);
  } finally {
    close();
    window.matchMedia = previous;
  }
});
