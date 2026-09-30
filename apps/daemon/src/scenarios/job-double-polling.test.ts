/**
 * ADR 0040 fixture: one render polled from two directs, each on its own clock.
 *
 * On 2026-09-28 视频导演 waited on one video job from two directs at once. Each turn asked the video
 * server how the job was going, booked a check-back, and asked again when it came due: 17 times
 * from one, 7 from the other. Every one of those was a turn, and every turn a model call, to learn
 * that the render was still running.
 *
 * Target, from ADR 0040 P4d (external jobs), which flips this to a plain `test`: a job is registered
 * when it is submitted and the daemon polls it on its own, once for everyone waiting; a Bot asking
 * `check_video` gets the job's last known state without reaching the server, a check-back booked
 * to poll a job still rendering is refused, and the result wakes whoever waits on it once it is
 * there. Today every check a Bot makes reaches the server, and each direct keeps its own schedule.
 */
import { afterEach, expect, test } from "bun:test";
import { call, checkBack, createScenario, endTurn, media, say, type HopContext, type Scenario } from "../test-kit/scenario";
import { videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** The job a media tool's result names, and its state; null for any other result. */
function jobOf(content: string): { job_id: string; status: string } | null {
  try {
    const outer = JSON.parse(content) as { data?: { content?: Array<{ text?: string }> } };
    const text = outer.data?.content?.[0]?.text;
    return text ? (JSON.parse(text) as { job_id: string; status: string }) : null;
  } catch {
    return null;
  }
}

test.failing("a render waited on from two directs is polled by the daemon, not by the Bot's turns", async () => {
  const h = await createScenario({ media: { videoPolls: 4 } });
  open.push(h);
  const { director, reviewer } = videoTeam(h);
  const dm = h.direct(director);
  const thread = h.botDirect(director, reviewer);
  // Wherever it is woken, the director does what it did then: submit once, then check, and while
  // the job runs, book a check-back to look again in a minute (each note says where it was booked,
  // so the two turns a tick wakes read differently).
  let job: string | null = null;
  const poll = ({ hop, results, sessionId }: HopContext) => {
    const seen = results.length > 0 ? jobOf(results.at(-1)!.content) : null;
    if (seen) job = seen.job_id;
    if (!job) return call(media("submit_video", { prompt: "Shot 05：雪地远景，镜头缓慢推进" }));
    if (hop === 1 || seen?.status === "pending") return call(media("check_video", { job_id: job }));
    if (seen?.status === "running") {
      return call(checkBack(1, `看 ${job} 渲好没有（${sessionId === dm ? "用户私聊" : "审片员私聊"}）`), endTurn());
    }
    return say(`${job} 渲好了`);
  };
  h.script(director).handle(poll);

  h.postUser(dm, "把 Shot 05 渲出来");
  await h.waitIdle();
  h.postBot(reviewer, thread, `${job} 那条 Shot 05 渲好了吗？好了跟我说`);
  await h.waitIdle();
  for (let minute = 0; minute < 4; minute += 1) {
    h.advance(61_000);
    await h.waitIdle();
  }

  // No turn's check reaches the server: the daemon asks, and the Bots read what it last heard.
  expect(h.mcpCalls(director).filter((row) => row.tool === "check_video").map(({ args }) => args)).toEqual([]);
  // A check-back booked to poll the running job is turned down.
  expect(h.toolCalls(director, "check_back").map(({ result }) => result?.ok ?? null).filter((ok) => ok !== false)).toEqual([]);
});
