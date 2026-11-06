/** The remote screen page against the story's scripted Mac (`stories/remote-screen.tsx`): what it shows and what it sends. */
import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const logged = (app: Awaited<ReturnType<typeof openStory>>) => (app.texts().find((t) => t.startsWith("log:")) ?? "").slice(4).trim();

async function connected(scenario: string) {
  const app = await openStory("remote-screen");
  await app.waitFor(`id:story-${scenario}`, { timeout: 10_000 });
  await app.press(`id:story-${scenario}`);
  await app.waitFor("id:screen-tile-0-0", { timeout: 10_000 });
  return app;
}

test("connects over a scripted Mac and shows its picture as tiles, with the route", async () => {
  const app = await connected("none");
  expect(app.count("id:screen-tile-0-0")).toBe(1);
  await app.waitFor("text:直连");
  expect(app.texts()).toContain("Mac 屏幕");
  expect(app.texts()).toContain("触摸板");
  // A Mac has smooth mode and no Ctrl+Alt+Del.
  expect(app.shows("id:screen-smooth")).toBe(true);
  expect(app.shows("id:screen-ctrl-alt-del")).toBe(false);
});

test("the key row sends a key, and an armed modifier is held around the next key then let go", async () => {
  const app = await connected("none");
  await app.press("id:screen-key-left");
  await app.waitUntil(() => logged(app) === "key:ff51:down key:ff51:up");
  await app.press("id:screen-key-command");
  await app.press("id:screen-key-escape");
  await app.waitUntil(() => logged(app).endsWith("key:ffeb:down key:ff1b:down key:ff1b:up key:ffeb:up"));
  // Let go after one key: the next goes alone.
  await app.press("id:screen-key-tab");
  await app.waitUntil(() => logged(app).endsWith("key:ffeb:up key:ff09:down key:ff09:up"));
});

test("the soft keyboard's text reaches the Mac as keysyms", async () => {
  const app = await connected("none");
  await app.type("id:screen-input", "hi");
  await app.waitUntil(() => logged(app).includes("key:68:down key:68:up key:69:down key:69:up"));
});

test("a slide on the picture drags with the left button from where the finger landed", async () => {
  const app = await connected("none");
  await app.drag("id:screen-stage", { x: 30, y: 0 });
  await app.waitUntil(() => /pointer:\d+,\d+:1/.test(logged(app)) && /pointer:\d+,\d+:0$/.test(logged(app)), { timeout: 5000 });
  // The button goes down at the middle of the picture (the stage's middle) and comes up at the end of the slide.
  expect(logged(app)).toMatch(/^pointer:32,24:1 /);
  const ends = logged(app).split(" ");
  const last = ends[ends.length - 1]!;
  expect(last.startsWith("pointer:32,24")).toBe(false);
});

test("in trackpad mode a slide moves the pointer by its travel and presses nothing", async () => {
  const app = await connected("none");
  await app.press("id:screen-trackpad");
  await app.waitFor("id:screen-pointer");
  await app.drag("id:screen-stage", { x: 40, y: 0 });
  await app.waitUntil(() => logged(app).includes("pointer:"), { timeout: 5000 });
  const moves = logged(app).split(" ");
  expect(moves.every((m) => m.endsWith(":0"))).toBe(true);
  expect(moves.some((m) => !m.startsWith("pointer:32,24"))).toBe(true);
});

test("trackpad mode is a toggle that says how it works", async () => {
  const app = await connected("none");
  await app.press("id:screen-trackpad");
  await app.waitFor("id:screen-tip");
  expect(app.texts().some((t) => t.startsWith("单指滑动移动光标"))).toBe(true);
  await app.waitFor("id:screen-pointer");
  await app.press("id:screen-trackpad");
  await app.waitFor("id:screen-pointer", { state: "gone" });
});

