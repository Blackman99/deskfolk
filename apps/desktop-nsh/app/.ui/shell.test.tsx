/** The whole window: the sidebar and the workbench on a desktop, the roster and its pages on a phone, and the window's own keys. */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy";
import { openStory, seeded } from "./fixture";

const t = copyFor("zh");

type App = Awaited<ReturnType<typeof openStory>>;
const stateOf = (app: App) => app.texts().find((x) => x.startsWith("selected:")) ?? "";
const has = (app: App, part: string) => stateOf(app).split(" ").includes(part);

const open = async (options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("shell", { height: 820, ...options });
  await app.waitUntil(() => has(app, "conn:connected"), { timeout: 15_000 });
  await app.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  return app;
};

test("wide: the sidebar beside the workbench; a conversation picked in the list opens as a tab with its composer", async () => {
  const app = await open({ width: 1280 });
  expect(app.shows("id:shell-sidebar")).toBe(true);
  expect(app.shows("id:sidebar-split")).toBe(true);
  // The phone's bottom bar stays off a desktop window, even with nothing open.
  expect(app.shows("id:mobile-nav")).toBe(false);
  await app.press(`id:session-${seeded.writerDirect}`);
  await app.waitUntil(() => has(app, `selected:${seeded.writerDirect}`));
  await app.waitFor("id:composer-drop", { timeout: 10_000 });
  // The tab's bar: its job and its map, the same actions as under its ⋯.
  await app.waitUntil(() => app.texts().includes(t.plan.segmentTrace) && app.texts().includes(t.taskmap.open));
  // The tab itself, in the strip (the workbench is handed the layout as plain objects).
  await app.waitFor("id:chat-tab-name");
  expect(app.shows("id:mobile-nav")).toBe(false);
});

test("wide: a conversation pulled from the list onto the workbench opens as a tab where it is let go", async () => {
  const app = await open({ width: 1280 });
  expect(app.count("id:chat-tab-name")).toBe(0);
  await app.drag(`id:session-${seeded.writerDirect}`, { x: 700, y: 120 });
  await app.waitFor("id:chat-tab-name", { timeout: 10_000 });
  await app.waitFor("id:composer-drop", { timeout: 10_000 });
  expect(app.count("id:chat-tab-name")).toBe(1);
});

test("⌘K opens search and Escape puts it away; Escape also closes the settings window", async () => {
  const app = await open({ width: 1280 });
  await app.keyboard.press("mod+k");
  await app.waitFor("id:global-search");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:global-search") === 0);

  await app.press("id:story-settings");
  await app.waitUntil(() => has(app, "settings:1"));
  await app.keyboard.press("escape");
  await app.waitUntil(() => has(app, "settings:0"));
});

test("⌘B folds the sidebar to its rail and back", async () => {
  const app = await open({ width: 1280 });
  await app.keyboard.press("mod+b");
  await app.waitUntil(() => app.count("id:shell-sidebar") === 0);
  await app.keyboard.press("mod+b");
  await app.waitFor("id:shell-sidebar");
});

test("narrow: the roster fills the window with the bottom bar; a conversation covers it and leaves when put down", async () => {
  const app = await open({ width: 420 });
  expect(app.shows("id:shell-sidebar")).toBe(true);
  expect(app.shows("id:mobile-nav")).toBe(true);
  expect(app.count("id:shell-main")).toBe(0);
  await app.press(`id:session-${seeded.writerDirect}`);
  await app.waitFor("id:conversation", { timeout: 10_000 });
  await app.waitFor("id:composer-drop", { timeout: 10_000 });
  await app.waitUntil(() => app.count("id:mobile-nav") === 0);
  await app.press("id:story-deselect");
  await app.waitUntil(() => app.count("id:conversation") === 0);
  expect(app.shows("id:mobile-nav")).toBe(true);
});

test("narrow: settings is one of the bottom bar's places: its list has no head and the bar stays under it", async () => {
  const app = await open({ width: 420 });
  await app.press("id:nav-settings");
  await app.waitFor("id:settings-nav", { timeout: 10_000 });
  expect(app.shows("id:settings-root-close")).toBe(false);
  expect(app.count("id:mobile-nav")).toBe(1);
  expect(app.shows("id:mobile-nav")).toBe(true);
  // A tab is a page one level deeper: its head with the way back, and no bar.
  await app.press("id:settings-tab-general");
  await app.waitFor("id:settings-main");
  await app.waitUntil(() => app.count("id:mobile-nav") === 0);
  await app.press("id:settings-mobile-back");
  await app.waitFor("id:settings-nav");
  expect(app.count("id:mobile-nav")).toBe(1);
  // The bar leaves settings for another of its places.
  await app.press("id:nav-projects");
  await app.waitUntil(() => has(app, "settings:0"));
  await app.waitUntil(() => app.count("id:settings-nav") === 0);
  expect(app.count("id:mobile-nav")).toBe(1);
});
