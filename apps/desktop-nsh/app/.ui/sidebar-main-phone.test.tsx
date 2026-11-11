/** The list on a phone: the tools beside the search, two pages (Bots and projects), the floating create button, the archived page. */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy";
import { openStory, seeded } from "./fixture";

const t = copyFor("zh");
type App = Awaited<ReturnType<typeof open>>;
const open = async () => {
  const app = await openStory("sidebar-main", { width: 390, height: 844 });
  await app.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  return app;
};
const logText = (app: App) => app.texts().find((x) => x.startsWith("log:")) ?? "";
const logged = (app: App, line: string) => logText(app).split(" ").includes(line);

test("a phone's list has the tools beside the search and no brand row, footer or section +", async () => {
  const app = await open();
  expect(app.shows("id:search-wrap >> id:tools-toggle")).toBe(true);
  expect(app.shows("id:search-trigger")).toBe(true);
  expect(app.shows("id:working-filter")).toBe(true);
  expect(app.shows("id:focus-toggle")).toBe(true);
  expect(app.shows("id:brand-row")).toBe(false);
  expect(app.shows("id:sidebar-foot")).toBe(false);
  expect(app.shows("id:bot-add")).toBe(false);
  expect(app.shows("id:create-fab")).toBe(true);
});

test("creating is the floating button, asking which once", async () => {
  const app = await open();
  await app.press("id:create-fab");
  await app.waitFor("id:fab-menu");
  expect(app.shows("id:fab-add-bot")).toBe(true);
  expect(app.shows("id:project-add-new")).toBe(false);
  await app.press("id:fab-add-group");
  await app.waitUntil(() => logged(app, "create-group"));
  await app.waitFor("id:fab-menu", { state: "gone" });
});

test("the projects page lists only projects, says how to start one, and its create button makes only project sessions", async () => {
  const app = await open();
  await app.press("id:phone-projects");
  await app.waitFor("text:" + t.project.emptyList);
  expect(app.shows(`id:session-${seeded.writerDirect}`)).toBe(false);
  expect(app.shows(`text:${t.sidebar.botsTab}`)).toBe(false);
  expect(app.shows("id:projects-empty-import")).toBe(true);
  await app.press("id:create-fab");
  await app.waitFor("id:fab-menu");
  expect(app.shows("id:fab-add-bot")).toBe(false);
  expect(app.shows("id:project-add-new")).toBe(true);
  expect(app.shows("id:project-add-import")).toBe(true);
});

test("the archived list is a page of its own with a head and Back", async () => {
  const app = await open();
  await app.press("id:show-archived");
  await app.waitFor("id:mobile-archived-head");
  expect(app.shows("id:search-trigger")).toBe(false);
  expect(app.shows("id:create-fab")).toBe(false);
  expect(app.shows(`text:${t.sidebar.archivedEmpty}`)).toBe(true);
  await app.press("id:mobile-archived-back");
  await app.waitFor("id:mobile-archived-head", { state: "gone" });
  await app.waitFor(`id:session-${seeded.writerDirect}`);
});

test("the phone's tools menu is a sheet and Usage is a page in place of the list", async () => {
  const app = await open();
  await app.press("id:tools-toggle");
  await app.waitFor("id:sidebar-tools-menu");
  await app.press("id:tools-usage");
  await app.waitFor("id:usage-page", { timeout: 10_000 });
  expect(app.shows("id:search-trigger")).toBe(false);
  await app.press("id:usage-page-back");
  await app.waitFor("id:search-trigger");
});
