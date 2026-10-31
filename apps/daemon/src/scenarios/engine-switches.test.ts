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
  expect(turnPromptTextsIn(under.h.store, "zh", under.direct).system).toContain("等用户的话");

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

test("an engine's own System section is what its Bots read, in its language; the other falls back to what it would be", async () => {
  for (const base of ["general", "plain"]) {
    const h = await createScenario({ learning: true });
    open.push(h);
    const [bot] = h.createBots({ name: "写的", duties: "做事" });
    const direct = h.direct(bot!);
    const engine = h.store.createPlaybook({ from: base, name: "自己的" });
    h.store.savePlaybook(engine.id, { diff: { ...h.store.getPlaybook(engine.id).diff, system: { zh: "只按我写的这段做事。" } } });
    h.store.setSessionPlaybook(direct, engine.id);
    h.judge("read_filing").reply({ about: "in_place" });
    h.script(bot!).handle(() => say("好"));
    h.postUser(direct, "你好");
    await h.waitIdle();
    const system = h.hops(bot!).at(-1)!.request.messages[0]!.content as string;
    expect(system).toContain("只按我写的这段做事。");
    expect(system).not.toContain("遇到任何障碍");
    expect(turnPromptTextsIn(h.store, "en", direct).system).toContain("When any obstacle arises");
  }
});

test("a group of tools an engine leaves out is not offered, not called, and not talked about", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "没工具的", duties: "做事" });
  const direct = h.direct(bot!);
  const engine = h.store.createPlaybook({ from: "general", name: "少给" });
  h.store.savePlaybook(engine.id, { diff: { v: 1, steps: {}, tools_off: ["setup", "prompts"] } });
  h.store.setSessionPlaybook(direct, engine.id);
  h.judge("read_filing").reply({ about: "in_place" });
  const refused: Array<string | null> = [];
  h.script(bot!, direct).reply(call(tool("list_endpoints"), tool("read_prompt", { id: "turn.system" }), tool("list_bots")), ({ results }) => {
    refused.push(...results.map((result) => result.error));
    return say("好");
  });
  h.postUser(direct, "看看");
  await h.waitIdle();
  expect(refused).toEqual(["not_offered", "not_offered", null]);
  const request = h.hops(bot!).at(-1)!.request;
  const names = (request.tools ?? []).map((entry) => (entry as { function: { name: string } }).function.name);
  for (const name of ["list_endpoints", "add_mcp_server", "read_prompt", "query_data"]) expect(names).not.toContain(name);
  for (const name of ["list_bots", "write_file", "remember", "work_on"]) expect(names).toContain(name);
  const system = request.messages[0]!.content as string;
  expect(system).not.toContain("名册级端点和 MCP");
  expect(system).not.toContain("每个 Bot 怎么工作写在内置提示词里");
  expect(system).toContain("遇到任何障碍");
});

test("resetting one step leaves the engine's own text and tools as they are", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const engine = h.store.createPlaybook({ from: "general", name: "自己的" });
  h.store.savePlaybook(engine.id, { diff: { v: 1, steps: { settle: { params: { quiet_s: 90 } } }, system: { zh: "我的" }, tools_off: ["routines"] } });
  // The same diff again is no change, and leaves no revision.
  const before = h.store.getPlaybook(engine.id).revision;
  h.store.savePlaybook(engine.id, { diff: { v: 1, steps: { settle: { params: { quiet_s: 90 } } }, tools_off: ["routines"], system: { zh: "我的" } } });
  expect(h.store.getPlaybook(engine.id).revision).toBe(before);
  // A new text is a change, on its own.
  expect(h.store.savePlaybook(engine.id, { diff: { v: 1, steps: { settle: { params: { quiet_s: 90 } } }, system: { zh: "我改的" }, tools_off: ["routines"] } }).revision).toBe(before + 1);

  expect(h.store.resetPlaybook(engine.id, { step: "settle" }).diff).toEqual({ v: 1, steps: {}, system: { zh: "我改的" }, tools_off: ["routines"] });
  expect(h.store.resetPlaybook(engine.id, {}).diff).toEqual({ v: 1, steps: {} });
  // A new engine from it starts with them.
  h.store.savePlaybook(engine.id, { diff: { v: 1, steps: {}, system: { zh: "再写" }, tools_off: ["setup"] } });
  expect(h.store.createPlaybook({ from: engine.id, name: "另一个" }).diff).toEqual({ v: 1, steps: {}, system: { zh: "再写" }, tools_off: ["setup"] });
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
