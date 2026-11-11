/** A project session's row and its rename, the add menu, the pinned strip and the phone's long-press sheet. */
import { expect, test } from "nsh/test";
import { openStory, seeded } from "./fixture";

const open = async (options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("sidebar-rows", options);
  await app.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  return app;
};
type App = Awaited<ReturnType<typeof open>>;
const logLine = (app: App) => app.texts().find((t) => t.includes("log:")) ?? "";
const logged = (app: App, line: string) => logLine(app).split(" ").includes(line);

async function server(app: App): Promise<Array<[string, string, number]>> {
  await app.press("id:probe");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("probe:[")));
  return JSON.parse(app.texts().find((t) => t.startsWith("probe:["))!.slice("probe:".length));
}

async function made(app: App, button: "make-group" | "make-project"): Promise<string> {
  await app.press(`id:${button}`);
  await app.waitUntil(() => /made:\w+/.test(logLine(app)));
  const id = [...logLine(app).matchAll(/made:(\w+)/g)].pop()![1]!;
  await app.waitFor(`id:session-${id}`, { timeout: 10_000 });
  return id;
}

test("a project session wears its agent's mark and its menu has rename, the directory, a terminal and the map", async () => {
  const app = await open();
  const id = await made(app, "make-project");
  expect(app.shows(`id:session-${id} >> id:agent-avatar`)).toBe(true);
  await app.rightClick(`id:session-${id}`);
  await app.waitFor("id:session-context-menu");
  for (const entry of ["rename", "project-dir", "project-terminal", "map", "clear", "archive", "delete"]) expect(app.shows(`id:session-menu-${entry}`)).toBe(true);
  // No Bot, so no profile to view.
  expect(app.count("id:session-menu-info")).toBe(0);
  await app.press("id:session-menu-project-terminal");
  await app.waitUntil(() => logged(app, `terminal:${id}`));
  await app.press("id:drop-made");
});

test("renaming turns the row into a name field: Enter saves through the runtime, Escape leaves the name", async () => {
  const app = await open();
  const id = await made(app, "make-project");
  await app.rightClick(`id:session-${id}`);
  await app.press("id:session-menu-rename");
  await app.waitFor("id:project-rename-field");
  expect(app.count(`id:session-${id}`)).toBe(0);
  await app.type("id:project-rename-field", "我的项目");
  await app.submit("id:project-rename-field");
  await app.waitFor("id:project-rename-field", { state: "gone" });
  await app.waitUntil(() => app.shows("text:我的项目"));
  expect((await server(app)).find((s) => s[0] === id)?.[1]).toBe("我的项目");
  // Escape: the field goes, the name stays.
  await app.rightClick(`id:session-${id}`);
  await app.press("id:session-menu-rename");
  await app.waitFor("id:project-rename-field");
  await app.clear("id:project-rename-field");
  await app.type("id:project-rename-field", "不保存");
  await app.keyboard.press("escape");
  await app.waitFor("id:project-rename-field", { state: "gone" });
  expect(app.shows("text:我的项目")).toBe(true);
  expect(app.shows("text:不保存")).toBe(false);
  expect((await server(app)).find((s) => s[0] === id)?.[1]).toBe("我的项目");
  await app.press("id:drop-made");
});

test("the rename field of the fixture saves a typed name, and stays when it did not go through", async () => {
  const app = await open();
  await app.press("id:fx-rename");
  await app.waitFor("id:fx-project >> id:project-rename-field");
  expect(app.value("id:project-rename-field")).toBe("Demo");
  await app.clear("id:project-rename-field");
  await app.type("id:project-rename-field", "bad");
  await app.submit("id:project-rename-field");
  await app.waitUntil(() => logged(app, "rename:bad"));
  // It did not go through: the field stays, with a tip naming why.
  expect(app.shows("id:project-rename-field")).toBe(true);
  await app.clear("id:project-rename-field");
  await app.type("id:project-rename-field", "Good");
  await app.submit("id:project-rename-field");
  await app.waitUntil(() => logged(app, "rename:Good"));
  await app.waitFor("id:project-rename-field", { state: "gone" });
});

