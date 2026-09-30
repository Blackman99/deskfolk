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
 * - ADR 0040 P4c (the supervisor) flips the second: after a clean restart the job goes on by itself
 *   within that tick.
 * Today the note stays in the Bot↔Bot direct, nobody is told, and nothing goes on until you do.
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

test.failing("after a clean restart, the job goes on by itself within a tick", async () => {
  const h = await createScenario({ durable: true, media: true });
  open.push(h);
  const { director, ep01 } = await cuttingTheMaster(h);
  h.script(director).handle(() => say("接着拼母带"));
  const downAt = isoNow();

  await h.restart({ clean: true });
  await h.waitIdle();

  expect(h.turns(director).filter((turn) => turn.created_at > downAt).map((turn) => turn.task_id)).toEqual([ep01.id]);
});
