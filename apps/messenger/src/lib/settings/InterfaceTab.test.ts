import { expect, test } from "bun:test";
import { emptyInterfaceProfile, type InterfaceResponse, type InterfaceRevisionHead, type InterfaceState } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { fakeApi } from "../test-mocks.ts";
import { buttonByText, click, render } from "../test-render.ts";
import { emptySnapshot } from "../snapshot.ts";
import InterfaceTab from "./InterfaceTab.svelte";
import SettingsModal from "./SettingsModal.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function head(over: Partial<InterfaceRevisionHead> = {}): InterfaceRevisionHead {
  return {
    id: "r2", revision: 2, op: "edit", actor: "bot", bot_id: "b1", turn_id: null, approval_id: null, message_id: null,
    reason: null, app_version: null, created_at: "2026-11-04T10:00:00.000Z",
    changes: ["light --accent: #7040c0", "send_key: \"mod_enter\"", "css: 12 characters", "enabled"], undoable: true, ...over,
  };
}

function aState(): InterfaceState {
  const profile = emptyInterfaceProfile();
  profile.tokens.light["--accent"] = "#7040c0";
  profile.tokens.dark["--accent"] = "#b79cf0";
  profile.behaviour.send_key = "mod_enter";
  profile.css = ".a { color: red }";
  profile.copy.zh["composer.send"] = "发出去";
  return { profile, revision: 2, revision_id: "r2", recent: [head(), head({ id: "r1", revision: 1, actor: "user", bot_id: null, undoable: false })] };
}

function setup(state: InterfaceState | null = aState()) {
  const calls: { name: string; args: unknown[] }[] = [];
  const answer: InterfaceResponse = { ...(state ?? aState()), reports: [{ at: "x", surface: "desktop", app_version: null, revision_id: "r2", applied: true, unmatched: [".nothing"], dropped: 2, bad_tokens: ["--bad"], floor_failed: [{ floor: "stop", why: "hidden" }] }] };
  const log = (name: string) => async (...args: unknown[]) => { calls.push({ name, args }); return answer; };
  const client = fakeApi({ getInterface: log("getInterface"), patchInterface: log("patchInterface"), undoInterfaceRevision: log("undo"), restoreInterfaceRevision: log("restore") });
  const runtime = fakeRuntime({ interface: state, bots: [{ id: "b1", name: "调优员" } as never] });
  runtime.client = client as never;
  return { runtime, calls, snapshot: runtime.snapshot };
}

test("the page shows every section from the profile", async () => {
  const { runtime, snapshot } = setup();
  const { host, close } = render(InterfaceTab, { runtime, t, snapshot, locale: "zh" });
  await sleep(0);
  const text = host.textContent ?? "";
  for (const heading of Object.values(t.ui.sections)) expect(text).toContain(heading);
  expect(host.querySelectorAll("[data-token]")).toHaveLength(2);
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(".a { color: red }");
  expect(host.querySelector('[data-copy-key="composer.send"]')?.textContent).toContain("发出去");
  expect(host.querySelector('[data-revision="r2"]')?.textContent).toContain("调优员");
  expect(host.querySelector('[data-revision="r2"]')?.textContent).toContain("还有 1 处");
  expect(host.querySelector('[data-revision="r1"]')?.textContent).toContain("你");
  expect(host.querySelector('[data-behaviour="send_key"] .is-active')?.textContent).toContain("Ctrl+回车");
  expect(host.querySelector('[data-floor="interface-pause"]')).not.toBeNull();
  expect(host.querySelector('[data-surface="desktop"]')?.textContent).toContain(".nothing");
  close();
});

test("the enabled switch and the behaviour choices patch the profile", async () => {
  const { runtime, calls, snapshot } = setup();
  const { host, close } = render(InterfaceTab, { runtime, t, snapshot, locale: "zh" });
  click(host.querySelector("#interface-enabled-toggle"));
  click(host.querySelector('[data-behaviour="send_key"] .segmented-btn'));
  await sleep(0);
  const patches = calls.filter((call) => call.name === "patchInterface").map((call) => (call.args[0] as { patch: unknown }).patch);
  expect(patches).toEqual([{ enabled: false }, { behaviour: { send_key: null } }]);
  close();
});

test("removing a token sends null for that look", async () => {
  const { runtime, calls, snapshot } = setup();
  const { host, close } = render(InterfaceTab, { runtime, t, snapshot, locale: "zh" });
  click(host.querySelector('[data-token="--accent"][data-side="dark"] button'));
  await sleep(0);
  const patch = calls.find((call) => call.name === "patchInterface")!.args[0] as { patch: unknown };
  expect(patch.patch).toEqual({ tokens: { dark: { "--accent": null } } });
  close();
});

test("undo and restore call the revision endpoints; only an undoable change offers undo", async () => {
  const { runtime, calls, snapshot } = setup();
  const { host, close } = render(InterfaceTab, { runtime, t, snapshot, locale: "zh" });
  expect(host.querySelectorAll('[data-action="undo"]')).toHaveLength(1);
  click(host.querySelector('[data-revision="r2"] [data-action="undo"]'));
  await sleep(0);
  click(host.querySelector('[data-revision="r1"] [data-action="restore"]'));
  await sleep(0);
  expect(calls.filter((call) => call.name === "undo" || call.name === "restore").map((call) => [call.name, call.args[0]])).toEqual([["undo", "r2"], ["restore", "r1"]]);
  close();
});

test("putting everything back asks first, then resets the four parts", async () => {
  const { runtime, calls, snapshot } = setup();
  const { host, close } = render(InterfaceTab, { runtime, t, snapshot, locale: "zh" });
  click(buttonByText(host, t.ui.resetAll));
  expect(calls.some((call) => call.name === "patchInterface")).toBe(false);
  click(buttonByText(host, t.ui.resetAll));
  await sleep(0);
  const patch = calls.find((call) => call.name === "patchInterface")!.args[0] as { patch: unknown };
  expect(patch.patch).toEqual({ reset: ["tokens", "behaviour", "css", "copy"] });
  close();
});

test("the stylesheet saves a second after typing stops, against the revision it was loaded at", async () => {
  const { runtime, calls, snapshot } = setup();
  const { host, close } = render(InterfaceTab, { runtime, t, snapshot, locale: "zh" });
  const area = host.querySelector("textarea") as HTMLTextAreaElement;
  area.value = ".b {}";
  area.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(1100);
  const body = calls.find((call) => call.name === "patchInterface")!.args[0] as { patch: unknown; if_revision: string; edit_session: string };
  expect(body.patch).toEqual({ css: { set: ".b {}" } });
  expect(body.if_revision).toBe("r2");
  expect(body.edit_session).toBeTruthy();
  close();
});

test("the tab is in Settings only when the daemon keeps a profile", () => {
  for (const [state, shown] of [[aState(), true], [null, false]] as const) {
    const runtime = fakeRuntime({ ...emptySnapshot(), interface: state });
    runtime.settingsOpen = true;
    const { host, close } = render(SettingsModal, {
      runtime, t, saveFailed: false, providerEditor: null, confirmingProvider: false,
      patchImmediate: async () => true, openDeleteProviderConfirm: () => {}, closeSettings: () => {}, workbench: true,
    });
    expect(host.querySelector('[data-settings-tab="interface"]') !== null).toBe(shown);
    close();
  }
});
