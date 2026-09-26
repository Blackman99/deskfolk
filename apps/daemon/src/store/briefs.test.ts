import { describe, expect, test } from "bun:test";
import { USER_MEMBER } from "@real-bot/protocol";
import { Store } from ".";
import { BRIEF_MAX } from "./tasks";

function fixture() {
  const store = new Store();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  return { store, bot: writer.bot, session: writer.direct_session };
}

describe("a job keeps what it was asked for", () => {
  test("the opening message is the brief, whole, while the title stays a folder name", () => {
    const { store, bot, session } = fixture();
    const body = "写一份季度报表。\n\n要求：\n- 按地区分组\n- 附上一张趋势图\n- 交到 reports/q3.md";
    const trigger = store.postMessage(session.id, { body });
    const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger.id });
    const task = store.getTask(turn.task_id!);
    expect(task.brief).toBe(body);
    expect(task.title.startsWith("写一份季度报表。 要求： - 按地区分组")).toBe(true);
    expect([...task.title].length).toBeLessThan([...body].length);
    store.close();
  });

  test("a follow-up joins the job without rewriting its brief", () => {
    const { store, bot, session } = fixture();
    const first = store.postMessage(session.id, { body: "导出季度报表" });
    const one = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: first.id });
    const second = store.postMessage(session.id, { body: "第三季度那张图再大一点" });
    const two = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: second.id });
    expect(two.task_id).toBe(one.task_id!);
    expect(store.getTask(two.task_id!).brief).toBe("导出季度报表");
    store.close();
  });

  test("a handoff inherits the brief of the job it came from, across sessions", () => {
    const { store, bot, session } = fixture();
    const other = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" }).bot;
    const trigger = store.postMessage(session.id, { body: "写周报，让 Reviewer 过一遍" });
    const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: trigger.id });
    const direct = store.createBotDirect(bot.id, other.id, { sessionId: session.id, messageId: trigger.id });
    const handoff = store.insertMessage({
      sessionId: direct.id,
      turnId: turn.id,
      kind: "bot",
      author: bot.id,
      body: "请看 report.md",
    });
    const theirs = store.createTurn({ sessionId: direct.id, botId: other.id, triggerMessageId: handoff.id });
    expect(theirs.task_id).toBe(turn.task_id!);
    expect(store.getTask(theirs.task_id!).brief).toBe("写周报，让 Reviewer 过一遍");
    store.close();
  });

  test("the brief is clipped to the budget, and a blank message still opens a job", () => {
    const { store, bot, session } = fixture();
    const long = store.postMessage(session.id, { body: "要".repeat(BRIEF_MAX + 20) });
    const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: long.id });
    expect([...store.getTask(turn.task_id!).brief!].length).toBe(BRIEF_MAX);
    store.close();
  });

  test("the first turn of a plan is the one with no earlier turn, and the session's current plan is findable", () => {
    const { store, bot, session } = fixture();
    expect(store.sessionCurrentTask(session.id)).toBeNull();
    const first = store.postMessage(session.id, { body: "导出季度报表" });
    const one = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: first.id });
    expect(store.taskHasEarlierTurns(one.task_id!, one.id)).toBe(false);
    expect(store.sessionCurrentTask(session.id)?.id).toBe(one.task_id!);
    const second = store.postMessage(session.id, { body: "再来一版" });
    const two = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: second.id });
    expect(store.taskHasEarlierTurns(two.task_id!, two.id)).toBe(true);
    // A judgement has no turn yet; asked with no turn to exclude, any turn counts as earlier.
    expect(store.taskHasEarlierTurns(two.task_id!, "")).toBe(true);
    // No clock closes a plan: however long it has been quiet, it is still the one to join. Only
    // another plan opening in the session takes its place, and parks it.
    store.db.run(`UPDATE turns SET last_activity_at = ? WHERE task_id = ?`, [new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(), one.task_id!]);
    expect(store.sessionCurrentTask(session.id)?.id).toBe(one.task_id!);
    const other = store.openTask({ sessionId: session.id, title: "别的事" });
    expect(store.sessionCurrentTask(session.id)?.id).toBe(other.id);
    expect(store.getTask(one.task_id!)).toMatchObject({ status: "parked" });
    expect(store.getTask(one.task_id!).closed_at).toBeString();
    void USER_MEMBER;
    store.close();
  });
});
