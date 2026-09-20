import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aProvider, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
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
