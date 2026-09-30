/**
 * ADR 0040 fixture F-d: 07:20, 「前三镜背景严重跳跃」 filed under the wrong plan.
 *
 * The group's history was cleared on 2026-09-29 at 05:14; EP01, the job before, had last moved
 * before that. Eight minutes later the short film 《回响纪元》 opened in the same group, and from then
 * on every turn in the group's work was on it: 视频导演 made its shots, and 审片员 passed Shots 01–03
 * between 05:36 and 05:58. At 07:20 you told 审片员, in a direct just cleared, that the first three
 * shots' backgrounds jumped about. The organizer filed that under EP01, which still counted as one of
 * 审片员's jobs, so the one turn at work on the film — 视频导演's, since 07:16 — never heard it, and
 * nothing was sent back for rework.
 *
 * Target, in two steps:
 * - ADR 0040 P4b (deterministic attribution) flips the first test: EP01 went dormant (from P3) when
 *   the group was cleared after its last activity, so 审片员's only live candidate is the film, and
 *   「前三镜」 names its Shots 01–03. The line is filed there, 审片员 works on it there, and
 *   视频导演's running turn on the film reads it at its next step.
 * - ADR 0040 P4e (submissions, reviews and parts) flips the second: a complaint about approved work
 *   sends it back for rework — Shots 01–03 reopen.
 *
 * Today the line is filed under EP01, the film's running turn never sees it, and Shots 01–03 stay
 * approved.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionRequest } from "../completions";
import { call, createScenario, endTurn, requestText, say, shell, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const COMPLAINT = "前三镜背景严重跳跃，1 镜在仓外、2 镜又回到仓里，3 镜起身没有过渡，嘴鼻结冰的特效也太假";

/** From the day before to 07:20, then the complaint; the director's turn on the film goes on after it. */
async function theMorning(h: Scenario) {
  const { director, reviewer, room } = videoTeam(h);
  const reviewerDm = h.direct(reviewer);
  // EP01, the day before, with a review of 审片员's left open: that keeps it among 审片员's jobs.
  const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
  h.store.createTicket({ taskId: ep01.id, title: "EP01 整片审片", status: "todo", worker: reviewer.id });
  // 04:11: talked over with 审片员 in its direct, filed under EP01.
  const said = h.store.transaction(() => h.store.postMessage(reviewerDm, { body: "机械臂还是要左手" }));
  h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [ep01.id, said.id]);
  // 05:14:53: the group's history is cleared. 05:22:51: the film opens there.
  h.store.clearSessionMessages(room);
  const echo = openPlan(h, room, "回响纪元", planSpec("未来世界短片《回响纪元》"));
  const firstThree = h.store.createTicket({ taskId: echo.id, title: "Shot 01–03", status: "done", worker: director.id });
  const rest = h.store.createTicket({ taskId: echo.id, title: "Shot 04–12", status: "doing", worker: director.id });
  // 05:36–05:58: Shots 01–03 delivered, one file each, and passed.
  const shots = ["shot_01.mp4", "shot_02.mp4", "shot_03.mp4"].map((name) => `${firstThree.dir}/${name}`);
  mkdirSync(join(h.root, firstThree.dir), { recursive: true });
  for (const path of shots) writeFileSync(join(h.root, path), "shot");
  const delivered = h.store.insertMessage({ sessionId: room, kind: "bot", author: director.id, body: "Shot 01–03 交付", paths: shots });
  h.store.db.run(`UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?`, [echo.id, firstThree.id, delivered.id]);
  // 07:16:19: 视频导演 at work on the film (here in its thread with 审片员), in the middle of a hop.
  const thread = h.botDirect(director, reviewer);
  const go = Promise.withResolvers<void>();
  let working = false;
  const read: CompletionRequest[] = [];
  h.script(director, thread).reply(
    async () => {
      working = true;
      await go.promise;
      return call(shell("ls"));
    },
    ({ request }) => {
      read.push(request);
      return call(endTurn());
    },
  );
  h.postBot(reviewer, thread, "Shot 04 的光再压暗一点", { taskId: echo.id, ticketId: rest.id });
  await h.waitFor(() => working, { what: "the director's turn on the film" });
  // 07:20: the direct was cleared; the complaint is its first line.
  h.store.clearSessionMessages(reviewerDm);
  // How the organizer filed it then.
  h.judge("organizer", { session: reviewerDm }).reply({
    decision: "join",
    join_plan_id: ep01.id,
    plan: planSpec("EP01 动画成片"),
    tickets: [],
    message_ticket: null,
  });
  h.script(reviewer, reviewerDm).reply(say("收到，前三镜我让视频导演重做"));

  const complaint = h.postUser(reviewerDm, COMPLAINT);
  await h.routed();
  go.resolve();
  await h.waitIdle();
  return { reviewer, reviewerDm, echo, firstThree, complaint, read };
}

test.failing("the complaint is filed under the film and reaches the turn at work on it", async () => {
  const h = await createScenario();
  open.push(h);
  const { reviewer, reviewerDm, echo, complaint, read } = await theMorning(h);

  expect(h.store.getTask(h.store.getMessage(complaint.id).task_id!).title).toBe(echo.title);
  // 审片员 takes it up on the film.
  expect(h.turns(reviewer).filter((turn) => turn.session_id === reviewerDm).map((turn) => turn.task_id)).toEqual([echo.id]);
  // 视频导演's next step on the film reads it.
  expect(read.map((request) => requestText(request).includes(COMPLAINT))).toEqual([true]);
});

test.failing("the complaint sends the approved Shots 01–03 back for rework", async () => {
  const h = await createScenario();
  open.push(h);
  const { firstThree } = await theMorning(h);

  // Rework, on the tickets the board still reads (P4e keeps `status` in step: rework is `doing`).
  expect(h.store.getTicket(firstThree.id).status).toBe("doing");
});
