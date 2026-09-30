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
 * - ADR 0040 P3 (checks derived from your words) flips the first test: 「约2分钟」 becomes a
 *   running-time check of 108–132 s the moment it is said, bound to the master once a `*MASTER*`
 *   video is delivered; it runs, and fails on 107.00 s.
 * - ADR 0040 P4e (structured reviews) flips the second: 审片员's approval is refused while that
 *   check fails, and the refusal says why.
 *
 * Today no check exists, and a text 「PASSED」 is all it takes. The 107-second master is made with
 * ffmpeg when it is installed; without it the first test still fails for want of a check, but P3
 * will need the file to flip it.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkEnv } from "../acceptance-eval";
import { resolveFfmpegBins } from "../seams-check";
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
  h.postUser(room, "片长 2 分钟左右，别超太多");
  await h.waitIdle();
  return { planId: plan!.id, replies };
}

test.failing("your 「约2分钟」 becomes a check that runs on the master and fails it at 107 s", async () => {
  const h = await createScenario();
  open.push(h);
  const { planId } = await theMaster(h, []);

  const yours = h.store.listChecks(planId).filter((check) => check.source === "user");
  expect(yours.map((check) => check.last_run?.outcome ?? null)).toEqual(["fail"]);
  expect(yours[0]!.last_run!.detail).toContain("107");
});

test.failing("an approval over the failing check is refused, and says why", async () => {
  const h = await createScenario();
  open.push(h);
  const { replies } = await theMaster(h, [call(tool("review", { outcome: "approve", verdicts: [] }))]);

  expect(replies.map(({ name, ok }) => ({ name, ok }))).toEqual([{ name: "review", ok: false }]);
  expect(replies[0]!.content).toContain("107");
});
