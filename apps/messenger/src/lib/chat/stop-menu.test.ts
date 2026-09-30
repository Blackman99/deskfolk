import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aHold, aTurn } from "../test-fixtures.ts";
import { conversationStopItems, planStopItems } from "./stop-menu.ts";

const t = copyFor("zh").control;
const bots = new Map([aBot({ id: "bot-1", name: "视频导演" }), aBot({ id: "bot-2", name: "审片员" })].map((bot) => [bot.id, bot]));

function items(session = aDirect(), turns = [aTurn({ session_id: "botbot-1", task_id: "task-1" })], holds = [aHold({ id: "x", scope: "turn", scope_id: "t" })]) {
  return conversationStopItems({ session, turns, bots, holds, t, deleted: "已删除" });
}

test("in a direct: its Bot wherever it works, the job its work is in, every Bot", () => {
  expect(items().map(({ label, choice }) => ({ label, choice }))).toEqual([
    { label: "停下视频导演的全部工作", choice: { scope: "bot", id: "bot-1" } },
    { label: "停下这件事", choice: { scope: "plan", id: "task-1" } },
    { label: "停下所有 Bot", choice: { scope: "global", id: null } },
  ]);
});

test("nothing to stop while its Bot is idle, and nothing in a Bot↔Bot direct", () => {
  expect(items(aDirect(), [aTurn({ status: "completed" })])).toEqual([]);
  expect(items(aDirect(), [aTurn({ bot_id: "bot-2" })])).toEqual([]);
  expect(items(aBotDirect(), [aTurn({ session_id: "botbot-1" })])).toEqual([]);
});

test("in a group: the group, then each Bot at work there", () => {
  const group = aGroup();
  const turns = [aTurn({ id: "a", session_id: group.id, bot_id: "bot-2" }), aTurn({ id: "b", session_id: group.id, bot_id: "bot-1", task_id: "task-3", last_activity_at: "2026-09-19T02:00:05.000Z" })];
  expect(items(group, turns).map((item) => item.label)).toEqual(["停下这个群里的工作", "停下视频导演的全部工作", "停下审片员的全部工作", "停下这件事", "停下所有 Bot"]);
});

test("what a stop in force already covers is left out; everything stopped leaves nothing", () => {
  expect(items(aDirect(), undefined, [aHold()]).map((item) => item.choice.scope)).toEqual(["plan", "global"]);
  expect(items(aDirect(), undefined, [aHold({ scope: "global", scope_id: null })])).toEqual([]);
});

test("the board: its job by name, and every Bot", () => {
  expect(planStopItems({ taskId: "task-1", title: "EP01", holds: [], t }).map((item) => item.label)).toEqual(["停下这件事《EP01》", "停下所有 Bot"]);
  expect(planStopItems({ taskId: "task-1", title: "EP01", holds: [aHold({ scope: "plan", scope_id: "task-1" })], t }).map((item) => item.choice.scope)).toEqual(["global"]);
});
