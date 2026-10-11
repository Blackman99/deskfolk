/**
 * Roles as a page of its own (ADR 0083; the map itself is ADR 0082's), drawing an engine (ADR 0085):
 * opened from Tools or by a card about a call's prompt, at the call it was asked for, reading the
 * built-in prompts and the engines itself.
 */
import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import {
  builtinPlaybook,
  compactPlaybookDiff,
  emptyPlaybookDiff,
  resolvePlaybook,
  type BuiltinPlaybookId,
  type Playbook,
  type PlaybookDiff,
  type PlaybookList,
} from "@real-bot/protocol";
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

/** The three engines as the daemon lists them, changed as `diffs` say. */
function engines(diffs: Partial<Record<BuiltinPlaybookId, PlaybookDiff>> = {}, defaultId = "general"): PlaybookList {
  const item = (id: BuiltinPlaybookId): Playbook => {
    const diff = diffs[id] ?? emptyPlaybookDiff();
    const changed = Object.keys(diff.steps).length > 0;
    return { id, builtin: true, base_id: id, name: null, revision: changed ? 1 : 0, revision_id: changed ? `rev-${id}` : null, diff, resolved: resolvePlaybook(id, diff), updated_at: null };
  };
  return { default_id: defaultId, items: [item("general"), item("video"), item("coding")] };
}

/** A daemon that keeps the engines' differences as the window sends them. */
function engineServer(start: PlaybookList = engines()) {
  let list = start;
  const saved: Array<{ id: string; diff: PlaybookDiff; ifRevision: string | null }> = [];
  return {
    saved,
    api: {
      listPlaybooks: async () => list,
      savePlaybook: async (id: string, diff: PlaybookDiff, ifRevision: string | null) => {
        saved.push({ id, diff, ifRevision });
        list = { ...list, items: list.items.map((item) => item.id !== id ? item : {
          ...item, diff: compactPlaybookDiff(item.base_id, diff), resolved: resolvePlaybook(item.base_id, diff), revision: item.revision + 1, revision_id: `rev-${item.revision + 1}`,
        }) };
        return list.items.find((item) => item.id === id)!;
      },
      createPlaybook: async (from: string, name: string) => {
        const base = list.items.find((item) => item.id === from)!;
        const made: Playbook = { ...base, id: "01MINE00000000000000000000", builtin: false, name, revision: 1, revision_id: "rev-mine" };
        list = { ...list, items: [...list.items, made] };
        return made;
      },
      playbookRevisions: async () => [{ id: "r1", playbook_id: "video", revision: 1, op: "edit" as const, actor: "user", bot_id: null, turn_id: null, approval_id: null, message_id: null, reason: null, before: null, after: null, created_at: "2026-10-11T08:00:00.000Z" }],
    },
  };
}

