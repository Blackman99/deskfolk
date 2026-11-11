/** The list's own controls: the switches, the holds bar, the footer row, the + menu, and a phone's create button, archived head and tools sheet. */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy";
import { openStory, seeded } from "./fixture";

const t = copyFor("zh");
type App = Awaited<ReturnType<typeof open>>;
const open = async (options: Parameters<typeof openStory>[1] = { height: 1100 }) => {
  const app = await openStory("sidebar-rail", options);
  await app.waitFor(`id:rail-session-${seeded.group}`, { timeout: 15_000 });
  return app;
};
const log = (app: App) => app.texts().find((x) => x === "—" || /^(rail-|search|expand|menu:|drag:|workspace-toggle|lift|create|spend|routines|usage|roles|terminal|foot-|narrow-|archived|fab|screen|workspace$)/.test(x)) ?? "";
const state = (app: App) => app.texts().find((x) => x.startsWith("selected:")) ?? "";

test("the working filter and the focus switch are toggles", async () => {
  const app = await open();
  expect(state(app)).toContain("working:off");
  await app.press("id:working-filter");
  await app.waitUntil(() => state(app).includes("working:on"));
  await app.press("id:working-filter");
  await app.waitUntil(() => state(app).includes("working:off"));
  expect(state(app)).toContain("focus:off");
  await app.press("id:focus-toggle");
  await app.waitUntil(() => state(app).includes("focus:on"));
  await app.press("id:focus-toggle");
  await app.waitUntil(() => state(app).includes("focus:off"));
});

test("the holds bar says what each holds and lifts it; a refusal is said on its row until the next try", async () => {
  const app = await open();
  expect(app.shows(`id:holds-bar >> text:${t.control.holdsTitle}`)).toBe(true);
  expect(app.shows("id:holds-bar >> text:2")).toBe(true);
  expect(app.shows("id:hold-hold-1 >> text:Writer")).toBe(true);
  expect(app.shows("id:hold-hold-2 >> text:Editor")).toBe(true);
  // Only the one dropped by a button is tagged.
  expect(app.shows(`id:hold-hold-2 >> text:${t.control.dropped}`)).toBe(true);
  expect(app.shows(`id:hold-hold-1 >> text:${t.control.dropped}`)).toBe(false);
  await app.press("id:hold-lift-hold-1");
  await app.waitUntil(() => log(app).includes("lift:hold-1"));
  expect(app.shows("id:hold-failed-hold-2")).toBe(false);
  await app.press("id:hold-lift-hold-2");
  await app.waitFor("id:hold-failed-hold-2");
  expect(app.shows(`id:hold-hold-2 >> text:${t.control.failed}`)).toBe(true);
  await app.press("id:hold-lift-hold-1");
  await app.waitFor("id:hold-failed-hold-2", { state: "gone" });
});

test("the footer row keeps its words while they fit and drops them in a narrow list", async () => {
  const app = await open();
  // Two rows in the story: 300 wide with the words, 190 wide with icons only.
  expect(app.shows(`id:foot-wide >> text:${t.sidebar.workspace}`)).toBe(true);
  expect(app.shows(`id:foot-wide >> text:${t.sidebar.tools}`)).toBe(true);
  expect(app.shows(`id:foot-wide >> text:${t.sidebar.settings}`)).toBe(true);
  expect(app.shows(`id:foot-narrow >> text:${t.sidebar.workspace}`)).toBe(false);
  expect(app.shows(`id:foot-narrow >> text:${t.sidebar.settings}`)).toBe(false);
  // Icons only, the buttons still act.
  await app.press("id:foot-wide >> id:foot-settings");
  await app.waitUntil(() => log(app).includes("foot-settings"));
  await app.press("id:foot-narrow >> id:foot-settings");
  await app.waitUntil(() => log(app).includes("narrow-settings"));
});

test("the footer's tools button opens the menu over itself, and a choice runs and closes it", async () => {
  const app = await open();
  await app.press("id:foot-wide >> id:tools-toggle");
  await app.waitFor("id:sidebar-tools-menu");
  // The footer's menu is the list's: no workspace page, no screen (those are a phone's).
  expect(app.shows("id:tools-workspace")).toBe(false);
  await app.press("id:tools-usage");
  await app.waitUntil(() => log(app).includes("usage"));
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });
  await app.press("id:foot-wide >> id:tools-toggle");
  await app.waitFor("id:sidebar-tools-menu");
  // The same button closes it again.
  await app.press("id:foot-wide >> id:tools-toggle");
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });
});

test("the + of the Bot section offers a Bot or a group and closes on Escape", async () => {
  const app = await open();
  await app.press("id:bot-add-plus");
  await app.waitFor("id:bot-add-menu");
  expect(app.shows(`id:bot-add-bot >> text:${t.sidebar.addBot}`)).toBe(true);
  expect(app.shows(`id:bot-add-group >> text:${t.sidebar.addGroup}`)).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:bot-add-menu", { state: "gone" });
  await app.press("id:bot-add-plus");
  await app.press("id:bot-add-group");
  await app.waitUntil(() => log(app).includes("create-group"));
  await app.waitFor("id:bot-add-menu", { state: "gone" });
  await app.press("id:bot-add-plus");
  await app.press("id:bot-add-bot");
  await app.waitUntil(() => log(app).includes("create-bot"));
});

test("the archived head and the create button are a phone's: a wide window draws neither", async () => {
  const app = await open();
  expect(app.shows("id:mobile-archived-head")).toBe(false);
  expect(app.shows("id:create-fab")).toBe(false);
});

test("a phone's archived list heads itself with Back, the title and the count", async () => {
  const app = await open({ width: 390, height: 844 });
  await app.waitFor("id:mobile-archived-head");
  expect(app.shows(`id:mobile-archived-head >> text:${t.sidebar.archivedSessions}`)).toBe(true);
  expect(app.shows("id:mobile-archived-head >> text:(3)")).toBe(true);
  await app.press("id:mobile-archived-back");
  await app.waitUntil(() => log(app).includes("archived-back"));
});

test("a phone's create button asks which once, in a sheet from the bottom", async () => {
  const app = await open({ width: 390, height: 844 });
  await app.waitFor("id:create-fab");
  await app.press("id:create-fab");
  await app.waitFor("id:fab-menu");
  expect(app.shows(`id:fab-add-bot >> text:${t.sidebar.addBot}`)).toBe(true);
  expect(app.shows(`id:project-add-new >> text:${t.project.newInFolder}`)).toBe(true);
  expect(app.shows(`id:project-add-import >> text:${t.project.importSession}`)).toBe(true);
  await app.press("id:fab-add-group");
  await app.waitUntil(() => log(app).includes("fab-group"));
  await app.waitFor("id:fab-menu", { state: "gone" });
  await app.press("id:create-fab");
  await app.press("id:bottom-sheet-close");
  await app.waitFor("id:fab-menu", { state: "gone" });
  await app.press("id:create-fab");
  await app.press("id:project-add-import");
  await app.waitUntil(() => log(app).includes("fab-import"));
});

test("a phone's tools are a sheet whose pages include the workspace and the screen", async () => {
  const app = await open({ width: 390, height: 844 });
  await app.press("id:phone-tools >> id:tools-toggle");
  await app.waitFor("id:sidebar-tools-menu");
  expect(app.shows("id:tools-workspace")).toBe(true);
  expect(app.shows("id:tools-screen")).toBe(true);
  expect(app.shows(`id:tools-routines >> text:${t.calendar.open}`)).toBe(true);
  await app.press("id:tools-screen");
  await app.waitUntil(() => log(app).includes("screen"));
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });
});
