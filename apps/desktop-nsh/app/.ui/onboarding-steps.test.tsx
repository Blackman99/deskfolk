import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");
type App = Awaited<ReturnType<typeof openStory>>;
type Api = { seq: number; workspace: string; providers: { name: string; url: string; models: number; default: string | null }[]; bots: number; groups: number };

async function open(): Promise<App> {
  const app = await openStory("onboarding");
  await app.waitFor("id:onboarding-step-1", { timeout: 15_000 });
  return app;
}
/** The runtime fills the endpoint form from the saved endpoint once its snapshot is in; presets and typing come after. */
async function toProvider(app: App) {
  await app.press("id:onboarding-next-1");
  await app.waitFor("id:onboarding-endpoint");
  await app.waitUntil(() => app.value("id:onboarding-endpoint") === "http://127.0.0.1:9/v1");
}
const text = (app: App, prefix: string) => app.texts().find((line) => line.startsWith(prefix)) ?? "";
const readApi = async (app: App): Promise<Api> => {
  const before = Number(/"seq":(\d+)/.exec(text(app, '{"seq"'))?.[1] ?? 0);
  await app.press("id:story-read");
  await app.waitUntil(() => Number(/"seq":(\d+)/.exec(text(app, '{"seq"'))?.[1] ?? 0) > before);
  return JSON.parse(text(app, '{"seq"')) as Api;
};

test("the first pane is the workspace; Next leads on and the step bar leads back", async () => {
  const app = await open();
  try {
    expect(app.shows(`text:${t.onboarding.stepWorkspace}`)).toBe(true);
    expect(app.shows("id:onboarding-locale")).toBe(true);
    expect(app.enabled("id:onboarding-next-1")).toBe(true);
    // The default workspace button fills the path in; it stays a valid one.
    await app.press("id:onboarding-workspace-default");
    expect(app.enabled("id:onboarding-next-1")).toBe(true);
    await app.press("id:onboarding-next-1");
    await app.waitFor("id:onboarding-step-2");
    expect(app.shows("id:onboarding-step-1")).toBe(false);
    // A finished step is a check and opens again.
    await app.press("id:onboarding-step-tab-1");
    await app.waitFor("id:onboarding-step-1");
    // The footer's skip link tells the caller.
    await app.press("id:onboarding-skip");
    await app.waitFor("text:dismissed:1");
  } finally {
    await app.press("id:story-restore");
    await app.waitFor("id:onboarding-step-1");
  }
});

test("a preset fills the endpoint form, the format and the name; the other way asks for a local agent", async () => {
  const app = await open();
  try {
    await toProvider(app);
    await app.press("id:preset-ollama");
    await app.waitUntil(() => app.value("id:onboarding-endpoint") === "http://localhost:11434/v1");
    expect(app.value("id:onboarding-provider-name")).toBe("Ollama");
    expect(app.shows(`text:${t.onboarding.localPresetHint}`)).toBe(true);
    // A model server on this computer needs no key: Next is open without one.
    expect(app.enabled("id:onboarding-next-2")).toBe(true);

    await app.press("id:preset-anthropic");
    await app.waitUntil(() => app.value("id:onboarding-endpoint") === "https://api.anthropic.com");
    expect(app.shows(`text:${t.settings.apiFormatAnthropicHint}`)).toBe(true);
    expect(app.shows(`text:${t.onboarding.localPresetHint}`)).toBe(false);

    // An emptied name is refused on Next, with its reason under the field.
    await app.clear("id:onboarding-provider-name");
    // The step bar takes the same validation path as Next.
    await app.press("id:onboarding-step-tab-3");
    await app.waitFor("text:" + t.settings.providerNameEmpty);
    expect(app.shows("id:onboarding-step-3")).toBe(false);
    await app.type("id:onboarding-provider-name", "Mine");
    expect(app.shows(`text:${t.settings.providerNameEmpty}`)).toBe(false);

    // Claude Code instead of an endpoint: the endpoint's fields go, its check card comes.
    await app.press("id:connect-mode-claude");
    await app.waitFor("text:" + t.onboarding.claudeCheckDesc);
    expect(app.shows("id:onboarding-endpoint")).toBe(false);
    await app.press("id:connect-mode-endpoint");
    await app.waitFor("id:onboarding-endpoint");
  } finally {
    await app.press("id:story-restore");
  }
});

