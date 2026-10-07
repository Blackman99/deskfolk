/**
 * ADR 0040 fixture F-f: a 107-second master passed as "about two minutes".
 *
 * You opened EP01 on 2026-09-28 with 「片长约2分钟」 and said it again that afternoon. At 18:33
 * 审片员 passed the master as about two minutes; it ran 107.00 seconds. Its profile listed the
 * running time as a must-check, a memory held the pass criteria, it ran at the high thinking level —
 * and a model judging another model's work passed it anyway. No check of the daemon's own measured
 * the file.
 *
 * Target, in two steps:
 * - ADR 0040 P3 (checks derived from your words), done: 「约2分钟」 is offered as a running-time
 *   check of 108–132 s the moment it is filed, and is the same offer when you say it again that
 *   afternoon — shown on the board, with no card asking you to confirm what you said (2026-10-04).
 *   Bound to the master once a `*MASTER*` video is delivered, it is measured and shown failing at
 *   107.00 s — information, not yet a block: your words alone never make a gate. One confirm on the
 *   board does, and the gate then fails the 107-second master. Your complaint about it,
 *   「上一版 107 秒太短了」, names 107 seconds too, and changes nothing.
 * - ADR 0040 P4e (submissions and reviews, ADR 0046, engine level 5), done, the spec's way (§6.5):
 *   「片长约2分钟」, raised twice in the ledger, is a required item. 视频导演 hands the master over with
 *   `submit`, it goes to 审片员 as the ticket's reviewer, and 审片员 — on the same model — passes it
 *   「约 2 分钟」 and approves. A same-model pass on what you said twice needs a passing check or your
 *   word: the check from your words measures 107.00 s and is not confirmed, so the approval is
 *   refused with that measurement and the ball comes to you, on the hand-over's one card — 放行 or
 *   退回, the reviewer's word, 「片长约2分钟」 and the 107.00 s on it. The producer is told nothing about
 *   a number you have not confirmed. You confirm the check on the board: now a gate, measured again,
 *   failing — at the next tick the master goes back to 视频导演 against the number you confirmed, and
 *   the card says why in place of its buttons. A text 「PASSED」 moves nothing at any point.
 *
 * The 107-second master is made with ffmpeg, and the check reads it with ffprobe: where they are not
 * installed the first test is skipped, since there is no file to deliver or to measure.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkEnv } from "../acceptance-eval";
import { resolveFfmpegBins } from "../seams-check";
import { derivedNotGate, PLAN_MAP_FILE } from "../store";
import { call, createScenario, say, sendMessage, shell, tool, type Scenario, type ToolOutcome } from "../test-kit/scenario";
import { openPlan, planSpec, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const FFMPEG = resolveFfmpegBins(checkEnv(process.env));

/** A black 16×16 video of `seconds`, at `path` under the workspace; nothing when ffmpeg is missing. */
function render(h: Scenario, path: string, seconds: number): void {
  mkdirSync(join(h.root, path, ".."), { recursive: true });
  if (!FFMPEG) return;
  const args = ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1", "-t", String(seconds), "-c:v", "mpeg4", "-y", join(h.root, path)];
  const made = spawnSync(FFMPEG.ffmpeg, args, { stdio: "ignore" });
  if (made.status !== 0) throw new Error(`ffmpeg exited ${made.status}`);
}

/**
 * 12:02 you open EP01 in the group with the running time, and at 15:38 say it again; 视频导演 cuts
 * the master and hands it to 审片员, who reviews it with `review` (the reply that comes back is
 * kept) and then says it passed.
 */
async function theMaster(h: Scenario, reviewing: Array<ReturnType<typeof call> | ReturnType<typeof say>>) {
  const { director, reviewer, room } = videoTeam(h);
  render(h, "assets/render/EP01_cut.mp4", 107);
  h.judge("organizer", { session: room }).reply({
    decision: "new",
    plan: planSpec("EP01 动画成片：BEACON ZERO 第一集", { acceptance: ["母带片长约 2 分钟"] }),
    tickets: [{ id: "new-1", title: "06 母带", spec: "拼出 EP01 母带", status: "doing", worker: "视频导演" }],
    message_ticket: "new-1",
  });
  h.script(director, room).reply(
    call(shell(`cp '${join(h.root, "assets/render/EP01_cut.mp4")}' EP01_MASTER.mp4`)),
    call(sendMessage("@审片员 母带好了：EP01_MASTER.mp4，请审")),
  );
  const replies: ToolOutcome[] = [];
  h.script(reviewer, room).reply(...reviewing, ({ results }) => {
    replies.push(...results);
    return say("PASSED：母带约 2 分钟，节奏和左右手都对");
  });
  h.postUser(room, "@视频导演 做一集 EP01 动画成片，片长约2分钟");
  await h.waitIdle();
  const [plan] = h.store.sessionTasks(room);
  // The afternoon's line is filed under the same plan.
  h.judge("organizer", { session: room }).reply({ decision: "continue", plan: planSpec("EP01 动画成片：BEACON ZERO 第一集"), tickets: [] });
  h.postUser(room, "片长 2 分钟左右，别超太多");
  await h.waitIdle();
  return { planId: plan!.id, replies, director };
}

