import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;
type Item = { id: string; name: string | null; builtin: boolean; revision: number; base: string; diff: Record<string, unknown>; own: { name: string; on: boolean; at: string; then: string; kind: string }[] };
type Probe = { default: string; items: Item[] };

/** The story on the fixture's runtime, with the engines read (the test process has no network of its own). */
async function openPlaybooks(part: "board" | "narrow" = "board") {
  const app = await openStory("settings-playbooks", { width: 1100, height: 900 });
  await app.waitFor("id:settings-playbooks", { timeout: 15_000 });
  if (part === "narrow") await app.press("id:story-show-narrow");
  await app.waitFor(part === "board" ? "id:playbook-row-general" : "id:playbook-chip-general", { timeout: 15_000 });
  return app;
}

/** What the daemon holds, through the story's read button: pressed again until `check` holds (a save lands after the press that made it). */
async function until(app: App, check: (probe: Probe) => boolean, what: string): Promise<Probe> {
  for (let i = 0; i < 40; i++) {
    await app.press("id:story-read");
    await app.wait(150);
    const text = app.texts().find((t) => t.startsWith("probe:{"));
    if (text) {
      const probe = JSON.parse(text.slice("probe:".length)) as Probe;
      if (check(probe)) return probe;
    }
  }
  throw new Error(`never became true: ${what}`);
}

const mine = (probe: Probe) => probe.items.filter((item) => !item.builtin);
const shown = (app: App) => (app.texts().find((t) => t.startsWith("shown:")) ?? "").slice("shown:".length);

/** Puts the engines back as the fixture had them. */
async function restore(app: App) {
  await app.press("id:story-cleanup");
  await app.waitFor("text:log:cleaned", { timeout: 15_000 });
}

test("the list has a row for each engine with the default starred; a row shows its engine and its line", async () => {
  const app = await openPlaybooks();
  for (const id of ["general", "video", "coding", "plain"]) expect(app.shows(`id:playbook-row-${id}`)).toBe(true);
  expect(app.texts().filter((text) => text === "★")).toHaveLength(1);
  expect(app.texts()).toContain("写代码：不要书记员，其余照默认。");
  expect(shown(app)).toBe("general");
  await app.press("id:playbook-row-coding");
  await app.waitUntil(() => shown(app) === "coding");
  // The map is the shown engine's: coding has no scribe.
  expect(app.shows("id:playbook-node-scribe")).toBe(true);
  expect(app.texts()).toContain("已关");
  await app.press("id:playbook-row-general");
  await app.waitUntil(() => shown(app) === "general");
});

test("the + names a new engine from the shown one; rename, history, default and remove are on its menu", async () => {
  const app = await openPlaybooks();
  try {
    await app.press("id:playbook-list-add");
    await app.waitFor("id:playbook-name");
    await app.type("id:playbook-name", "我的引擎");
    await app.submit("id:playbook-name");
    const made = await until(app, (probe) => mine(probe).length === 1, "the engine is made");
    const id = mine(made)[0]!.id;
    expect(mine(made)[0]).toMatchObject({ name: "我的引擎", base: "general", builtin: false });
    // The new engine is the one shown, and its row says what it was made from.
    await app.waitUntil(() => shown(app) === id);
    expect(app.shows(`id:playbook-row-${id}`)).toBe(true);
    expect(app.texts().some((text) => text.includes("通用"))).toBe(true);

    // A right-click offers it all: yours can be renamed and removed.
    await app.rightClick(`id:playbook-row-${id}`);
    await app.waitFor(`id:playbook-menu-${id}`);
    for (const action of ["default", "new", "rename", "history", "remove"]) expect(app.shows(`id:playbook-action-${action}`)).toBe(true);
    await app.press("id:playbook-action-rename");
    await app.waitFor("id:playbook-naming-rename");
    expect(app.shows(`id:playbook-menu-${id}`)).toBe(false);
    await app.clear("id:playbook-name");
    await app.type("id:playbook-name", "改了名");
    await app.submit("id:playbook-name");
    const renamed = await until(app, (probe) => mine(probe)[0]?.name === "改了名", "the engine is renamed");
    expect(mine(renamed)[0]!.revision).toBeGreaterThan(0);
    await app.waitFor("text:改了名");

    // A built-in has no name of its own to change and cannot go.
    await app.rightClick("id:playbook-row-video");
    await app.waitFor("id:playbook-menu-video");
    expect(app.shows("id:playbook-action-rename")).toBe(false);
    expect(app.shows("id:playbook-action-remove")).toBe(false);
    expect(app.shows("id:playbook-action-history")).toBe(true);
    // Under the ⋯ the menu is the same; its history opens beside the map, in the step's place.
    await app.press("id:playbook-action-history");
    await app.waitFor("id:playbook-history-of-video");
    expect(app.shows("id:playbook-step-reader")).toBe(false);
    await app.press("id:playbook-history-close");
    await app.waitFor("id:playbook-history-of-video", { state: "gone", timeout: 15_000 });

    // The history of the renamed one says what changed.
    await app.waitFor(`id:playbook-more-${id}`);
    await app.press(`id:playbook-more-${id}`);
    await app.waitFor(`id:playbook-menu-${id}`);
    await app.press("id:playbook-action-history");
    await app.waitFor(`id:playbook-history-of-${id}`);
    await app.waitFor("id:playbook-history");

    // Making it the default moves the star.
    await app.waitFor(`id:playbook-more-${id}`);
    await app.press(`id:playbook-more-${id}`);
    await app.waitFor("id:playbook-action-default");
    await app.press("id:playbook-action-default");
    await until(app, (probe) => probe.default === id, "it is the default");
    await app.waitFor(`id:playbook-more-${id}`);
    await app.press(`id:playbook-more-${id}`);
    await app.waitFor(`id:playbook-menu-${id}`);
    // The default cannot go.
    expect(app.enabled("id:playbook-action-remove")).toBe(false);
    expect(app.shows("id:playbook-action-default")).toBe(false);
    await app.press("id:playbook-action-new");
    await app.waitFor("id:playbook-naming-new");
    await app.type("id:playbook-name", "第二个");
    await app.submit("id:playbook-name");
    const two = await until(app, (probe) => mine(probe).length === 2, "a second is made");
    expect(mine(two).some((item) => item.name === "第二个" && item.base === "general")).toBe(true);

    // Removing asks first.
    const second = mine(two).find((item) => item.name === "第二个")!.id;
    await app.rightClick(`id:playbook-row-${second}`);
    await app.waitFor("id:playbook-action-remove");
    await app.press("id:playbook-action-remove");
    await app.waitFor("id:danger-confirm");
    await app.press("id:danger-cancel");
    await app.waitFor("id:danger-confirm", { state: "gone", timeout: 15_000 });
    expect(app.shows(`id:playbook-row-${second}`)).toBe(true);
    await app.rightClick(`id:playbook-row-${second}`);
    await app.waitFor("id:playbook-action-remove");
    await app.press("id:playbook-action-remove");
    await app.waitFor("id:danger-confirm");
    await app.press("id:danger-confirm");
    const gone = await until(app, (probe) => mine(probe).length === 1, "the second is removed");
    expect(mine(gone)[0]!.id).toBe(id);
    await app.waitFor(`id:playbook-row-${second}`, { state: "gone", timeout: 15_000 });
  } finally {
    await restore(app);
  }
});

