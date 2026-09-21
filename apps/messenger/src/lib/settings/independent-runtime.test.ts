import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import SettingsModal from "./SettingsModal.svelte";
import type { TauriInternals } from "../tauri.ts";
import {
  gatedIndependentStatus,
  invokeIndependentRuntime,
  parseIndependentStatus,
  setLaunchAtLogin,
} from "./independent-runtime.ts";

function fakeInternals(
  handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): TauriInternals & { calls: Array<{ cmd: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  return {
    calls,
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return handler(cmd, args);
    },
  };
}

const gated = {
  enabled: false,
  available: false,
  diagnostic: "g_pack_not_verified",
  supervising: true,
  writer: "window",
  drain: { phase: "running", remaining: [], forced: false },
  error: "g_pack_not_verified",
  warning: null,
};

test("parseIndependentStatus keeps a gated production payload", () => {
  expect(parseIndependentStatus(gated)).toEqual({
    ...gated,
    error: "g_pack_not_verified",
  });
});

test("parseIndependentStatus rejects PathExists-style or extra writers", () => {
  expect(parseIndependentStatus({ ...gated, writer: "launchd" })).toBeNull();
  expect(parseIndependentStatus({ ...gated, drain: { phase: "idle", remaining: [], forced: false } })).toBeNull();
  expect(parseIndependentStatus(null)).toBeNull();
});

test("invokeIndependentRuntime never claims production is available without Tauri", async () => {
  await expect(invokeIndependentRuntime("enable", undefined)).resolves.toEqual(
    gatedIndependentStatus("browser_cannot_install_agent"),
  );
});

test("invokeIndependentRuntime maps a refused bundled-frame invoke to gated status", async () => {
  const internals = fakeInternals(async () => {
    throw new Error("disabled");
  });
  await expect(invokeIndependentRuntime("enable", internals)).resolves.toEqual(
    gatedIndependentStatus("disabled"),
  );
});

test("invokeIndependentRuntime forwards status and enable through the desktop command", async () => {
  const internals = fakeInternals(async () => gated);
  await expect(invokeIndependentRuntime("status", internals)).resolves.toMatchObject({
    available: false,
    diagnostic: "g_pack_not_verified",
    enabled: false,
  });
  await expect(invokeIndependentRuntime("enable", internals)).resolves.toMatchObject({
    available: false,
  });
  expect(internals.calls).toEqual([
    { cmd: "independent_runtime_status", args: undefined },
    { cmd: "independent_runtime", args: { request: { operation: "enable" } } },
  ]);
});

test("confirming a gated independent-runtime enable closes the dialog and leaves the switch off", async () => {
  const runtime = reactive(fakeRuntime({}, { settingsOpen: true }));
  const { host, close } = render(SettingsModal, {
    runtime,
    t: copyFor("en"),
    saveFailed: false,
    providerEditor: null,
    confirmingProvider: false,
    confirmingIndependent: false,
    patchImmediate: async () => true,
    openDeleteProviderConfirm: () => {},
    closeSettings: () => {},
  });
  const prefs = [...host.querySelectorAll(".settings-tab-btn")].find((el) => el.textContent?.includes("Preferences"));
  click(prefs);
  const toggle = host.querySelector("#independent-runtime-toggle") as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  toggle.checked = true;
  toggle.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  expect(host.querySelector("#independent-runtime-confirm-title")?.textContent).toBe("Enable independent runtime");
  const confirm = [...host.querySelectorAll("button")].find((el) => el.textContent === "Confirm");
  click(confirm);
  for (let i = 0; i < 20 && host.querySelector("#independent-runtime-confirm-title"); i += 1) {
    await Promise.resolve();
    flushSync();
  }
  expect(host.querySelector("#independent-runtime-confirm-title")).toBeNull();
  expect((host.querySelector("#independent-runtime-toggle") as HTMLInputElement).checked).toBe(false);
  expect(host.querySelector("[data-independent-reason]")?.textContent).toContain("browser cannot install");
  close();
});

test("setLaunchAtLogin is independent of the runtime agent command", async () => {
  const internals = fakeInternals(async () => true);
  await expect(setLaunchAtLogin(false, internals)).resolves.toBe(true);
  expect(internals.calls).toEqual([{ cmd: "set_launch_at_login", args: { enabled: false } }]);
  await expect(setLaunchAtLogin(true, undefined)).resolves.toBe(false);
});
