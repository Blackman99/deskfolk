import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type Api = {
  seq: number;
  providers: { id: string; name: string; url: string | null; key: boolean; models: string[]; default: string | null }[];
  mcp: { name: string; transport: string; command: string; args: string[]; url: string | null; enabled: boolean; note: string | null }[];
};
type App = Awaited<ReturnType<typeof openStory>>;

/** The runtime's own list (a GET the story makes), not the snapshot the page draws. */
async function readApi(app: App, last: { seq: number }): Promise<Api> {
  await app.press("id:api-refresh");
  const find = () => app.texts().find((text) => text.startsWith('{"seq":'));
  await app.waitUntil(() => {
    const text = find();
    return text !== undefined && (JSON.parse(text) as Api).seq > last.seq;
  });
  const got = JSON.parse(find()!) as Api;
  last.seq = got.seq;
  return got;
}

async function opened(options: { width?: number; height?: number } = {}) {
  const app = await openStory("settings-providers", options);
  await app.waitFor("id:providers-tab", { timeout: 15_000 });
  const last = { seq: 0 };
  return { app, api: () => readApi(app, last) };
}

async function cleanUp(app: App) {
  await app.press("id:api-cleanup");
  await app.wait(400);
}

/** Adds a custom endpoint through the editor; the editor ends open on the new endpoint. */
async function addCustom(app: App, name: string, url = "http://127.0.0.1:9/v1", key = "sk-not-real") {
  await app.press("id:provider-add");
  await app.waitFor("id:connector-pick-custom");
  await app.press("id:connector-pick-custom");
  await app.waitFor("id:provider-add-name");
  await app.type("id:provider-add-name", name);
  await app.type("id:provider-add-url", url);
  await app.type("id:provider-add-key", key);
  await app.waitFor("id:provider-add-key", { state: "gone", timeout: 15_000 });
}

const idOf = async (api: () => Promise<Api>, name: string) => (await api()).providers.find((row) => row.name === name)?.id;

test("the page lists the endpoint the fixture seeded: name, default model, model count and its actions", async () => {
  const { app, api } = await opened();
  const seeded = (await api()).providers[0]!;
  await app.waitFor(`id:provider-card-${seeded.id}`);
  expect(app.shows(`id:provider-name-${seeded.id}`)).toBe(true);
  expect(app.shows("text:管理模型端点，选择各端点的默认模型。")).toBe(true);
  expect(app.shows("text:添加端点")).toBe(true);
  expect(app.texts()).toContain("1 个模型");
  expect(app.shows(`id:default-model-${seeded.id}`)).toBe(true);
  expect(app.shows(`id:provider-edit-${seeded.id}`)).toBe(true);
  expect(app.shows(`id:provider-delete-${seeded.id}`)).toBe(true);
  expect(app.shows(`id:provider-models-${seeded.id}`)).toBe(true);
  // The only endpoint is the default: it has the badge and no "set as default".
  expect(app.shows(`id:provider-badge-default-${seeded.id}`)).toBe(true);
  expect(app.shows(`id:provider-default-${seeded.id}`)).toBe(false);
});

test("adding starts on the connector tiles; the custom form creates the endpoint, lists it, and the fetch error shows", async () => {
  const { app, api } = await opened();
  try {
    await app.press("id:provider-add");
    await app.waitFor("id:connector-pick-custom");
    for (const id of ["anthropic", "xiaomi", "qwen", "deepseek"]) expect(app.shows(`id:connector-pick-${id}`)).toBe(true);
    await app.press("id:connector-pick-custom");
    await app.waitFor("id:provider-add-name");
    expect(app.shows("id:provider-add-format-openai")).toBe(true);
    await app.type("id:provider-add-name", "T-fake");
    await app.type("id:provider-add-url", "http://127.0.0.1:9/v1");
    await app.type("id:provider-add-key", "sk-not-real");
    // Created a moment after typing stops; the editor moves on to the new endpoint's models.
    await app.waitUntil(() => app.texts().includes("已自动保存"), { timeout: 15_000 });
    const made = (await api()).providers.find((row) => row.name === "T-fake");
    expect(made?.url).toBe("http://127.0.0.1:9/v1");
    expect(made?.key).toBe(true);
    await app.waitFor(`id:provider-${made!.id}-models-label`);
    // The fake address refuses at once; the messenger's error state is the fetch tip.
    expect(app.shows(`id:provider-${made!.id}-fetch-error`)).toBe(false);
    await app.press(`id:provider-${made!.id}-fetch`);
    await app.waitFor(`id:provider-${made!.id}-fetch-error`, { timeout: 15_000 });
    expect(app.texts().some((text) => text.startsWith("未能获取模型列表"))).toBe(true);
    await app.press("id:modal-close");
    await app.waitFor("id:provider-editor", { state: "gone" });
    await app.waitFor(`id:provider-card-${made!.id}`);
    expect(app.shows("text:T-fake")).toBe(true);
  } finally {
    await cleanUp(app);
  }
});

