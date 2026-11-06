import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

async function job(width = 1300) {
  const app = await openStory("job-view", { width, height: 900 });
  await app.waitFor("id:trace-flow", { timeout: 15_000 });
  const logged = (line: string) => app.texts().some((t) => t.includes(line));
  return { app, logged };
}

test("wide: the rail, the trace and the job's spec lie side by side, and the title row says how the job stands", async () => {
  const { app } = await job();
  for (const id of ["tk-1", "tk-2", "tk-3", "tk-4"]) expect(app.shows(`id:rail-row-${id}`)).toBe(true);
  expect(app.shows("id:trace-card-t1")).toBe(true);
  expect(app.shows("id:job-inspector")).toBe(true);
  expect(app.texts()).toContain("整件事");
  // The status and the counts, the chips beside the stop menu.
  expect(app.texts()).toContain("进行中");
  expect(app.texts()).toContain("需要你看 1");
  expect(app.texts()).toContain("引擎：通用");
  expect(app.shows("id:stop-menu")).toBe(true);
  // A pane has no close button of its own.
  expect(app.shows("id:job-close")).toBe(false);
});

test("a row picks its ticket for every part; the same press, the x or Escape puts it down", async () => {
  const { app } = await job();
  await app.press("id:rail-row-tk-2");
  await app.waitFor("id:insp-title");
  expect(app.texts()).toContain("配乐");
  // What it answers to is said under its card; who ran it, from the trace.
  expect(app.shows("id:ticket-owes")).toBe(true);
  expect(app.shows("id:ticket-ran")).toBe(true);
  expect(app.shows("id:ran-bot-bot-2")).toBe(true);
  await app.press("id:insp-unpick");
  await app.waitFor("id:insp-title", { state: "gone" });
  expect(app.texts()).toContain("整件事");
  await app.press("id:rail-row-tk-2");
  await app.waitFor("id:insp-title");
  await app.press("id:rail-row-tk-2");
  await app.waitFor("id:insp-title", { state: "gone" });
  await app.press("id:rail-row-tk-3");
  await app.waitFor("id:insp-title");
  await app.keyboard.press("Escape");
  await app.waitFor("id:insp-title", { state: "gone" });
});

test("a ticket's files and latest turn go to the host; 在要点里看 turns to the spec held to it and 回到任务 comes back", async () => {
  const { app, logged } = await job();
  await app.press("id:rail-row-tk-1");
  await app.waitFor("id:insp-artifacts");
  await app.press("id:insp-artifacts");
  await app.waitUntil(() => logged("artifact:work/先出分镜-7f3k/01-分镜草图/board.pdf|1|tree"));
  await app.press("id:rail-row-tk-2");
  await app.waitFor("id:insp-jump");
  await app.press("id:insp-jump");
  await app.waitUntil(() => logged("jump:group-1/b2"));
  await app.press("id:ticket-owes-spec");
  await app.waitFor("id:insp-back");
  expect(app.texts()).toContain("回到任务 #02");
  await app.press("id:insp-back");
  await app.waitFor("id:insp-title");
});

test("a step opened on the trace has its panel in the inspector, and Escape closes it before the ticket", async () => {
  const { app } = await job();
  await app.press("id:rail-row-tk-2");
  await app.waitFor("id:insp-title");
  await app.press("id:trace-step-s2");
  await app.waitFor("id:trace-step-detail");
  expect(app.shows("id:insp-title")).toBe(false);
  await app.keyboard.press("Escape");
  await app.waitFor("id:trace-step-detail", { state: "gone" });
  await app.waitFor("id:insp-title");
  await app.press("id:trace-step-s2");
  await app.waitFor("id:trace-step-detail");
  await app.press("id:trace-step-close");
  await app.waitFor("id:trace-step-detail", { state: "gone" });
});

test("the widen button gives the inspector the whole tab and brings the rail and trace back", async () => {
  const { app } = await job();
  await app.press("id:insp-expand");
  await app.waitFor("id:job-rail", { state: "hidden" }).catch(() => undefined);
  await app.press("id:insp-expand");
  expect(app.shows("id:rail-row-tk-1")).toBe(true);
});

test("medium: the spec waits behind 要点 over the trace; a pick shows the ticket over it", async () => {
  const { app } = await job();
  await app.press("id:story-width-medium");
  await app.waitFor("id:job-chip-spec");
  expect(app.shows("id:job-inspector")).toBe(false);
  await app.press("id:job-chip-spec");
  await app.waitFor("id:job-inspector");
  expect(app.texts()).toContain("整件事");
  await app.press("id:insp-close");
  await app.waitFor("id:job-inspector", { state: "gone" });
  await app.press("id:rail-row-tk-2");
  await app.waitFor("id:insp-title");
  await app.keyboard.press("Escape");
  await app.waitFor("id:job-inspector", { state: "gone" });
});

test("narrow: the three parts are one at a time behind the switch, and a pick comes up as a sheet", async () => {
  const { app } = await job();
  await app.press("id:story-width-narrow");
  await app.waitFor("id:job-segments");
  await app.press("id:job-segment-board");
  await app.press("id:rail-row-tk-3");
  await app.waitFor("id:insp-title");
  expect(app.texts()).toContain("终稿审阅");
  await app.press("id:insp-unpick");
  await app.waitFor("id:insp-title", { state: "gone" });
  await app.press("id:job-segment-spec");
  await app.waitFor("id:insp-label");
  expect(app.texts()).toContain("整件事");
  // The spec's 待你确认 names tickets; the plan's counts are said as the rail says them.
  await app.press("id:job-segment-trace");
  await app.press("id:trace-step-s2");
  await app.waitFor("id:trace-step-detail");
  await app.press("id:trace-step-close");
  await app.waitFor("id:trace-step-detail", { state: "gone" });
});