test.skipIf(!FFMPEG)("your 「约2分钟」 is offered once though said twice, shown failing the 107 s master, and fails it as a gate after one confirm", async () => {
  const h = await createScenario();
  open.push(h);
  const { planId, director } = await theMaster(h, []);
  const room = h.store.getTask(planId).session_id!;
  const cards = () => h.store.listMessages(room, { limit: 100 }).items.reverse().filter((message) => message.control?.kind === "check");
  const holding = () => h.store.listChecks(planId).filter((check) => !derivedNotGate(check) && check.last_run?.outcome === "fail").map((check) => check.id);

  // Read from your words, not written by anyone: 10% either way of two minutes, bound to the master
  // and measured there — failing at 107 s — but only offered.
  const [yours] = h.store.listChecks(planId);
  expect(yours).toMatchObject({
    origin: "derived",
    source: "user",
    kind: "measure",
    measure: { dimension: "duration", min: 108, max: 132 },
    derived_state: "proposed",
    bind_glob: "*MASTER*",
    last_run: { outcome: "fail", detail: "107.00 秒，要时长 108–132 秒" },
  });
  expect(yours!.path).toEndWith("EP01_MASTER.mp4");
  // No card asks you to confirm what you said, after either line.
  expect(cards()).toEqual([]);
  // Shown to the Bots as an unconfirmed check that fails, and holding nothing back.
  expect(readFileSync(join(h.root, h.store.getTask(planId).dir, PLAN_MAP_FILE), "utf8")).toContain("[未确认，不通过]");
  expect(holding()).toEqual([]);

  // One confirm on the board: a gate, measured again, failing the 107-second master and holding the job open.
  h.engine.confirmDerivedCheck(yours!.id);
  await h.waitIdle();
  expect(h.store.listChecks(planId)).toMatchObject([{ id: yours!.id, derived_state: "active", last_run: { outcome: "fail", detail: "107.00 秒，要时长 108–132 秒" } }]);
  expect(holding()).toEqual([yours!.id]);

  // Your complaint about that master gives 107 seconds as well. Complaints never touch a check, so
  // it still asks for 108–132 s, is still in force and still fails the master it failed.
  h.script(director, room).reply(say("好，我重剪"));
  h.postUser(room, "@视频导演 上一版 107 秒太短了");
  await h.waitIdle();
  expect(h.store.listQuotes({ taskId: planId }).map((quote) => quote.body)).toContain("@视频导演 上一版 107 秒太短了");
  const [after] = h.store.listChecks(planId);
  expect(after).toMatchObject({ id: yours!.id, measure: { dimension: "duration", min: 108, max: 132 }, derived_state: "active" });
  expect(h.store.listChecks(planId)).toHaveLength(1);
  expect(after!.last_run).toMatchObject({ outcome: "fail", detail: "107.00 秒，要时长 108–132 秒" });
});