test("a key field is masked and never drawn as text; nothing is created until the key is there", async () => {
  const { app, api } = await opened();
  try {
    await app.press("id:provider-add");
    await app.press("id:connector-pick-custom");
    await app.waitFor("id:provider-add-name");
    await app.type("id:provider-add-name", "T-nokey");
    await app.type("id:provider-add-url", "https://example.invalid/v1");
    await app.wait(1500);
    expect((await api()).providers.find((row) => row.name === "T-nokey")).toBeUndefined();
    await app.type("id:provider-add-key", "sk-secret-value");
    expect(app.texts().join("\n")).not.toContain("sk-secret-value");
    await app.waitUntil(() => app.texts().includes("已自动保存"), { timeout: 15_000 });
    expect((await api()).providers.find((row) => row.name === "T-nokey")?.key).toBe(true);
    expect(app.texts().join("\n")).not.toContain("sk-secret-value");
  } finally {
    await cleanUp(app);
  }
});

test("an address that is not a URL creates nothing, and the endpoint appears once it is one", async () => {
  const { app, api } = await opened();
  try {
    await app.press("id:provider-add");
    await app.press("id:connector-pick-custom");
    await app.waitFor("id:provider-add-name");
    await app.type("id:provider-add-name", "T-bad");
    await app.type("id:provider-add-url", "not a url");
    await app.type("id:provider-add-key", "sk-x");
    await app.wait(1500);
    expect((await api()).providers.find((row) => row.name === "T-bad")).toBeUndefined();
    await app.clear("id:provider-add-url");
    await app.type("id:provider-add-url", "http://127.0.0.1:9/v1");
    await app.waitUntil(() => app.texts().includes("已自动保存"), { timeout: 15_000 });
    expect((await api()).providers.find((row) => row.name === "T-bad")?.url).toBe("http://127.0.0.1:9/v1");
  } finally {
    await cleanUp(app);
  }
});

test("editing a saved endpoint renames it, keeps the key field empty with its badge, and the list follows", async () => {
  const { app, api } = await opened();
  try {
    await addCustom(app, "T-rename");
    const id = (await idOf(api, "T-rename"))!;
    await app.press("id:modal-close");
    await app.waitFor("id:provider-editor", { state: "gone" });
    await app.press(`id:provider-edit-${id}`);
    await app.waitFor(`id:provider-${id}-name`);
    expect(app.value(`id:provider-${id}-name`)).toBe("T-rename");
    expect(app.value(`id:provider-${id}-key`) ?? "").toBe("");
    expect(app.shows(`id:provider-${id}-key-badge`)).toBe(true);
    expect(app.texts()).toContain("已配置");
    await app.clear(`id:provider-${id}-name`);
    await app.type(`id:provider-${id}-name`, "T-renamed");
    await app.waitUntil(() => app.texts().includes("已自动保存"), { timeout: 15_000 });
    expect((await api()).providers.find((row) => row.id === id)?.name).toBe("T-renamed");
    await app.press("id:modal-close");
    await app.waitFor("id:provider-editor", { state: "gone" });
    await app.waitFor("text:T-renamed");
  } finally {
    await cleanUp(app);
  }
});

