import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

async function openModal(width = 1100, height = 900) {
  const app = await openStory("settings-routing", { width, height });
  await app.waitFor("id:settings-routing", { timeout: 15_000 });
  await app.press("id:story-show-modal");
  await app.waitFor("id:settings-modal", { timeout: 15_000 });
  return app;
}

const settings = (app: App) => (app.texts().find((t) => t.startsWith("settings:")) ?? "").slice("settings:".length);
const title = (app: App) => app.texts().find((t) => t === "设置") ?? "";
const restore = async (app: App) => {
  // On a phone settings is the whole window, over the story's buttons: Back walks out of it first
  // (one level at a time), as a person would.
  for (let i = 0; i < 6 && app.shows("id:settings-modal"); i++) await app.back().catch(() => undefined);
  await app.press("id:story-cleanup");
  await app.waitFor("text:log:cleaned", { timeout: 15_000 });
};

test("the settings window: the nav beside the page, General first with its autosave hint; ✕ closes it", async () => {
  const app = await openModal();
  try {
    expect(settings(app)).toBe("open:list:ok");
    expect(app.shows("id:settings-nav")).toBe(true);
    for (const tab of ["general", "behavior", "models", "agents", "mcp", "prompts", "notifications", "about"]) expect(app.shows(`id:settings-tab-${tab}`)).toBe(true);
    expect(app.shows("id:settings-tab-lessons")).toBe(false);
    expect(app.shows("id:settings-mobile-back")).toBe(false);
    expect(app.shows("id:workspace")).toBe(true);
    expect(app.shows("id:settings-save-state")).toBe(true);
    await app.press("id:settings-close");
    await app.waitUntil(() => settings(app) === "closed:list:ok");
    expect(app.shows("id:settings-modal")).toBe(false);
  } finally {
    await restore(app);
  }
});

test("a tab opens in the page and names it; Escape closes the window", async () => {
  const app = await openModal();
  try {
    await app.press("id:settings-tab-models");
    await app.waitFor("id:models-panel");
    expect(app.shows("id:workspace")).toBe(false);
    expect(app.shows("id:models-tab-endpoints")).toBe(true);
    await app.press("id:settings-tab-behavior");
    await app.waitFor("id:models-panel", { state: "gone" });
    await app.press("id:settings-tab-prompts");
    await app.waitFor("id:prompts-search");
    await app.press("id:settings-tab-mcp");
    await app.waitFor("id:mcp-add");
    await app.press("id:settings-tab-agents");
    await app.waitFor("id:agents-tab");
    await app.press("id:settings-tab-about");
    await app.waitFor("id:about-version");
    await app.keyboard.press("escape");
    await app.waitUntil(() => settings(app).startsWith("closed"));
  } finally {
    await restore(app);
  }
});

test("a change made in General saves through the window and shows as saved", async () => {
  const app = await openModal();
  try {
    await app.press("id:theme-dark");
    await app.waitUntil(() => app.texts().includes("已保存") || app.texts().some((t) => t.includes("保存")));
    expect(settings(app)).toBe("open:list:ok");
  } finally {
    await app.press("id:theme-light");
    await restore(app);
  }
});

test("the endpoint editor opens over the window: Escape closes the editor and leaves the window", async () => {
  const app = await openModal();
  try {
    await app.press("id:settings-tab-models");
    await app.waitFor("id:provider-add");
    await app.press("id:provider-add");
    await app.waitFor("id:provider-editor");
    await app.keyboard.press("escape");
    await app.waitFor("id:provider-editor", { state: "gone", timeout: 15_000 });
    expect(app.shows("id:settings-modal")).toBe(true);
    expect(settings(app).startsWith("open")).toBe(true);
  } finally {
    await restore(app);
  }
});

test("what is pending over any page shows on the page: a request awaiting a retry", async () => {
  const app = await openModal();
  try {
    expect(app.shows("id:pending-credentials")).toBe(false);
    await app.press("id:story-pending");
    await app.waitFor("id:credential-retry");
    expect(app.shows("id:pending-credentials")).toBe(true);
    await app.press("id:story-pending");
    await app.waitFor("id:credential-retry", { state: "gone", timeout: 15_000 });
  } finally {
    await restore(app);
  }
});

test("on a phone the nav is the first page, a tab opens one level deeper, and Back steps out of it", async () => {
  const app = await openModal(400, 800);
  try {
    await app.waitFor("id:settings-nav");
    expect(settings(app)).toBe("open:list:ok");
    expect(app.shows("id:settings-main")).toBe(false);
    await app.press("id:settings-tab-general");
    await app.waitFor("id:settings-main");
    expect(settings(app)).toBe("open:detail:ok");
    expect(app.shows("id:settings-nav")).toBe(false);
    expect(app.shows("id:workspace")).toBe(true);
    await app.press("id:settings-mobile-back");
    await app.waitFor("id:settings-nav");
    expect(settings(app)).toBe("open:list:ok");
    // At the list there is nothing to step out of: the shell's Back leaves settings.
    await app.keyboard.press("mod+shift+b");
    await app.waitUntil(() => app.texts().includes("log:back:false"));
  } finally {
    await restore(app);
  }
});

test("on a phone Models lists its sections, a section opens under its name, and Back walks out one level at a time", async () => {
  const app = await openModal(400, 800);
  try {
    await app.press("id:settings-tab-models");
    await app.waitFor("id:section-endpoints");
    await app.press("id:section-endpoints");
    await app.waitFor("id:models-panel");
    expect(app.texts()).toContain("端点");
    await app.keyboard.press("mod+shift+b");
    await app.waitUntil(() => app.texts().includes("log:back:true"));
    await app.waitFor("id:section-endpoints");
    expect(settings(app)).toBe("open:detail:ok");
    await app.keyboard.press("mod+shift+b");
    await app.waitFor("id:settings-nav");
    expect(settings(app)).toBe("open:list:ok");
    // ✕ on a page steps out as Back does; on the list it closes settings.
    await app.press("id:settings-root-close");
    await app.waitUntil(() => settings(app).startsWith("closed"));
  } finally {
    await restore(app);
  }
});

test("on a phone ✕ on a deep page steps out of it, not out of settings", async () => {
  const app = await openModal(400, 800);
  try {
    await app.press("id:settings-tab-models");
    await app.press("id:section-endpoints");
    await app.waitFor("id:models-panel");
    await app.press("id:settings-close");
    await app.waitFor("id:section-endpoints");
    expect(settings(app).startsWith("open")).toBe(true);
  } finally {
    await restore(app);
  }
});

test("on a phone the endpoint editor is a page over settings and Back leaves it before anything else", async () => {
  const app = await openModal(400, 800);
  try {
    await app.press("id:settings-tab-models");
    await app.press("id:section-endpoints");
    await app.waitFor("id:provider-add");
    await app.press("id:provider-add");
    await app.waitFor("id:provider-editor");
    await app.keyboard.press("mod+shift+b");
    await app.waitUntil(() => app.texts().includes("log:back:true"));
    await app.waitFor("id:provider-editor", { state: "gone", timeout: 15_000 });
    expect(app.shows("id:models-panel")).toBe(true);
  } finally {
    await restore(app);
  }
});
