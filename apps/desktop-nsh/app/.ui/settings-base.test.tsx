import { expect, open, test } from "nsh/test";
import { openStory, seeded } from "./fixture";

async function storyWithPicker(picked: string | null) {
  const endpoint = { origin: seeded.origin, token: seeded.token };
  const asked: unknown[] = [];
  const app = await open("../Story.tsx", {
    platform: "macos",
    width: 1100,
    height: 900,
    locale: "zh-CN",
    network: "live",
    host: {
      params: { ...endpoint, windowId: 1, material: "none", story: "settings-base" },
      handlers: {
        "tauri.local_api_endpoint": endpoint,
        "tauri.app_version": "0.0.0",
        "tauri.window_material": "none",
        "tauri.pick_workspace_folder": (args: unknown) => (asked.push(args), picked),
      },
    },
  });
  return { app, asked };
}

test("the autosave label goes hint, saving, saved, and failed outweighs saved", async () => {
  const app = await openStory("settings-base");
  await app.waitFor("id:settings-save-state", { timeout: 10_000 });
  await app.waitFor("text:改动自动保存");
  await app.press("id:save-go");
  await app.waitFor("text:保存中…");
  await app.press("id:save-done");
  await app.waitFor("text:已自动保存");
  await app.press("id:save-fail");
  await app.waitFor("text:没能保存。");
});

test("a settings row shows its title, description, marks and its control works", async () => {
  const app = await openStory("settings-base");
  await app.waitFor("id:dark-label", { timeout: 10_000 });
  expect(app.shows("text:偏好设置")).toBe(true);
  expect(app.shows("text:外观、语言与工作区")).toBe(true);
  expect(app.shows("text:跟随系统外观，或固定为深色。")).toBe(true);
  expect(app.shows("text:实验")).toBe(true);
  expect(app.shows("text:只影响新对话")).toBe(true);
  await app.press("id:dark-switch");
  await app.waitUntil(() => app.texts().includes("dark:on"));
});

test("section tabs open a section and show their counts; the list drills into one", async () => {
  const app = await openStory("settings-base");
  await app.waitFor("id:models-tab-providers", { timeout: 10_000 });
  await app.waitFor("id:models-tab-providers-count");
  expect(app.shows("id:models-tab-builtin-count")).toBe(false);
  await app.press("id:models-tab-ladder");
  await app.waitUntil(() => app.texts().includes("active:ladder"));
  await app.press("id:section-builtin");
  await app.waitUntil(() => app.texts().includes("picked:builtin"));
  expect(app.shows("text:3 个服务，2 个可用")).toBe(true);
});