test("the models view adds names by hand, enables them, and the default model picks from them", async () => {
  const { app, api } = await opened();
  try {
    await addCustom(app, "T-models");
    const id = (await idOf(api, "T-models"))!;
    await app.waitFor(`id:provider-${id}-manual-open`);
    await app.press(`id:provider-${id}-manual-open`);
    await app.type(`id:provider-${id}-manual-input`, "alpha-1");
    await app.press(`id:provider-${id}-manual-confirm`);
    await app.waitFor(`id:model-row-alpha-1`);
    await app.type(`id:provider-${id}-manual-input`, "beta-2");
    await app.submit(`id:provider-${id}-manual-input`);
    await app.waitFor(`id:model-row-beta-2`);
    expect(app.texts()).toContain("已启用 beta-2");
    // A name already on the list is said so, not added twice.
    await app.type(`id:provider-${id}-manual-input`, "beta-2");
    await app.submit(`id:provider-${id}-manual-input`);
    await app.waitFor("text:这个模型已经启用。");
    await app.waitUntil(() => app.texts().includes("已自动保存"), { timeout: 15_000 });
    await app.waitUntil(async () => (await api()).providers.find((row) => row.id === id)?.models.length === 2, { timeout: 15_000 });
    const saved = (await api()).providers.find((row) => row.id === id)!;
    expect(saved.models).toEqual(["alpha-1", "beta-2"]);
    // The box is the toggle; a name typed by hand that is off is no longer listed.
    await app.press("id:model-toggle-beta-2");
    await app.waitUntil(() => app.texts().includes("已启用 1 · 可用 1"));
    expect(app.shows("id:model-row-beta-2")).toBe(false);
    await app.press("id:modal-close");
    await app.waitFor("id:provider-editor", { state: "gone" });
    await app.waitFor(`id:provider-models-count-${id}`);
    expect(app.shows(`id:default-model-${id}`)).toBe(true);
  } finally {
    await cleanUp(app);
  }
});

test("a long model list gets search and filters; select and clear act on what the search shows", async () => {
  const { app, api } = await opened();
  try {
    await addCustom(app, "T-long");
    const id = (await idOf(api, "T-long"))!;
    const names = ["gpt-a", "gpt-b", "claude-a", "claude-b", "gemini-a", "gemini-b", "qwen-a", "qwen-b", "llama-a"];
    expect(app.shows(`id:provider-${id}-model-search`)).toBe(false);
    for (const name of names) {
      await app.press(`id:provider-${id}-manual-open`).catch(() => {});
      await app.type(`id:provider-${id}-manual-input`, name);
      await app.submit(`id:provider-${id}-manual-input`);
      await app.waitFor(`id:model-row-${name}`);
    }
    await app.waitFor(`id:provider-${id}-model-search`);
    await app.type(`id:provider-${id}-model-search`, "claude");
    await app.waitFor("id:model-row-claude-a");
    expect(app.shows("id:model-row-gpt-a")).toBe(false);
    // Everything shown is on, so "select" has nothing to do; "clear" turns the two off.
    expect(app.enabled(`id:provider-${id}-select-visible`)).toBe(false);
    await app.press(`id:provider-${id}-clear-visible`);
    await app.waitFor("id:model-row-claude-a", { state: "gone" });
    await app.waitFor(`id:provider-${id}-model-none`);
    await app.press(`id:provider-${id}-model-search-clear`);
    await app.waitFor("id:model-row-gpt-a");
    expect(app.texts()).toContain("已启用 7 · 可用 7");
    await app.press(`id:provider-${id}-filter-enabled`);
    expect(app.shows("id:model-row-qwen-a")).toBe(true);
    await app.type(`id:provider-${id}-model-search`, "zzz");
    await app.waitFor(`id:provider-${id}-model-none`);
  } finally {
    await cleanUp(app);
  }
});

