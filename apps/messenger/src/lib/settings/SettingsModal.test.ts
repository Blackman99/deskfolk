import { expect, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";
import { copyFor } from "../copy.ts";
import { aProvider, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import { updateChecker } from "../update-checker.svelte.ts";
import { IDLE_INSTALL, type UpdateInstallState } from "../updates.ts";
import SettingsModal from "./SettingsModal.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(over: { providers?: ReturnType<typeof aProvider>[] } = {}) {
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
      launch_at_login: true,
      locale: "zh",
      theme: "system",
      wizard_complete: true,
    },
  });
  runtime.settingsOpen = true;
  const view = render(SettingsModal, {
    runtime,
    t,
    saveFailed: false,
    providerEditor: null,
    confirmingProvider: false,
    patchImmediate: async () => true,
    openDeleteProviderConfirm: () => {},
    closeSettings: () => {},
  });
  return { ...view, runtime, provider };
}

test("the settings dialog has no save button", () => {
  const { host, close } = open();
  expect(host.textContent).toContain(t.sidebar.autoSaveHint);
  expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain(t.settings.save);
  close();
});

function openModels(host: HTMLElement): void {
  click(host.querySelectorAll<HTMLButtonElement>(".settings-tab-btn")[2]);
}

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
  fill(host.querySelector("#provider-add-name"), "CPA");
  await sleep(750);
  expect(runtime.calls.filter((c) => c.name === "createProvider")).toHaveLength(0);
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

function openAbout(host: HTMLElement): void {
  const tabs = host.querySelectorAll<HTMLButtonElement>(".settings-tab-btn");
  click(tabs[tabs.length - 1]);
}

function withMobileViewport(run: () => void): void {
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
    run();
  } finally {
    window.matchMedia = previousMatchMedia;
  }
}

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
    openModels(host);
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
      openModels(host);
      click(host.querySelector(".btn-provider-edit"));
      expect(back()).toBe(true);
      expect(host.querySelector(".provider-editor-modal")).toBeNull();
      expect(host.querySelector(".settings-modal.is-mobile-detail")).toBeTruthy();
      click(host.querySelector(".btn-provider-add"));
      expect(back()).toBe(true);
      expect(back()).toBe(true);
      click(host.querySelectorAll(".settings-tab-btn")[3]);
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
  "https://github.com/Blackman99/real-bot/releases/download/v0.1.0-rc.5/Real.Bot_0.1.0-rc.5_aarch64.dmg";

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
    releaseUrl: "https://github.com/Blackman99/real-bot/releases/tag/v0.1.0-rc.5",
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
    detail: "/Applications/Real Bot.app is not writable",
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

test("✕ closes the page it sits on, not the settings behind it", () => {
  withMobileViewport(() => {
    const { host, close } = open();
    openModels(host);
    const modal = host.querySelector(".settings-modal");
    // Inside the endpoint editor: ✕ leaves the editor, the section list stays.
    click(host.querySelector(".btn-provider-edit"));
    click(host.querySelector(".settings-subpage-close"));
    expect(host.querySelector(".provider-editor-modal")).toBeNull();
    expect(modal?.classList.contains("is-mobile-detail")).toBe(true);
    // In a section: ✕ goes back to the list of sections.
    click(host.querySelector(".settings-main-head > .modal-close"));
    expect(modal?.classList.contains("is-mobile-detail")).toBe(false);
    expect(host.querySelector(".settings-modal")).not.toBeNull();
    close();
  });
});
