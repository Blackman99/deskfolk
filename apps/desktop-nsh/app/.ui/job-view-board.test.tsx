import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

async function job(width = 1300) {
  const app = await openStory("job-view", { width, height: 900 });
  await app.waitFor("id:trace-flow", { timeout: 15_000 });
  const logged = (line: string) => app.texts().some((t) => t.includes(line));
  return { app, logged };
}

test("the board opened out has five columns with the cards in them, and closes back to the rail", async () => {
  const { app } = await job();
  await app.press("id:rail-expand");
  await app.waitFor("id:ticket-list");
  for (const status of ["todo", "doing", "review", "done", "parked"]) expect(app.shows(`id:board-column-${status}`)).toBe(true);
  expect(app.shows("id:ticket-main-tk-2")).toBe(true);
  expect(app.texts()).toContain("3 未完成 · 共 4");
  expect(app.texts()).toContain("25%");
  await app.press("id:ticket-main-tk-4");
  await app.press("id:job-board-close");
  await app.waitFor("id:ticket-list", { state: "gone" });
  // The pick made on the board is the one the inspector shows.
  await app.waitFor("id:insp-title");
});

test("a status from a card's menu goes to the daemon with the plan's revision", async () => {
  const { app, logged } = await job();
  await app.press("id:rail-expand");
  await app.waitFor("id:ticket-row-tk-2");
  await app.press("id:ticket-row-tk-2 >> id:ticket-status");
  await app.press("id:ticket-status-review");
  await app.waitUntil(() => logged('patch:tk-2:{"status":"review","if_revision":1}'));
});

test("a refused move (the plan changed meanwhile) says so on the board", async () => {
  const { app, logged } = await job();
  await app.press("id:story-fail");
  await app.press("id:rail-expand");
  await app.waitFor("id:ticket-row-tk-4");
  await app.press("id:ticket-row-tk-4 >> id:ticket-status");
  await app.press("id:ticket-status-doing");
  await app.waitUntil(() => logged("patch:tk-4"));
  await app.waitFor("id:ticket-board-conflict");
});

test("a ticket the tab was asked to show is picked, its column lit and the rail filtered; clearing the filter brings the rest back", async () => {
  const { app } = await job();
  await app.press("id:story-ask");
  await app.waitFor("id:rail-filter");
  await app.waitFor("id:insp-title");
  expect(app.texts()).toContain("配乐");
  expect(app.shows("id:rail-row-tk-1")).toBe(false);
  expect(app.shows("id:rail-row-tk-2")).toBe(true);
  await app.press("id:rail-filter-clear");
  await app.waitFor("id:rail-filter", { state: "gone" });
  expect(app.shows("id:rail-row-tk-1")).toBe(true);
});

test("your stops over the job show under its title and a lift goes to the host; the stop menu offers this job", async () => {
  const { app, logged } = await job();
  expect(app.shows("id:job-holds")).toBe(false);
  await app.press("id:story-hold");
  await app.waitFor("id:job-hold-hold-1");
  await app.press("id:job-hold-lift-hold-1");
  await app.waitUntil(() => logged("lift:hold-1"));
  await app.waitFor("id:job-hold-hold-1", { state: "gone" });
  await app.press("id:stop-menu");
  await app.waitFor("id:stop-item-global");
  await app.press("id:stop-item-plan:task-1");
  await app.waitUntil(() => logged("stop:plan"));
});

test("the job switcher lists the conversation's jobs; another job loads in place of this one and the host hears of it", async () => {
  const { app, logged } = await job();
  await app.press("id:trace-job-switcher");
  await app.waitFor("id:trace-job-task-2");
  await app.press("id:trace-job-task-2");
  await app.waitUntil(() => logged("task:task-2"));
  // The other job has no tickets: no rail, and its plan is the inspector's.
  await app.waitFor("id:rail-row-tk-1", { state: "gone" });
  expect(app.shows("id:job-inspector")).toBe(true);
});

test("the chips: 需要你看 to the whole job's spec, the engine to Roles, the map to the host", async () => {
  const { app, logged } = await job();
  await app.press("id:rail-row-tk-2");
  await app.waitFor("id:insp-title");
  await app.press("id:job-chip-attention");
  await app.waitFor("id:insp-label");
  await app.press("id:job-chip-engine");
  await app.waitUntil(() => logged("roles:general"));
  await app.press("id:job-chip-map");
  await app.waitUntil(() => logged("map:task-1"));
});

test("the narrow host is a page with its own close; Escape with nothing to put away closes it too", async () => {
  const { app } = await job(480);
  await app.press("id:story-page");
  await app.waitFor("id:flow-board");
  await app.waitFor("id:job-close");
  await app.keyboard.press("Escape");
  await app.waitFor("id:flow-board", { state: "gone" });
  await app.press("id:story-page");
  await app.waitFor("id:flow-board");
  await app.press("id:job-close");
  await app.waitFor("id:flow-board", { state: "gone" });
});

test("a press on a row's lane picks its ticket and brings the trace to its nearest card (a second press keeps it picked)", async () => {
  const { app } = await job();
  await app.press("id:rail-row-tk-1 >> id:rail-lane");
  await app.waitFor("id:insp-title");
  expect(app.texts()).toContain("分镜草图");
  await app.press("id:rail-row-tk-1 >> id:rail-lane");
  expect(app.shows("id:insp-title")).toBe(true);
  // A press elsewhere on the row is the toggle.
  await app.press("id:rail-row-tk-1 >> id:rail-owner-tk-1");
  await app.waitFor("id:insp-title", { state: "gone" });
});

test("a card dragged to another column asks for that status when it lands", async () => {
  const { app, logged } = await job();
  await app.press("id:rail-expand");
  await app.waitFor("id:ticket-row-tk-4");
  await app.dragAndHold("id:ticket-main-tk-4", { x: 260, y: 0 });
  await app.waitFor("id:ticket-ghost");
  await app.drop();
  await app.waitUntil(() => logged('patch:tk-4:{"status":"doing"'));
  await app.waitFor("id:ticket-ghost", { state: "gone" });
});

test("Escape while a card is in hand drops nothing", async () => {
  const { app, logged } = await job();
  await app.press("id:rail-expand");
  await app.waitFor("id:ticket-row-tk-4");
  await app.dragAndHold("id:ticket-main-tk-4", { x: 260, y: 0 });
  await app.waitFor("id:ticket-ghost");
  await app.keyboard.press("Escape");
  await app.waitFor("id:ticket-ghost", { state: "gone" });
  await app.drop();
  await app.wait(300);
  expect(logged("patch:tk-4")).toBe(false);
});

test("a card held at the board's right edge scrolls the board under it, so it lands in a column that was out of sight", async () => {
  // Narrow enough that the five columns run past the pane.
  const { app, logged } = await job(760);
  await app.press("id:rail-expand");
  await app.waitFor("id:ticket-row-tk-4");
  await app.dragAndHold("id:ticket-main-tk-4", { x: 600, y: 0 });
  await app.waitFor("id:ticket-ghost");
  // Held still, the board keeps moving under it.
  await app.wait(1500);
  await app.drop();
  await app.waitUntil(() => logged('patch:tk-4:{"status":"parked"'));
});
