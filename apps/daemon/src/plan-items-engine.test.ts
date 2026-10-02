import { afterEach, expect, test } from "bun:test";
import { call, createScenario, say, tool, type Scenario } from "./test-kit/scenario";
import { openPlan, planSpec, videoTeam } from "./scenarios/video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** ADR 0053: the lead lays out the plan's tickets with plan_items; another Bot is told to ask the lead. */
test("the lead's plan_items puts tickets on the board; another Bot's call is refused", async () => {
  const h = await createScenario({ submissions: true });
  open.push(h);
  const { director, reviewer, room } = videoTeam(h);
  const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
  h.store.db.run("UPDATE tasks SET lead_bot_id = ? WHERE id = ?", [director.id, ep01.id]);
  h.script(director, room).reply(
    call(tool("plan_items", { items: [{ title: "分镜", owner: director.name }, { title: "动画", owner: director.name, reviewer: reviewer.name, depends_on: ["分镜"], parts: ["Shot 01", "Shot 02"] }] })),
    say("拆好了"),
  );
  h.postUser(room, "@视频导演 把 EP01 拆一下");
  await h.waitIdle();
  const [planned] = h.toolCalls(director, "plan_items");
  expect(planned?.result?.ok).toBe(true);
  const tickets = h.store.db.query<{ title: string; reviewer_bot_id: string | null }, [string]>("SELECT title, reviewer_bot_id FROM tickets WHERE task_id = ? ORDER BY seq").all(ep01.id);
  expect(tickets).toEqual([{ title: "分镜", reviewer_bot_id: null }, { title: "动画", reviewer_bot_id: reviewer.id }]);

  h.script(reviewer, room).reply(call(tool("plan_items", { items: [{ title: "字幕", owner: reviewer.name }] })), say("那我去找负责人"));
  h.postUser(room, "@审片员 你也拆一张字幕任务");
  await h.waitIdle();
  const [refused] = h.toolCalls(reviewer, "plan_items");
  expect(refused?.result).toMatchObject({ ok: false, error: "forbidden" });
});
