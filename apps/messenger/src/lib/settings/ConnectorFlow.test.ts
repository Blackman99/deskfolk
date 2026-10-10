import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aProvider, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import SettingsModal from "./SettingsModal.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Probe = (baseUrl?: string, apiKey?: string, providerId?: string, apiFormat?: string, workspaceId?: string | null) => Promise<unknown>;

function open(providers = [aProvider()], probeModels?: Probe) {
  const provider = providers[0] ?? aProvider();
  const runtime = fakeRuntime(
    {
      providers,
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
    } as never,
    probeModels ? { probeModels } : {},
  );
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
  click(view.host.querySelector<HTMLButtonElement>('[data-settings-tab="models"]'));
  return { ...view, runtime };
}

function pick(host: HTMLElement, name: string): void {
  click(buttonByText(host, t.settings.providerAdd));
  click([...host.querySelectorAll(".connector-pick")].find((tile) => tile.querySelector(".connector-pick-name")?.textContent === name));
}

const models = (names: string[]) => ({ ok: true, models: names, catalog: names.map((name) => ({ name, thinking_levels: [] })) });
const refused = { ok: false, error: "Endpoint returned 401: Invalid API Key", status: 401 };

test("adding starts on the built-in connectors and a custom tile", () => {
  const { host, close } = open();
  click(buttonByText(host, t.settings.providerAdd));
  const names = [...host.querySelectorAll(".connector-pick-name")].map((el) => el.textContent);
  expect(names).toEqual(["Anthropic", "小米 MiMo", "千问", "DeepSeek", t.connectors.custom]);
  // Each built-in one on its own logo, DeepSeek's whale among them.
  expect(host.querySelector(".connector-pick .connector-logo.is-deepseek")).toBeTruthy();
  expect(host.querySelector("#provider-add-url")).toBeNull();
  close();
});

test("a connector asks for the key alone, and back returns to the tiles", () => {
  const { host, close } = open();
  pick(host, "小米 MiMo");
  expect(host.querySelector("#provider-add-key")).toBeTruthy();
  expect(host.querySelector("#provider-add-url")).toBeNull();
  expect((host.querySelector("#provider-add-name") as HTMLInputElement).value).toBe("小米 MiMo");
  click(host.querySelector(".settings-subpage-head button"));
  expect(host.querySelectorAll(".connector-pick")).toHaveLength(5);
  close();
});

test("the key is tried on each plan in turn, and the endpoint is created on the one that takes it", async () => {
  const asked: (string | undefined)[] = [];
  const { host, runtime, close } = open([aProvider()], async (baseUrl) => {
    asked.push(baseUrl);
    return baseUrl === "https://token-plan-sgp.xiaomimimo.com/v1" ? models(["mimo-v2.6-pro", "mimo-v2.6-flash"]) : refused;
  });
  pick(host, "小米 MiMo");
  fill(host.querySelector("#provider-add-key"), "tp-secret");
  await sleep(1500);
  expect(asked).toEqual(["https://token-plan-cn.xiaomimimo.com/v1", "https://token-plan-sgp.xiaomimimo.com/v1"]);
  const creates = runtime.calls.filter((c) => c.name === "createProvider");
  expect(creates).toHaveLength(1);
  expect(creates[0]!.args[0]).toMatchObject({
    name: "小米 MiMo",
    base_url: "https://token-plan-sgp.xiaomimimo.com/v1",
    api_key: "tp-secret",
    available_models: ["mimo-v2.6-pro", "mimo-v2.6-flash"],
  });
  expect((creates[0]!.args[0] as Record<string, unknown>).api_format).toBeUndefined();
  close();
});

test("a key no plan takes says so and creates nothing", async () => {
  const { host, runtime, close } = open([aProvider()], async () => refused);
  pick(host, "千问");
  fill(host.querySelector("#provider-add-key"), "sk-wrong");
  await sleep(1500);
  expect(host.querySelector(".models-fetch-tip")?.textContent).toBe(
    t.connectors.keyRefused("千问", "Token Plan、按量付费 · 北京、按量付费 · 国际"),
  );
  expect(runtime.calls.filter((c) => c.name === "createProvider")).toHaveLength(0);
  close();
});

