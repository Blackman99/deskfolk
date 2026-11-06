/** The folded rail: its order and marks, its tooltips and their grace, the footer and the tools menu flown out beside it. */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy";
import { openStory, seeded } from "./fixture";

const t = copyFor("zh");
type App = Awaited<ReturnType<typeof open>>;
const open = async (options: Parameters<typeof openStory>[1] = { height: 900 }) => {
  const app = await openStory("sidebar-rail", options);
  await app.waitFor(`id:rail-session-${seeded.group}`, { timeout: 15_000 });
  return app;
};
const log = (app: App) => app.texts().find((x) => x === "—" || /^(rail-|search|expand|menu:|drag:|workspace-toggle|lift|create|spend|routines|usage|roles|terminal|foot-|narrow-|archived|fab|screen)/.test(x)) ?? "";
const state = (app: App) => app.texts().find((x) => x.startsWith("selected:")) ?? "";
const rail = (id: string) => `id:rail-session-${id}`;

test("the rail lists the conversations as avatars, the file drop in a section of its own", async () => {
  const app = await open();
  expect(app.shows(rail(seeded.writerDirect))).toBe(true);
  expect(app.shows(rail(seeded.group))).toBe(true);
  expect(app.shows("id:rail-file-drop")).toBe(true);
  // The file drop, then the Bots' section: one divider. Pinning the group makes a section before them.
  expect(app.count("id:rail-divider")).toBe(1);
  await app.press("id:story-pin");
  await app.waitUntil(() => app.count("id:rail-divider") === 2);
  await app.press("id:story-pin");
  await app.waitUntil(() => app.count("id:rail-divider") === 1);
  // Hiding the group takes its avatar away.
  await app.press("id:story-hide-group");
  await app.waitFor(rail(seeded.group), { state: "gone" });
});

test("a project session is a section of its own and wears its agent's mark, with no dot while the agent is quiet", async () => {
  const app = await open();
  await app.press("id:story-extras");
  await app.waitFor("id:rail-agent");
  expect(app.count("id:rail-divider")).toBe(2);
  expect(app.shows("id:rail-session-project-story >> id:rail-agent")).toBe(true);
  expect(app.shows("id:rail-session-project-story >> id:rail-agent-busy")).toBe(false);
});

test("what waits on you is a badge with its count, and unread is another", async () => {
  const app = await open();
  expect(app.shows(`${rail(seeded.group)} >> id:rail-badge-waiting`)).toBe(true);
  expect(app.shows(`${rail(seeded.group)} >> text:2`)).toBe(true);
  expect(app.shows(`${rail(seeded.writerDirect)} >> id:rail-badge`)).toBe(true);
  expect(app.shows(`${rail(seeded.writerDirect)} >> text:4`)).toBe(true);
  expect(app.shows(`${rail(seeded.writerDirect)} >> id:rail-badge-waiting`)).toBe(false);
});

test("an avatar opens its conversation, its menu and the start of a drag; the rail's buttons expand and search", async () => {
  const app = await open();
  await app.press(rail(seeded.group));
  await app.waitUntil(() => state(app).includes(`selected:${seeded.group}`));
  await app.rightClick(rail(seeded.writerDirect));
  await app.waitUntil(() => log(app).includes("menu:direct"));
  await app.press("id:rail-expand");
  await app.waitUntil(() => log(app).includes("expand"));
  await app.press("id:rail-search");
  await app.waitUntil(() => log(app).includes("search"));
  expect(app.shows("id:rail-tip-search")).toBe(false);
});

test("the working filter keeps what is waiting or unread, and stays pressed", async () => {
  const app = await open();
  await app.press("id:story-pin");
  await app.press("id:rail-working");
  // Both rows have something on them (an approval, unread), so both stay; the divider is the pin's.
  expect(app.shows(rail(seeded.group))).toBe(true);
  expect(app.shows(rail(seeded.writerDirect))).toBe(true);
  await app.press("id:rail-working");
});

test("a tip shows for the pointer, stays while it rests on the tip, and goes when the pointer leaves", async () => {
  const app = await open({ height: 900, clock: {} });
  const tip = `id:rail-tip-${seeded.group}`;
  await app.hover(rail(seeded.group));
  // (A headless hover settles the 200ms wait before it resolves, so the delay itself is not observable here.)
  await app.clock!.runFor(120);
  expect(app.shows(tip)).toBe(true);
  // The title, then what the avatar shows: the approvals waiting.
  expect(app.shows(`${tip} >> text:周报小组`)).toBe(true);
  expect(app.shows(`${tip} >> text:${t.sidebar.statusWaitingApproval} 2`)).toBe(true);
  // Onto the tip and it stays, past the grace.
  await app.hover(tip);
  await app.clock!.runFor(400);
  expect(app.shows(tip)).toBe(true);
  await app.hover("id:rail-expand");
  await app.clock!.runFor(100);
  expect(app.shows(tip)).toBe(false);
});