test("a name left blank or with Escape makes nothing", async () => {
  const app = await openPlaybooks();
  try {
    await app.press("id:playbook-list-add");
    await app.waitFor("id:playbook-name");
    await app.submit("id:playbook-name");
    await app.waitFor("id:playbook-naming-new", { state: "gone", timeout: 15_000 });
    await app.press("id:playbook-list-add");
    await app.waitFor("id:playbook-name");
    await app.type("id:playbook-name", "不该有");
    await app.keyboard.press("escape");
    await app.waitFor("id:playbook-naming-new", { state: "gone", timeout: 15_000 });
    await app.wait(300);
    expect(mine(await until(app, () => true, "read"))).toHaveLength(0);
  } finally {
    await restore(app);
  }
});

test("on a phone's column the header has a chip per engine and the actions of the shown one", async () => {
  const app = await openPlaybooks("narrow");
  try {
    for (const id of ["general", "video", "coding", "plain"]) expect(app.shows(`id:playbook-chip-${id}`)).toBe(true);
    expect(app.shows("id:playbook-default")).toBe(true);
    expect(app.shows("id:playbook-action-default")).toBe(false);
    expect(app.shows("id:playbook-action-rename")).toBe(false);
    await app.press("id:playbook-chip-video");
    await app.waitUntil(() => shown(app) === "video");
    expect(app.shows("id:playbook-header-hint")).toBe(true);
    expect(app.shows("id:playbook-action-default")).toBe(true);

    // A new one made from the shown engine.
    await app.press("id:playbook-action-new");
    await app.type("id:playbook-name", "窄屏的");
    await app.press("id:playbook-name-submit");
    const made = await until(app, (probe) => mine(probe).length === 1, "the engine is made");
    expect(mine(made)[0]).toMatchObject({ name: "窄屏的", base: "video" });
    const id = mine(made)[0]!.id;
    await app.waitUntil(() => shown(app) === id);
    expect(app.shows("id:playbook-action-rename")).toBe(true);

    await app.press("id:playbook-action-rename");
    await app.clear("id:playbook-name");
    await app.type("id:playbook-name", "窄屏改");
    await app.press("id:playbook-name-submit");
    await until(app, (probe) => mine(probe)[0]?.name === "窄屏改", "renamed");

    // The history toggles open under the actions.
    await app.press("id:playbook-action-history");
    await app.waitFor("id:playbook-history");
    await app.press("id:playbook-action-history");
    await app.waitFor("id:playbook-history", { state: "gone", timeout: 15_000 });

    // Removing is confirmed in a line of its own; the shown engine falls back to the default.
    await app.press("id:playbook-action-remove");
    await app.waitFor("id:playbook-confirm-remove");
    await app.press("id:playbook-confirm-cancel");
    await app.waitFor("id:playbook-confirm-remove", { state: "gone", timeout: 15_000 });
    await app.press("id:playbook-action-remove");
    await app.waitFor("id:playbook-confirm-remove");
    await app.press("id:playbook-confirm-remove");
    await until(app, (probe) => mine(probe).length === 0, "removed");
    await app.waitUntil(() => shown(app) === "general");

    // Making another default.
    await app.press("id:playbook-chip-coding");
    await app.press("id:playbook-action-default");
    await until(app, (probe) => probe.default === "coding", "coding is the default");
    await app.waitFor("id:playbook-default");
  } finally {
    await restore(app);
  }
});