test("Anthropic asks for a workspace when the key needs one, and saves it", async () => {
  const sent: (string | null | undefined)[] = [];
  const { host, runtime, close } = open([aProvider()], async (_baseUrl, _key, _id, format, workspaceId) => {
    expect(format).toBe("anthropic");
    sent.push(workspaceId);
    return workspaceId
      ? models(["claude-opus-5-5"])
      : { ok: false, status: 422, error: "Endpoint returned 400: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use." };
  });
  pick(host, "Anthropic");
  fill(host.querySelector("#provider-add-key"), "sk-ant-usr-secret");
  await sleep(900);
  expect(host.querySelector(".models-fetch-tip")?.textContent).toBe(t.connectors.workspaceNeeded);
  expect(runtime.calls.filter((c) => c.name === "createProvider")).toHaveLength(0);
  fill(host.querySelector("#provider-add-workspace"), "wrkspc_01Test");
  await sleep(1500);
  expect(sent).toEqual([null, "wrkspc_01Test"]);
  const creates = runtime.calls.filter((c) => c.name === "createProvider");
  expect(creates).toHaveLength(1);
  expect(creates[0]!.args[0]).toMatchObject({
    name: "Anthropic",
    base_url: "https://api.anthropic.com",
    api_format: "anthropic",
    workspace_id: "wrkspc_01Test",
  });
  close();
});

test("an endpoint at a connector's address shows its logo and plan; any other keeps its letter", () => {
  const { host, close } = open([
    aProvider({ id: "prov-1", name: "小米", base_url: "https://token-plan-cn.xiaomimimo.com/v1" }),
    aProvider({ id: "prov-2", name: "My CPA", base_url: "https://cpa.example.com/v1" }),
  ]);
  const cards = [...host.querySelectorAll(".provider-card")];
  expect(cards[0]?.querySelector(".connector-logo.is-xiaomi")).toBeTruthy();
  expect(cards[0]?.querySelector(".provider-plan-chip")?.textContent).toBe("Token Plan · 中国");
  expect(cards[0]?.querySelector(".provider-card-mark")).toBeNull();
  expect(cards[1]?.querySelector(".connector-logo")).toBeNull();
  expect(cards[1]?.querySelector(".provider-card-mark")?.textContent).toBe("M");
  close();
});

test("editing a connector endpoint shows its plan, and picking another probes only that one", async () => {
  const asked: (string | undefined)[] = [];
  const { host, runtime, close } = open(
    [aProvider({ id: "prov-1", name: "小米", base_url: "https://token-plan-cn.xiaomimimo.com/v1" })],
    async (baseUrl) => {
      asked.push(baseUrl);
      return refused;
    },
  );
  click(host.querySelector(".btn-provider-edit"));
  const select = host.querySelector<HTMLSelectElement>("#provider-prov-1-plan")!;
  expect(select.value).toBe("token-plan-cn");
  expect(host.querySelector("#provider-prov-1-url")).toBeNull();
  select.value = "payg";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(1500);
  expect(asked).toEqual(["https://api.xiaomimimo.com/v1"]);
  expect(runtime.calls.filter((c) => c.name === "patchProvider")[0]?.args).toEqual(["prov-1", { base_url: "https://api.xiaomimimo.com/v1" }]);
  close();
});

test("a workspace id pasted as Anthropic's key is pointed to its own field and never tried", async () => {
  const asked: unknown[] = [];
  const { host, close } = open([aProvider()], async (...args) => {
    asked.push(args);
    return refused;
  });
  pick(host, "Anthropic");
  fill(host.querySelector("#provider-add-key"), "wrkspc_01KScB9");
  await sleep(900);
  expect(host.textContent).toContain(t.connectors.keyIsWorkspace);
  expect(asked).toHaveLength(0);
  fill(host.querySelector("#provider-add-workspace"), "wrkspc-x");
  expect(host.querySelector(".workspace-field .field-error")?.textContent).toBe(t.connectors.workspaceInvalid);
  close();
});

test("a saved Anthropic endpoint whose key is refused says a workspace id may have been saved as the key", async () => {
  const { host, close } = open(
    [aProvider({ id: "prov-1", name: "My Anthropic", base_url: "https://api.anthropic.com/", api_format: "anthropic", available_models: [] })],
    async () => ({ ok: false, error: "Endpoint returned 401: Invalid bearer token", status: 401 }),
  );
  click(host.querySelector(".btn-provider-edit"));
  await sleep(50);
  expect(host.querySelector(".models-fetch-tip")?.textContent).toBe(`${t.connectors.keyRefusedSingle("Anthropic")} ${t.connectors.keyMayBeWorkspace}`);
  expect(host.querySelector("#provider-prov-1-workspace")).toBeTruthy();
  close();
});
