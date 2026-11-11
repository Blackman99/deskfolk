/** The full session list on the runtime's own conversations: sections, the + menus, projects by directory, pins, rename, the working filter, the archived list, holds and tools. */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy";
import { openStory, seeded } from "./fixture";

const t = copyFor("zh");
type App = Awaited<ReturnType<typeof open>>;
const open = async (options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("sidebar-main", { height: 900, ...options });
  await app.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  return app;
};
const logText = (app: App) => app.texts().find((x) => x.startsWith("log:")) ?? "";
const logged = (app: App, line: string) => logText(app).split(" ").includes(line);
const stateText = (app: App) => app.texts().find((x) => x.startsWith("selected:")) ?? "";
/** The project directory the runtime lists (its real path, not the temp symlink the fixture was given). */
const dirOf = (app: App) => /dirs:(\S+)/.exec(stateText(app))![1]!.split("|")[0]!;
const labelOf = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!;

/** Makes a project session in the workspace; returns its id. */
async function makeProject(app: App): Promise<string> {
  const before = logText(app);
  await app.press("id:make-project");
  await app.waitUntil(() => logText(app) !== before && /made:\w+/.test(logText(app)));
  const id = [...logText(app).matchAll(/made:(\w+)/g)].pop()![1]!;
  await app.waitFor(`id:session-${id}`, { timeout: 10_000 });
  return id;
}
const cleanup = async (app: App) => {
  await app.press("id:drop-made");
  await app.waitUntil(() => logged(app, "dropped"));
};

test("the list heads itself with the mark, the switches and a search; the conversations are in their sections", async () => {
  const app = await open();
  expect(app.shows("id:brand-row")).toBe(true);
  expect(app.shows("id:working-filter")).toBe(true);
  expect(app.shows("id:focus-toggle")).toBe(true);
  expect(app.shows(`id:search-trigger >> text:${t.sidebar.searchShort}`)).toBe(true);
  expect(app.shows(`text:${t.sidebar.botsTab}`)).toBe(true);
  expect(app.shows(`text:${t.project.section}`)).toBe(true);
  expect(app.shows(`id:session-${seeded.writerDirect} >> text:Writer`)).toBe(true);
  expect(app.shows(`id:session-${seeded.group} >> text:周报小组`)).toBe(true);
  // A wide window has the footer, no floating create button and no phone's tools beside the search.
  expect(app.shows("id:sidebar-foot")).toBe(true);
  expect(app.shows("id:create-fab")).toBe(false);
  await app.press("id:search-trigger");
  await app.waitUntil(() => logged(app, "search"));
});

test("a press selects a conversation, a right-click asks for its menu, a row pulled away is handed on for dragging", async () => {
  const app = await open();
  await app.press(`id:session-${seeded.writerDirect}`);
  await app.waitUntil(() => stateText(app).includes(`selected:${seeded.writerDirect}`));
  await app.rightClick(`id:session-${seeded.group}`);
  await app.waitUntil(() => logged(app, "menu:group"));
  // A press that stays put is a press, not a drag.
  expect(logText(app).includes("drag:")).toBe(false);
  await app.drag(`id:session-${seeded.group}`, { x: 120, y: 0 });
  await app.waitUntil(() => logged(app, "drag:group") && logged(app, "drag-end:group"));
  await app.press("id:toggle-drag");
  const before = logText(app);
  await app.drag(`id:session-${seeded.writerDirect}`, { x: 120, y: 0 });
  await app.wait(200);
  expect(logText(app)).toBe(before);
});

test("the Bots section's + offers a Bot or a group", async () => {
  const app = await open();
  await app.press("id:bot-add");
  await app.waitFor("id:bot-add-menu");
  await app.press("id:bot-add-group");
  await app.waitUntil(() => logged(app, "create-group"));
  await app.waitFor("id:bot-add-menu", { state: "gone" });
  await app.press("id:bot-add");
  await app.press("id:bot-add-bot");
  await app.waitUntil(() => logged(app, "create-bot"));
});

test("a project directory is one row with its sessions under it: fold, unfold, its + and its right-click menu", async () => {
  const app = await open();
  try {
    const id = await makeProject(app);
    const dir = dirOf(app);
    const dirHead = `id:project-dir-head:${dir}`;
    await app.waitFor(dirHead);
    expect(app.shows(`${dirHead} >> text:${labelOf(dir)}`)).toBe(true);
    expect(app.shows(`id:session-${id}`)).toBe(true);
    await app.press(dirHead);
    await app.waitFor(`id:session-${id}`, { state: "gone" });
    await app.press(dirHead);
    await app.waitFor(`id:session-${id}`);
    // The directory's +: the same agents right there, the directory itself and a terminal.
    await app.press(`id:project-dir-add:${dir}`);
    await app.waitFor("id:project-add-menu");
    expect(app.shows("id:project-add-open-dir")).toBe(true);
    expect(app.shows("id:project-add-open-terminal")).toBe(true);
    expect(app.shows("id:project-add-import")).toBe(false);
    await app.press("id:project-add-open-dir");
    await app.waitUntil(() => logged(app, `dir:${dir}`));
    await app.waitFor("id:project-add-menu", { state: "gone" });
    // The same menu where the pointer was.
    await app.rightClick(dirHead);
    await app.waitFor("id:project-add-menu");
    await app.press("id:project-add-open-dir");
    await app.waitFor("id:project-add-menu", { state: "gone" });
    // The section's + offers carrying a terminal session on, which a directory's does not.
    await app.press("id:project-add");
    await app.waitFor("id:project-add-menu");
    expect(app.shows("id:project-add-import")).toBe(true);
    expect(app.shows("id:project-add-open-dir")).toBe(false);
  } finally {
    await cleanup(app);
  }
});

