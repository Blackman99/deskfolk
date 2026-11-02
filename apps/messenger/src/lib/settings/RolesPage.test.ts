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

/** The engines as the daemon lists them, changed as `diffs` say. */
function engines(diffs: Partial<Record<BuiltinPlaybookId, PlaybookDiff>> = {}, defaultId = "general"): PlaybookList {
  const item = (id: BuiltinPlaybookId): Playbook => {
    const diff = diffs[id] ?? emptyPlaybookDiff();
    const changed = Object.keys(diff.steps).length > 0;
    return { id, builtin: true, base_id: id, name: null, revision: changed ? 1 : 0, revision_id: changed ? `rev-${id}` : null, diff, resolved: resolvePlaybook(id, diff), updated_at: null };
  };
  return { default_id: defaultId, items: [item("general"), item("video"), item("coding"), item("plain")] };
}

/** A daemon that keeps the engines' differences as the window sends them. */
function engineServer(start: PlaybookList = engines()) {
  let list = start;
  const saved: Array<{ id: string; diff: PlaybookDiff; ifRevision: string | null }> = [];
  /** Made, renamed and removed, in order. */
  const asked: unknown[][] = [];
  return {
    saved,
    asked,
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
        asked.push(["create", from, name]);
        const base = list.items.find((item) => item.id === from)!;
        const made: Playbook = { ...base, id: "01MINE00000000000000000000", builtin: false, base_id: base.base_id, name, revision: 1, revision_id: "rev-mine" };
        list = { ...list, items: [...list.items, made] };
        return made;
      },
      renamePlaybook: async (id: string, name: string, ifRevision: string | null) => {
        asked.push(["rename", id, name, ifRevision]);
        list = { ...list, items: list.items.map((item) => (item.id === id ? { ...item, name, revision: item.revision + 1, revision_id: `rev-${item.revision + 1}` } : item)) };
        return list.items.find((item) => item.id === id)!;
      },
      deletePlaybook: async (id: string) => {
        asked.push(["delete", id]);
        list = { ...list, items: list.items.filter((item) => item.id !== id) };
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
/** An engine's menu from its row's ⋯; the menu itself hangs on the page. */
const menuOf = (host: HTMLElement, id: string) => {
  click(host.querySelector(`[data-playbook-more="${id}"]`));
  return document.querySelector<HTMLElement>(`[data-playbook-menu="${id}"]`);
};
const action = (menu: HTMLElement | null, name: string) => menu?.querySelector<HTMLButtonElement>(`[data-playbook-action="${name}"]`) ?? null;
/** Typed into the name field, then Enter (or Escape). */
const typeName = (host: HTMLElement, value: string, key = "Enter") => {
  const field = host.querySelector<HTMLInputElement>("[data-playbook-name]")!;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  flushSync();
};
const settle = async () => { await sleep(10); flushSync(); };

test("an engine drawn as the flow: each step under what sets it off, the picked one beside it with its numbers, model and prompts", async () => {
  const provider = aProvider();
  const { host, runtime, close } = open({
    providers: [provider],
    builtinModels: { ...noBuiltinModels(), scribe: { provider_id: provider.id, model: "grok-4.6" } },
  });
  await settle();
  expect([...host.querySelectorAll("[data-playbook-round]")].map((el) => el.getAttribute("data-playbook-round"))).toEqual(["line", "group", "turn", "handed_in", "accepted", "overturned", "compose"]);
  // Twenty steps and the Bot's turn; in 通用 the scribe is off.
  expect(host.querySelectorAll("[data-playbook-node]")).toHaveLength(21);
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
  expect(host.querySelector('[data-playbook-row="video"]')?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('[data-playbook-row="video"]')?.textContent).toContain("★");
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

test("an engine with no jobs: what stands on them shows off and says why, and reading can be off only there", async () => {
  const server = engineServer();
  const { host, close } = open({ client: quietClient(server.api) });
  await settle();
  // In 通用 the jobs can be switched off, says what goes with them; reading is held on by them.
  click(node(host, "jobs"));
  flushSync();
  expect(host.querySelector("[data-playbook-also-stops]")?.textContent).toContain(t.playbooks.steps.settle!.name);
  expect(host.querySelector('[data-playbook-step="jobs"] [data-playbook-switch]')).not.toBeNull();
  click(node(host, "reader"));
  flushSync();
  expect(host.querySelector('[data-playbook-step="reader"] [data-playbook-switch]')).toBeNull();
  expect(host.querySelector("[data-playbook-held-on]")?.textContent).toContain(t.playbooks.steps.jobs!.name);
  expect(node(host, "reader")?.querySelector(".playbook-card-lock")).not.toBeNull();

  click(host.querySelector('[data-playbook-row="plain"]'));
  flushSync();
  expect(host.querySelector("[data-playbook-hint]")?.textContent).toContain(t.playbooks.builtinHint.plain!);
  for (const id of ["jobs", "settle", "closing", "checks", "ceiling", "pickup", "retrospective"]) expect(node(host, id)?.getAttribute("data-on")).toBe("false");
  // A step that only follows them has not been changed, and shows no mark or lock of its own.
  for (const id of ["checks", "pickup", "wait_word"]) {
    expect(node(host, id)?.querySelector("[data-differs]")).toBeNull();
    expect(node(host, id)?.querySelector(".playbook-card-lock")).toBeNull();
  }
  click(node(host, "settle"));
  flushSync();
  expect(host.querySelector("[data-playbook-stopped-by]")?.textContent).toContain(t.playbooks.steps.jobs!.name);
  expect(host.querySelector('[data-playbook-step="settle"] [data-playbook-switch]')).toBeNull();
  // Here reading has a switch of its own.
  click(node(host, "reader"));
  flushSync();
  expect(host.querySelector('[data-playbook-step="reader"] [data-playbook-switch]')).not.toBeNull();
  close();
});

test("switching jobs back on takes reading back with them: a save would refuse it left off", async () => {
  const server = engineServer(engines({ plain: { v: 1, steps: { reader: { on: false } } } }));
  const { host, close } = open({ client: quietClient(server.api) });
  await settle();
  click(host.querySelector('[data-playbook-row="plain"]'));
  flushSync();
  click(node(host, "jobs"));
  flushSync();
  const box = host.querySelector<HTMLInputElement>('[data-playbook-step="jobs"] [data-playbook-switch]')!;
  box.checked = true;
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(server.saved.at(-1)?.diff.steps.jobs).toEqual({ on: true });
  expect(server.saved.at(-1)?.diff.steps.reader).toEqual({});
  close();
});

test("the Bot's turn in an engine: a System section of its own, written from what it stands in for, and the tools it gives", async () => {
  const server = engineServer();
  const asked: Array<[string, string]> = [];
  const client = quietClient({ ...server.api, playbookSystem: async (id: string, locale: string) => { asked.push([id, locale]); return { text: "内置的那段话", own: null }; } });
  const { host, close } = open({ client });
  await settle();
  click(host.querySelector('[data-playbook-row="plain"]'));
  flushSync();
  click(node(host, "turn"));
  flushSync();
  expect(host.querySelector('[data-routing-part="engine-system"]')?.textContent).toContain(t.playbooks.turn.systemBuiltin);
  click(host.querySelector("[data-engine-system-write]"));
  await settle();
  expect(asked).toEqual([["plain", "zh"]]);
  const text = host.querySelector<HTMLTextAreaElement>("[data-engine-system]")!;
  expect(text.value).toBe("内置的那段话");
  text.value = "我写的";
  text.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  click(host.querySelector("[data-engine-system-save]"));
  await settle();
  expect(server.saved.at(-1)).toMatchObject({ id: "plain", diff: { system: { zh: "我写的" } } });
  expect(host.querySelector('[data-routing-part="engine-system"]')?.textContent).toContain(t.playbooks.turn.systemOwn);
  expect(host.querySelector("[data-engine-system]")).toBeNull();

  // Tools: off keeps the text, and only these groups have a switch.
  expect([...host.querySelectorAll<HTMLInputElement>("[data-engine-tool]")].map((box) => [box.dataset.engineTool, box.checked])).toEqual([
    ["roster", true], ["routines", true], ["setup", true], ["prompts", true],
  ]);
  const setup = host.querySelector<HTMLInputElement>('[data-engine-tool="setup"]')!;
  setup.checked = false;
  setup.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(server.saved.at(-1)?.diff).toMatchObject({ system: { zh: "我写的" }, tools_off: ["setup"] });

  // Back to built-in takes the text alone away.
  click(host.querySelector("[data-engine-system-restore]"));
  await settle();
  expect(server.saved.at(-1)?.diff.system).toBeUndefined();
  expect(server.saved.at(-1)?.diff.tools_off).toEqual(["setup"]);
  close();
});

test("making an engine with no jobs the default says first what it moves; another goes at once", async () => {
  const server = engineServer();
  const impact = { sessions: 12, open_jobs: 3 };
  const { host, runtime, close } = open({ client: quietClient({ ...server.api, playbookImpact: async () => impact }) });
  await settle();
  click(host.querySelector('[data-playbook-row="plain"]'));
  flushSync();
  click(action(menuOf(host, "plain"), "default"));
  await settle();
  const dialog = document.querySelector("dialog.confirm-backdrop");
  expect(dialog?.textContent).toContain(t.playbooks.defaultBody(12, 3));
  expect(runtime.calls.filter((call) => call.name === "patchSettings")).toEqual([]);
  click(dialog!.querySelector(".modal-foot button.deny"));
  flushSync();
  expect(runtime.calls.filter((call) => call.name === "patchSettings").map((call) => call.args[0])).toEqual([{ default_playbook: "plain" }]);
  close();
});

test("engines down the left: one shown, made the default, a new one made from it, and its history read beside the map", async () => {
  const server = engineServer();
  const { host, runtime, close } = open({ client: quietClient(server.api) });
  await settle();
  // One row each, as the conversations are: the default starred and shown, each with what it is for.
  expect([...host.querySelectorAll("[data-playbook-row]")].map((row) => row.getAttribute("data-playbook-row"))).toEqual(["general", "video", "coding", "plain"]);
  expect(host.querySelector('[data-playbook-row="general"]')?.textContent).toContain("★");
  expect(host.querySelector('[data-playbook-row="video"]')?.textContent).toContain(t.playbooks.builtinHint.video!);
  expect(host.querySelector("[data-playbook-header]")).toBeNull();
  click(host.querySelector('[data-playbook-row="video"]'));
  flushSync();
  expect(host.querySelector('[data-playbook-row="video"]')?.getAttribute("aria-selected")).toBe("true");
  expect(node(host, "scribe")?.getAttribute("data-on")).toBe("true");
  expect(host.querySelector("[data-playbook-hint]")?.textContent).toContain(t.playbooks.builtinHint.video!);
  // Escape closes the menu and gives the focus back to the ⋯ it hangs from.
  menuOf(host, "video")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(document.querySelector("[data-playbook-menu]")).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[data-playbook-more="video"]'));
  // A built-in has no name to change and cannot be removed.
  const menu = menuOf(host, "video");
  expect(action(menu, "rename")).toBeNull();
  expect(action(menu, "remove")).toBeNull();
  click(action(menu, "default"));
  expect(runtime.calls.filter((call) => call.name === "patchSettings").map((call) => call.args[0])).toEqual([{ default_playbook: "video" }]);
  expect(document.querySelector("[data-playbook-menu]")).toBeNull();

  // A new one from it: its row is a name field until Enter, then it is made and shown.
  click(action(menuOf(host, "video"), "new"));
  await settle();
  expect(host.querySelector("[data-playbook-naming]")?.textContent).toContain(t.playbooks.basedOn(t.playbooks.builtin.video!));
  typeName(host, "MV 专用");
  await settle();
  expect(server.asked).toEqual([["create", "video", "MV 专用"]]);
  expect(host.querySelector("[data-playbook-name]")).toBeNull();
  const mine = host.querySelector('[data-playbook-row="01MINE00000000000000000000"]');
  expect(mine?.getAttribute("aria-selected")).toBe("true");
  expect(mine?.textContent).toContain(t.playbooks.basedOn(t.playbooks.builtin.video!));

  // Its history, beside the map in the picked step's place; picking a step goes back to it.
  click(action(menuOf(host, "video"), "history"));
  await settle();
  expect(host.querySelector('[data-playbook-row="video"]')?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("[data-playbook-history-of=\"video\"] [data-playbook-history]")?.textContent).toContain(t.playbooks.historyOp.edit);
  expect(host.querySelector("[data-playbook-step]")).toBeNull();
  click(node(host, "settle"));
  expect(host.querySelector("[data-playbook-history]")).toBeNull();
  expect(host.querySelector('[data-playbook-step="settle"]')).toBeTruthy();
  click(action(menuOf(host, "video"), "history"));
  await settle();
  click(host.querySelector("[data-playbook-history-close]"));
  expect(host.querySelector("[data-playbook-history]")).toBeNull();
  close();
});

test("one of yours renamed in its row and removed after a word; the + makes one from the engine shown", async () => {
  const mine: Playbook = { ...engines().items[1]!, id: "01MINE00000000000000000000", builtin: false, base_id: "video", name: "MV 专用", revision: 1, revision_id: "rev-mine", updated_at: "2026-10-11T08:00:00.000Z" };
  const start = engines();
  const server = engineServer({ ...start, items: [...start.items, mine] });
  const { host, close } = open({ client: quietClient(server.api) });
  await settle();
  click(host.querySelector('[data-playbook-row="01MINE00000000000000000000"]'));
  flushSync();

  // A right-click on its row opens the same menu; rename turns the row into its name, selected.
  const row = host.querySelector<HTMLElement>('[data-playbook-row="01MINE00000000000000000000"]')!;
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  flushSync();
  click(action(document.querySelector("[data-playbook-menu]"), "rename"));
  await settle();
  expect(host.querySelector<HTMLInputElement>("[data-playbook-name]")?.value).toBe("MV 专用");
  // Escape leaves the name; the same name again sends nothing.
  typeName(host, "别的", "Escape");
  expect(host.querySelector("[data-playbook-name]")).toBeNull();
  click(action(menuOf(host, "01MINE00000000000000000000"), "rename"));
  await settle();
  typeName(host, "MV 专用");
  await settle();
  expect(server.asked).toEqual([]);
  click(action(menuOf(host, "01MINE00000000000000000000"), "rename"));
  await settle();
  typeName(host, "MV 二");
  await settle();
  expect(server.asked).toEqual([["rename", "01MINE00000000000000000000", "MV 二", "rev-mine"]]);
  expect(host.querySelector('[data-playbook-row="01MINE00000000000000000000"]')?.textContent).toContain("MV 二");

  // Removing it asks first; then the default is shown.
  click(action(menuOf(host, "01MINE00000000000000000000"), "remove"));
  flushSync();
  const dialog = document.querySelector("dialog.confirm-backdrop");
  expect(dialog?.textContent).toContain(t.playbooks.removeTitle("MV 二"));
  expect(server.asked).toHaveLength(1);
  click(dialog!.querySelector(".modal-foot button.deny"));
  await settle();
  expect(server.asked.at(-1)).toEqual(["delete", "01MINE00000000000000000000"]);
  expect(host.querySelector('[data-playbook-row="01MINE00000000000000000000"]')).toBeNull();
  expect(host.querySelector('[data-playbook-row="general"]')?.getAttribute("aria-selected")).toBe("true");

  // The + names a new one made from the engine shown; blank leaves things as they were.
  click(host.querySelector('[data-playbook-row="coding"]'));
  click(host.querySelector("[data-playbook-add]"));
  await settle();
  expect(host.querySelector("[data-playbook-naming=\"new\"]")?.textContent).toContain(t.playbooks.basedOn(t.playbooks.builtin.coding!));
  typeName(host, "  ");
  expect(host.querySelector("[data-playbook-name]")).toBeNull();
  click(host.querySelector("[data-playbook-add]"));
  await settle();
  typeName(host, "写库");
  await settle();
  expect(server.asked.at(-1)).toEqual(["create", "coding", "写库"]);
  close();
});

test("the default engine of yours cannot be removed, and says why", async () => {
  const mine: Playbook = { ...engines().items[0]!, id: "01MINE00000000000000000000", builtin: false, base_id: "general", name: "我的", revision: 1, revision_id: "rev-mine" };
  const start = engines({}, "01MINE00000000000000000000");
  const server = engineServer({ ...start, items: [...start.items, mine] });
  const { host, close } = open({ client: quietClient(server.api) });
  await settle();
  const menu = menuOf(host, "01MINE00000000000000000000");
  expect(action(menu, "default")).toBeNull();
  expect(action(menu, "remove")?.disabled).toBe(true);
  expect(action(menu, "remove")?.title).toBe(t.playbooks.removeIsDefault);
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
  expect(host.querySelector("[data-playbook-list]")).toBeNull();
  expect(node(host, "scribe")?.getAttribute("data-on")).toBe("true");
  close();
});

test("asked for an engine — from a job's title row — it shows that engine, not the default (ADR 0086)", async () => {
  const server = engineServer(engines({}, "general"));
  const runtime = fakeRuntime({ providers: [aProvider()] });
  runtime.client = quietClient(server.api) as never;
  runtime.rolesTarget = { role: null, playbook: "video" };
  const view = render(RolesPage, { runtime, t });
  await settle();
  expect(view.host.querySelector('[data-playbook-row="video"]')?.getAttribute("aria-selected")).toBe("true");
  expect(runtime.rolesTarget).toBeNull();
  view.close();
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
    // Narrow, the engines are a row of chips over the map, not a list beside it.
    expect(host.querySelector('[data-playbook-chip="general"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector("[data-playbook-list]")).toBeNull();
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
