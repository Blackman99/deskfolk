/**
 * The rules a job can do without (ADR 0103): an engine that works in jobs can still leave these out,
 * each going on the way a routine or a small job already does. Each pair shows the same work under
 * 通用 and under an engine with the one rule off, so a test here cannot pass by nothing happening.
 */
import { afterEach, expect, test } from "bun:test";
import type { PlaybookStepId } from "@real-bot/protocol";
import { turnPromptTextsIn } from "../prompts/book";
import { call, createScenario, fileUnder, say, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** A job of two tickets in your direct, on an engine with `off` switched off (none: 通用). */
async function job(off: PlaybookStepId[] = []) {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "做事的", duties: "做事" });
  const direct = h.direct(bot!);
  if (off.length > 0) {
    const engine = h.store.createPlaybook({ from: "general", name: "自己的" });
    h.store.savePlaybook(engine.id, { diff: { v: 1, steps: Object.fromEntries(off.map((step) => [step, { on: false }])) } });
    h.store.setSessionPlaybook(direct, engine.id);
  }
  const plan = h.store.openTask({ sessionId: direct, title: "一件事", brief: "做", kind: "一件事", spec: { kind: "一件事", goal: "做", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" } });
  const first = h.store.createTicket({ taskId: plan.id, title: "第一件", spec: "做", status: "todo", worker: bot!.id });
  const second = h.store.createTicket({ taskId: plan.id, title: "第二件", spec: "做", status: "todo", worker: bot!.id });
  h.judge("read_user_line").handle(() => ({ control: "none", control_only: false, status_only: false, objections: [] }));
  h.judge("read_filing").handle(fileUnder("一件事", { ticket: "第一件" }));
  return { h, bot: bot!, direct, plan, first, second };
}

/** The Bot makes the first ticket's file and ends on it; what it is told after that it just ends. */
async function handOver({ h, bot, direct, first }: Awaited<ReturnType<typeof job>>) {
  h.script(bot).handle(({ hop }) => {
    if (h.store.listSubmissions({ taskId: first.task_id }).length > 0) return call(tool("end_turn", { reason: "nothing_new" }));
    return hop === 1 ? call(writeFile(`${first.dir}/a.md`, "x")) : say(`做好了：${first.dir}/a.md`);
  });
  h.postUser(direct, "做第一件");
  await h.waitIdle({ timeoutMs: 15_000 });
  const [submission] = h.store.listSubmissions({ taskId: first.task_id });
  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle({ timeoutMs: 15_000 });
  return h.store.getSubmission(submission!.id);
}

test("what nobody reviews waits on your word; with that off it goes through once its gates pass, and a Bot is told so", async () => {
  const under = await job();
  const waiting = await handOver(under);
  expect(waiting).toMatchObject({ state: "submitted" });
  expect(waiting.awaiting).not.toBeNull();
  expect(turnPromptTextsIn(under.h.store, "zh", under.direct).system).toBeUndefined();

  const off = await job(["wait_word"]);
  const through = await handOver(off);
  expect(through).toMatchObject({ state: "approved", awaiting: null });
  expect(off.h.store.listWorkEvents({ kind: "submission.approved" }).map((event) => event.payload)).toMatchObject([{ submission_id: through.id, by: "unattended" }]);
  const system = turnPromptTextsIn(off.h.store, "zh", off.direct).system!;
  expect(system).toContain("门禁过了就直接通过");
  expect(system).not.toContain("等用户的话");
});

test("your own System section stays as you wrote it, whatever the engine waits on", async () => {
  const { h, direct } = await job(["wait_word"]);
  const { savePromptText } = await import("../prompts/book");
  savePromptText(h.store, { id: "turn.system", locale: "zh", text: "我自己写的系统指令", actor: "user" });
  expect(turnPromptTextsIn(h.store, "zh", direct).system).toBe("我自己写的系统指令");
});

test("a job left alone is called back; with pick-ups off nobody chases it", async () => {
  const later = () => new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const under = await job();
  expect(under.h.store.supervisorTick({ now: later() }).wakes.map((wake) => wake.ticketId)).toContain(under.first.id);

  const off = await job(["pickup"]);
  expect(off.h.store.supervisorTick({ now: later() }).wakes).toEqual([]);
  // It is a job all the same: only the chasing is gone.
  expect(off.h.store.playbookFor({ sessionId: off.direct }).resolved.jobs.on).toBe(true);
});

test("a line is read for the job's size; with large jobs off it is not", async () => {
  const reads = async (off: PlaybookStepId[]) => {
    const { h, bot, direct } = await job(off);
    h.script(bot).handle(() => call(tool("end_turn", { reason: "nothing_new" })));
    h.postUser(direct, "做第一件，做成二十分钟");
    await h.waitIdle({ timeoutMs: 15_000 });
    return h.judgeCalls("other").length;
  };
  expect(await reads([])).toBe(1);
  expect(await reads(["large_job"])).toBe(0);
});
