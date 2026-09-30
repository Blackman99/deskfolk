/**
 * ADR 0040 fixture F-a: 2026-09-29 10:35–11:15, told to stop, the Bots kept working.
 *
 * At 10:35 you told 视频导演 in its direct 「你手头的生成停一下」. It was at work in two Bot↔Bot
 * directs with 审片员 — on 《回响纪元》 in one, on EP01 in the other — and neither turn heard
 * anything: the one on EP01 went on re-cutting the master, the other sent Shot 11 for review, and four
 * seconds later the direct answered 「私聊里的也停了」. At 10:45 审片员 was told 「停下你所有的工作」,
 * took it as a note and ran nine more commands. The two then traded 「停工已对齐」 lines, each one
 * waking the other. At 10:53 「你私聊里的没停」 went through the organizer like any request. At 11:01
 * two Stops ended two turns on 《回响纪元》; a minute later the plan settled, the settle put Shot 12
 * back in progress, and the call-back right after it submitted Shot 12.
 *
 * The target is ADR 0040's control plane: a stop is a hold only you lift, every way of starting or
 * waking a turn and every call with an effect checks it, and the app itself — not a model turn —
 * says what was stopped. Each test names the phase that flips it to a plain `test`:
 * - ADR 0040 P2 (holds, the wake and tool gates, the stop receipt): the first three.
 * - ADR 0040 P1 (a Stop no longer ends in a settle, so nothing calls the plan back): the fourth.
 * - ADR 0040 P4c (a line in a Bot↔Bot thread wakes nobody): the last, for when nobody is held.
 *
 * P2 records every wake a hold turns away as `wake.suppressed` in the work log (`suppressedWakes()`,
 * each wake path's own test in wake-gate.test.ts). The lines here make no hold until the stop line
 * does, so the check that each wake here is on that record goes in with it.
 *
 * Today one kind of acknowledgement already wakes nobody: in a Bot↔Bot direct, a bare remark
 * answering a bare remark, when neither turn behind the two lines ran a command or an MCP tool
 * (`isNodToANod` in engine/participation.ts, the stopgap P1 keeps). That rule reads the text and the
 * turns behind it, so an acknowledgement from a turn that looked at anything first still wakes the
 * other Bot. The last test is that case: 视频导演 lists its folder before it agrees. From P4c no
 * line in a thread wakes anybody, whatever the turn behind it ran.
 *
 * The first four tests open their Bot↔Bot work with a line posted in the other Bot's name, a line
 * no turn wrote (see `postBot`). The nod rule reads the turn behind each line, so the last test has
 * 审片员's own turn send its opener, as every Bot's line is sent. From P4c neither kind of line wakes
 * anybody by itself, and the fixture opens that work with a delegation instead; the last test checks
 * its own opening so that it cannot pass for want of one.
 */
