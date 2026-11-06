import { expect, open, test } from "nsh/test";
import { openStory, seeded } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

const probe = (app: App) => app.texts().find((t) => t.startsWith("probe:")) ?? "";
/** Reads what the daemon holds through the story's probe button (the test process has no network of its own). */
async function read(app: App, button: string, label: string): Promise<string> {
  await app.press(`id:${button}`);
  await app.waitUntil(() => probe(app).startsWith(`probe:${label}=`), { timeout: 8000 });
  return probe(app);
}
async function openPrompts(options: Parameters<typeof openStory>[1] = {}, row = "id:prompt-turn.system") {
  const app = await openStory("settings-prompts", options);
  await app.waitFor("id:prompts-search", { timeout: 10_000 });
  await app.waitFor(row, { timeout: 10_000 });
  return app;
}
/** Restores the default of turn.memory (zh) whatever a test left in it. */
async function restore(app: App) {
  if ((await read(app, "probe-text", "text")).includes('"edited":true')) {
    await app.press("id:prompt-turn.memory");
    await app.waitFor("id:prompt-reset", { timeout: 8000 });
    await app.press("id:prompt-reset");
    await app.press("id:prompt-reset-do");
    await app.waitFor("id:prompt-reset", { state: "gone" });
    await app.press("id:modal-close");
  }
}

test("prompts show one group a tab with the tools last; a search looks through every group", async () => {
  const app = await openPrompts();
  for (const group of ["turn", "agent", "tool"]) await app.waitFor(`id:prompts-tab-${group}`);
  expect(app.shows("id:prompts-tab-call")).toBe(false);
  // The first group is open; a default says nothing about being one.
  expect(app.shows("id:prompt-group-turn")).toBe(true);
  expect(app.shows("id:prompt-turn.system-chip")).toBe(false);
  await app.press("id:prompts-tab-tool");
  await app.waitFor("id:prompt-group-tool");
  expect(app.shows("id:prompts-tools-note")).toBe(true);
  expect(app.shows("id:prompt-tool.shell")).toBe(true);
  // A search keeps what matches, by group, in one list, and the tabs go.
  await app.type("id:prompts-search", "turn.memory");
  await app.waitFor("id:prompt-turn.memory");
  expect(app.shows("id:prompts-tab-turn")).toBe(false);
  expect(app.shows("id:prompt-turn.system")).toBe(false);
  await app.clear("id:prompts-search");
  await app.type("id:prompts-search", "nothing like it");
  await app.waitFor("id:prompts-no-match");
  await app.clear("id:prompts-search");
  await app.waitFor("id:prompts-tab-turn");
});

test("a row opens its editor page; what is typed saves itself, and the history, comparison and reset follow", async () => {
  const app = await openPrompts();
  await app.press("id:prompt-turn.memory");
  await app.waitFor("id:prompt-text", { timeout: 10_000 });
  expect(app.shows("id:prompt-editor-id")).toBe(true);
  expect(app.texts()).toContain("turn.memory");
  expect(app.shows("id:prompt-reset")).toBe(false);
  await app.type("id:prompt-text", "追加一句。");
  await app.waitFor("text:已保存", { timeout: 8000 });
  const saved = await read(app, "probe-text", "text");
  expect(saved).toContain("追加一句。");
  expect(saved).toContain('"edited":true');
  // The comparison marks what changed from the default.
  await app.press("id:prompt-tab-compare");
  await app.waitFor("id:prompt-compare-diff");
  // The added words are marked inside their changed line.
  await app.waitFor("id:prompt-compare-diff-line-0", { timeout: 3000 });
  expect(app.texts().some((t) => t.includes("追加一句。"))).toBe(true);
  expect(app.shows("id:prompt-text")).toBe(false);
  // The history lists the change, with Undo on the latest one.
  await app.press("id:prompt-tab-history");
  await app.waitFor("id:prompt-tab-history-count");
  expect(app.texts().some((t) => t.endsWith("· 修改"))).toBe(true);
  expect(app.texts()).toContain("撤销");
  // Reset asks first, then goes back to the default.
  await app.press("id:prompt-tab-text");
  await app.press("id:prompt-reset");
  await app.waitFor("id:prompt-reset-confirm");
  await app.press("id:prompt-reset-cancel");
  expect(app.shows("id:prompt-reset-confirm")).toBe(false);
  await app.press("id:prompt-reset");
  await app.press("id:prompt-reset-do");
  await app.waitFor("id:prompt-reset", { state: "gone" });
  expect(await read(app, "probe-text", "text")).toContain('"edited":false');
  await app.press("id:modal-close");
  await app.waitFor("id:prompt-text", { state: "gone" });
});

