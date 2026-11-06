/** The sidebar's rows on the runtime's own sessions: what a row shows, hover actions, pins, the menu and what it does. */
import { expect, test } from "nsh/test";
import { FILE_DROP_SESSION_ID } from "@real-bot/protocol";
import { openStory, seeded } from "./fixture";

const open = async (options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("sidebar-rows", options);
  await app.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  return app;
};
type App = Awaited<ReturnType<typeof open>>;
const logged = (app: App, line: string) => app.texts().some((t) => t.includes("log:") && t.split(" ").includes(line));

/** The server's own list (`GET /v1/sessions`, asked by the story): `[id, name, archived]` per session. */
async function server(app: App): Promise<Array<[string, string, number]>> {
  await app.press("id:probe");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("probe:[")));
  const text = app.texts().find((t) => t.startsWith("probe:["))!;
  return JSON.parse(text.slice("probe:".length));
}

/** A throwaway session the story makes (a group, or a project session), so what a test archives or deletes is its own. */
async function made(app: App, button: "make-group" | "make-project"): Promise<string> {
  const before = app.texts().find((t) => t.includes("log:")) ?? "";
  await app.press(`id:${button}`);
  await app.waitUntil(() => (app.texts().find((t) => t.includes("log:")) ?? "") !== before && /made:\w+/.test(app.texts().find((t) => t.includes("log:")) ?? ""));
  const line = app.texts().find((t) => t.includes("log:"))!;
  const id = [...line.matchAll(/made:(\w+)/g)].pop()![1]!;
  await app.waitFor(`id:session-${id}`, { timeout: 10_000 });
  return id;
}

test("a row shows the title, the last line and the time of the runtime's conversation", async () => {
  const app = await open();
  expect(app.shows(`id:session-${seeded.writerDirect} >> text:Writer`)).toBe(true);
  expect(app.shows(`id:session-${seeded.writerDirect} >> id:row-time`)).toBe(true);
  expect(app.shows(`id:session-${seeded.group} >> text:周报小组`)).toBe(true);
  await app.press(`id:session-${seeded.writerDirect}`);
  await app.waitFor("text:Writer");
});

test("a status replaces the last line, with its count; unread, elsewhere, archived and the file drop say their own thing", async () => {
  const app = await open();
  expect(app.shows("id:fx-working >> text:正在处理")).toBe(true);
  expect(app.shows("id:fx-working >> text:hidden by status")).toBe(false);
  expect(app.shows("id:fx-waiting >> text:等你放行")).toBe(true);
  expect(app.shows("id:fx-waiting >> text:2")).toBe(true);
  expect(app.shows("id:fx-unread >> text:最后一句话")).toBe(true);
  expect(app.shows("id:fx-unread >> text:99+")).toBe(true);
  expect(app.shows("id:fx-elsewhere >> text:在「周报小组」里工作")).toBe(true);
  expect(app.shows("id:fx-elsewhere >> text:last line")).toBe(false);
  expect(app.shows("id:fx-archived >> text:old line")).toBe(true);
  expect(app.shows("id:fx-filedrop >> id:file-drop-mark")).toBe(true);
  expect(app.shows("id:fx-filedrop >> text:3 files")).toBe(true);
  // The project row wears its agent's mark and the run's dot.
  expect(app.shows("id:fx-project >> id:agent-avatar")).toBe(true);
  expect(app.shows("id:fx-project >> id:avatar-status-dot")).toBe(true);
  await app.press("id:fx-unread >> id:session-fx-unread");
  await app.waitUntil(() => logged(app, "select:fx-unread"));
});

test("under the pointer a row offers pin and more; pinning puts it in the strip, and the pin selects it", async () => {
  const app = await open();
  const id = seeded.editorDirect;
  expect(app.shows(`id:session-pin-${id}`)).toBe(false);
  await app.hover(`id:session-${id}`);
  await app.waitFor(`id:session-pin-${id}`);
  expect(app.shows(`id:session-more-${id}`)).toBe(true);
  await app.press(`id:session-pin-${id}`);
  await app.waitFor(`id:pinned-${id}`);
  expect(app.shows("id:pinned-roster")).toBe(true);
  await app.press(`id:pinned-${id}`);
  // Pinned: the pin button is on, and pressing it takes the row out of the strip.
  await app.hover(`id:session-${id}`);
  await app.press(`id:session-pin-${id}`);
  await app.waitFor(`id:pinned-${id}`, { state: "gone" });
  expect(app.shows("id:pinned-roster")).toBe(false);
});

