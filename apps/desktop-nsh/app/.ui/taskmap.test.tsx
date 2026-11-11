import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy";
import { openStory } from "./fixture";

const t = copyFor("zh").taskmap;

const opened = async (mode = "project", options: Parameters<typeof openStory>[1] = {}) => {
  const app = await openStory("taskmap", options);
  if (mode !== "project") {
    await app.waitFor(`id:taskmap-mode-${mode}`, { timeout: 10_000 });
    await app.press(`id:taskmap-mode-${mode}`);
  }
  await app.waitFor("id:taskmap-step", { timeout: 15_000 });
  return app;
};
const has = (app: Awaited<ReturnType<typeof opened>>, text: string) => app.texts().some((x) => x.includes(text));
const STORE = "id:taskmap-plate-code:apps/daemon/src/store";

test("the town is laid out from the session's folders, its characters and cards read from the replay", async () => {
  const app = await opened();
  // At its newest step: every call counted.
  expect(app.texts()).toContain(t.controls.step(25, 25));
  // The folders are places: the key lists them with their paths.
  expect(app.texts()).toContain("apps/daemon/src/store");
  expect(app.texts()).toContain("apps/messenger/src/lib/chat");
  expect(app.texts()).toContain(t.places.root);
  expect(app.texts()).toContain(t.places.check);
  // The agent and its subagent, each with its figure and a card.
  expect(app.shows("id:taskmap-figure-0")).toBe(true);
  expect(app.shows("id:taskmap-figure-1")).toBe(true);
  expect(app.shows("id:taskmap-lead-0")).toBe(true);
  expect(app.texts()).toContain(t.card.subs);
  expect(app.texts()).toContain("Build the chat · Sonnet 5.5");
  // What it was asked, and the moments: a subagent went out, a call failed.
  expect(has(app, "把地图做出来")).toBe(true);
  expect(has(app, t.moments.fail(1))).toBe(true);
  // The agent's logo on its badge; nothing is running, so where it left off reads as rest.
  expect(app.shows("id:agent-logo-claude_code")).toBe(true);
  expect(has(app, t.status.idle("").trim())).toBe(true);
  expect(app.texts()).toContain(t.note);
});

test("a building's plate opens its card, the card's visit moves the playhead, and ✕ puts it away", async () => {
  const app = await opened();
  expect(app.shows("id:taskmap-insp")).toBe(false);
  await app.press(STORE);
  await app.waitFor("id:taskmap-insp");
  expect(app.texts()).toContain("apps/daemon/src/store");
  expect(app.shows("id:taskmap-legend")).toBe(false);
  // Its visits are listed with the character who made them; the card steps to the one before.
  expect(app.texts()).toContain("主线 12");
  await app.press("id:taskmap-insp-prev");
  await app.waitUntil(() => !app.texts().includes(t.controls.step(25, 25)));
  await app.press("id:taskmap-insp-close");
  await app.waitFor("id:taskmap-insp", { state: "gone" });
  expect(app.shows("id:taskmap-legend")).toBe(true);
});

test("a press on the picked plate again lets go of the pick, and a drag over the town leaves the map as it was read", async () => {
  const app = await opened();
  await app.press(STORE);
  await app.waitFor("id:taskmap-insp");
  await app.press(STORE);
  await app.waitFor("id:taskmap-insp", { state: "gone" });
  await app.drag("id:taskmap-view", { x: 60, y: 20 });
  await app.drag("id:taskmap-view", { x: -30, y: 0 });
  expect(app.texts()).toContain(t.controls.step(25, 25));
  expect(app.shows("id:taskmap-figure-0")).toBe(true);
});

test("play runs the clock to the newest step, a speed is a press, and a line you said jumps there", async () => {
  const app = await opened();
  await app.press("id:taskmap-quest-0");
  await app.waitUntil(() => !app.texts().includes(t.controls.step(25, 25)));
  await app.press("id:taskmap-speed-32");
  await app.press("id:taskmap-play");
  // Playing, it sweeps on until the newest step, then rests there.
  await app.waitUntil(() => app.texts().includes(t.controls.step(25, 25)), { timeout: 30_000 });
  expect(app.shows("id:taskmap-play")).toBe(true);
});

test("the controls turn and zoom the town, and following a character shows its chip until you stop", async () => {
  const app = await opened();
  expect(app.texts()).toContain("0°");
  await app.press("id:taskmap-turn-right");
  await app.waitUntil(() => app.texts().some((x) => x === "90°" || x === "270°"), { timeout: 5000 });
  await app.press("id:taskmap-reset");
  await app.waitUntil(() => app.texts().includes("0°"), { timeout: 5000 });
  // Zoomed out to fit the town, zooming in is open and out is shut.
  expect(app.enabled("id:taskmap-zoom-out")).toBe(false);
  const zoom = () => app.texts().find((x) => /^\d+%$/.test(x));
  const was = zoom();
  await app.press("id:taskmap-zoom-in");
  await app.waitUntil(() => zoom() !== was);
  // Follow the agent, then stop from the chip.
  expect(app.shows("id:taskmap-following")).toBe(false);
  await app.press("id:taskmap-follow-0");
  await app.waitFor("id:taskmap-following");
  expect(app.texts()).toContain(t.following("主线"));
  await app.press("id:taskmap-following");
  await app.waitFor("id:taskmap-following", { state: "gone" });
});