test("leaving the button closes the tip only after the grace", async () => {
  const app = await open({ height: 900, clock: {} });
  const tip = `id:rail-tip-${seeded.group}`;
  await app.hover(rail(seeded.group));
  await app.clock!.runFor(250);
  expect(app.shows(tip)).toBe(true);
  await app.hover("id:rail-search");
  await app.clock!.runFor(100);
  expect(app.shows(tip)).toBe(true);
  await app.clock!.runFor(60);
  expect(app.shows(tip)).toBe(false);
});

test("a tip shows the unread count, a press closes it, and Escape dismisses it", async () => {
  const app = await open();
  const direct = `id:rail-tip-${seeded.writerDirect}`;
  await app.hover(rail(seeded.writerDirect));
  await app.wait(260);
  expect(app.shows(`${direct} >> text:${t.sidebar.unread} 4`)).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor(direct, { state: "gone" });
  await app.hover("id:rail-expand");
  await app.wait(260);
  expect(app.shows("id:rail-tip-expand")).toBe(true);
  await app.press("id:rail-expand");
  await app.waitFor("id:rail-tip-expand", { state: "gone" });
});

test("the rail's tip names the shortcut", async () => {
  const app = await open();
  await app.hover("id:rail-search");
  await app.wait(260);
  expect(app.shows(`id:rail-tip-search >> text:${t.sidebar.searchShort}`)).toBe(true);
  // The workspace is set in the fixture: its button toggles.
  await app.hover("id:rail-workspace");
  await app.wait(260);
  expect(app.shows(`id:rail-tip-workspace >> text:${t.sidebar.workspace}`)).toBe(true);
  expect(app.shows(`id:rail-tip-workspace >> text:${t.sidebar.workspaceUnset}`)).toBe(false);
  await app.press("id:rail-workspace");
  await app.waitUntil(() => state(app).includes("workspace:on"));
});

test("a control that cannot act still explains itself, and its press does nothing", async () => {
  const app = await open();
  await app.press("id:story-no-workspace");
  await app.hover("id:rail-workspace");
  await app.wait(260);
  expect(app.shows(`id:rail-tip-workspace >> text:${t.sidebar.workspace}`)).toBe(true);
  expect(app.shows(`id:rail-tip-workspace >> text:${t.sidebar.workspaceUnset}`)).toBe(true);
  // Readers hear it is disabled (a test cannot press it), and nothing was toggled.
  expect(app.enabled("id:rail-workspace")).toBe(false);
  await expect(app.press("id:rail-workspace")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(state(app)).toContain("workspace:off");
  expect(log(app)).not.toContain("workspace-toggle");
});

test("the rail's tools open a menu out to the side that closes on Escape, a press elsewhere and a choice", async () => {
  const app = await open();
  await app.press("id:rail-tools");
  await app.waitFor("id:sidebar-tools-menu");
  expect(app.count("id:tools-routines")).toBe(1);
  expect(app.shows("id:tools-usage")).toBe(true);
  expect(app.shows("id:tools-roles")).toBe(true);
  expect(app.shows("id:tools-screen")).toBe(false);
  expect(app.shows("id:tools-workspace")).toBe(false);
  await app.keyboard.press("escape");
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });
  await app.press("id:rail-tools");
  await app.waitFor("id:sidebar-tools-menu");
  await app.press("id:story-pin");
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });
  await app.press("id:rail-tools");
  await app.press("id:tools-spend");
  await app.waitUntil(() => log(app).includes("rail-spend"));
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });
  await app.press("id:rail-tools");
  await app.press("id:tools-terminal");
  await app.waitUntil(() => log(app).includes("rail-terminal"));
  await app.press("id:rail-tools");
  await app.press("id:tools-archived");
  await app.waitUntil(() => log(app).includes("rail-archived"));
});

test("without a workbench the tools name pages and a new terminal is the runtime's own", async () => {
  const app = await open();
  await app.press("id:story-no-workbench");
  await app.waitUntil(() => state(app).includes("bench:off"));
  await app.press("id:rail-tools");
  await app.waitFor("id:sidebar-tools-menu");
  expect(app.shows(`id:tools-terminal >> text:${t.terminal.title}`)).toBe(true);
  expect(app.shows(`id:tools-routines >> text:${t.calendar.open}`)).toBe(true);
  await app.press("id:tools-terminal");
  await app.waitFor("id:sidebar-tools-menu", { state: "gone" });
  expect(log(app)).not.toContain("rail-terminal");
});

test("settings press reaches the caller", async () => {
  const app = await open();
  await app.press("id:rail-settings");
  await app.waitUntil(() => log(app).includes("rail-settings"));
  await app.waitUntil(() => state(app).includes("settings:on"));
});
