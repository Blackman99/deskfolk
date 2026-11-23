/** The list on a phone: the tools beside the search, two pages (Bots and projects), the floating create button, a project directory's + as a sheet, the archived page. */
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
const stateText = (app: App) => app.texts().find((x) => x.startsWith("selected:")) ?? "";
/** The project directory the runtime lists (its real path, not the temp symlink the fixture was given). */
const dirOf = (app: App) => /dirs:(\S+)/.exec(stateText(app))![1]!.split("|")[0]!;
const labelOf = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!;

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

test("a project directory's + asks in a sheet from the bottom named after the directory: the agents there, the directory and a terminal", async () => {
  const app = await open();
  const before = logText(app);
  await app.press("id:make-project");
  await app.waitUntil(() => logText(app) !== before && /made:\w+/.test(logText(app)));
  try {
    await app.press("id:phone-projects");
    const dir = dirOf(app);
    const add = `id:project-dir-add:${dir}`;
    await app.waitFor(add, { timeout: 10_000 });
    await app.press(add);
    await app.waitFor("id:project-add-menu");
    // A sheet, not a menu hanging off the +: its panel, its heading the directory's name, its ✕.
    expect(app.shows("id:bottom-sheet-panel >> id:project-add-menu")).toBe(true);
    expect(app.shows(`id:bottom-sheet-panel >> text:${labelOf(dir)}`)).toBe(true);
    expect(app.shows("id:bottom-sheet-close")).toBe(true);
    for (const agent of ["claude_code", "codex", "antigravity"]) expect(app.shows(`id:project-add-new-${agent}`)).toBe(true);
    expect(app.shows("id:project-add-open-dir")).toBe(true);
    expect(app.shows("id:project-add-open-terminal")).toBe(true);
    expect(app.shows("id:project-add-import")).toBe(false);
    // Right in the directory: no folder to pick after, so no ellipsis.
    expect(app.texts().some((x) => x.startsWith("新开 Claude Code 会话") && !x.endsWith("…"))).toBe(true);
    await app.press("id:project-add-open-dir");
    await app.waitUntil(() => logged(app, `dir:${dir}`));
    await app.waitFor("id:project-add-menu", { state: "gone" });
    // The ✕ puts it away with nothing chosen.
    await app.press(add);
    await app.waitFor("id:project-add-menu");
    await app.press("id:bottom-sheet-close");
    await app.waitFor("id:project-add-menu", { state: "gone" });
  } finally {
    await app.press("id:drop-made");
    await app.waitUntil(() => logged(app, "dropped"));
  }
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

test("phone filter toggles show dismissible active chips under the search bar", async () => {
  const app = await open();
  expect(app.shows("id:working-filter-chip")).toBe(false);
  expect(app.shows("id:focus-mode-chip")).toBe(false);

  await app.press("id:working-filter");
  await app.waitFor("id:working-filter-chip");
  await app.press("id:focus-toggle");
  await app.waitFor("id:focus-mode-chip");

  await app.press("id:working-filter-chip");
  await app.waitFor("id:working-filter-chip", { state: "gone" });
  expect(app.shows("id:focus-mode-chip")).toBe(true);

  await app.press("id:focus-mode-chip");
  await app.waitFor("id:focus-mode-chip", { state: "gone" });
});