test("a pinned project session moves to the band and leaves its directory; renaming it stands it under the directory again as a name field", async () => {
  const app = await open();
  try {
    const id = await makeProject(app);
    await app.press("id:pin-project");
    await app.waitFor(`id:pinned-${id}`);
    await app.waitFor(`id:session-${id}`, { state: "gone" });
    await app.press("id:rename-project");
    await app.waitFor("id:project-rename-field");
    await app.type("id:project-rename-field", "新名字");
    await app.submit("id:project-rename-field");
    await app.waitFor("id:project-rename-field", { state: "gone" });
    await app.waitUntil(() => logged(app, "rename:新名字"));
  } finally {
    await cleanup(app);
  }
});

test("a project session's name field: Escape leaves the name as it was", async () => {
  const app = await open();
  try {
    const id = await makeProject(app);
    await app.press("id:rename-project");
    await app.waitFor("id:project-rename-field");
    await app.type("id:project-rename-field", "不保存");
    await app.keyboard.press("escape");
    await app.waitFor("id:project-rename-field", { state: "gone" });
    await app.waitUntil(() => logged(app, "rename:none"));
    expect(app.shows(`id:session-${id}`)).toBe(true);
  } finally {
    await cleanup(app);
  }
});

test("the working filter lists what a Bot works in and drops the rest; and keeps what is unread", async () => {
  const app = await open();
  try {
    await app.press("id:toggle-work");
    await app.press("id:working-filter");
    await app.waitUntil(() => app.shows(`id:session-${seeded.group}`));
    expect(app.shows(`id:session-${seeded.group} >> text:${t.sidebar.statusRunning}`)).toBe(true);
    // Once its turn ends it leaves; Writer's direct stays, it has something unread, and the project section goes.
    expect(app.shows(`text:${t.project.section}`)).toBe(false);
    await app.press("id:toggle-work");
    await app.waitFor(`id:session-${seeded.group}`, { state: "gone" });
    expect(app.shows(`id:session-${seeded.writerDirect}`)).toBe(true);
    await app.press("id:working-filter");
    await app.waitFor(`id:session-${seeded.group}`);
  } finally {
    await app.press("id:toggle-work").catch(() => {});
  }
});

test("the archived list is part of the list on a wide window, with its own heading and a way back", async () => {
  const app = await open();
  try {
    await app.press("id:make-group");
    await app.waitUntil(() => /made:\w+/.test(logText(app)));
    await app.press("id:archive-made");
    await app.waitUntil(() => logged(app, "archived"));
    await app.press("id:show-archived");
    await app.waitFor("id:archived-ghead");
    expect(app.shows(`id:archived-ghead >> text:${t.sidebar.archivedSessions}`)).toBe(true);
    expect(app.shows("id:working-filter")).toBe(false);
    expect(app.shows(`id:session-${seeded.group}`)).toBe(false);
    await app.press("id:back-to-sessions");
    await app.waitFor("id:archived-ghead", { state: "gone" });
    await app.waitFor(`id:session-${seeded.group}`);
  } finally {
    await cleanup(app);
  }
});

test("a stop waiting to be lifted is a bar above the list", async () => {
  const app = await open();
  expect(app.shows("id:holds-bar")).toBe(false);
  await app.press("id:toggle-hold");
  await app.waitFor("id:holds-bar");
  expect(app.shows("id:hold-lift-hold-main")).toBe(true);
  await app.press("id:toggle-hold");
  await app.waitFor("id:holds-bar", { state: "gone" });
});

test("the collapse button is there only when the list can be put away", async () => {
  const app = await open();
  expect(app.shows("id:side-collapse")).toBe(true);
  await app.press("id:side-collapse");
  await app.waitUntil(() => logged(app, "collapse"));
  await app.press("id:toggle-collapse");
  await app.waitFor("id:side-collapse", { state: "gone" });
});

test("the footer's tools menu opens, and Roles replaces the list with its page", async () => {
  const app = await open();
  await app.press("id:tools-toggle");
  await app.waitFor("id:sidebar-tools-menu");
  expect(stateText(app)).toContain("tools:on");
  await app.press("id:tools-roles");
  await app.waitUntil(() => stateText(app).includes("page:roles"));
  await app.waitFor("id:search-trigger", { state: "gone" });
  await app.press("id:foot-settings");
  await app.waitUntil(() => logged(app, "settings"));
});

test("the footer's workspace and the focus switch act", async () => {
  const app = await open();
  await app.press("id:foot-workspace");
  await app.waitUntil(() => logged(app, "workspace"));
  await app.press("id:focus-toggle");
  await app.press("id:focus-toggle");
});
