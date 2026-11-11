import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");

async function open(section: "work" | "control") {
  const app = await openStory("chat-cards");
  await app.waitFor(`id:show-${section}`, { timeout: 10_000 });
  await app.press(`id:show-${section}`);
  return app;
}

test("a job's question takes a written answer and sends it", async () => {
  const app = await open("work");
  await app.waitFor("id:card-work");
  expect(app.texts()).toContain(t.workQuestion.title);
  expect(app.texts()).toContain("预告片用哪一版配乐？");
  expect(app.texts()).toContain(t.workQuestion.hint);
  // Nothing written: nothing to send.
  await expect(app.press("id:card-work >> id:work-question-submit")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.type("id:card-work >> id:work-question-input", "   ");
  await expect(app.press("id:card-work >> id:work-question-submit")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.type("id:card-work >> id:work-question-input", "用第一版");
  await app.press("id:card-work >> id:work-question-submit");
  await app.waitUntil(() => app.texts().includes("answer:   用第一版"));
});

test("an answered question keeps the answer; a lapsed or read-only one takes none", async () => {
  const app = await open("work");
  await app.waitFor("id:card-work-answered");
  expect(app.shows("id:card-work-answered >> id:work-question-input")).toBe(false);
  expect(app.shows("id:card-work-answered >> id:work-question-answer")).toBe(true);
  expect(app.texts()).toContain("用第二版");
  expect(app.texts()).toContain(t.workQuestion.saved);

  expect(app.texts()).toContain(t.workQuestion.lapsedTitle);
  expect(app.texts()).toContain(t.workQuestion.lapsed);
  expect(app.shows("id:card-work-lapsed >> id:work-question-input")).toBe(false);

  expect(app.texts()).toContain(t.workQuestion.readOnly);
  expect(app.shows("id:card-work-readonly >> id:work-question-input")).toBe(false);
  expect(app.shows("id:card-work-readonly >> id:work-question-submit")).toBe(false);
});

test("the buttons under a stop receipt press into the daemon and show a refusal", async () => {
  const app = await open("control");
  await app.waitFor("id:card-control-receipt");
  expect(app.shows("id:card-control-receipt >> id:control-actions")).toBe(true);
  await app.press("id:card-control-receipt >> id:control-undo");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("act:undo:")));
  expect(app.shows("id:card-control-receipt >> id:control-error")).toBe(false);
  // A refusal comes back as a value: the row stays, with the failure beside it.
  await app.press("id:card-control-refused >> id:control-undo");
  await app.waitFor("id:card-control-refused >> id:control-error");
  expect(app.texts()).toContain(t.control.failed);
  expect(app.shows("id:card-control-refused >> id:control-undo")).toBe(true);
});

test("a line already acted on shows only what was done", async () => {
  const app = await open("control");
  await app.waitFor("id:card-control-done");
  expect(app.shows("id:card-control-done >> id:control-done")).toBe(true);
  expect(app.shows("id:card-control-done >> id:control-actions")).toBe(false);
});

test("sending a hand-over back asks what to change first, and sends the note", async () => {
  const app = await open("control");
  await app.waitFor("id:card-control-handover");
  await app.press("id:card-control-handover >> id:control-reject");
  await app.waitFor("id:control-note-form");
  // Nothing has gone to the daemon yet.
  expect(app.texts().some((text) => text.startsWith("act:reject"))).toBe(false);
  await app.press("id:control-note-cancel");
  await app.waitFor("id:control-note-form", { state: "gone" });
  await app.press("id:card-control-handover >> id:control-reject");
  await app.waitFor("id:control-note");
  await app.type("id:control-note", "第二段重写");
  await app.press("id:control-note-send");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("act:reject:") && text.endsWith(":第二段重写")));
  await app.waitFor("id:control-note-form", { state: "gone" });
});

test("a plan the line opened can be taken back, asking first and saying what it costs", async () => {
  const app = await open("control");
  await app.waitFor("id:card-plan-opened");
  await app.press("id:card-plan-opened >> id:plan-undo");
  await app.waitFor("id:card-plan-opened >> id:plan-confirm");
  expect(app.texts()).toContain(t.control.planUndoWarning);
  await app.press("id:card-plan-opened >> id:plan-cancel");
  await app.waitFor("id:card-plan-opened >> id:plan-undo");
  await app.press("id:card-plan-opened >> id:plan-undo");
  await app.press("id:card-plan-opened >> id:plan-confirm");
  await app.waitUntil(() => app.texts().includes("act:undo_plan::"));
});

test("folding a plan into another job needs a job chosen", async () => {
  const app = await open("control");
  await app.waitFor("id:card-plan-opened");
  await app.press("id:card-plan-opened >> id:plan-merge");
  await app.waitFor("id:card-plan-opened >> id:plan-merge-target");
  expect(app.texts()).toContain(t.control.planMergeWarning);
  await expect(app.press("id:card-plan-opened >> id:plan-confirm")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("id:card-plan-opened >> id:plan-merge-target");
  await app.press("text:EP02 正片");
  await app.press("id:card-plan-opened >> id:plan-confirm");
  await app.waitUntil(() => app.texts().includes("act:merge_plan:task-2:"));
});

test("a refused plan action says so; one already acted on keeps its word and what stayed", async () => {
  const app = await open("control");
  await app.waitFor("id:card-plan-refused");
  await app.press("id:card-plan-refused >> id:plan-undo");
  await app.press("id:card-plan-refused >> id:plan-confirm");
  await app.waitFor("id:card-plan-refused >> id:plan-failed");
  expect(app.texts()).toContain(t.control.failed);
  expect(app.shows("id:card-plan-acted >> id:plan-acted")).toBe(true);
  expect(app.texts()).toContain(t.control.planRetained);
  expect(app.shows("id:card-plan-acted >> id:plan-undo")).toBe(false);
});
