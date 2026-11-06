import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

const open = async (options = {}) => {
  const app = await openStory("panels-b", options);
  await app.waitFor("id:profile-basics", { timeout: 15_000 });
  await app.waitFor("id:routine-section", { timeout: 15_000 });
  return app;
};

/** What the daemon holds, read by the story (the test host has no network of its own): `kind:` and its text. */
const ask = async (app: App, kind: "routines" | "bot" | "playbook"): Promise<string> => {
  await app.press(`id:tool-probe-${kind}`);
  await app.waitUntil(() => app.texts().some((t) => t.startsWith(`${kind}:`)), { timeout: 10_000 });
  return app.texts().find((t) => t.startsWith(`${kind}:`))!.slice(kind.length + 1);
};
const routinesNow = async (app: App) => {
  const text = await ask(app, "routines");
  return text ? text.split(";") : [];
};
/** A clean start: no routine of Writer's on the daemon. */
const withoutRoutines = async (app: App) => {
  for (let tries = 0; tries < 5 && (await routinesNow(app)).length > 0; tries++) {
    await app.press("id:tool-clear-routines");
    await app.wait(400);
  }
  expect(await routinesNow(app)).toEqual([]);
};
const log = (app: App, part: string) => app.texts().some((t) => t.includes(part));

// ---- basics --------------------------------------------------------------

test("the basics show the Bot's fields and the autosave hint", async () => {
  const app = await open();
  await app.waitUntil(() => app.value("id:profile-name") === "Writer");
  expect(app.value("id:profile-duties")).toBe("写东西、改东西");
  expect(app.value("id:profile-boundaries")).toBe("只在工作区里动手");
  expect(app.texts()).toContain("Bot 基础信息");
  expect(app.texts()).toContain("改动自动保存");
  expect(app.shows("id:profile-runner")).toBe(true);
  expect(app.texts()).toContain("应用用你配的端点跑这个 Bot 的每一轮。");
  expect(app.shows("id:profile-thinking")).toBe(true);
});

test("typing in the duties saves the Bot by itself and says so", async () => {
  const app = await open();
  await app.waitUntil(() => app.value("id:profile-duties") === "写东西、改东西");
  await app.type("id:profile-duties", "，也写周报");
  await app.waitFor("text:已自动保存", { timeout: 10_000 });
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西，也写周报|active|");
  // Put the fixture's Bot back as other tests find it.
  await app.clear("id:profile-duties");
  await app.type("id:profile-duties", "写东西、改东西");
  await app.wait(1500);
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|active|");
});

test("an empty name is refused and not saved", async () => {
  const app = await open();
  await app.waitUntil(() => app.value("id:profile-name") === "Writer");
  await app.clear("id:profile-name");
  await app.waitFor("id:profile-name-error", { timeout: 10_000 });
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|active|");
  await app.type("id:profile-name", "Writer");
  await app.waitFor("id:profile-name-error", { state: "gone", timeout: 10_000 });
});

test("the permission mode is chosen from the Select and the hint follows", async () => {
  const app = await open();
  await app.waitFor("id:profile-permission", { timeout: 10_000 });
  expect(app.texts()).toContain("跟随应用（自动）");
  await app.press("id:profile-permission");
  await app.waitFor("text:只读");
  await app.press("text:只读");
  await app.waitFor("text:已自动保存", { timeout: 10_000 });
  expect(app.texts()).toContain("只读文件、查资料；写文件、跑命令、改应用配置都不做。");
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|active|read_only");
  // Back to following the app.
  await app.press("id:profile-permission");
  await app.waitFor("text:跟随应用（自动）");
  await app.press("text:跟随应用（自动）");
  await app.wait(1500);
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|active|");
});