test("closing the editor saves what was typed at once", async () => {
  const app = await openPrompts();
  await app.press("id:prompt-turn.memory");
  await app.waitFor("id:prompt-text", { timeout: 10_000 });
  await app.type("id:prompt-text", "马上存。");
  await app.press("id:modal-close");
  await app.waitFor("id:prompt-text", { state: "gone" });
  expect(await read(app, "probe-text", "text")).toContain("马上存。");
  // The row now carries the edit mark; the edited filter keeps it.
  await app.waitFor("id:prompt-turn.memory-chip");
  await app.waitFor("id:prompts-filter-edited");
  await app.press("id:prompts-filter-edited");
  await app.waitFor("id:prompt-turn.memory");
  expect(app.shows("id:prompt-turn.system")).toBe(false);
  await app.press("id:prompts-filter-all");
  await restore(app);
});

test("the language switch keeps the view you were reading, and the editor page closes with ✕", async () => {
  const app = await openPrompts();
  await app.press("id:prompt-turn.system");
  await app.waitFor("id:prompt-locale-en", { timeout: 10_000 });
  await app.press("id:prompt-tab-history");
  await app.waitFor("id:prompt-no-history");
  await app.press("id:prompt-locale-en");
  await app.waitFor("id:prompt-no-history", { timeout: 8000 });
  expect(app.shows("id:prompt-panel-history")).toBe(true);
  // The Back of the story reaches the editor's page and closes it.
  await app.press("id:modal-close");
  await app.waitFor("id:prompt-editor", { state: "gone" });
  // A prompt opened afresh starts on its text.
  await app.press("id:prompt-turn.system");
  await app.waitFor("id:prompt-text", { timeout: 10_000 });
});

test("on a phone the groups are a list and a group opens as a page; the editor is a page with Back", async () => {
  const app = await openPrompts({ width: 480, height: 800 }, "id:section-turn");
  await app.waitFor("id:section-turn", { timeout: 10_000 });
  expect(app.shows("id:prompts-tab-turn")).toBe(false);
  expect(app.shows("id:prompt-turn.system")).toBe(false);
  await app.press("id:section-turn");
  await app.waitFor("id:prompt-turn.system");
  expect(app.shows("id:prompts-search")).toBe(false);
  await app.press("id:prompt-turn.memory");
  await app.waitFor("id:prompt-text", { timeout: 10_000 });
  expect(app.shows("id:modal-back")).toBe(true);
  expect(app.shows("id:prompt-editor-id")).toBe(false);
  await app.press("id:modal-back");
  await app.waitFor("id:prompt-text", { state: "gone" });
  // Back from the group's page goes to the list of groups.
  await app.press("id:story-back");
  await app.waitUntil(() => app.texts().includes("log:back:section"));
  await app.waitFor("id:section-turn");
});

test("lessons: each shows its kind and badge; mode and retire change it, a refused change says so, restore brings it back", async () => {
  const app = await openStory("settings-prompts");
  await app.press("id:story-tab-lessons");
  await app.waitFor("id:lesson-L-warn", { timeout: 10_000 });
  expect(app.texts()).toContain("grep -r");
  expect(app.texts()).toContain("先警告");
  expect(app.texts()).toContain("拦下");
  expect(app.texts()).toContain("已采用");
  expect(app.texts()).toContain("待你在卡片上确认");
  // A reflection has no mode button; a retired shell lesson offers Restore.
  expect(app.shows("id:lesson-L-list-mode")).toBe(false);
  expect(app.shows("id:lesson-L-old-restore")).toBe(true);
  expect(app.shows("id:lesson-L-warn-restore")).toBe(false);
  await app.press("id:lesson-L-warn-mode");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("log:patch:L-warn") && t.includes('"action":"block"')));
  await app.waitUntil(() => app.texts().includes("改成先警告") === true || app.shows("id:lesson-L-warn-mode"));
  await app.press("id:lesson-L-warn-retire");
  await app.waitFor("id:lesson-L-warn-restore");
  await app.press("id:lesson-L-warn-restore");
  await app.waitFor("id:lesson-L-warn-retire");
  // The story refuses retiring L-block.
  await app.press("id:lesson-L-block-retire");
  await app.waitFor("id:lesson-L-block-failed");
  expect(app.shows("id:lesson-L-block-retire")).toBe(true);
});

