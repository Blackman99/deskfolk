/**
 * ADR 0040 fixture F-b: one filing cut EP01's rules from five to one.
 *
 * EP01 had five rules of yours: the running time, the lines, which way the door opens, a transition
 * at every doorway, and the robot arm being a left arm. On 2026-09-29 04:21 you told 审片员 in its
 * direct that C09's feet must not sink into the floor. The organizer filed the line under EP01 and
 * answered with that one rule as the plan's whole list, and the list is replaced as a whole, so the
 * other five were gone. The left arm and the running time never came back, and every turn on EP01
 * worked from one rule after that.
 *
 * Target, from ADR 0040 P3 (your words, the requirement ledger), which flips this to a plain `test`:
 * rules only grow. A filing may add one, not drop one; the plan's rules, and what every turn on it
 * reads, keep all five and gain the new one, and clearing the direct the lines were said in (as
 * happened at 07:20) takes nothing from them. Today the answer replaces the list.
 *
 * The five are set on the board here, where the real ones came from your lines over two days, so
 * that the ledger has them without a scribe to script; the adversarial scribe answer (one that
 * claims the C09 line supersedes the arm and the running time) is P3's own test to add here.
 */
import { afterEach, expect, test } from "bun:test";
import { createScenario, requestText, say, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec, rulesOf, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const FIVE = [
  "片长约 2 分钟",
  "台词按剧本原文，不改写",
  "仓门朝左开",
  "每次过门都要有过渡镜头",
  "机械臂必须是左手",
];

test.failing("a filing that answers with one rule leaves the other five in place, for every turn on the plan", async () => {
  const h = await createScenario();
  open.push(h);
  const { director, reviewer, room } = videoTeam(h);
  const goal = "EP01 动画成片：BEACON ZERO 第一集";
  const ep01 = openPlan(h, room, "EP01", planSpec(goal));
  h.store.setPlanSpecByUser(ep01.id, planSpec(goal, { rules: FIVE }));
  // The reviewer's open ticket is what makes EP01 a job it has going when you speak in its direct.
  h.store.createTicket({ taskId: ep01.id, title: "EP01 逐镜审片", status: "todo", worker: reviewer.id });

  // 04:21, in 审片员's direct.
  const dm = h.direct(reviewer);
  h.judge("organizer", { session: dm }).reply({
    decision: "join",
    join_plan_id: ep01.id,
    plan: planSpec(goal, { rules: ["C09 脚不能穿地"] }),
    tickets: [],
    message_ticket: null,
  });
  h.script(reviewer, dm).reply(say("收到，C09 脚穿地记下了"));
  h.postUser(dm, "C09 的脚不能穿地");
  await h.waitIdle();

  expect(rulesOf(h, ep01.id)).toEqual(expect.arrayContaining(FIVE));

  // 07:20: the direct is cleared.
  h.store.clearSessionMessages(dm);
  expect(rulesOf(h, ep01.id)).toEqual(expect.arrayContaining(FIVE));

  // The director's next turn on EP01 reads all of them.
  h.script(director, room).reply(say("C09 我来重做"));
  h.postUser(room, "@视频导演 C09 重做一下");
  await h.waitIdle();
  const [hop] = h.hops(director);
  const read = requestText(hop!.request);
  for (const rule of FIVE) expect(read).toContain(rule);
});
