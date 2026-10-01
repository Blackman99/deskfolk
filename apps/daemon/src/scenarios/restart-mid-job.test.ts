/**
 * ADR 0040 fixture: the daemon restarting in the middle of a long job.
 *
 * A restart ends every turn that is running. The note saying so goes into the session the turn was
 * in, and a notification only when you are in that session; most of a video job's turns run in
 * Bot↔Bot directs, where you are not. On 2026-09-26 a job cut off that way sat for 7.6 hours until
 * you noticed and pressed continue.
 *
 * Target, in two steps:
 * - ADR 0040 P2 (restart classification) flips the first test: within the first scheduler tick after
 *   a crash, the session of the job's plan — where you are — says the job was cut off and offers to
 *   go on or leave it, with a notification; nothing is submitted again on its own.
 * - ADR 0040 P4c (the supervisor, ADR 0045) flips the second: after a clean restart the job goes on
 *   by itself within that tick. The cases after it pin the rest of the restart policy at that level:
 *   a crash goes on once after a minute of steady running, a development restart soon after another
 *   waits for you, and a last step whose outcome is unknown is never repeated on its own.
 */
import { afterEach, expect, test } from "bun:test";
import type { CompletionResult } from "../completions";
import { isoNow } from "../ids";
import { call, createScenario, media, say, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec, submitsOf, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** 视频导演 submits the ending in its thread with 审片员, then sits in a long hop cutting the master. */
async function cuttingTheMaster(h: Scenario) {
  const { director, reviewer, room } = videoTeam(h);
  const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
  h.store.createTicket({ taskId: ep01.id, title: "06 母带", status: "doing", worker: director.id });
  const thread = h.botDirect(director, reviewer);
  let cutting = false;
  h.script(director, thread).reply(call(media("submit_video", { prompt: "EP01 片尾：主角走向雪原" })), () => {
    cutting = true;
    return new Promise<CompletionResult>(() => {});
  });
  h.postBot(reviewer, thread, "片尾那段渲完直接拼进母带", { taskId: ep01.id });
  await h.waitFor(() => cutting, { what: "the director's turn to be cutting the master" });
  return { director, room, ep01 };
}

/**
 * The same long hop at the supervisor's level, where a Bot↔Bot line no longer wakes anyone (ADR
 * 0044): you ask 视频导演 in the group, filed under EP01, and it submits the ending, then cuts.
 */
async function askedToCut(h: Scenario) {
  const { director, room } = videoTeam(h);
  const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
  h.store.createTicket({ taskId: ep01.id, title: "06 母带", status: "doing", worker: director.id });
  let cutting = false;
  h.script(director, room).reply(call(media("submit_video", { prompt: "EP01 片尾：主角走向雪原" })), () => {
    cutting = true;
    return new Promise<CompletionResult>(() => {});
  });
  const line = h.store.postMessage(room, { body: "@视频导演 片尾渲完直接拼进母带" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: ep01.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitFor(() => cutting, { what: "the director's turn to be cutting the master" });
  return { director, room, ep01 };
}

test("after a crash, the plan's session says within a tick that the job was cut off", async () => {
  const h = await createScenario({ durable: true, media: true });
  open.push(h);
  const { room } = await cuttingTheMaster(h);
  const downAt = isoNow();

  // restart() leaves the new daemon one scheduler tick in.
  await h.restart({ clean: false });
  await h.waitIdle();

  expect(h.messages(room).filter((message) => message.kind === "system" && message.created_at > downAt)).toHaveLength(1);
  const notified = h.store.db
    .query<{ kind: string }, [string, string]>(`SELECT kind FROM notifications WHERE session_id = ? AND created_at > ?`)
    .all(room, downAt);
  expect(notified).toHaveLength(1);
  // What the job did last was a submit; nobody sends it again unasked.
  expect(submitsOf(h, "EP01 片尾")).toBe(1);
});

test("after a clean restart, the job goes on by itself within a tick", async () => {
  const h = await createScenario({ durable: true, media: true, supervision: true });
  open.push(h);
  const { director, room, ep01 } = await askedToCut(h);
  h.script(director).handle(() => say("接着拼母带"));
  const downAt = isoNow();

  await h.restart({ clean: true });
  await h.waitIdle();

  expect(h.turns(director).filter((turn) => turn.created_at > downAt).map((turn) => turn.task_id)).toEqual([ep01.id]);
  // The notice said it would, and is answered by it: no 继续 left to press, the notification resolved.
  const notice = h.messages(room).find((message) => message.control?.kind === "restart")!;
  expect(notice.body).toContain("这次是正常停下，现在就从断的地方自动接着做");
  expect(notice.control).toMatchObject({ kind: "restart", acted: ["resume"] });
  expect(h.store.db.query("SELECT action_state FROM notifications WHERE semantic_key = ?").get(`restart:${notice.id}`)).toEqual({ action_state: "resolved" });
  expect(submitsOf(h, "EP01 片尾")).toBe(1);
});

test("after a crash at the supervisor's level the job waits a minute of steady running, then goes on once", async () => {
  const h = await createScenario({ durable: true, media: true, supervision: true });
  open.push(h);
  const { director, room, ep01 } = await askedToCut(h);
  h.script(director).handle(() => say("接着拼母带"));
  const downAt = isoNow();

  await h.restart({ clean: false });
  await h.waitIdle();
  const notice = h.messages(room).find((message) => message.control?.kind === "restart")!;
  expect(notice.body).toContain("守护进程稳定运行 1 分钟后会自动接着做一次");
  expect(h.turns(director).filter((turn) => turn.created_at > downAt)).toEqual([]);

  h.tick(new Date(Date.now() + 61_000));
  await h.waitIdle();
  h.tick(new Date(Date.now() + 62_000));
  await h.waitIdle();
  expect(h.turns(director).filter((turn) => turn.created_at > downAt).map((turn) => turn.task_id)).toEqual([ep01.id]);
  expect(submitsOf(h, "EP01 片尾")).toBe(1);
});

test("a development daemon restarting again within five minutes leaves the job for your 继续", async () => {
  const h = await createScenario({ durable: true, media: true, supervision: true });
  open.push(h);
  const { director, room } = await askedToCut(h);
  h.script(director).handle(() => say("接着拼母带"));
  const downAt = isoNow();

  await h.restart({ clean: true, dev: true });
  await h.restart({ clean: true, dev: true });
  await h.waitIdle();
  h.tick(new Date(Date.now() + 10 * 60_000));
  await h.waitIdle();

  // The first restart said it would go on after a minute; the second, seconds later, cut nothing
  // new and so said nothing, but it is the restart in quick succession that keeps the job waiting.
  const notices = h.messages(room).filter((message) => message.control?.kind === "restart");
  expect(notices).toHaveLength(1);
  expect(notices[0]!.body).toContain("稳定运行 1 分钟后");
  expect(h.turns(director).filter((turn) => turn.created_at > downAt)).toEqual([]);
  expect(h.store.db.query("SELECT state FROM work_items WHERE bot_id = ? AND task_id IS NOT NULL").all(director.id)).toEqual([{ state: "needs_attention" }]);
});

test("a crash in the middle of an external call never repeats it on its own", async () => {
  const h = await createScenario({ durable: true, media: true, supervision: true });
  open.push(h);
  const { director, room } = await askedToCut(h);
  h.script(director).handle(() => say("接着拼母带"));
  // What the effect ledger holds for a call that was sent when the process died.
  const cut = h.turns(director).find((turn) => turn.status === "running")!;
  h.store.db.run(`INSERT INTO tool_executions (id, work_item_id, task_id, ticket_id, bot_id, turn_id, tool_call_id, tool, side_effect, started_at)
    VALUES ('in-flight', ?, ?, ?, ?, ?, 'call-in-flight', 'mcp_media_submit_video', 1, ?)`,
    [cut.work_item_id!, cut.task_id!, cut.ticket_id ?? null, director.id, cut.id, isoNow()]);
  const downAt = isoNow();

  await h.restart({ clean: false });
  h.tick(new Date(Date.now() + 61_000));
  await h.waitIdle();

  const notice = h.messages(room).find((message) => message.control?.kind === "restart")!;
  expect(notice.body).toContain("最后一步是结果不明的外部调用");
  expect(h.turns(director).filter((turn) => turn.created_at > downAt)).toEqual([]);
  expect(submitsOf(h, "EP01 片尾")).toBe(1);
});
