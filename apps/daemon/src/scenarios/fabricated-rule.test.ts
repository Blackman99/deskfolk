/**
 * ADR 0040 fixture: a rule you never said, written into 《回响纪元》 as yours.
 *
 * You opened the short film with two rules: the story is set in a future world, and it runs over
 * two minutes. On 2026-09-29 at 10:53 you told 视频导演 「你私聊里的没停」; the organizer filed the
 * line under the film and rewrote its rules to one of its own — carry on and finish the film — and
 * the two of yours were gone. At 10:56 审片员, relaying you the wrong way round in its direct with
 * 视频导演, told it 「按用户要求接着做 Shot 12」, and at 11:09 视频导演 repeated the made-up rule
 * word for word.
 *
 * Target, from ADR 0040 P3 (your words, the requirement ledger): a rule is a line of yours. Nothing
 * a model writes becomes one, and a filing never drops one of yours; the plan keeps both, and gains
 * nothing you did not say. The organizer's rules are no longer taken at all, message or settle, and
 * what you ask goes to the ledger only through the scribe, which reads your lines, never a Bot's,
 * and keeps only words it can find in them.
 *
 * Here the made-up rule comes from the settle after 审片员's relay rather than from the filing of
 * your line: from P2 on, a line like 「你私聊里的没停」 is taken as control and never reaches a
 * filing, or the scribe (the second test). So your 10:53 line is stored under the plan as the
 * organizer filed it then, not posted, only for the settle to know you spoke. The two rules are set
 * on the board, which writes them into the ledger as yours.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, endTurn, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec, rulesOf, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const YOURS = ["题材必须是未来世界", "时长超过 2 分钟"];

test("a settle that answers with a rule of its own neither adds it nor drops yours", async () => {
  const h = await createScenario();
  open.push(h);
  const { director, reviewer, room } = videoTeam(h);
  const goal = "未来世界短片《回响纪元》";
  const echo = openPlan(h, room, "回响纪元", planSpec(goal));
  h.store.setPlanSpecByUser(echo.id, planSpec(goal, { rules: YOURS }));
  // 10:53, in 视频导演's direct, filed under the short film.
  const said = h.store.transaction(() => h.store.postMessage(h.direct(director), { body: "你私聊里的没停" }));
  h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [echo.id, said.id]);

  // 10:56, in their Bot↔Bot direct; the turn it opens ends, and the plan settles.
  const thread = h.botDirect(reviewer, director);
  h.script(director, thread).reply(call(endTurn()));
  h.judge("organizer", { session: room }).reply({
    decision: "continue",
    plan: planSpec(goal, { rules: ["用户要求这条短片接着做完，只补 Shot 12"] }),
    tickets: [],
  });
  h.postBot(reviewer, thread, "按用户要求接着做 Shot 12，做完这一条就收", { taskId: echo.id });
  await h.waitIdle();

  expect(rulesOf(h, echo.id)).toEqual(expect.arrayContaining(YOURS));
  expect(rulesOf(h, echo.id).filter((rule) => rule.includes("接着做"))).toEqual([]);
  // A Bot's relay is nobody's requirement: the scribe never reads it. The ledger holds your two,
  // written in as you typed them on the board, and nothing else.
  expect(h.judgeCalls("scribe")).toEqual([]);
  expect(h.store.listRequirements().map((entry) => [entry.quote, entry.source_kind, entry.status])).toEqual(YOURS.map((rule) => [rule, "board", "open"]));
});

test("under holds your 「你私聊里的没停」 is answered by the app and reaches neither the organizer nor the scribe", async () => {
  const h = await createScenario({ holds: true });
  open.push(h);
  const { director, room } = videoTeam(h);
  const goal = "未来世界短片《回响纪元》";
  const echo = openPlan(h, room, "回响纪元", planSpec(goal));
  h.store.setPlanSpecByUser(echo.id, planSpec(goal, { rules: YOURS }));

  h.postUser(h.direct(director), "你私聊里的没停");
  await h.waitIdle();

  expect(h.judgeCalls("organizer")).toEqual([]);
  expect(h.judgeCalls("scribe")).toEqual([]);
  expect(h.store.listRequirements().map((entry) => entry.quote)).toEqual(YOURS);
  expect(rulesOf(h, echo.id)).toEqual(YOURS);
});
