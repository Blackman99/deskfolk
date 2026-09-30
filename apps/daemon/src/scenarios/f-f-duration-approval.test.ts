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
 *   check of 108–132 s the moment it is filed, and offered again, 「你已经说了 2 次」, when you say it
 *   that afternoon. Bound to the master once a `*MASTER*` video is delivered, it is measured and shown
 *   failing at 107.00 s — information, not yet a block: your words alone never make a gate. One
 *   click on 确认 does, and the gate then fails the 107-second master. Your complaint about it,
 *   「上一版 107 秒太短了」, names 107 seconds too, and changes nothing.
 * - ADR 0040 P4e (structured reviews) flips the second: 审片员's approval is refused while that
 *   check fails, and the refusal says why. Until then a text 「PASSED」 is all it takes.
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
import { planSpec, videoTeam } from "./video-team";

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

test.skipIf(!FFMPEG)("your 「约2分钟」 is offered, offered again when said twice, shown failing the 107 s master, and fails it as a gate after one confirm", async () => {
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
  // The card after your first line, and again after your second, saying how often you said it.
  expect(cards().map((message) => (message.control?.kind === "check" ? [message.control.event, message.control.check_ids] : null))).toEqual([
    ["proposed", [yours!.id]],
    ["proposed", [yours!.id]],
  ]);
  expect(cards()[1]!.body).toStartWith("你已经说了 2 次。按你的话加检查：时长 108–132 秒？");
  // Shown to the Bots as an unconfirmed check that fails, and holding nothing back.
  expect(readFileSync(join(h.root, h.store.getTask(planId).dir, PLAN_MAP_FILE), "utf8")).toContain("[未确认，不通过]");
  expect(holding()).toEqual([]);

  // One click on 确认: a gate, measured again, failing the 107-second master and holding the job open.
  h.engine.control(cards()[1]!.id, { action: "confirm_check" });
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

test.failing("an approval over the failing check is refused, and says why", async () => {
  const h = await createScenario();
  open.push(h);
  const { replies } = await theMaster(h, [call(tool("review", { outcome: "approve", verdicts: [] }))]);

  expect(replies.map(({ name, ok }) => ({ name, ok }))).toEqual([{ name: "review", ok: false }]);
  expect(replies[0]!.content).toContain("107");
});