test("picking Claude Agent as the runner swaps the model rows and its hint follows the status", async () => {
  const app = await open();
  await app.waitFor("id:profile-model", { timeout: 10_000 });
  await app.press("id:profile-runner");
  await app.waitFor("text:Claude Agent（你本机的 Claude Code）");
  await app.press("text:Claude Agent（你本机的 Claude Code）");
  await app.waitFor("text:正在找你本机的 Claude Code…");
  await app.waitFor("id:profile-agent-model-group");
  expect(app.shows("id:profile-model")).toBe(false);
  expect(app.shows("id:profile-thinking")).toBe(false);
  await app.press("id:tool-claude-unavailable");
  await app.waitFor("text:没查到 Claude Code 的状态。电脑上的 Deskfolk 版本较旧时，先在电脑上更新。");
  // Back to the app's own runner, and the fixture's Bot as other tests find it.
  await app.press("id:profile-runner");
  await app.waitFor("text:Deskfolk（端点上的模型）");
  await app.press("text:Deskfolk（端点上的模型）");
  await app.waitFor("id:profile-model");
  await app.wait(1500);
  expect(app.texts()).toContain("应用用你配的端点跑这个 Bot 的每一轮。");
});

// ---- actions -------------------------------------------------------------

test("the actions card archives and restores the Bot", async () => {
  const app = await open();
  await app.waitFor("id:bot-archive", { timeout: 10_000 });
  await app.press("id:bot-archive");
  await app.waitFor("id:bot-restore", { timeout: 10_000 });
  expect(log(app, "log=archived")).toBe(true);
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|archived|");
  await app.press("id:bot-restore");
  await app.waitFor("id:bot-archive", { timeout: 10_000 });
  expect(await ask(app, "bot")).toBe("Writer|写东西、改东西|active|");
});

test("the danger zone offers clearing the history and deleting, and reports the press", async () => {
  const app = await open();
  await app.waitFor("id:bot-delete", { timeout: 10_000 });
  await app.waitFor("id:bot-clear-history", { timeout: 10_000 });
  await app.press("id:bot-clear-history");
  await app.waitUntil(() => log(app, "log=clear-history"));
  await app.press("id:bot-delete");
  await app.waitUntil(() => log(app, "log=delete-bot"));
});

test("the mute row of the Bot's direct is there for a you-Bot conversation", async () => {
  const app = await open();
  await app.waitFor("id:session-mute-switch", { timeout: 10_000 });
  await app.press("id:session-mute-switch");
  await app.press("id:session-mute-switch");
  expect(app.shows("id:session-mute")).toBe(true);
});

test("the engine picker moves the direct to another engine and back", async () => {
  const app = await open();
  await app.waitFor("id:playbook-select", { timeout: 15_000 });
  expect(app.texts().some((t) => t.startsWith("跟默认"))).toBe(true);
  await app.press("id:playbook-select");
  await app.waitFor("text:视频");
  await app.press("text:视频");
  await app.wait(800);
  expect(await ask(app, "playbook")).toBe("video");
  expect(app.texts()).toContain("视频");
  await app.press("id:playbook-select");
  await app.waitFor("text:跟默认（通用）");
  await app.press("text:跟默认（通用）");
  await app.wait(800);
  expect(await ask(app, "playbook")).toBe("none");
});

// ---- routines ------------------------------------------------------------

test("an empty list explains itself; adding asks for what is missing, then saves", async () => {
  const app = await open();
  await withoutRoutines(app);
  await app.waitFor("id:routine-empty", { timeout: 10_000 });
  await app.press("id:routine-empty-add");
  await app.waitFor("id:routine-editor");
  await app.press("id:routine-save");
  await app.waitFor("id:routine-title-error");
  await app.type("id:routine-title", "每日早报");
  await app.clear("id:routine-time");
  await app.type("id:routine-time", "24:01");
  await app.press("id:routine-save");
  await app.waitFor("id:routine-time-error");
  expect(app.shows("id:routine-title-error")).toBe(false);
  await app.clear("id:routine-time");
  await app.type("id:routine-time", "08:30");
  await app.type("id:routine-instruction", "汇总今天的工作");
  await app.press("id:routine-save");
  await app.waitFor("id:routine-editor", { state: "gone", timeout: 10_000 });
  expect(await routinesNow(app)).toEqual(["每日早报|08:30|daily|on|汇总今天的工作"]);
  expect(app.texts()).toContain("08:30");
  await withoutRoutines(app);
});

