import { afterEach, expect, test } from "bun:test";
import { INTERFACE_EDIT_KIND, type ClientEvent, type InterfaceResponse, type InterfaceRevision, type InterfaceRevisionHead } from "@real-bot/protocol";
import { runCollabTool, type ToolCtx } from "./collab-tools";
import { createLocalApi } from "./local-api";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const stores: Store[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

function setup() {
  const store = new Store({ endpointKey: memoryKeyStore() });
  stores.push(store);
  const { bot, direct_session } = store.createBot({ name: "Painter", duties: "tidy the app's look", boundaries: "ask first" });
  const line = store.postMessage(direct_session.id, { body: "make the accent purple" });
  const turn = store.createTurn({ sessionId: direct_session.id, botId: bot.id, triggerMessageId: line.id });
  const ctx: ToolCtx = { store, botId: bot.id, sessionId: direct_session.id, turnId: turn.id, parentId: null };
  return { store, bot, turn, ctx };
}

test("a change is one revision with the record before and after; undo takes back only the latest, while it still stands", () => {
  const { store } = setup();
  expect(store.interfaceState()).toMatchObject({ revision: 0, revision_id: null, recent: [] });
  const first = store.changeInterface({ tokens: { both: { "--accent": "#7c3aed" } }, theme: "dark" }, { actor: "user" });
  expect(first.revision).toMatchObject({ op: "edit", actor: "user", revision: 1 });
  expect(first.revision!.before).toMatchObject({ theme: "system" });
  expect(first.revision!.after).toMatchObject({ theme: "dark", profile: { tokens: { light: { "--accent": "#7c3aed" }, dark: { "--accent": "#7c3aed" } } } });
  // The theme lives in Settings, and moved there too.
  expect(store.settingsCached().theme).toBe("dark");
  const second = store.changeInterface({ behaviour: { send_key: "mod_enter" } }, { actor: "user" });
  expect(store.interfaceState().recent.map((head) => [head.id, head.undoable])).toEqual([[second.revision!.id, true], [first.revision!.id, false]]);
  // Only the latest can be taken back.
  expect(() => store.undoInterfaceRevision(first.revision!.id)).toThrow(/latest/);
  const undone = store.undoInterfaceRevision(second.revision!.id);
  expect(undone.revision).toMatchObject({ op: "undo" });
  expect(store.interfaceRecord().profile.behaviour).toEqual({});
  // Any change can be restored; this one brings the theme back too.
  store.changeInterface({ reset: ["tokens"], theme: "light" }, { actor: "user" });
  store.restoreInterfaceRevision(first.revision!.id);
  expect(store.interfaceRecord()).toMatchObject({ theme: "dark", profile: { tokens: { light: { "--accent": "#7c3aed" } } } });
  // A change that changes nothing is no revision.
  expect(store.changeInterface({ theme: "dark" }).revision).toBeNull();
});

test("a sitting of Settings folds into one revision, except typing it back to how it began", () => {
  const { store } = setup();
  const sitting = { actor: "user" as const, editSession: "s1" };
  store.changeInterface({ css: { set: "a{}" } }, sitting);
  store.changeInterface({ css: { set: "a{color:red}" } }, sitting);
  expect(store.listInterfaceRevisions().length).toBe(1);
  // Back to how the sitting began: a change of its own…
  store.changeInterface({ css: { set: "" } }, sitting);
  expect(store.listInterfaceRevisions().length).toBe(2);
  // …and what comes after it starts another.
  store.changeInterface({ css: { set: "b{}" } }, sitting);
  store.changeInterface({ css: { set: "b{color:blue}" } }, sitting);
  expect(store.listInterfaceRevisions().map((head) => head.changes)).toEqual([["css: 13 characters"], ["css: removed"], ["css: 12 characters"]]);
});

test("a stale page is refused, and what cannot be applied says why", () => {
  const { store } = setup();
  const made = store.changeInterface({ behaviour: { motion: "reduce" } }, { actor: "user", ifRevision: null });
  expect(() => store.changeInterface({ behaviour: { motion: "system" } }, { ifRevision: null })).toThrow(/changed since/);
  expect(() => store.changeInterface({ css: { set: "@import url(x.css);" } })).toThrow(/@import/);
  expect(() => store.changeInterface({ theme: "sepia" })).toThrow(/theme must be/);
  expect(store.changeInterface({ behaviour: { motion: "system" } }, { ifRevision: made.revision!.id }).revision).not.toBeNull();
});

test("every change reaches the windows as interface.changed, with the theme in settings.changed", () => {
  const { store } = setup();
  const events: ClientEvent[] = [];
  store.onCommit((event) => events.push(event));
  store.changeInterface({ tokens: { light: { "--bg": "#fff" } }, theme: "dark" });
  const changed = events.filter((event) => event.event === "interface.changed");
  expect(changed).toHaveLength(1);
  expect(changed[0]).toMatchObject({ revision: 1, profile: { tokens: { light: { "--bg": "#fff" } } } });
  expect(events.some((event) => event.event === "settings.changed" && event.theme === "dark")).toBe(true);
});

test("the Bot's change applies at once under auto, waits on a ui-edit card under ask first, and is refused read-only", async () => {
  const { store, bot, turn, ctx } = setup();
  const done = await runCollabTool(ctx, "edit_interface", { reason: "the user wants a purple accent", tokens: { both: { "--accent": "#7c3aed" } } });
  expect(done.ok).toBe(true);
  const head = store.listInterfaceRevisions({ turnId: turn.id })[0]!;
  expect(head).toMatchObject({ actor: "bot", bot_id: bot.id, turn_id: turn.id, reason: "the user wants a purple accent", undoable: true });
  expect((await runCollabTool(ctx, "edit_interface", { reason: "again", tokens: { both: { "--accent": "#7c3aed" } } })).error?.code).toBe("no_change");

  // Glass content is a behaviour; a stylesheet that shuts pop-ups into a pane is named back.
  const glass = await runCollabTool(ctx, "edit_interface", { reason: "frosted content", behaviour: { content_glass: "frosted" } });
  expect(glass.ok).toBe(true);
  expect(glass.data!.warning).toBeUndefined();
  const trapped = await runCollabTool(ctx, "edit_interface", { reason: "blur", css: { set: "[data-ui=\"pane\"] { backdrop-filter: blur(24px); }\n[data-ui=\"tab\"] { transform: none; }" } });
  expect(String(trapped.data!.warning)).toContain("backdrop-filter");
  expect(String(trapped.data!.warning)).not.toContain("transform");
  expect(String(trapped.data!.warning)).toContain("content_glass");

  // Code colours, one look at a time.
  expect((await runCollabTool(ctx, "edit_interface", { reason: "dracula for code at night", behaviour: { code_theme: { dark: "dracula" } } })).ok).toBe(true);
  expect(store.interfaceRecord().profile.behaviour.code_theme).toEqual({ dark: "dracula" });
  expect((await runCollabTool(ctx, "edit_interface", { reason: "x", behaviour: { code_theme: { light: "dracula" } } })).error?.code).toBe("invalid_args");

  store.patchSettingsSync({ permission_mode: "ask_first" });
  const asked = await runCollabTool(ctx, "edit_interface", { reason: "a serif font", tokens: { both: { "--font": "Georgia, serif" } } });
  expect(asked.ok).toBe(false);
  const card = asked.waitApproval!;
  expect(card.kind_key).toBe(INTERFACE_EDIT_KIND);
  expect(card.summary.split("\n").slice(0, 4)).toEqual(["改界面", "理由：a serif font", "- light --font: Georgia, serif", "- dark --font: Georgia, serif"]);
  expect(card.summary).toContain("@@patch\n{\"tokens\":{\"both\":{\"--font\":\"Georgia, serif\"}}}");
  // Nothing changed until you allow it; then it records the card.
  expect(store.interfaceRecord().profile.tokens.light["--font"]).toBeUndefined();
  const allowed = await card.run({ approval_id: "01J0000000000000000000000A", message_id: "01J0000000000000000000000B" });
  expect(allowed.ok).toBe(true);
  expect(store.listInterfaceRevisions()[0]).toMatchObject({ approval_id: "01J0000000000000000000000A", message_id: "01J0000000000000000000000B" });

  // A card whose change no longer fits goes back to the Bot.
  store.patchSettingsSync({ permission_mode: "ask_first" });
  store.changeInterface({ css: { set: "a { color: red; }" } });
  const css = await runCollabTool(ctx, "edit_interface", { reason: "blue links", css: { edits: [{ old: "red", new: "blue" }] } });
  store.changeInterface({ css: { set: "" } });
  expect((await css.waitApproval!.run({ approval_id: "01J0000000000000000000000C" })).error?.code).toBe("conflict");

  store.patchSettingsSync({ permission_mode: "read_only" });
  expect((await runCollabTool(ctx, "edit_interface", { reason: "x", behaviour: { motion: "reduce" } })).error?.code).toBe("refused");
  // Reading is free in every mode.
  expect((await runCollabTool(ctx, "describe_interface", {})).ok).toBe(true);
});

test("describe_interface shows the lists, the hooks, what windows found, and finds tokens and words", async () => {
  const { store, ctx } = setup();
  store.noteInterfaceWindow({
    catalog: { app_version: "v1", tokens: [{ name: "--accent", light: "#0f766e", dark: "#2dd4bf" }, { name: "--accent-soft", light: "#ccfbf1", dark: null }], copy: { zh: { "composer.send": "发送" }, en: { "composer.send": "Send" } } },
    report: { at: "", surface: "desktop", app_version: "v1", revision_id: null, applied: true, unmatched: [".gone"], dropped: 1, bad_tokens: [], floor_failed: [{ floor: "stop", why: "display: none" }] },
  });
  const read = await runCollabTool(ctx, "describe_interface", { find: "发送" });
  expect(read.ok).toBe(true);
  expect(read.data!.hooks).toMatchObject({ sidebar: "侧栏" });
  expect(read.data!.token_families).toEqual({ "--accent": 2 });
  expect(read.data!.found_words).toEqual([{ key: "composer.send", text: "发送" }]);
  expect(read.data!.windows).toEqual([{ surface: "desktop", at: expect.any(String), applied: true, revision_id: null, unmatched: [".gone"], dropped: 1, floor_failed: [{ floor: "stop", why: "display: none" }] }]);
  const codeColours = (read.data!.behaviour_list as Array<{ key: string; values: unknown }>).find((row) => row.key === "code_theme");
  expect(codeColours?.values).toMatchObject({ light: expect.arrayContaining(["github-light", "solarized-light"]), dark: expect.arrayContaining(["dracula", "nord"]) });
  const tokens = await runCollabTool(ctx, "describe_interface", { find: "#2dd4bf" });
  expect(tokens.data!.found_tokens).toEqual([{ name: "--accent", light: "#0f766e", dark: "#2dd4bf" }]);
  expect(JSON.stringify(read.data).length).toBeLessThan(8000);
});

test("the API reads, changes, lists, undoes and takes a window's report, and the phone may do the same", async () => {
  const { store } = setup();
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}/v1${path}`, {
    method, headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const start = (await (await request("GET", "/interface")).json()) as InterfaceResponse;
    expect(start).toMatchObject({ revision: 0, revision_id: null, reports: [], profile: { enabled: true, css: "" } });
    const saved = await request("PATCH", "/interface", { patch: { tokens: { light: { "--accent": "red" } } }, if_revision: null, edit_session: "s" });
    expect(saved.status).toBe(200);
    const after = (await saved.json()) as InterfaceResponse;
    expect(after.profile.tokens.light).toEqual({ "--accent": "red" });
    expect((await request("PATCH", "/interface", { patch: { tokens: { light: { "--accent": "blue" } } }, if_revision: null })).status).toBe(409);
    expect((await request("PATCH", "/interface", { patch: { density: "compact" } })).status).toBe(422);
    const list = (await (await request("GET", "/interface/revisions")).json()) as { items: InterfaceRevisionHead[] };
    expect(list.items).toHaveLength(1);
    const one = (await (await request("GET", `/interface/revisions/${list.items[0]!.id}`)).json()) as InterfaceRevision;
    expect(one.after.profile.tokens.light).toEqual({ "--accent": "red" });
    const undone = (await (await request("POST", `/interface/revisions/${one.id}/undo`, {})).json()) as InterfaceResponse;
    expect(undone.profile.tokens.light).toEqual({});
    expect((await request("POST", "/interface/window", { report: { surface: "phone", applied: false, unmatched: [], dropped: 0, bad_tokens: [], floor_failed: [] } })).status).toBe(204);
    const reports = ((await (await request("GET", "/interface")).json()) as InterfaceResponse).reports;
    expect(reports.map((report) => [report.surface, report.applied])).toEqual([["phone", false]]);
  } finally {
    server.stop(true);
  }
  const phone = (method: string, path: string, body?: Record<string, unknown>) => () => validateBusiness({ id: "r", method, path, body } as never);
  expect(phone("GET", "/v1/interface")).not.toThrow();
  expect(phone("PATCH", "/v1/interface", { patch: { css: { set: "a{}" } }, if_revision: null })).not.toThrow();
  expect(phone("POST", "/v1/interface/revisions/01J0000000000000000000000A/undo", {})).not.toThrow();
  expect(phone("POST", "/v1/interface/window", { report: { surface: "phone" } })).not.toThrow();
});