test("the models step lists the picked ones, takes a name added, refuses none, and the default is one of them", async () => {
  const app = await open();
  try {
    await toProvider(app);
    // A local server with a nothing-listing preset: the list is the manual one.
    await app.press("id:preset-lmstudio");
    await app.waitUntil(() => app.value("id:onboarding-endpoint") === "http://localhost:1234/v1");
    await app.press("id:onboarding-next-2");
    await app.waitFor("id:onboarding-step-3");
    // The runtime may still be filling the form from the saved endpoint; let it, then start from none.
    await app.wait(1500);
    await app.press("id:models-manual-toggle");
    await app.waitFor("id:endpoint-models");
    await app.clear("id:endpoint-models");
    await app.waitUntil(() => !app.enabled("id:onboarding-next-3"));
    await app.press("id:models-manual-toggle");
    await app.waitFor("id:custom-model-input");

    await app.type("id:custom-model-input", "alpha");
    await app.press("id:custom-model-add");
    await app.waitFor("id:model-chip-alpha");
    await app.type("id:custom-model-input", "beta");
    await app.submit("id:custom-model-input");
    await app.waitFor("id:model-chip-beta");
    // The first ticked becomes the default; Next is open.
    await app.waitUntil(() => app.enabled("id:onboarding-next-3"));
    // Unticking all closes it again, and ticking one brings a default back.
    await app.press("id:model-chip-alpha");
    await app.press("id:model-chip-beta");
    await app.waitUntil(() => !app.enabled("id:onboarding-next-3"));
    await app.press("id:model-chip-beta");
    await app.waitUntil(() => app.enabled("id:onboarding-next-3"));

    // The manual list is the same models as lines.
    await app.press("id:models-manual-toggle");
    await app.waitFor("id:endpoint-models");
    expect(app.value("id:endpoint-models")).toBe("beta");
    await app.press("id:onboarding-back-3");
    await app.waitFor("id:onboarding-step-2");
  } finally {
    await app.press("id:story-restore");
  }
});

test("hosted has no workspace step; its first step is the endpoint", async () => {
  const app = await open();
  try {
    await app.press("id:story-hosted");
    await app.waitFor("id:onboarding-step-2");
    expect(app.shows("id:onboarding-step-tab-1")).toBe(false);
    expect(app.shows(`text:${t.settings.workspaceHostOnly}`)).toBe(true);
    expect(app.shows("id:onboarding-back-2")).toBe(false);
  } finally {
    await app.press("id:story-restore");
    await app.waitFor("id:onboarding-step-1");
  }
});

test("the language switch on the card follows the wizard", async () => {
  const app = await open();
  try {
    await app.press("id:locale-en");
    await app.waitFor("text:" + copyFor("en").onboarding.stepWorkspace);
    expect(app.shows(`text:${t.onboarding.stepWorkspace}`)).toBe(false);
  } finally {
    await app.press("id:locale-zh");
    await app.waitFor("text:" + t.onboarding.stepWorkspace);
    await app.press("id:story-restore");
  }
});

test("finishing on an endpoint saves the workspace and the endpoint, and lets the caller go (the roster is not empty)", async () => {
  const app = await open();
  try {
    const before = await readApi(app);
    expect(before.providers[0]?.name).toBe("Default");
    await app.press("id:onboarding-next-1");
    await app.waitFor("id:onboarding-provider-name");
    await app.clear("id:onboarding-provider-name");
    await app.type("id:onboarding-provider-name", "Wizard");
    await app.waitUntil(() => app.enabled("id:onboarding-next-2"));
    await app.press("id:onboarding-next-2");
    await app.waitFor("id:onboarding-step-3");
    await app.waitUntil(() => app.enabled("id:onboarding-next-3"));
    // With Bots on the roster the button says finish, and the wizard is not held for a Bot step.
    expect(app.shows(`text:${t.onboarding.submit} ✓`)).toBe(true);
    await app.press("id:onboarding-next-3");
    await app.waitUntil(() => text(app, "holding:") === "holding:false");
    let after = await readApi(app);
    for (let i = 0; i < 20 && after.providers[0]?.name !== "Wizard"; i++) {
      await app.wait(250);
      after = await readApi(app);
    }
    expect(after.providers).toHaveLength(before.providers.length);
    expect(after.providers[0]?.name).toBe("Wizard");
    expect(after.bots).toBe(before.bots);
    expect(app.shows("id:onboarding-step-4")).toBe(false);
  } finally {
    await app.press("id:story-restore");
    await app.waitUntil(() => text(app, '{"seq"').includes('"name":"Default"'), { timeout: 10_000 });
  }
});
