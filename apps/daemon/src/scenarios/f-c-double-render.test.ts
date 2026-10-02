/**
 * ADR 0040 fixture F-c: C07 and C08 rendered twice, once in each of two Bot↔Bot directs.
 *
 * On 2026-09-27 two chains of Bot↔Bot directs between 视频导演 and 审片员 were both on the same
 * EP01 ticket at the same time. Each was told to redo C07 and C08, each turn submitted both
 * (08:56:55 and 08:59:42 in one, 09:21:11 and 09:23:59 in the other), and the video server billed
 * four renders for two shots. A turn belongs to a session, so two sessions meant two turns doing
 * one job.
 *
 * Target, in two layers:
 * - ADR 0040 P4b (work items: one live segment per Bot per plan) flips the first test: with both
 *   directs filed under EP01, the second line reaches the segment already working on it instead of
 *   opening another, and each shot is submitted once.
 * - ADR 0040 P4d (external jobs, deduplicated by their arguments; ADR 0047, engine level 6) flips
 *   the second: even with the second line filed under another plan, so that two segments do run,
 *   the same submit with the same arguments within half an hour gets the first job back instead of
 *   reaching the server. From level 3 a Bot↔Bot line wakes nobody, so there the two lines are
 *   yours, in the director's direct and in the group.
 *
 * Before both, both chains ran and the server saw each shot twice.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, endTurn, media, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec, submitsOf, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const C07 = { prompt: "C07：机械臂从左侧入画，背景是仓内" };
const C08 = { prompt: "C08：仓门关闭，背景是仓内" };

/**
 * 视频导演 is told to redo C07 and C08 in one direct, and while that turn is still on its first hop,
 * again in another, both lines filed under EP01.
 */
async function toldTwice(h: Scenario) {
  const { director, reviewer, room } = videoTeam(h);
  const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
  const redo = h.store.createTicket({ taskId: ep01.id, title: "C07、C08 重渲", status: "doing", worker: director.id });
  const first = h.botDirect(director, reviewer);
  const second = h.botDirect(director, reviewer);
  const bothIn = Promise.withResolvers<void>();
  let working = false;
  h.script(director, first).reply(async () => {
    working = true;
    await bothIn.promise;
    return call(media("submit_video", C07));
  }, call(media("submit_video", C08)), call(endTurn()));
  h.script(director, second).reply(call(media("submit_video", C07)), call(media("submit_video", C08)), call(endTurn()));

  h.postBot(reviewer, first, "C07、C08 背景跳了，重渲一下", { taskId: ep01.id, ticketId: redo.id });
  await h.waitFor(() => working, { what: "the first turn on the redo" });
  h.postBot(reviewer, second, "C05 审完了。C07、C08 也按新背景重渲", { taskId: ep01.id, ticketId: redo.id });
  await h.routed();
  bothIn.resolve();
  await h.waitIdle();
  return { director };
}

test("told twice in two directs about the same plan, the director renders each shot once", async () => {
  const h = await createScenario({ media: true, workItems: true });
  open.push(h);
  const { director } = await toldTwice(h);

  expect({ C07: submitsOf(h, "C07"), C08: submitsOf(h, "C08") }).toEqual({ C07: 1, C08: 1 });
  // The second line was heard by the turn already on the plan. A later look-back, once the plan
  // goes quiet with a ticket still open, is a turn of its own and is not counted here.
  const redo = h.turns(director).filter((turn) => !h.store.getMessage(turn.trigger_message_id).body.startsWith("回看："));
  expect(redo).toHaveLength(1);
});

test("filed under another plan, the second submit of the same shot gets the first job back", async () => {
  // Each job its own id, the way a real server's are.
  const h = await createScenario({ media: { videoPolls: 1 }, jobs: true });
  open.push(h);
  const { director, room } = videoTeam(h);
  const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
  const redo = h.store.createTicket({ taskId: ep01.id, title: "C07、C08 重渲", status: "doing", worker: director.id });
  const other = openPlan(h, room, "回响纪元", planSpec("未来世界短片《回响纪元》"));
  const dm = h.direct(director);
  const told: Array<{ session: string; body: string; target: { taskId: string; ticketId?: string } }> = [
    { session: dm, body: "C07、C08 背景跳了，重渲一下", target: { taskId: ep01.id, ticketId: redo.id } },
    { session: room, body: "@视频导演 C05 审完了。C07、C08 也按新背景重渲", target: { taskId: other.id } },
  ];
  const results: string[] = [];
  for (const { session, body, target } of told) {
    h.script(director, session).reply(call(media("submit_video", C07)), call(media("submit_video", C08)), ({ results: got }) => {
      results.push(...got.map((result) => result.content));
      return call(endTurn());
    });
    const line = h.store.postMessage(session, { body });
    h.store.fileMessage(line.id, { explicit: [target] });
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
  }

  expect({ C07: submitsOf(h, "C07"), C08: submitsOf(h, "C08") }).toEqual({ C07: 1, C08: 1 });
  // The second segment was told it got the job already running, not a new one.
  expect(results.at(-1)).toContain("deduped");
});