test("a help tip opens on hover and pins on a press until Escape", async () => {
  const app = await openStory("settings-base");
  await app.waitFor("id:tip-prefs", { timeout: 10_000 });
  expect(app.shows("id:tip-prefs-text")).toBe(false);
  await app.hover("id:tip-prefs");
  await app.waitFor("id:tip-prefs-text");
  expect(app.texts()).toContain("这里的选项改动后立即保存，无需确认。");
  await app.press("id:tip-prefs");
  await app.press("id:tip-prefs");
  await app.waitFor("id:tip-prefs-text", { state: "gone" });
  await app.press("id:tip-prefs");
  await app.waitFor("id:tip-prefs-text");
  await app.wait(400);
  expect(app.shows("id:tip-prefs-text")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:tip-prefs-text", { state: "gone" });
});

test("the subpage Back and ✕ show only in a narrow window", async () => {
  const app = await openStory("settings-base");
  await app.waitFor("id:card", { timeout: 10_000 });
  expect(app.shows("text:✕")).toBe(false);
  await app.setViewport(600, 900);
  await app.waitFor("text:✕");
});

test("the picker asks the shell's folder dialog and keeps what it returns", async () => {
  const { app, asked } = await storyWithPicker("/Users/a/chosen");
  await app.waitFor("id:workspace", { timeout: 10_000 });
  expect(app.texts()).toContain("尚未设置");
  await app.press("id:workspace");
  await app.waitUntil(() => app.texts().includes("workspace:/Users/a/chosen|"));
  expect(asked.length).toBe(1);
  expect(JSON.stringify(asked[0])).toContain("选择工作区");
  expect(app.texts()).toContain("/Users/a/chosen");
  await app.press("id:workspace-choose");
  await app.waitUntil(() => asked.length === 2);
  expect(JSON.stringify(asked[1])).toContain("/Users/a/chosen");
});

test("a cancelled dialog changes nothing; with no shell it says it is unavailable", async () => {
  const { app } = await storyWithPicker(null);
  await app.waitFor("id:workspace", { timeout: 10_000 });
  await app.press("id:workspace");
  await app.wait(300);
  expect(app.texts()).toContain("workspace:|");
  expect(app.shows("id:workspace-hint")).toBe(false);
});

test("a remote picker browses the host's folders: open, Up, use, and a folder that cannot be read", async () => {
  const app = await openStory("settings-base");
  await app.waitFor("id:remote-workspace", { timeout: 10_000 });
  await app.press("id:remote-workspace");
  await app.waitFor("id:host-browse");
  expect(app.texts()).toContain("/Users/a");
  expect(app.shows("id:host-browse-item:notes.txt")).toBe(false);
  expect(app.enabled("id:host-browse-up")).toBe(true);
  await app.press("id:host-browse-item:locked");
  await app.waitFor("text:请在 Mac 上授权访问");
  await app.press("id:host-browse-item:work");
  await app.waitUntil(() => app.texts().includes("/Users/a/work"));
  expect(app.shows("text:请在 Mac 上授权访问")).toBe(false);
  await app.press("id:host-browse-use");
  await app.waitFor("id:host-browse", { state: "gone" });
  await app.waitUntil(() => app.texts().includes("workspace:|/Users/a/work"));
  await app.press("id:remote-workspace-choose");
  await app.waitFor("id:host-browse");
  await app.press("id:host-browse-cancel");
  await app.waitFor("id:host-browse", { state: "gone" });
});

test("the workspace id field says as it is typed whether the id is well formed", async () => {
  const app = await openStory("settings-base");
  await app.waitFor("id:ws-id", { timeout: 10_000 });
  expect(app.shows("id:ws-id-hint")).toBe(true);
  expect(app.shows("id:ws-id-error")).toBe(false);
  await app.type("id:ws-id", "nope");
  await app.waitFor("id:ws-id-error");
  await app.clear("id:ws-id");
  await app.type("id:ws-id", "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ");
  await app.waitFor("id:ws-id-hint");
  expect(app.shows("id:ws-id-error")).toBe(false);
});

test("the independent-runtime confirmation confirms, cancels, and while draining holds and offers wait or force", async () => {
  const app = await openStory("settings-base");
  await app.waitFor("id:ask-enable", { timeout: 10_000 });
  await app.press("id:ask-enable");
  await app.waitFor("text:确认开启独立运行时");
  expect(app.shows("id:independent-waiting")).toBe(false);
  await app.press("id:independent-confirm-go");
  await app.waitUntil(() => app.texts().includes("log:confirm"));
  await app.waitFor("text:确认开启独立运行时", { state: "gone" });
  await app.press("id:ask-enable");
  await app.press("id:independent-cancel");
  await app.waitUntil(() => app.texts().includes("log:cancel"));
  await app.press("id:ask-drain");
  await app.waitFor("text:确认关闭独立运行时");
  await app.waitFor("id:independent-waiting");
  await app.waitFor("id:independent-error");
  expect(app.texts()).toContain("原因：busy");
  await app.press("id:independent-wait");
  await app.waitUntil(() => app.texts().includes("log:wait"));
  expect(app.shows("id:independent-confirm-go")).toBe(false);
  await app.press("id:independent-force");
  await app.waitUntil(() => app.texts().includes("log:force"));
  await app.waitFor("text:确认关闭独立运行时", { state: "gone" });
});
