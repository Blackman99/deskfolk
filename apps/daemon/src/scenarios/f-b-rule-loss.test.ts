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
 * Target, from ADR 0040 P3 (your words, the requirement ledger): rules only grow. The organizer no
 * longer writes them: its answer files the line and leaves the plan's rules as they were, so every
 * turn on EP01 still reads all five. The C09 line reaches the requirements ledger through the
 * scribe instead, as a sixth entry beside the five. A scribe answer claiming the C09 line replaces
 * the arm and the running time — the adversarial answer — replaces neither: the arm is of another
 * category, so that change is dropped and logged; the running time is claimed to be of the same
 * one, so the change is only proposed, and the entry stays open, since the line gives no new
 * running time. Clearing the direct the line was said in (as happened at 07:20) takes nothing from
 * any of it.
 *
 * The five are set on the board here, where the real ones came from your lines over two days. The
 * board does not write the ledger yet, so each is entered there by hand, on the quote the board
 * kept of it.
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
const CATEGORIES = ["时长", "台词", "场景", "转场", "角色设定"];

test("a filing that answers with one rule leaves the other five in place, for every turn on the plan", async () => {
  const h = await createScenario();
  open.push(h);
  const { director, reviewer, room } = videoTeam(h);
  const goal = "EP01 动画成片：BEACON ZERO 第一集";
  const ep01 = openPlan(h, room, "EP01", planSpec(goal));
  h.store.setPlanSpecByUser(ep01.id, planSpec(goal, { rules: FIVE }));
  const [duration, , , , arm] = FIVE.map((rule, i) =>
    h.store.addRequirement({
      scope: "plan",
      scopeId: ep01.id,
      quote: rule,
      category: CATEGORIES[i],
      sourceKind: "board",
      sourceQuoteId: h.store.listQuotes({ taskId: ep01.id }).find((quote) => quote.body === rule)!.id,
      addedBy: "user",
    }),
  );
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
  h.judge("scribe", { session: dm }).reply({
    adds: [{ quote: "C09 的脚不能穿地", restated: "C09 的脚不能穿进地面", category: "穿模", scope_hint: "plan" }],
    raises: [],
    supersedes: [
      { requirement_id: arm!.id, quote: "C09 的脚不能穿地", restated: "只剩一条：C09 脚不穿地", category: "穿模" },
      { requirement_id: duration!.id, quote: "C09 的脚不能穿地", restated: "只剩一条：C09 脚不穿地", category: "时长" },
    ],
  });
  h.script(reviewer, dm).reply(say("收到，C09 脚穿地记下了"));
  h.postUser(dm, "C09 的脚不能穿地");
  await h.waitIdle();

  const openEntries = () => h.store.listRequirements({ status: "open" }).map((entry) => entry.quote);
  expect(rulesOf(h, ep01.id)).toEqual(expect.arrayContaining(FIVE));
  expect(openEntries()).toEqual([...FIVE, "C09 的脚不能穿地"]);
  expect(h.store.listRequirements({ status: "proposed" })).toMatchObject([{ supersedes: duration!.id, category: "时长" }]);
  expect(h.store.listWorkEvents({ kind: "scribe.rejected" })).toMatchObject([{ payload: { requirement: arm!.id, reason: "other_category" } }]);

  // 07:20: the direct is cleared.
  h.store.clearSessionMessages(dm);
  expect(rulesOf(h, ep01.id)).toEqual(expect.arrayContaining(FIVE));
  expect(openEntries()).toEqual([...FIVE, "C09 的脚不能穿地"]);

  // The director's next turn on EP01 reads all of them.
  h.script(director, room).reply(say("C09 我来重做"));
  h.postUser(room, "@视频导演 C09 重做一下");
  await h.waitIdle();
  const [hop] = h.hops(director);
  const read = requestText(hop!.request);
  for (const rule of FIVE) expect(read).toContain(rule);
});