import { afterEach, expect, test } from "bun:test";
import type { CompletionResult } from "../completions";
import { isoNow } from "../ids";
import { call, checkBack, createScenario, endTurn, media, say, sendMessage, shell, type Scenario, type ScenarioOptions } from "../test-kit/scenario";
import { openPlan, planSpec, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function scenario(options?: ScenarioOptions): Promise<Scenario> {
  const h = await createScenario(options);
  open.push(h);
  return h;
}

/**
 * 10:21 and 10:26: 视频导演 at work in two Bot↔Bot directs with 审片员, on 《回响纪元》 in one and
 * EP01 in the other, each turn in the middle of a hop that answers only once `go` resolves: then
 * one submits Shot 11 and the other writes the master. The one on EP01 has already booked a look
 * at the export in five minutes.
 */
async function atWork(h: Scenario) {
  const team = videoTeam(h);
  const { director, reviewer, room } = team;
  const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
  const echo = openPlan(h, room, "回响纪元", planSpec("未来世界短片《回响纪元》"));
  const echoThread = h.botDirect(director, reviewer);
  const epThread = h.botDirect(director, reviewer);
  const go = Promise.withResolvers<void>();
  const mid = { echo: false, ep: false };
  h.script(director, echoThread).reply(async () => {
    mid.echo = true;
    await go.promise;
    return call(media("submit_video", { prompt: "Shot 11：仓门打开，机械臂伸向镜头" }));
  }, call(endTurn()));
  h.script(director, epThread).reply(call(checkBack(5, "看 EP01 母带导出好没有")), async () => {
    mid.ep = true;
    await go.promise;
    return call(shell("printf 'ep01 master' > EP01_MASTER.mp4"));
  }, call(endTurn()));
  h.postBot(reviewer, echoThread, "Shot 11 分镜过了，开始生成", { taskId: echo.id });
  h.postBot(reviewer, epThread, "EP01 母带按新的转场重新拼一遍", { taskId: ep01.id });
  await h.waitFor(() => mid.echo && mid.ep, { what: "both of the director's turns to be mid-hop" });
  return { ...team, ep01, echo, echoThread, epThread, go };
}

// ADR 0040 P2.
test.failing("a stop said in the director's direct ends its work in both Bot↔Bot directs at once, and the app says what it stopped", async () => {
  const h = await scenario({ media: true });
  const t = await atWork(h);
  const dm = h.direct(t.director);
  // What the direct said at 10:41, four seconds after Shot 11 went for review.
  h.script(t.director, dm).reply(say("私聊里的也停了"));

  const stop = h.postUser(dm, "你手头的生成停一下");
  await h.routed();
  t.go.resolve();
  await h.waitIdle();
  // At 10:36 and 10:38 two more turns of the director's opened on 《回响纪元》. Two more ways to wake
  // it: a line of 审片员's in that thread, and the look at the export falling due.
  h.postBot(t.reviewer, t.echoThread, "Shot 11 的机械臂再看一眼", { taskId: t.echo.id });
  await h.waitIdle();
  h.advance(6 * 60_000);
  await h.waitIdle();

  // Nothing with an effect after the line: no Shot 11, no master.
  expect(h.sideEffectCalls(t.director, stop).map(({ name, args }) => ({ name, args }))).toEqual([]);
  expect(h.mcpCalls(t.director).filter((row) => row.tool === "submit_video")).toEqual([]);
  // Both turns were cut off, and no turn opened after the line: not for the line itself, not for
  // 审片员's line, not for the look.
  expect(h.turns(t.director).map(({ session_id, status }) => ({ session_id, status }))).toEqual([
    { session_id: t.echoThread, status: "stopped" },
    { session_id: t.epThread, status: "stopped" },
  ]);
  // A stop takes no model call: not the organizer's, not a turn's.
  expect(h.judgeCalls("organizer").filter((row) => row.at > stop.created_at)).toEqual([]);
  expect(h.hops().filter((hop) => hop.sessionId === dm).map(({ turnId, hop }) => ({ turnId, hop }))).toEqual([]);
  // The receipt is the app's, and names the two jobs whose turns it stopped.
  const after = h.messages(dm).filter((message) => message.created_at > stop.created_at);
  expect(after.map(({ kind }) => kind)).toEqual(["system"]);
  expect(after[0]!.body).toContain("EP01");
  expect(after[0]!.body).toContain("回响纪元");
});

// ADR 0040 P2.
test.failing("told it has not stopped, the app checks what is running and answers, with no model call", async () => {
  const h = await scenario({ media: true });
  const t = await atWork(h);
  const dm = h.direct(t.director);
  h.postUser(dm, "你手头的生成停一下");
  await h.routed();
  t.go.resolve();
  await h.waitIdle();

  // 10:53:36.
  const again = h.postUser(dm, "你私聊里的没停");
  await h.waitIdle();

  expect(h.judgeCalls("organizer").filter((row) => row.at > again.created_at)).toEqual([]);
  expect(h.turns(t.director).filter((turn) => turn.created_at > again.created_at)).toEqual([]);
  // The answer is the app's, about the director, from what the store says is running.
  const answer = h.messages(dm).filter((message) => message.created_at > again.created_at);
  expect(answer.map(({ kind }) => kind)).toEqual(["system"]);
  expect(answer[0]!.body).toContain("视频导演");
});

// ADR 0040 P2.
test.failing("the reviewer told to stop all its work opens no turn and runs nothing, and a held Bot's line wakes nobody", async () => {
  const h = await scenario({ media: true });
  const t = await atWork(h);
  h.postUser(h.direct(t.director), "你手头的生成停一下");
  await h.routed();
  t.go.resolve();
  await h.waitIdle();

  // 10:45:46: heard as a note and answered with commands.
  const reviewerDm = h.direct(t.reviewer);
  h.script(t.reviewer, reviewerDm).reply(call(shell("ls")), call(shell("ls -la")), say("收到，这镜看完就停"));
  const stop = h.postUser(reviewerDm, "停下你所有的工作");
  await h.waitIdle();
  // 10:51: the two of them, both held, acknowledging each other in their direct.
  h.postBot(t.director, t.echoThread, "停工已对齐，本轮不发消息。");
  await h.waitIdle();

  expect(h.sideEffectCalls(t.reviewer, stop).map(({ name, args }) => ({ name, args }))).toEqual([]);
  expect(h.turns(t.reviewer).filter((turn) => turn.created_at > stop.created_at)).toEqual([]);
});

// ADR 0040 P1.
test("Stop on the director's two turns in a plan calls nobody back: no settle, no call-back, no Shot 12", async () => {
  const h = await scenario({ media: true });
  const { director, reviewer, room } = videoTeam(h);
  const echo = openPlan(h, room, "回响纪元", planSpec("未来世界短片《回响纪元》"));
  h.store.createTicket({ taskId: echo.id, title: "Shot 12", status: "todo", worker: director.id });
  // Two turns on the plan, each in its own Bot↔Bot direct with 审片员, each in the middle of a hop.
  const threads = [h.botDirect(director, reviewer), h.botDirect(director, reviewer)];
  let mid = 0;
  for (const thread of threads) {
    h.script(director, thread).reply(() => {
      mid += 1;
      return new Promise<CompletionResult>(() => {});
    });
  }
  h.postBot(reviewer, threads[0]!, "Shot 11 审过了", { taskId: echo.id });
  h.postBot(reviewer, threads[1]!, "Shot 12 的分镜也过了", { taskId: echo.id });
  await h.waitFor(() => mid === 2, { what: "both of the director's turns to be mid-hop" });
  // Where the 11:02 call-back landed, and what it did there.
  h.script(director, room).reply(call(media("submit_video", { prompt: "Shot 12：主角走出仓门" })), call(endTurn()));

  // 11:01:05, two Stops 139 ms apart.
  const stoppedAt = isoNow();
  for (const turn of h.turns(director)) h.engine.stop(turn.id);
  await h.waitIdle();

  expect(h.sideEffectCalls(director, stoppedAt).map(({ name, args }) => ({ name, args }))).toEqual([]);
  expect(h.turns(director).filter((turn) => turn.created_at > stoppedAt)).toEqual([]);
  expect(h.store.lastPlanNudge(echo.id)).toBeNull();
  // Nor is the plan settled over it.
  expect(h.judgeCalls("organizer").filter((row) => row.at > stoppedAt)).toEqual([]);
});

// ADR 0040 P4c.
test.failing("in a Bot↔Bot direct an acknowledgement wakes nobody, even with nobody held and a command run before it", async () => {
  const h = await scenario();
  const { director, reviewer } = videoTeam(h);
  const thread = h.botDirect(director, reviewer);
  const reviewerDm = h.direct(reviewer);
  // 审片员 passes your word on from its direct with you.
  h.script(reviewer, reviewerDm).reply(call(sendMessage("用户叫停了，Shot 12 先不开", { session_id: thread }), endTurn()));
  // 视频导演 lists its folder, then agrees. It waits for 审片员's turn to end first, so that its
  // answer can only open a turn of 审片员's, not be heard in the one still ending.
  h.script(director, thread).reply(async () => {
    await h.waitFor(() => h.store.listLiveTurns().every((turn) => turn.bot_id !== reviewer.id), { what: "审片员's turn to end" });
    return call(shell("ls"));
  }, say("停工已对齐，Shot 12 不开。"));

  h.postUser(reviewerDm, "跟视频导演说一声，Shot 12 先不开");
  await h.waitIdle();

  // The opening got through (see the header): the director answered in the thread.
  expect(h.messages(thread).map(({ author, body }) => ({ author, body }))).toEqual([
    { author: reviewer.id, body: "用户叫停了，Shot 12 先不开" },
    { author: director.id, body: "停工已对齐，Shot 12 不开。" },
  ]);
  // What woke 审片员 in the thread, if anything did.
  const woken = h.turns(reviewer).filter((turn) => turn.session_id === thread);
  expect(woken.map((turn) => h.store.getMessage(turn.trigger_message_id).body)).toEqual([]);
});