test("notifications: a category and the quiet hours change in the daemon; an unanswered shell leaves the test disabled", async () => {
  const app = await openStory("settings-prompts");
  await app.press("id:story-tab-notifications");
  await app.waitFor("id:notif-cat-reply", { timeout: 10_000 });
  await app.waitUntil(() => app.texts().includes("6 / 6"), { timeout: 8000 });
  await app.press("id:notif-cat-reply");
  await app.waitUntil(() => app.texts().includes("5 / 6"), { timeout: 8000 });
  expect(await read(app, "probe-policy", "policy")).toContain('"reply":false');
  await app.press("id:notif-cat-reply");
  await app.waitUntil(() => app.texts().includes("6 / 6"), { timeout: 8000 });
  expect(await read(app, "probe-policy", "policy")).toContain('"reply":true');
  // Quiet hours: off, then on shows the two times and the zone.
  expect(app.shows("id:notif-quiet-times")).toBe(false);
  await app.press("id:notif-quiet-switch");
  await app.waitFor("id:notif-quiet-times", { timeout: 8000 });
  await app.waitFor("id:notif-quiet-start");
  expect(await read(app, "probe-policy", "policy")).toContain('"quiet":true');
  expect(app.texts()).toContain("UTC");
  await app.press("id:notif-quiet-switch");
  await app.waitFor("id:notif-quiet-times", { state: "gone" });
  // The shell answers neither permission command: the device is off and the native test is disabled.
  expect(app.texts()).toContain("未开启");
  await app.waitFor("id:notif-test-disabled");
  expect(app.enabled("id:notif-send-test")).toBe(false);
  await app.press("id:notif-device-switch");
  await app.wait(300);
  expect(app.shows("id:notif-sound")).toBe(false);
});

test("notifications: with the shell granting permission the device turns on; sound, preview and badge appear, and the test can be sent", async () => {
  const endpoint = { origin: seeded.origin, token: seeded.token };
  const asked: string[] = [];
  const grant = { permission: "granted", nativeReadingV1: true, nativeDeliveryV1: true };
  const app = await open("../Story.tsx", {
    platform: "macos",
    width: 1100,
    height: 900,
    locale: "zh-CN",
    network: "live",
    host: {
      params: { ...endpoint, windowId: 1, material: "none", story: "settings-prompts" },
      handlers: {
        "tauri.local_api_endpoint": endpoint,
        "tauri.app_version": "0.0.0",
        "tauri.window_material": "none",
        "tauri.notification_permission_state": () => (asked.push("state"), { ...grant, permission: "default" }),
        "tauri.request_notification_permission": () => (asked.push("request"), grant),
      },
    },
  });
  await app.press("id:story-tab-notifications");
  await app.waitFor("id:notif-device-switch", { timeout: 10_000 });
  expect(app.shows("id:notif-sound")).toBe(false);
  await app.press("id:notif-device-switch");
  await app.waitFor("id:notif-sound", { timeout: 8000 });
  expect(asked).toContain("request");
  expect(await read(app, "probe-device", "device")).toContain('"enabled":true');
  expect(app.shows("id:notif-preview")).toBe(true);
  await app.press("id:notif-badge");
  await app.wait(500);
  expect(await read(app, "probe-device", "device")).toContain('"badge":false');
  // With permission granted the test button is live; it ends in a word either way (sent, queued or refused).
  expect(app.enabled("id:notif-send-test")).toBe(true);
  await app.press("id:notif-send-test");
  await app.waitFor("id:notif-test-feedback", { timeout: 8000 });
  // Turning it off again.
  await app.press("id:notif-device-switch");
  await app.waitFor("id:notif-sound", { state: "gone" });
  expect(await read(app, "probe-device", "device")).toContain('"enabled":false');
});