test("a weekly routine needs a day; the workdays preset fills Monday to Friday", async () => {
  const app = await open();
  await withoutRoutines(app);
  await app.press("id:routine-empty-add");
  await app.waitFor("id:routine-editor");
  await app.type("id:routine-title", "周报");
  await app.press("id:routine-freq-weekly");
  await app.waitFor("id:routine-weekdays");
  await app.press("id:routine-save");
  await app.waitFor("id:routine-weekdays-error");
  await app.press("id:routine-preset-workdays");
  await app.press("id:routine-day-sat");
  await app.press("id:routine-day-sat");
  await app.press("id:routine-save");
  await app.waitFor("id:routine-editor", { state: "gone", timeout: 10_000 });
  expect(await routinesNow(app)).toEqual(["周报|09:00|mon,tue,wed,thu,fri|on|"]);
  expect(app.texts()).toContain("工作日");
  await withoutRoutines(app);
});

test("a routine is edited under its own row, paused from its switch and deleted after asking", async () => {
  const app = await open();
  await withoutRoutines(app);
  await app.press("id:tool-seed-a");
  await app.waitFor("label:编辑日程: 巡检", { timeout: 10_000 });
  // Edit under the row.
  await app.press("label:编辑日程: 巡检");
  await app.waitFor("id:routine-editor");
  expect(app.value("id:routine-title")).toBe("巡检");
  expect(app.value("id:routine-time")).toBe("10:00");
  await app.type("id:routine-title", "二");
  await app.press("id:routine-save");
  await app.waitFor("id:routine-editor", { state: "gone", timeout: 10_000 });
  expect(await routinesNow(app)).toEqual(["巡检二|10:00|daily|on|看一眼"]);
  // Pause.
  await app.press("label:暂停: 巡检二");
  await app.waitFor("text:已暂停", { timeout: 10_000 });
  await app.wait(300);
  expect(await routinesNow(app)).toEqual(["巡检二|10:00|daily|off|看一眼"]);
  // Delete: cancel first, then confirm.
  await app.press("label:删除日程: 巡检二");
  await app.waitFor("id:danger-dialog");
  await app.press("id:danger-cancel");
  await app.waitFor("id:danger-dialog", { state: "gone" });
  expect((await routinesNow(app)).length).toBe(1);
  await app.press("label:删除日程: 巡检二");
  await app.press("id:danger-confirm");
  await app.waitFor("id:routine-empty", { timeout: 10_000 });
  expect(await routinesNow(app)).toEqual([]);
});

test("cancel closes the routine editor without saving", async () => {
  const app = await open();
  await withoutRoutines(app);
  await app.press("id:routine-empty-add");
  await app.type("id:routine-title", "不存");
  await app.press("id:routine-cancel");
  await app.waitFor("id:routine-editor", { state: "gone" });
  expect(await routinesNow(app)).toEqual([]);
});

test("on a phone the routine editor is a page whose back returns to the list", async () => {
  const app = await open({ width: 390, height: 800 });
  await withoutRoutines(app);
  await app.press("id:tool-seed-b");
  await app.waitFor("label:编辑日程: 手机", { timeout: 10_000 });
  expect(app.count("label:删除日程: 手机")).toBe(0);
  await app.press("label:编辑日程: 手机");
  await app.waitFor("id:routine-page");
  await app.waitFor("id:modal-back");
  await app.waitFor("id:routine-page-delete");
  await app.press("id:modal-back");
  await app.waitFor("id:routine-page", { state: "gone" });
  // The header's add opens a new one.
  await app.press("id:routine-header-add");
  await app.waitFor("id:routine-page");
  expect(app.shows("id:routine-page-delete")).toBe(false);
  await app.press("id:modal-back");
  await app.waitFor("id:routine-page", { state: "gone" });
  await withoutRoutines(app);
});

// ---- memory --------------------------------------------------------------

test("the memory list shows this Bot's memories, folds after five and counts them", async () => {
  const app = await open();
  await app.waitFor("id:memory-card");
  await app.waitFor("id:memory-row-fake-1", { timeout: 10_000 });
  expect(app.texts()).toContain("7");
  expect(app.shows("id:memory-row-fake-8")).toBe(false);
  expect(app.shows("id:memory-row-fake-6")).toBe(false);
  await app.press("id:memory-more");
  await app.waitFor("id:memory-row-fake-7");
  await app.press("id:memory-more");
  await app.waitFor("id:memory-row-fake-7", { state: "gone" });
});

