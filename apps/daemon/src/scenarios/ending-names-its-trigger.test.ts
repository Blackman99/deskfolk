/**
 * 2026-10-03 01:13–01:17, in your direct with 通识: the segment fixing the brief had no mail at all,
 * but ended with a disposition for the line that woke it, which is no mail. The end contract sent
 * the ending back twice for that id ("invalid_inbox_disposition"), the segment ended needing
 * attention, and the supervisor picked it up again: one more turn for nothing (9 such bounces on 4
 * work items between 10-01 and 10-03).
 *
 * A word about mail the segment never had records nothing and asks for nothing.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, tool, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

test("an ending that gives a disposition for the line that woke it ends the first time", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "通识", duties: "通用助手" });
  const dm = h.direct(bot!);
  const job = openPlan(h, dm, "每日AI重点新闻简报", planSpec("每日AI重点新闻简报"));
  h.store.createTicket({ taskId: job.id, title: "2026-10-03", status: "doing", worker: bot!.id });
  h.script(bot!, dm).reply(
    ({ turn }) => call(tool("end_turn", { reason: "nothing_new", inbox: [{ id: turn!.trigger_message_id, disposition: "adopted", note: "已放大并对齐" }] })),
  );
  h.postUser(dm, "标题跟 LOGO 没有对齐，而且太小");
  await h.waitIdle();

  const [turn, ...more] = h.turns(bot!);
  expect(more).toEqual([]);
  expect(turn).toMatchObject({ status: "completed", end_reason: "nothing_new" });
  expect(h.store.listWorkEvents({ kind: "end.rejected" })).toEqual([]);
  expect(h.hops(bot!)).toHaveLength(1);
});