test.skipIf(!FFMPEG)("an approval over the failing check is refused, and says why", async () => {
  const h = await createScenario({ submissions: true });
  open.push(h);
  const { director, reviewer, room } = videoTeam(h);
  render(h, "assets/render/EP01_cut.mp4", 107);
  const plan = openPlan(h, room, "EP01 动画成片：BEACON ZERO 第一集", planSpec("EP01 动画成片：BEACON ZERO 第一集"));
  const master = h.store.createTicket({ taskId: plan.id, title: "06 母带", status: "doing", worker: director.id });
  // 审片员 reviews the master: set on the board.
  h.store.patchTicketByUser(master.id, { reviewerBotId: reviewer.id });
  // 12:02 and 15:38: the running time, twice, filed under the plan; nobody is woken by either. The
  // ledger has it as one entry raised twice, as the scribe leaves it.
  const said = ["做一集 EP01 动画成片，片长约2分钟", "片长 2 分钟左右，别超太多"].map((body) => {
    const line = h.store.postMessage(room, { body });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    return h.store.listQuotes({ messageId: line.id })[0]!;
  });
  const entry = h.store.addRequirement({ scope: "plan", scopeId: plan.id, quote: "片长约2分钟", sourceKind: "message", sourceQuoteId: said[0]!.id,
    addedBy: "scribe", category: "时长" });
  h.store.raiseRequirement(entry.id, { quoteId: said[1]!.id, actor: "scribe" });
  h.engine.syncDerivedChecks(plan.id);
  await h.waitIdle();

  h.script(director, room).reply(
    call(shell(`cp '${join(h.root, "assets/render/EP01_cut.mp4")}' EP01_MASTER.mp4`)),
    call(tool("submit", { artifacts: ["EP01_MASTER.mp4"], note: "母带约 2 分钟" })),
    say("母带交了，等审片"),
  );
  const replies: ToolOutcome[] = [];
  h.script(reviewer).reply(
    call(tool("review", { outcome: "approve", verdicts: [{ requirement_id: entry.id, verdict: "pass", evidence: ["母带约 2 分钟"] }] })),
    ({ results }) => {
      replies.push(...results);
      return say("PASSED：母带约 2 分钟，节奏和左右手都对");
    },
  );
  const ask = h.store.postMessage(room, { body: "@视频导演 母带拼好交给审片员" });
  h.store.fileMessage(ask.id, { explicit: [{ taskId: plan.id, ticketId: master.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(ask.id), { fromUser: true });
  await h.waitIdle();

  // Handed over: the check from your words, bound to the master and measured, is only offered, so it
  // held nothing back; the master went to its reviewer.
  const [submission] = h.store.listSubmissions({ taskId: plan.id });
  expect(submission).toMatchObject({ origin: "submit", bot_id: director.id, checks: [{ gate: false, outcome: "fail", detail: "107.00 秒，要时长 108–132 秒" }] });
  expect(submission!.artifacts.map((artifact) => artifact.path)).toEqual([`${master.dir}/EP01_MASTER.mp4`]);

  // 审片员's approval, on the producer's own model, is refused with the measurement, and the ball is yours.
  expect(replies.map(({ name, ok }) => ({ name, ok }))).toEqual([{ name: "review", ok: false }]);
  expect(replies[0]!.content).toContain("awaiting_user");
  expect(replies[0]!.content).toContain("107.00 秒，要时长 108–132 秒");
  const card = h.messages(room).find((message) => message.control?.kind === "review_item")!;
  expect(card.control).toMatchObject({ kind: "review_item", submission_id: submission!.id, requirement_ids: [entry.id], offer: ["approve", "reject"] });
  expect(card.body).toContain("审片员审过了，判通过");
  expect(card.body).toContain("- 「片长约2分钟」（你说过 2 次）——应用量到：");
  expect(card.body).toContain("107.00 秒，要时长 108–132 秒");
  expect(h.store.ballHolder({ ticketId: master.id })).toEqual({ kind: "user", reason: "review", ref: card.id });
  // The 「PASSED」 in words moved nothing, and nobody told 视频导演 to recut to an unconfirmed number.
  expect(h.store.getSubmission(submission!.id).state).toBe("in_review");
  expect(h.store.getTicket(master.id)).toMatchObject({ stage: "in_review", status: "review" });
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE bot_id = ? AND source = 'review'").get(director.id)).toEqual({ n: 0 });

  // You confirm the check on the board: a gate now, measured again, failing — at the next tick the
  // master goes back to 视频导演, and the card says why.
  h.script(director).reply(call(tool("end_turn", { reason: "nothing_new" })));
  const [offered] = h.store.listChecks(plan.id);
  h.engine.confirmDerivedCheck(offered!.id);
  await h.waitIdle();
  const [check] = h.store.listChecks(plan.id);
  expect(check).toMatchObject({ derived_state: "active", last_run: { outcome: "fail", detail: "107.00 秒，要时长 108–132 秒" } });
  h.tick();
  await h.waitIdle();
  expect(h.store.getSubmission(submission!.id).state).toBe("checks_failed");
  expect(h.store.getMessage(card.id).control).toMatchObject({ offer: [], result: expect.stringContaining("检查没过，已退回") });
  expect(h.store.getTicket(master.id)).toMatchObject({ stage: "rework", status: "doing" });
  const told = h.store.db.query<{ body_snapshot: string }, [string]>("SELECT body_snapshot FROM inbox_items WHERE bot_id = ? AND source = 'review'").all(director.id);
  expect(told).toHaveLength(1);
  expect(told[0]!.body_snapshot).toContain("107.00 秒，要时长 108–132 秒");
});