test("the header's zoom button goes in and comes back to fitting the screen", async () => {
  const app = await connected("none");
  expect(app.texts()).toContain("原始大小");
  await app.press("id:screen-zoom");
  await app.waitFor("text:适应屏幕");
  await app.press("id:screen-zoom");
  await app.waitFor("text:原始大小");
});

test("disconnecting says so, and reconnect brings the picture back", async () => {
  const app = await connected("none");
  await app.press("id:screen-disconnect");
  await app.waitFor("text:连接已断开。");
  await app.waitUntil(() => app.texts().includes("stops:1"));
  await app.press("id:screen-reconnect");
  await app.waitFor("id:screen-tile-0-0", { timeout: 10_000 });
});

test("ARD asks for the Mac's account, and says when it is refused", async () => {
  const app = await openStory("remote-screen");
  await app.waitFor("id:story-ard", { timeout: 10_000 });
  await app.press("id:story-ard");
  await app.waitFor("text:登录这台 Mac 的屏幕共享", { timeout: 10_000 });
  expect(app.shows("id:screen-username")).toBe(true);
  // Both fields are needed.
  expect(app.enabled("id:screen-submit")).toBe(false);
  await app.type("id:screen-username", "me");
  await app.type("id:screen-password", "secret");
  expect(app.enabled("id:screen-submit")).toBe(true);
  await app.press("id:screen-submit");
  // The Mac refuses; the form comes back with its words, asked from a fresh connection.
  await app.waitFor("text:账户名或密码不对，屏幕共享拒绝了。", { timeout: 10_000 });
  expect(app.shows("id:screen-username")).toBe(true);
});

test("a kept sign-in is tried at once, and the account name comes back in the form when it fails", async () => {
  const app = await openStory("remote-screen");
  await app.waitFor("id:story-remembered", { timeout: 10_000 });
  await app.press("id:story-remembered");
  await app.waitFor("text:账户名或密码不对，屏幕共享拒绝了。", { timeout: 10_000 });
  expect(app.value("id:screen-username")).toBe("me");
  expect(app.shows("id:screen-keep")).toBe(true);
});

test("Screen Sharing off on the Mac is said with what to do, and the page can try again", async () => {
  const app = await openStory("remote-screen");
  await app.waitFor("id:story-off", { timeout: 10_000 });
  await app.press("id:story-off");
  await app.waitFor("text:Mac 上的「屏幕共享」没开。在 Mac 上打开 系统设置 → 通用 → 共享 → 屏幕共享。", { timeout: 10_000 });
  expect(app.shows("id:screen-reconnect")).toBe(true);
});

test("a Mac that never answers ends in a failure, not an endless wait", async () => {
  const app = await openStory("remote-screen");
  await app.waitFor("id:story-silent", { timeout: 10_000 });
  await app.press("id:story-silent");
  await app.waitFor("text:正在等 Mac 的屏幕共享回应…", { timeout: 10_000 });
  await app.waitFor("text:Mac 的屏幕共享没有回应。", { timeout: 10_000 });
  expect(app.shows("id:screen-reconnect")).toBe(true);
});

test("a Windows PC has its own words and keys: Ctrl first, Ctrl+Alt+Del, no smooth", async () => {
  const app = await connected("windows");
  expect(app.texts()).toContain("电脑屏幕");
  expect(app.shows("id:screen-smooth")).toBe(false);
  expect(app.texts()).toContain("Ctrl");
  expect(app.texts()).toContain("Win");
  await app.press("id:screen-ctrl-alt-del");
  await app.waitUntil(() => logged(app).includes("key:ffe3:down key:ffe9:down key:ffff:down key:ffff:up key:ffe9:up key:ffe3:up"));
});

test("the back button leaves the page and lets the Mac go", async () => {
  const app = await connected("none");
  await app.press("id:screen-back");
  await app.waitFor("id:screen-pane", { state: "gone" });
  await app.waitUntil(() => app.texts().includes("stops:1"));
});