test("the add menu offers a new session of each agent, then import; its choice closes it", async () => {
  const app = await open();
  await app.press("id:add-open");
  await app.waitFor("id:project-add-menu");
  expect(app.shows("id:project-add-new-claude_code")).toBe(true);
  expect(app.shows("id:project-add-new-codex")).toBe(true);
  expect(app.shows("id:project-add-import")).toBe(true);
  expect(app.count("id:project-add-open-dir")).toBe(0);
  // A folder is picked after, so each "new" says so.
  expect(app.texts().some((t) => t.startsWith("新开 Codex 会话…"))).toBe(true);
  await app.press("id:project-add-new-codex");
  await app.waitUntil(() => logged(app, "new:codex"));
  await app.waitFor("id:project-add-menu", { state: "gone" });
  // The arrow keys walk it and Enter chooses; Escape closes.
  await app.press("id:add-open");
  await app.waitFor("id:project-add-menu");
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitUntil(() => (logLine(app).match(/new:codex/g) ?? []).length === 2);
  await app.press("id:add-open");
  await app.waitFor("id:project-add-menu");
  await app.keyboard.press("escape");
  await app.waitFor("id:project-add-menu", { state: "gone" });
});

test("a directory's menu opens where it was asked: the agents in place, no import, the directory and a terminal", async () => {
  const app = await open();
  await app.press("id:dir-add-open");
  await app.waitFor("id:project-add-menu");
  expect(app.count("id:project-add-import")).toBe(0);
  expect(app.texts().some((t) => t.startsWith("新开 Claude Code 会话") && !t.endsWith("…"))).toBe(true);
  await app.press("id:project-add-open-terminal");
  await app.waitUntil(() => logged(app, "open-terminal"));
  await app.press("id:dir-add-open");
  await app.press("id:project-add-open-dir");
  await app.waitUntil(() => logged(app, "open-dir"));
  await app.waitFor("id:project-add-menu", { state: "gone" });
});

test("the more button of a row opens its menu", async () => {
  const app = await open();
  await app.hover(`id:session-${seeded.group}`);
  await app.press(`id:session-more-${seeded.group}`);
  await app.waitFor("id:session-context-menu");
  expect(app.shows("id:session-menu-archive")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:session-context-menu", { state: "gone" });
});

test("more than five pins get a button that unfolds the strip; fewer do not", async () => {
  const app = await open({ height: 1000 });
  const ids = [seeded.writerDirect, seeded.editorDirect, seeded.group];
  for (let i = 0; i < 3; i++) ids.push(await made(app, "make-group"));
  for (const id of ids.slice(0, 5)) {
    await app.hover(`id:session-${id}`);
    await app.press(`id:session-pin-${id}`);
    await app.waitFor(`id:pinned-${id}`);
  }
  expect(app.count("id:pinned-expand")).toBe(0);
  await app.hover(`id:session-${ids[5]}`);
  await app.press(`id:session-pin-${ids[5]}`);
  await app.waitFor("id:pinned-expand");
  expect(app.count("id:pinned-expand")).toBe(1);
  await app.press("id:pinned-expand");
  expect(app.count("id:pinned-expand")).toBe(1);
  // Every pin is still there when it is unfolded.
  for (const id of ids) expect(app.shows(`id:pinned-${id}`)).toBe(true);
  await app.press("id:pinned-expand");
  // Unpinning one takes the button away.
  await app.rightClick(`id:pinned-${ids[5]}`);
  await app.press("id:session-menu-pin");
  await app.waitFor("id:pinned-expand", { state: "gone" });
  await app.press("id:drop-made");
}, 90_000);

test("on a phone a long press opens the menu as a sheet named after the conversation; the sheet's entries work", async () => {
  const app = await open({ width: 390, height: 844, platform: "ios" });
  expect(app.count(`id:session-pin-${seeded.group}`)).toBe(0);
  await app.longPress(`id:session-${seeded.group}`);
  await app.waitFor("id:session-context-menu");
  expect(app.shows("text:周报小组")).toBe(true);
  expect(app.shows("id:bottom-sheet-close")).toBe(true);
  await app.press("id:session-menu-pin");
  await app.waitFor("id:session-context-menu", { state: "gone" });
  await app.waitFor(`id:pinned-${seeded.group}`);
  await app.longPress(`id:pinned-${seeded.group}`);
  await app.waitFor("id:session-context-menu");
  await app.press("id:bottom-sheet-close");
  await app.waitFor("id:session-context-menu", { state: "gone" });
});