test("a right click on the town stays the map's (it turns it); beside the town the pane's menu still opens", async () => {
  const app = await opened();
  // The story's frame round the map listens as a workbench pane does, and logs `pane-menu`.
  await app.rightClick("id:taskmap-view");
  await app.wait(100);
  expect(has(app, "pane-menu")).toBe(false);
  await app.rightClick("id:taskmap-lead-0");
  await app.waitUntil(() => has(app, "pane-menu"));
});

test("a call seen live lands on the map before any replay holds it", async () => {
  const app = await opened();
  await app.press("id:taskmap-live-call");
  await app.waitUntil(() => app.texts().includes(t.controls.step(26, 26)));
});

test("a conversation with no record yet says the map starts from this version", async () => {
  const app = await opened("empty");
  await app.waitFor("id:taskmap-empty");
  expect(app.texts()).toContain(t.bots.empty);
});

test("a Bot conversation's map: one plan, each Bot a card of its own with the conversation its step is in", async () => {
  const app = await opened("plan");
  await app.waitFor("id:trace-job-switcher");
  // The conversation's newest work.
  expect(app.texts()).toContain("周报");
  expect(app.texts()).toContain(t.plan.across(2));
  expect(app.shows("id:taskmap-lead-0")).toBe(true);
  expect(app.shows("id:taskmap-lead-1")).toBe(true);
  expect(app.texts()).toContain("Writer");
  expect(app.texts()).toContain("Editor");
  // What you said, each with where; no subagents card.
  expect(has(app, "写本周周报")).toBe(true);
  expect(has(app, "请编辑看节奏")).toBe(true);
  expect(app.texts()).not.toContain(t.card.subs);
  expect(app.texts()).toContain(t.bots.note);
});

test("another plan is picked in the map's switcher; one-question jobs sit in a column of their own", async () => {
  const app = await opened("plan");
  await app.waitFor("id:trace-job-switcher");
  await app.press("id:trace-job-switcher");
  await app.waitFor("id:trace-job-task-2");
  expect(app.shows("id:trace-job-task-1")).toBe(true);
  // The one-question job is not among the work; its kind opens it.
  expect(app.shows("id:trace-job-task-3")).toBe(false);
  await app.press("id:trace-job-kind-oneShot");
  await app.waitFor("id:trace-job-task-3");
  await app.press("id:trace-job-kind-work");
  await app.waitFor("id:trace-job-task-2");
  await app.press("id:trace-job-task-2");
  await app.waitUntil(() => app.texts().includes("task:task-2"));
  await app.waitFor("id:trace-job-task-2", { state: "gone" });
  expect(app.texts()).toContain("季度复盘");
});

test("on a phone the jobs open as a sheet, the one-question ones folded into a row", async () => {
  const app = await opened("plan", { width: 520, height: 900 });
  await app.waitFor("id:trace-job-switcher");
  // A small pane keeps the map to its town: no hint, no key.
  expect(app.shows("id:taskmap-hint")).toBe(false);
  expect(app.shows("id:taskmap-legend")).toBe(false);
  await app.press("id:trace-job-switcher");
  await app.waitFor("id:trace-job-task-2");
  expect(app.shows("id:trace-job-task-3")).toBe(false);
  await app.press("id:trace-job-fold");
  await app.waitFor("id:trace-job-task-3");
  await app.press("id:trace-job-task-3");
  await app.waitUntil(() => app.texts().includes("task:task-3"));
});

test("the wheel zooms the town about the pointer, a pinch too, and a sideways swipe turns it", async () => {
  const app = await opened();
  const zoom = () => app.texts().find((x) => /^\d+%$/.test(x));
  const send = (dx: number, dy: number, ctrl = false) =>
    app.host.send("shell.wheel", { x: 500, y: 350, dx, dy, ctrl, meta: false, shift: false, alt: false, pinch: ctrl, phase: null, momentum: null });
  const was = zoom();
  // A wheel forward (negative) zooms in; the town starts fitted, so zooming out has nowhere to go.
  await send(0, -120);
  await app.waitUntil(() => zoom() !== was, { timeout: 5000 });
  const zoomed = Number.parseInt(zoom() ?? "0", 10);
  expect(zoomed).toBeGreaterThan(Number.parseInt(was ?? "0", 10));
  await send(0, -40, true);
  await app.waitUntil(() => Number.parseInt(zoom() ?? "0", 10) > zoomed, { timeout: 5000 });
  const pinched = Number.parseInt(zoom() ?? "0", 10);
  await send(0, 60, true);
  await app.waitUntil(() => Number.parseInt(zoom() ?? "0", 10) < pinched, { timeout: 5000 });
  // A sideways swipe turns it (and does not zoom).
  const level = zoom();
  expect(app.texts()).toContain("0°");
  await send(100, 5);
  await app.waitUntil(() => !app.texts().includes("0°"), { timeout: 5000 });
  expect(app.texts().some((x) => x === "24°" || x === "336°")).toBe(true);
  expect(zoom()).toBe(level);
});
