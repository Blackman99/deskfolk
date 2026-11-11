/**
 * A Bot whose agent ran out of usage (2026-11-10, 视频导演's direct): its Claude Code hit the plan's
 * limit mid-job, and over the next 20 minutes the supervisor called it back to each open ticket of
 * the job, twice, every call failing at once the same way. The conversation got ten
 * 「这一轮没写完：Claude 的用量额度用完了（…重置）」 in a row. Out of usage is not retried for you
 * (ADR 0061), so the call-backs leave the Bot alone until a turn of it ends some other way; and a
 * failure that says again what the conversation's last line already says is kept off it.
 */
import { afterEach, expect, test } from "bun:test";
import { completionFailBody } from "../prompts";
import { call, createScenario, failed, tool, type HopContext, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const OUT = completionFailBody("zh", "agent_limit");
const MIN = 60_000;

/** The labels of your lines a hop read (`U12`). */
function yourLabels(request: HopContext["request"]): string[] {
  const text = request.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
  return [...new Set(text.match(/\bU\d+\b/g) ?? [])];
}

function answerAll({ request }: HopContext) {
  return call(tool("end_turn", { reason: "answered", inbox: yourLabels(request).map((id) => ({ id, disposition: "answered" })) }));
}

function failureLines(h: Scenario, sessionId: string): Array<{ bot_only: number }> {
  return h.store.db.query<{ bot_only: number }, [string, string]>("SELECT bot_only FROM messages WHERE session_id = ? AND body = ? ORDER BY message_seq")
    .all(sessionId, OUT);
}

function orphanCallBacks(h: Scenario): number {
  return h.store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM check_backs WHERE kind = 'supervisor'
    AND json_extract(wait_spec, '$.reason') = 'orphan'`).get()!.n;
}

test("out of usage: no call-backs until a turn ends otherwise, and the same failure again stays out of the conversation", async () => {
  const h = await createScenario({ supervision: true });
  open.push(h);
  const [bot] = h.createBots("视频导演");
  const dm = h.direct(bot!);
  const plan = h.store.openTask({ sessionId: dm, title: "MV" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "第二场", worker: bot!.id });
  h.store.createTicket({ taskId: plan.id, title: "第三场", worker: bot!.id });
  const seed = h.store.insertMessage({ sessionId: dm, kind: "bot", author: bot!.id, body: "第二场的镜头表写好了" });
  h.store.db.run("UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?", [plan.id, ticket.id, seed.id]);
  h.script(bot!).reply(failed("agent_limit"), failed("agent_limit"), failed("agent_limit"));
  h.script(bot!).handle(answerAll);

  h.postUser(dm, "接着出第二场", { parentId: seed.id });
  await h.waitIdle();
  expect(h.turns(bot!)).toHaveLength(1);
  expect(failureLines(h, dm)).toEqual([{ bot_only: 0 }]);

  // Both tickets go quiet, past every quiet window: nobody is called back to fail the same way.
  h.tick(new Date(Date.now() + 15 * MIN));
  await h.waitIdle();
  h.tick(new Date(Date.now() + 30 * MIN));
  await h.waitIdle();
  expect(orphanCallBacks(h)).toBe(0);
  expect(h.turns(bot!)).toHaveLength(1);

  // Something else wakes it (a render's result, a check-back): it fails the same way, and that is
  // kept as the turn's record, out of the conversation, with no second notification.
  h.store.queueWork({ botId: bot!.id, sessionId: dm, taskId: plan.id, ticketId: ticket.id, messageId: null, author: "app",
    body: "（应用）作业完成了", source: "system", kind: "wake", priority: 3, notice: false });
  h.engine.dispatchQueuedWork();
  await h.waitIdle();
  expect(h.turns(bot!)).toHaveLength(2);
  expect(failureLines(h, dm)).toEqual([{ bot_only: 0 }, { bot_only: 1 }]);
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'failure' AND session_id = ?").get(dm)).toEqual({ n: 1 });

  // Continue on the line you can see, failing the same way again: that line's Continue is spent, so
  // this failure shows, with a Continue of its own; nothing is hidden behind a button you pressed.
  const shown = h.store.db.query<{ id: string }, [string, string]>("SELECT id FROM messages WHERE session_id = ? AND body = ? AND bot_only = 0")
    .get(dm, OUT)!;
  h.engine.continueFromInterrupt(shown.id, { byYou: true });
  await h.waitIdle();
  expect(h.turns(bot!)).toHaveLength(3);
  expect(failureLines(h, dm)).toEqual([{ bot_only: 0 }, { bot_only: 1 }, { bot_only: 0 }]);
  expect(h.store.db.query("SELECT source_turn_id FROM messages WHERE session_id = ? AND body = ? AND bot_only = 0 ORDER BY message_seq DESC LIMIT 1")
    .get(dm, OUT)).toEqual({ source_turn_id: null });

  // Your word gets it going, and once a turn of it ends otherwise the call-backs reach it again.
  h.postUser(dm, "额度恢复了，继续");
  await h.waitIdle();
  expect(h.turns(bot!).at(-1)!.status).toBe("completed");
  h.tick(new Date(Date.now() + 45 * MIN));
  await h.waitIdle();
  expect(orphanCallBacks(h)).toBeGreaterThan(0);
});