test("a model's attributes open under its row: a price and a strength chip, and the row shows them", async () => {
  const { app, api } = await opened();
  try {
    await addCustom(app, "T-attrs");
    const id = (await idOf(api, "T-attrs"))!;
    await app.press(`id:provider-${id}-manual-open`);
    await app.type(`id:provider-${id}-manual-input`, "pricey-1");
    await app.submit(`id:provider-${id}-manual-input`);
    await app.waitFor("id:model-attrs-toggle-pricey-1");
    await app.press("id:model-attrs-toggle-pricey-1");
    await app.waitFor("id:model-attrs-pricey-1");
    await app.type(`id:provider-${id}-price-pricey-1`, "2.5");
    await app.press(`id:provider-${id}-strength-code-pricey-1`);
    await app.press(`id:provider-${id}-strength-add-pricey-1`);
    await app.type(`id:provider-${id}-strength-input-pricey-1`, "vision");
    await app.submit(`id:provider-${id}-strength-input-pricey-1`);
    await app.waitFor(`id:provider-${id}-strength-vision-pricey-1`);
    // The row's pills show the price and the tags.
    expect(app.texts()).toContain("2.5");
    expect(app.texts()).toContain("vision");
    // A billing figure that is not a number is flagged.
    await app.type(`id:provider-${id}-billingInput-pricey-1`, "abc");
    await app.waitFor(`id:provider-${id}-billing-error-pricey-1`);
    await app.press("id:model-attrs-toggle-pricey-1");
    await app.waitFor("id:model-attrs-pricey-1", { state: "gone" });
  } finally {
    await cleanUp(app);
  }
});

test("the speed test of a saved endpoint reports the failure when the address does not answer", async () => {
  const { app, api } = await opened();
  try {
    await addCustom(app, "T-speed");
    const id = (await idOf(api, "T-speed"))!;
    await app.press(`id:provider-${id}-manual-open`);
    await app.type(`id:provider-${id}-manual-input`, "slow-1");
    await app.submit(`id:provider-${id}-manual-input`);
    await app.waitUntil(async () => (await api()).providers.find((row) => row.id === id)?.models.includes("slow-1") === true, { timeout: 15_000 });
    await app.press("id:model-attrs-toggle-slow-1");
    await app.waitFor(`id:provider-${id}-speed-run-slow-1`);
    await app.press(`id:provider-${id}-speed-run-slow-1`);
    await app.waitUntil(() => app.shows(`id:provider-${id}-speed-result-slow-1`) || app.shows(`id:provider-${id}-speed-error-slow-1`) || app.texts().some((text) => text.includes("没连上") || text.includes("失败")), {
      timeout: 20_000,
    });
  } finally {
    await cleanUp(app);
  }
});

test("a built-in connector asks for a key alone, waits for it, and offers the custom form", async () => {
  const { app } = await opened();
  await app.press("id:provider-add");
  await app.waitFor("id:connector-pick-deepseek");
  await app.press("id:connector-pick-deepseek");
  await app.waitFor("id:provider-add-key");
  expect(app.shows("id:provider-add-url")).toBe(false);
  expect(app.shows("id:provider-add-name")).toBe(true);
  expect(app.shows("id:provider-add-status")).toBe(true);
  expect(app.shows("id:provider-add-use-custom")).toBe(true);
  await app.press("id:provider-add-use-custom");
  await app.waitFor("id:provider-add-url");
  expect(app.value("id:provider-add-url")).toContain("http");
  // Back steps out of the form to the tiles, and the editor closes from there.
  await app.press("id:modal-close");
  await app.waitFor("id:provider-editor", { state: "gone" });
});

test("Anthropic's connector also asks for a workspace id and says when it is malformed", async () => {
  const { app } = await opened();
  await app.press("id:provider-add");
  await app.press("id:connector-pick-anthropic");
  await app.waitFor("id:provider-add-workspace");
  await app.type("id:provider-add-workspace", "nope");
  await app.waitFor("id:provider-add-workspace-error");
});