const quietClient = (over: Record<string, unknown> = {}) => ({
  listPrompts: async () => callPrompts(),
  getPrompt: () => new Promise(() => {}),
  modelLadder: async () => ({ items: [], available: false }),
  claudeCode: async () => { throw new Error("404"); },
  agents: async () => { throw new Error("404"); },
  ...engineServer().api,
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

const node = (host: HTMLElement, id: string) => host.querySelector<HTMLButtonElement>(`[data-playbook-node="${id}"]`);
const settle = async () => { await sleep(10); flushSync(); };

test("an engine drawn as the flow: each step under what sets it off, the picked one beside it with its numbers, model and prompts", async () => {
  const provider = aProvider();
  const { host, runtime, close } = open({
    providers: [provider],
    builtinModels: { ...noBuiltinModels(), scribe: { provider_id: provider.id, model: "grok-4.6" } },
  });
  await settle();
  expect([...host.querySelectorAll("[data-playbook-round]")].map((el) => el.getAttribute("data-playbook-round"))).toEqual(["line", "group", "turn", "handed_in", "accepted", "overturned", "compose"]);
  // Sixteen steps and the Bot's turn; in 通用 the scribe is off.
  expect(host.querySelectorAll("[data-playbook-node]")).toHaveLength(17);
  expect(node(host, "scribe")?.getAttribute("data-on")).toBe("false");
  expect(node(host, "scribe")?.textContent).toContain(t.playbooks.offShort);
  expect(node(host, "settle")?.textContent).toContain(t.routing.follows.default);
  expect(node(host, "intake")?.textContent).toContain("45 秒");
  // Reading is picked first: it always runs, and its model and two prompts are there.
  expect(node(host, "reader")?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('[data-playbook-step="reader"] [data-playbook-part="engine"]')?.textContent).toContain(t.playbooks.locked);
  expect([...host.querySelectorAll('[data-routing-detail="reader"] [data-prompt]')].map((el) => el.getAttribute("data-prompt"))).toEqual(["call.read_user_line", "call.read_bot_line"]);
  click(node(host, "settle"));
  expect(host.querySelector('[data-playbook-step="settle"] [data-side-model="organizer"]')).toBeTruthy();
  expect(host.querySelector<HTMLInputElement>('[data-playbook-param="quiet_s"]')?.value).toBe("30");
  // ↓ walks on to the next step of the round.
  node(host, "settle")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  flushSync();
  expect(node(host, "check_backs")?.getAttribute("aria-pressed")).toBe("true");
  // A Bot's every turn has its prompts on Settings › Prompts, which the link opens.
  click(node(host, "turn"));
  expect(host.querySelector('[data-routing-detail="turn"]')?.textContent).toContain(t.routing.turn.hint);
  click(host.querySelector('[data-routing-link="prompts"]'));
  expect(runtime.calls.filter((call) => call.name === "openPromptSettings")).toEqual([{ name: "openPromptSettings", args: [null] }]);
  close();
});

test("a step switched on, or a number changed, saves the engine's new difference on the revision it was made on; the built-in's value shows beside", async () => {
  const server = engineServer(engines({ video: { v: 1, steps: { escalation: { on: true } } } }, "video"));
  const { host, close } = open({ client: quietClient(server.api) });
  await settle();
  // The default is shown, starred.
  expect(host.querySelector('[data-playbook-chip="video"]')?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('[data-playbook-chip="video"]')?.textContent).toContain("★");
  click(node(host, "settle"));
  const quiet = host.querySelector<HTMLInputElement>('[data-playbook-param="quiet_s"]')!;
  expect(quiet.value).toBe("60");
  quiet.value = "5000";
  quiet.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  // Kept inside its range, sent with the change it was made on, the rest of the difference kept.
  expect(server.saved).toEqual([{ id: "video", diff: { v: 1, steps: { escalation: { on: true }, settle: { params: { quiet_s: 600 } } } }, ifRevision: "rev-video" }]);
  expect(host.querySelector('[data-playbook-step="settle"]')?.textContent).toContain(t.playbooks.builtinValue("60 秒"));
  expect(node(host, "settle")?.querySelector("[data-differs]")).toBeTruthy();
  click(node(host, "retrospective"));
  const toggle = host.querySelector<HTMLInputElement>("[data-playbook-switch]")!;
  toggle.checked = false;
  toggle.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(server.saved.at(-1)!.diff.steps.retrospective).toEqual({ on: false });
  expect(node(host, "retrospective")?.getAttribute("data-on")).toBe("false");
  close();
});

test("engines: another one shown, made the default, a new one made from it, and its history read", async () => {
  const server = engineServer();
  const { host, runtime, close } = open({ client: quietClient(server.api) });
  await settle();
  click(host.querySelector('[data-playbook-chip="video"]'));
  flushSync();
  expect(node(host, "scribe")?.getAttribute("data-on")).toBe("true");
  expect(host.querySelector("[data-playbook-header]")?.textContent).toContain(t.playbooks.builtinHint.video!);
  click(host.querySelector('[data-playbook-action="default"]'));
  expect(runtime.calls.filter((call) => call.name === "patchSettings").map((call) => call.args[0])).toEqual([{ default_playbook: "video" }]);
  click(host.querySelector('[data-playbook-action="new"]'));
  await settle();
  const name = host.querySelector<HTMLInputElement>("[data-playbook-name]")!;
  name.value = "MV 专用";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  click(host.querySelector('.playbook-name button[type="submit"]'));
  await settle();
  expect(host.querySelector('[data-playbook-chip="01MINE00000000000000000000"]')?.getAttribute("aria-selected")).toBe("true");
  click(host.querySelector('[data-playbook-action="history"]'));
  await settle();
  expect(host.querySelector("[data-playbook-history]")?.textContent).toContain(t.playbooks.historyOp.edit);
  close();
});

test("the model ladder is set on a Bot's turn; the turn's node names its rungs", async () => {
  const { host, close } = open({ client: ladderClient() });
  await settle();
  click(node(host, "turn"));
  await sleep(0);
  flushSync();
  expect(node(host, "turn")?.textContent).toContain(t.routing.turn.ladder("gemini-3.8-flash → grok-4.6"));
  const part = host.querySelector('[data-routing-detail="turn"] [data-routing-part="ladder"]')!;
  expect([...part.querySelectorAll(".ladder-name")].map((el) => el.textContent)).toEqual(["gemini-3.8-flash", "grok-4.6"]);
  close();
  const off = open();
  await settle();
  click(node(off.host, "turn"));
  await sleep(0);
  flushSync();
  expect(off.host.querySelector('[data-routing-part="ladder"]')?.textContent).toContain(t.routing.turn.ladderOff);
  off.close();
});

test("set up on a local agent with no endpoint, each call's model is there to change; with neither, only its prompts", async () => {
  const choice = { runner: "codex", model: "gpt-5.6", config_dir: null };
  const { host, close } = open({ providers: [], builtinModels: { reader: choice, organizer: choice, scribe: choice, judge: choice, composer: choice, judgement: choice, reflection: choice, retrospective: choice, compaction: choice } });
  await settle();
  expect(node(host, "reader")?.textContent).toContain("gpt-5.6 · Codex");
  expect(host.querySelector('[data-routing-detail="reader"] [data-side-model="reader"]')).toBeTruthy();
  close();
  const none = open({ providers: [] });
  await settle();
  expect(none.host.querySelector("[data-side-model]")).toBeNull();
  expect(none.host.querySelector('[data-routing-part="model"]')?.textContent).toContain(t.routing.noEndpoint);
  none.close();
});

test("a Mac older than engines shows every step running and nothing of engines to change", async () => {
  const { host, close } = open({ client: quietClient({ listPlaybooks: async () => { throw new Error("404"); } }) });
  await settle();
  expect(host.textContent).toContain(t.playbooks.older);
  expect(host.querySelector("[data-playbook-header]")).toBeNull();
  expect(node(host, "scribe")?.getAttribute("data-on")).toBe("true");
  close();
});

test("asked for a call — by a card about one of its prompts — it opens there", async () => {
  const runtime = fakeRuntime({ providers: [aProvider()] });
  runtime.client = quietClient() as never;
  runtime.rolesTarget = { role: "judgement" };
  const view = render(RolesPage, { runtime, t });
  await settle();
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
  // The organizer's prompts belong to the settle step.
  expect(node(page.host, "settle")?.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".prompt-editor-modal h2")?.textContent).toBe("标题 call.organizer");
  page.close();
});

function asPhone(): () => void {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 720px)", media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => { window.matchMedia = previous; };
}

