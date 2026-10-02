/**
 * ADR 0040 fixture: one render polled from two directs, each on its own clock.
 *
 * On 2026-09-28 视频导演 waited on one video job from two directs at once. Each turn asked the video
 * server how the job was going, booked a check-back, and asked again when it came due: 17 times
 * from one, 7 from the other. Every one of those was a turn, and every turn a model call, to learn
 * that the render was still running.
 *
 * ADR 0040 P4d (external jobs, ADR 0047, engine level 6) flips this to a plain `test`: a job is
 * registered when it is submitted and the daemon polls it on its own, once for everyone waiting; a
 * Bot asking `check_video` gets the job's last known state without reaching the server, a
 * check-back booked to poll a job still rendering is refused, and the result wakes whoever waits on
 * it once it is there. From level 3 a Bot↔Bot line wakes nobody, so the second wait here is your
 * question in the group rather than 审片员's in a direct. Before, every check a Bot made reached the
 * server, and each conversation kept its own schedule.
 */
import { afterEach, expect, test } from "bun:test";
import { call, checkBack, createScenario, endTurn, media, say, type HopContext, type Scenario } from "../test-kit/scenario";
import { videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** The job a media tool's result names, its state, and whether the app answered from what it last heard. */
function jobOf(content: string): { job_id: string; status: string; cached?: boolean } | null {
  try {
    const outer = JSON.parse(content) as { data?: { content?: Array<{ text?: string }> } };
    const text = outer.data?.content?.[0]?.text;
    return text ? (JSON.parse(text) as { job_id: string; status: string; cached?: boolean }) : null;
  } catch {
    return null;
  }
}

test("a render waited on from two conversations is polled by the daemon, not by the Bot's turns", async () => {
  const h = await createScenario({ media: { videoPolls: 4 }, jobs: true });
  open.push(h);
  const { director, room } = videoTeam(h);
  const dm = h.direct(director);
  // Wherever it is woken, the director does what it did then: submit once, then check, and while the
  // job runs, book a check-back to look again in a minute (each note says where it was booked).
  let job: string | null = null;
  const poll = ({ hop, results, sessionId }: HopContext) => {
    const seen = results.length > 0 ? jobOf(results.at(-1)!.content) : null;
    if (seen) job = seen.job_id;
    if (!job) return call(media("submit_video", { prompt: "Shot 05：雪地远景，镜头缓慢推进" }));
    if (hop === 1 || (seen && !seen.cached)) return call(media("check_video", { job_id: job }));
    if (seen?.status !== "completed") {
      return call(checkBack(1, `看 ${job} 渲好没有（${sessionId === dm ? "用户私聊" : "群里"}）`), endTurn());
    }
    return say(`${job} 渲好了`);
  };
  h.script(director).handle(poll);

  h.postUser(dm, "把 Shot 05 渲出来");
  await h.waitIdle();
  h.postUser(room, `@视频导演 ${job} 那条 Shot 05 渲好了吗？好了跟我说`);
  await h.waitIdle();
  // Long enough for the daemon's backed-off asks (30 s, 1, 2, 4, then 5 minutes) to see it done.
  for (let minute = 0; minute < 15; minute += 1) {
    h.advance(61_000);
    await h.waitIdle();
  }

  // No turn's check reaches the server: the daemon asks, and the Bots read what it last heard.
  expect(h.mcpCalls(director).filter((row) => row.tool === "check_video").map(({ args }) => args)).toEqual([]);
  expect(h.mcpCalls().filter((row) => row.tool === "check_video" && row.botId === null).length).toBeGreaterThan(0);
  // A check-back booked to poll the running job is turned down.
  expect(h.toolCalls(director, "check_back").map(({ result }) => result?.ok ?? null).filter((ok) => ok !== false)).toEqual([]);
  // Once the render is done, both conversations that waited on it hear so.
  const told = h.store.db.query<{ session_id: string }, [string]>("SELECT DISTINCT session_id FROM inbox_items WHERE bot_id = ? AND source = 'job'").all(director.id);
  expect(told.map((row) => row.session_id).sort()).toEqual([dm, room].sort());
});