test("a right click opens the menu at the pointer with the conversation's entries; Escape and a press elsewhere close it", async () => {
  const app = await open();
  await app.rightClick(`id:session-${seeded.group}`);
  await app.waitFor("id:session-context-menu");
  for (const id of ["pin", "info", "job", "clear", "archive", "delete"]) expect(app.shows(`id:session-menu-${id}`)).toBe(true);
  // A group has no rename, directory, terminal or map entry.
  for (const id of ["rename", "project-dir", "project-terminal", "map"]) expect(app.count(`id:session-menu-${id}`)).toBe(0);
  await app.keyboard.press("escape");
  await app.waitFor("id:session-context-menu", { state: "gone" });
  await app.rightClick(`id:session-${seeded.group}`);
  await app.waitFor("id:session-context-menu");
  await app.press("id:session-fx-working");
  await app.waitFor("id:session-context-menu", { state: "gone" });
  // The menu's pin is the row's pin.
  await app.rightClick(`id:session-${seeded.editorDirect}`);
  await app.press("id:session-menu-pin");
  await app.waitFor(`id:pinned-${seeded.editorDirect}`);
  await app.rightClick(`id:session-${seeded.editorDirect}`);
  await app.waitFor("text:取消置顶");
  await app.press("id:session-menu-pin");
  await app.waitFor(`id:pinned-${seeded.editorDirect}`, { state: "gone" });
});

test("the file drop's menu has clear history but no archive or delete", async () => {
  const app = await open();
  await app.rightClick(`id:session-${FILE_DROP_SESSION_ID}`);
  await app.waitFor("id:session-context-menu");
  expect(app.shows("id:session-menu-clear")).toBe(true);
  expect(app.enabled("id:session-menu-archive")).toBe(false);
  expect(app.enabled("id:session-menu-delete")).toBe(false);
  expect(app.count("id:session-menu-info")).toBe(0);
  await app.keyboard.press("escape");
});

test("archive and restore go through the runtime; the archived row sits below, dimmed", async () => {
  const app = await open();
  const id = await made(app, "make-group");
  await app.waitFor(`id:session-${id}`);
  await app.rightClick(`id:session-${id}`);
  await app.press("id:session-menu-archive");
  await app.waitUntil(async () => (await server(app)).find((s) => s[0] === id)?.[2] === 1);
  await app.waitFor(`id:archived-list >> id:session-${id}`);
  await app.rightClick(`id:session-${id}`);
  await app.waitFor("text:取消归档");
  await app.press("id:session-menu-archive");
  await app.waitUntil(async () => (await server(app)).find((s) => s[0] === id)?.[2] === 0);
  await app.waitFor(`id:archived-list >> id:session-${id}`, { state: "gone" });
  await app.press("id:drop-made");
});

test("delete asks first: cancel keeps the conversation, confirm removes it", async () => {
  const app = await open();
  const id = await made(app, "make-group");
  await app.waitFor(`id:session-${id}`);
  await app.rightClick(`id:session-${id}`);
  await app.press("id:session-menu-delete");
  await app.waitFor("id:danger-dialog");
  await app.press("id:danger-cancel");
  await app.waitFor("id:danger-dialog", { state: "gone" });
  expect((await server(app)).some((s) => s[0] === id)).toBe(true);
  await app.rightClick(`id:session-${id}`);
  await app.press("id:session-menu-delete");
  await app.press("id:danger-confirm");
  await app.waitUntil(async () => !(await server(app)).some((s) => s[0] === id));
  await app.waitFor(`id:session-${id}`, { state: "gone" });
});

test("clear history asks first too", async () => {
  const app = await open();
  const id = await made(app, "make-group");
  await app.waitFor(`id:session-${id}`);
  await app.rightClick(`id:session-${id}`);
  await app.press("id:session-menu-clear");
  await app.waitFor("id:danger-dialog");
  await app.press("id:danger-cancel");
  await app.waitFor("id:danger-dialog", { state: "gone" });
  await app.press("id:drop-made");
});
