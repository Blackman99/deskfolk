/** The header, the pane's bar, the tab labels and "elsewhere" on the fixture runtime's conversations. */
import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async (options: Parameters<typeof openStory>[1] = { height: 3400 }) => {
  const app = await openStory("chat-header", options);
  await app.waitFor("id:header-direct", { timeout: 15_000 });
  return app;
};
const state = (app: Awaited<ReturnType<typeof open>>) => app.texts().find((t) => t.startsWith("settings:")) ?? "";
const log = (app: Awaited<ReturnType<typeof open>>) => app.texts().find((t) => t === "—" || /(^| \| )(create-bot|onboarding|group-settings|bar:trace)/.test(t)) ?? "";

test("a direct's header names the Bot, says its status and who is in it", async () => {
  const app = await open();
  expect(app.shows("id:header-direct >> text:Writer")).toBe(true);
  expect(app.shows("id:header-direct >> text:你 ↔ Writer")).toBe(true);
  expect(app.shows("id:header-direct >> text:空闲")).toBe(true);
  expect(app.shows("id:header-direct >> text:fixture")).toBe(true);
  // A group lists its members and has the group's own settings label; a direct has the Bot's.
  expect(app.shows("id:header-group >> text:周报小组")).toBe(true);
  expect(app.shows("id:header-group >> text:在场: 你, Writer, Editor")).toBe(true);
  expect(app.shows("id:header-group >> text:群组设置")).toBe(true);
  expect(app.shows("id:header-direct >> text:Bot 设置")).toBe(true);
});

test("pin and settings are the header's buttons and take their state from the caller", async () => {
  const app = await open();
  expect(state(app)).toContain("pinned:0");
  await app.press("id:header-direct >> id:top-pin");
  await app.waitUntil(() => state(app).includes("pinned:1"));
  expect(app.shows("id:header-direct >> text:已置顶")).toBe(true);
  await app.press("id:header-direct >> id:top-pin");
  await app.waitUntil(() => state(app).includes("pinned:0"));
  await app.press("id:header-direct >> id:top-settings");
  await app.waitUntil(() => state(app).includes("settings:on"));
  // The identity is the same button as the settings one.
  await app.press("id:header-direct >> id:top-identity");
  await app.waitUntil(() => state(app).includes("settings:off"));
});

test("the group header's settings button reaches the caller", async () => {
  const app = await open();
  await app.press("id:header-group >> id:top-settings");
  await app.waitUntil(() => log(app).includes("group-settings"));
});

test("the file drop has no actions, and with no conversation the header asks for one", async () => {
  const app = await open();
  expect(app.shows("id:header-file >> id:top-file-identity")).toBe(true);
  expect(app.count("id:header-file >> id:top-pin")).toBe(0);
  expect(app.count("id:header-file >> id:top-settings")).toBe(0);
  expect(app.shows("id:header-none >> text:选择一个会话")).toBe(true);
  expect(app.count("id:header-none >> id:top-pin")).toBe(0);
});

test("on a phone the actions fold into a sheet and back leaves the conversation", async () => {
  const app = await open({ width: 420, height: 3400 });
  expect(app.count("id:header-direct >> id:top-actions")).toBe(0);
  await app.press("id:header-direct >> id:top-more");
  await app.waitFor("id:mobile-pin");
  await app.press("id:mobile-pin");
  await app.waitUntil(() => state(app).includes("pinned:1"));
  await app.waitFor("id:mobile-pin", { state: "gone" });
  await app.press("id:header-direct >> id:top-more");
  await app.press("id:mobile-settings");
  await app.waitUntil(() => state(app).includes("settings:on"));
  expect(app.shows("id:header-direct >> id:top-back")).toBe(true);
});

test("a pane's bar names the conversation and runs the tab's actions", async () => {
  const app = await open();
  expect(app.shows("id:bar-direct >> id:bar-title")).toBe(true);
  expect(app.shows("id:bar-direct >> text:Writer")).toBe(true);
  expect(app.shows("id:bar-direct >> text:fixture")).toBe(true);
  await app.press("id:bar-direct >> id:bar-action-pin");
  await app.waitUntil(() => state(app).includes("pinned:1"));
  await app.press("id:bar-direct >> id:bar-action-settings");
  await app.waitUntil(() => state(app).includes("settings:on"));
  // The identity opens the settings too.
  await app.press("id:bar-direct >> id:bar-identity");
  await app.waitUntil(() => state(app).includes("settings:off"));
  await app.press("id:bar-direct >> id:bar-action-trace");
  await app.waitUntil(() => log(app).includes("bar:trace"));
  // The flow's action carries its word.
  expect(app.shows("id:bar-direct >> text:经过")).toBe(true);
});

test("a project session's bar and tab say the agent and the directory", async () => {
  const app = await open();
  expect(app.shows("id:bar-project >> text:Claude Code · ~/my-projects/real-bot")).toBe(true);
  expect(app.shows("id:tab-project >> text:Deskfolk")).toBe(true);
  expect(app.shows("id:tab-file >> id:tab-file-mark")).toBe(true);
  expect(app.shows("id:tab-direct >> text:Writer")).toBe(true);
  expect(app.shows("id:tab-group >> text:周报小组")).toBe(true);
});

test("a Bot that works in another conversation is said on the direct, and only then", async () => {
  const app = await open();
  expect(app.count("id:elsewhere")).toBe(0);
  expect(app.count("id:header-direct >> id:top-elsewhere")).toBe(0);
  await app.press("id:toggle-elsewhere");
  await app.waitUntil(() => state(app).includes("elsewhere:on"));
  await app.waitFor("id:header-direct >> id:top-elsewhere", { timeout: 10_000 });
  await app.waitFor("id:elsewhere");
  // Its face shows the work as well.
  expect(app.shows("id:header-direct >> id:top-status-dot")).toBe(true);
  await app.press("id:toggle-elsewhere");
  await app.waitFor("id:header-direct >> id:top-elsewhere", { state: "gone" });
});