test("a memory says how old it is, where it was formed and what the Bot has learnt", async () => {
  const app = await open();
  await app.waitFor("id:memory-row-fake-1", { timeout: 10_000 });
  expect(app.shows("id:memory-origin-fake-1")).toBe(true);
  expect(app.shows("id:memory-origin-missing-fake-2")).toBe(true);
  expect(app.texts()).toContain("今天");
  await app.waitFor("id:memory-learning-fake-2");
  expect(app.texts()).toContain("已停用");
});

test("the enabled box switches a memory off without opening it", async () => {
  const app = await open();
  await app.waitFor("id:memory-enabled-fake-4", { timeout: 10_000 });
  const off = () => app.texts().filter((t) => t === "已停用").length;
  const before = off();
  await app.press("id:memory-enabled-fake-4");
  await app.waitUntil(() => off() === before + 1);
  await app.press("id:memory-enabled-fake-4");
  await app.waitUntil(() => off() === before);
});

test("editing a memory saves the trimmed fields; an empty one is refused; cancel keeps the old", async () => {
  const app = await open();
  await app.waitFor("id:memory-edit-fake-4", { timeout: 10_000 });
  await app.press("id:memory-edit-fake-4");
  await app.waitFor("id:memory-editor");
  expect(app.value("id:memory-subject")).toBe("记忆 4");
  expect(app.enabled("id:memory-save")).toBe(false);
  expect(app.texts()).toContain("Writer");
  await app.clear("id:memory-subject");
  await app.press("id:memory-save");
  await app.waitFor("id:memory-subject-error");
  await app.type("id:memory-subject", "  新主题  ");
  await app.press("id:memory-save");
  await app.waitFor("id:memory-editor", { state: "gone", timeout: 10_000 });
  expect(app.texts()).toContain("新主题");
  expect(log(app, "memory-saved:fake-4")).toBe(true);
  await app.press("id:memory-edit-fake-4");
  await app.waitFor("id:memory-editor");
  await app.type("id:memory-body", "多余");
  await app.press("id:memory-cancel");
  await app.waitFor("id:memory-editor", { state: "gone" });
  expect(app.texts()).not.toContain("第 4 条记忆的内容。多余");
});

test("deleting a memory asks first, from the row and from the editor", async () => {
  const app = await open();
  await app.waitFor("id:memory-delete-fake-5", { timeout: 10_000 });
  await app.press("id:memory-delete-fake-5");
  await app.waitFor("id:danger-dialog");
  await app.press("id:danger-cancel");
  await app.waitFor("id:danger-dialog", { state: "gone" });
  expect(app.shows("id:memory-row-fake-5")).toBe(true);
  await app.press("id:memory-delete-fake-5");
  await app.press("id:danger-confirm");
  await app.waitFor("id:memory-row-fake-5", { state: "gone", timeout: 10_000 });
  // From the editor: the page's delete closes the editor and asks.
  await app.press("id:memory-edit-fake-1");
  await app.waitFor("id:memory-editor");
  await app.press("id:memory-page-delete");
  await app.waitFor("id:memory-editor", { state: "gone" });
  await app.waitFor("id:danger-dialog");
  await app.press("id:danger-confirm");
  await app.waitFor("id:memory-row-fake-1", { state: "gone", timeout: 10_000 });
});

test("on a phone the memory editor is a page and the row's switch sits on the right", async () => {
  const app = await open({ width: 390, height: 800 });
  await app.waitFor("id:memory-row-fake-2", { timeout: 10_000 });
  expect(app.shows("id:memory-edit-fake-2")).toBe(false);
  await app.press("id:memory-open-fake-2");
  await app.waitFor("id:memory-editor");
  await app.waitFor("id:modal-back");
  await app.waitFor("id:memory-save");
  expect(app.shows("id:memory-cancel")).toBe(false);
  await app.press("id:modal-back");
  await app.waitFor("id:memory-editor", { state: "gone" });
});

test("the shell's Back closes an open editor first", async () => {
  const app = await open();
  await app.waitFor("id:memory-edit-fake-3", { timeout: 10_000 });
  await app.press("id:memory-edit-fake-3");
  await app.waitFor("id:memory-editor");
  await app.press("id:editor-back");
  await app.waitFor("id:memory-editor", { state: "gone" });
  await app.waitUntil(() => log(app, "back=true"));
});