test("as a page, Back steps out of a prompt, then a step, then the page", async () => {
  const restore = asPhone();
  let left = 0;
  const { host, close } = open({ host: "page", onBack: () => (left += 1) });
  try {
    await settle();
    const title = () => host.querySelector(".roles-page-title")?.textContent;
    expect(title()).toBe(t.routing.tab);
    expect(host.querySelector("[data-playbook-map]")).toBeTruthy();
    expect(host.querySelector("[data-playbook-step]")).toBeNull();
    click(node(host, "reader"));
    expect(title()).toBe(t.playbooks.steps.reader!.name);
    click(host.querySelector('[data-prompt="call.read_user_line"]'));
    await settle();
    expect(document.querySelector(".prompt-editor-modal")).toBeTruthy();
    click(host.querySelector(".roles-page-back"));
    await settle();
    expect(document.querySelector(".prompt-editor-modal")).toBeNull();
    expect(title()).toBe(t.playbooks.steps.reader!.name);
    click(host.querySelector(".roles-page-back"));
    expect(title()).toBe(t.routing.tab);
    expect(left).toBe(0);
    click(host.querySelector(".roles-page-back"));
    expect(left).toBe(1);
  } finally {
    close();
    restore();
  }
});

test("on a phone, the system's Back steps out of a step's page before it leaves the page", async () => {
  const restore = asPhone();
  let left = 0;
  const { host, close } = open({ host: "page", onBack: () => (left += 1) });
  try {
    await settle();
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
    restore();
  }
});