test("deleting asks first; cancel keeps the endpoint, confirm takes it off the list", async () => {
  const { app, api } = await opened();
  try {
    await addCustom(app, "T-delete");
    const id = (await idOf(api, "T-delete"))!;
    await app.press("id:modal-close");
    await app.waitFor("id:provider-editor", { state: "gone" });
    await app.press(`id:provider-delete-${id}`);
    await app.waitFor("id:danger-dialog");
    await app.press("id:danger-cancel");
    await app.waitFor("id:danger-dialog", { state: "gone" });
    expect(await idOf(api, "T-delete")).toBe(id);
    await app.press(`id:provider-delete-${id}`);
    await app.press("id:danger-confirm");
    await app.waitFor(`id:provider-card-${id}`, { state: "gone", timeout: 15_000 });
    expect(await idOf(api, "T-delete")).toBeUndefined();
  } finally {
    await cleanUp(app);
  }
});

test("a second endpoint can be made the default, and the badge moves", async () => {
  const { app, api } = await opened();
  try {
    await addCustom(app, "T-second");
    const id = (await idOf(api, "T-second"))!;
    const first = (await api()).providers.find((row) => row.name !== "T-second")!;
    await app.press("id:modal-close");
    await app.waitFor("id:provider-editor", { state: "gone" });
    expect(app.shows(`id:provider-badge-default-${first.id}`)).toBe(true);
    // No key would show a "not configured" badge; this one has a key, so it does not.
    expect(app.shows(`id:provider-badge-key-${id}`)).toBe(false);
    await app.press(`id:provider-default-${id}`);
    await app.waitFor(`id:provider-badge-default-${id}`, { timeout: 15_000 });
    expect(app.shows(`id:provider-badge-default-${first.id}`)).toBe(false);
    // Put it back so the next file finds the fixture as it was.
    await app.press(`id:provider-default-${first.id}`);
    await app.waitFor(`id:provider-badge-default-${first.id}`, { timeout: 15_000 });
  } finally {
    await cleanUp(app);
  }
});

test("on a phone the editor is a page: Back steps out of the model page, the status line is under it", async () => {
  const { app, api } = await opened({ width: 420, height: 820 });
  try {
    await app.press("id:provider-add");
    await app.waitFor("id:connector-pick-custom");
    // Back from the tiles closes the editor.
    await app.press("id:modal-back");
    await app.waitFor("id:provider-editor", { state: "gone" });
    await addCustom(app, "T-phone");
    const id = (await idOf(api, "T-phone"))!;
    await app.waitFor("id:provider-mobile-status");
    expect(app.shows("id:provider-editor-context")).toBe(true);
    await app.press(`id:provider-${id}-manual-open`);
    await app.type(`id:provider-${id}-manual-input`, "phone-1");
    await app.submit(`id:provider-${id}-manual-input`);
    await app.waitFor("id:model-attrs-toggle-phone-1");
    // A phone always has the search and the filters.
    expect(app.shows(`id:provider-${id}-model-search`)).toBe(true);
    await app.press("id:model-attrs-toggle-phone-1");
    await app.waitFor(`id:provider-${id}-model-detail`);
    expect(app.texts()).toContain("模型属性");
    expect(app.shows(`id:provider-${id}-model-search`)).toBe(false);
    await app.press("id:modal-back");
    await app.waitFor(`id:provider-${id}-model-detail`, { state: "gone" });
    expect(app.shows("id:provider-editor")).toBe(true);
    await app.press("id:modal-back");
    await app.waitFor("id:provider-editor", { state: "gone" });
  } finally {
    await cleanUp(app);
  }
});

