/**
 * ADR 0040 fixture: a plan opened because the job a line was about ended while it was being filed.
 *
 * On 2026-09-29 a line in 视频导演's direct was about EP01, the job it was doing in a Bot↔Bot
 * direct. The organizer answered "join EP01", its goal copied word for word. By the time the answer
 * was read, that turn had ended, so EP01 no longer counted as a job the Bot had going elsewhere; the
 * join fell back to continue, the direct had no plan of its own, and continuing nothing opened a new
 * plan with EP01's goal: an empty copy nobody asked for.
 *
 * Target, in two steps:
 * - ADR 0040 P1 (the race fix) flips the first test: a join or resume whose target dropped out of
 *   the candidates while the call was out keeps the line where it was and never opens a plan.
 * - ADR 0040 P4b (work items and deterministic attribution) flips the second: until then a turn with
 *   no plan to land on still opens one named after its trigger line; from P4b it starts at its desk
 *   and nothing opens until it does something.
 *
 * The line here asks for a change to EP01 rather than repeating the 09-29 line (「你没停还在进行」):
 * from P2 on a line like that is taken as control and never reaches the filing at all, which would
 * stop this fixture from exercising the race.
 */
import { afterEach, expect, test } from "bun:test";
import { createScenario, say, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const EP01_GOAL = "EP01 动画成片：BEACON ZERO 第一集，片长约 2 分钟";

function planCount(h: Scenario): number {
  return h.store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`).get()!.n;
}

/**
 * 视频导演 is on EP01 in its thread with 审片员 when you say something about EP01 in its direct;
 * the thread's turn ends while the organizer's answer is still on its way.
 */
async function raceTheJoin(h: Scenario) {
  const { director, reviewer, room } = videoTeam(h);
  const ep01 = openPlan(h, room, "EP01", planSpec(EP01_GOAL));
  const thread = h.botDirect(director, reviewer);
  const release = Promise.withResolvers<void>();
  let working = false;
  h.script(director, thread).reply(async () => {
    working = true;
    await release.promise;
    return say("片尾字幕在改");
  });
  h.postBot(reviewer, thread, "EP01 片尾字幕做到哪了？", { taskId: ep01.id });
  await h.waitFor(() => working, { what: "the director's turn on EP01 in the thread" });
  const [threadTurn] = h.turns(director);

  const dm = h.direct(director);
  h.judge("organizer", { session: dm }).reply(async () => {
    // The payload listed EP01 as a job going on elsewhere; that turn ends before the answer is read.
    release.resolve();
    await h.waitFor(() => h.store.getTurn(threadTurn!.id).status !== "running", { what: "the thread's turn to end" });
    return { decision: "join", join_plan_id: ep01.id, plan: planSpec(EP01_GOAL), tickets: [], message_ticket: null };
  });
  h.script(director, dm).reply(say("好，片尾字幕换成白色"));
  const before = planCount(h);

  h.postUser(dm, "EP01 片尾字幕换成白色");
  await h.routed();
  // Without a filing call to end it, the thread's turn ends here instead.
  release.resolve();
  await h.waitIdle();
  return { ep01, before };
}

test("a join whose target ended while the call was out opens no copy of that job", async () => {
  const h = await createScenario();
  open.push(h);
  const { ep01 } = await raceTheJoin(h);

  const copies = h.store.db
    .query<{ id: string }, [string, string]>(`SELECT id FROM tasks WHERE id != ? AND json_extract(spec, '$.goal') = ?`)
    .all(ep01.id, EP01_GOAL);
  expect(copies).toEqual([]);
});

test.failing("and the line opens no plan at all", async () => {
  const h = await createScenario();
  open.push(h);
  const { before } = await raceTheJoin(h);

  expect(planCount(h)).toBe(before);
});

// From P4b (engine level 2) the line is filed from the rows, with no organizer call to race: it opens nothing.
test("from level 2 the line opens no plan at all", async () => {
  const h = await createScenario({ workItems: true });
  open.push(h);
  const { before } = await raceTheJoin(h);

  expect(planCount(h)).toBe(before);
});
