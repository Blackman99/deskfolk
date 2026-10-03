/**
 * 2026-10-03 01:13, in your direct with 通识: at 01:10 the daily routine delivered that morning's AI
 * news brief, and three minutes later you said 「标题跟 LOGO 没有对齐，而且太小」. A routine's
 * standing plan is never a default candidate, so the one candidate left was 「按附件图片里的格式给出
 * 一份地址信息」, a job from three days before, and rule 6 filed the complaint there: the scribe
 * wrote 「标题要和 LOGO 对齐」 into the address job's ledger, a card asked about that job's old
 * rules, and two turns on the address job rewrote the brief's files in the routine's folder.
 *
 * A line of yours in a direct that comes right after the Bot's line, with nothing of yours in
 * between, answers that line, the way a quoted reply does: it is filed, by default, under the job
 * that line was on — a routine's standing plan and its dated ticket included.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attributionOptions } from "../store/attribution-options";
import { call, createScenario, endTurn, say, writeFile, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const COMPLAINT = "标题跟 LOGO 没有对齐，而且太小";

/** The address job from three days before, handed over and still open; then this morning's brief. */
async function theMorning(h: Scenario, opts: { briefAgoMs?: number } = {}) {
  const [helper] = h.createBots({ name: "通识", duties: "通用助手" });
  const dm = h.direct(helper!);
  const address = openPlan(h, dm, "按附件图片里的格式给出一份地址信息", planSpec("按附件图片里的格式给出一份地址信息", { kind: "地址信息" }));
  const ticket = h.store.createTicket({ taskId: address.id, title: "按图片格式给出地址信息", status: "review", worker: helper!.id });
  mkdirSync(join(h.root, ticket.dir), { recursive: true });
  writeFileSync(join(h.root, ticket.dir, "address.txt"), "Miami");
  const asked = h.store.transaction(() => h.store.postMessage(dm, { body: "按附件图片里的格式给出一份地址信息" }));
  h.store.fileMessage(asked.id, { explicit: [{ taskId: address.id, ticketId: ticket.id }] });
  const handed = h.postBot(helper!, dm, `地址写好了：${ticket.dir}/address.txt`, { taskId: address.id, ticketId: ticket.id });
  await h.waitIdle();
  const daysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  h.store.db.run("UPDATE messages SET created_at = ? WHERE id IN (?, ?)", [daysAgo, asked.id, handed.id]);

  // 01:00: the routine fires; its turn draws the brief and hands it over.
  const routine = h.store.createRoutine({ bot_id: helper!.id, title: "每日AI重点新闻简报", instruction: "做今天的 AI 日报图", schedule: { kind: "daily", time: "01:00" } });
  h.store.db.run("UPDATE routines SET created_at = ? WHERE id = ?", [daysAgo, routine.id]);
  h.script(helper!, dm).reply(
    ({ turn }) => call(writeFile(`${h.store.turnWorkDir(turn!.id)}/AI日报.png`, "png")),
    ({ turn }) => say(`今天的日报：${h.store.turnWorkDir(turn!.id)}/AI日报.png`),
  );
  const fired = h.engine.fireRoutine(routine.id);
  expect(fired).not.toBeNull();
  await h.waitIdle();
  const standing = h.store.routineTask(routine.id)!;
  const today = h.store.listTickets(standing.id).at(-1)!;
  const brief = h.messages(dm).filter((m) => m.kind === "bot").at(-1)!;
  expect(brief).toMatchObject({ task_id: standing.id, ticket_id: today.id });
  if (opts.briefAgoMs) {
    h.store.db.run("UPDATE messages SET created_at = ? WHERE id = ?", [new Date(Date.now() - opts.briefAgoMs).toISOString(), brief.id]);
  }
  return { helper: helper!, dm, address, standing, today };
}

test("your complaint right after the routine's brief is filed under the brief's job, and the Bot works on it there", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { helper, dm, address, standing, today } = await theMorning(h);

  h.script(helper, dm).reply(say("好，我把标题放大并和 LOGO 对齐。"));
  const complaint = h.postUser(dm, COMPLAINT);
  await h.waitIdle();

  expect(h.store.filingsOfMessage(complaint.id).map(({ taskId, ticketId, strength }) => ({ taskId, ticketId, strength }))).toEqual([
    { taskId: standing.id, ticketId: today.id, strength: "default" },
  ]);
  const turn = h.turns(helper).at(-1)!;
  expect(turn).toMatchObject({ trigger_message_id: complaint.id, task_id: standing.id, ticket_id: today.id });
  // Nothing of it reaches the address job.
  expect(h.store.filingsOfMessage(complaint.id).some((f) => f.taskId === address.id)).toBe(false);
  // The tag under it names the brief's job (not 「一件事」), and you can file a line there by hand,
  // today's run first.
  const listed = attributionOptions(h.store, complaint.id).items.find((plan) => plan.id === standing.id);
  expect(listed).toMatchObject({ title: "每日AI重点新闻简报" });
  expect(listed!.tickets[0]).toEqual({ id: today.id, title: today.title });
});

test("a line long after the Bot's last one is not read as an answer to it", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { helper, dm, standing } = await theMorning(h, { briefAgoMs: 3 * 60 * 60 * 1000 });

  h.script(helper, dm).reply(say("好的。"));
  const later = h.postUser(dm, COMPLAINT);
  await h.waitIdle();

  expect(h.store.filingsOfMessage(later.id).some((f) => f.taskId === standing.id)).toBe(false);
});

test("a line of yours in between: the next one is not an answer to the Bot's line", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { helper, dm, standing } = await theMorning(h);

  h.script(helper, dm).reply(say("好的。"), say("好的。"));
  // The first goes nowhere in particular: it is the answer to the brief, the second answers nothing.
  h.store.transaction(() => h.store.postMessage(dm, { body: "收到" }));
  const second = h.postUser(dm, COMPLAINT);
  await h.waitIdle();

  expect(h.store.filingsOfMessage(second.id).some((f) => f.taskId === standing.id)).toBe(false);
});

test("「另外…」 right after the brief asks for something else: it is not filed under the brief", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { helper, dm, standing } = await theMorning(h);

  h.script(helper, dm).reply(say("好的，我先看看。"), call(endTurn()));
  const other = h.postUser(dm, "另外帮我写三句咖啡店开业宣传语");
  await h.waitIdle();

  expect(h.store.filingsOfMessage(other.id).some((f) => f.taskId === standing.id)).toBe(false);
});