test("MCP: adding a server asks twice, lists it, and a rename saves itself without a button", async () => {
  const { app, api } = await opened();
  try {
    expect(app.shows("text:还没有 MCP 服务器。")).toBe(true);
    await app.press("id:mcp-add");
    await app.waitFor("id:mcp-editor-name");
    expect(app.shows("id:mcp-editor-command")).toBe(true);
    expect(app.shows("id:mcp-editor-url")).toBe(false);
    // An empty name is refused first.
    await app.press("id:mcp-submit");
    await app.waitFor("id:mcp-editor-name-error");
    await app.type("id:mcp-editor-name", "T-files");
    await app.press("id:mcp-submit");
    await app.waitFor("id:mcp-editor-command-error");
    await app.type("id:mcp-editor-command", "bun");
    await app.type("id:mcp-editor-args", "run server.ts");
    await app.press("id:mcp-submit");
    // The first press only asks for confirmation.
    await app.waitFor("text:确认添加");
    expect((await api()).mcp.length).toBe(0);
    await app.press("id:mcp-submit");
    await app.waitFor("id:mcp-editor", { state: "gone", timeout: 15_000 });
    const made = (await api()).mcp.find((row) => row.name === "T-files");
    expect(made).toMatchObject({ transport: "stdio", command: "bun", args: ["run", "server.ts"], enabled: true });
    await app.waitFor("text:T-files");
    expect(app.texts()).toContain("stdio");
    // Open it, rename: saved by itself, no submit button.
    const row = app.texts().find((text) => text === "T-files");
    expect(row).toBeTruthy();
    await app.press("text:T-files");
    await app.waitFor("id:mcp-editor-name");
    expect(app.value("id:mcp-editor-name")).toBe("T-files");
    expect(app.shows("id:mcp-submit")).toBe(false);
    expect(app.shows("id:mcp-delete")).toBe(true);
    await app.clear("id:mcp-editor-name");
    await app.type("id:mcp-editor-name", "T-docs");
    await app.type("id:mcp-editor-usage-note", "for docs only");
    await app.waitUntil(() => app.texts().includes("已自动保存"), { timeout: 15_000 });
    const saved = (await api()).mcp.find((item) => item.name === "T-docs");
    expect(saved?.note).toBe("for docs only");
    expect(saved?.command).toBe("bun");
    // Changing the command needs the button, and a second press.
    await app.type("id:mcp-editor-command", "x");
    await app.waitFor("id:mcp-submit");
    expect(app.texts()).toContain("确认改连接");
    expect((await api()).mcp.find((item) => item.name === "T-docs")?.command).toBe("bun");
  } finally {
    await cleanUp(app);
  }
});

test("MCP: an HTTP server asks for an address, search narrows the list, the box turns it off, delete removes it", async () => {
  const { app, api } = await opened();
  try {
    await app.press("id:mcp-add");
    await app.waitFor("id:mcp-editor-transport");
    await app.press("id:mcp-editor-transport");
    await app.press("text:HTTP");
    await app.waitFor("id:mcp-editor-url");
    expect(app.shows("id:mcp-editor-command")).toBe(false);
    await app.type("id:mcp-editor-name", "T-web");
    await app.type("id:mcp-editor-url", "not-a-url");
    await app.press("id:mcp-submit");
    await app.waitFor("id:mcp-editor-url-error");
    await app.clear("id:mcp-editor-url");
    await app.type("id:mcp-editor-url", "http://127.0.0.1:9/mcp");
    await app.press("id:mcp-submit");
    await app.press("id:mcp-submit");
    await app.waitFor("id:mcp-editor", { state: "gone", timeout: 15_000 });
    const made = (await api()).mcp.find((row) => row.name === "T-web");
    expect(made).toMatchObject({ transport: "http", url: "http://127.0.0.1:9/mcp", enabled: true });
    await app.waitFor("id:mcp-search");
    await app.type("id:mcp-search", "zzz-nothing");
    await app.waitFor("id:mcp-empty");
    expect(app.texts()).toContain("没有匹配的 MCP 服务器。");
    await app.press("id:mcp-search-clear");
    await app.waitFor("text:T-web");
    // The enable box turns it off, saved at once.
    const card = app.texts().includes("T-web");
    expect(card).toBe(true);
    await app.press("text:启用");
    await app.waitUntil(async () => (await api()).mcp.find((row) => row.name === "T-web")?.enabled === false, { timeout: 15_000 });
    await app.press("text:T-web");
    await app.waitFor("id:mcp-delete");
    await app.press("id:mcp-delete");
    await app.waitFor("id:mcp-editor", { state: "gone", timeout: 15_000 });
    expect((await api()).mcp.find((row) => row.name === "T-web")).toBeUndefined();
  } finally {
    await cleanUp(app);
  }
});
