/**
 * A settings change opens no job (2026-10-08, live at engine level 8). In your direct with 工作区文件助手
 * you asked 「你能根据已经配置的模型补一下它们的上下文大小配置吗」. Its update_endpoint was the desk's
 * first effect, so it opened a job of the line's name with a ticket to produce. The change was made and
 * the Bot said so, but nothing can be handed over on a ticket whose work is a setting: the ending was
 * sent back (unfinished_obligations) and closed as nothing_new, the ticket still 待做; ten minutes later
 * the plan watch called the Bot back (「还没收口……接着做」, a line only the Bot sees) and it posted the
 * same answer again; that second ending with no progress put up 「……连续两次结束都没有进展……先停下等你」.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, say, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const REQUEST = "你能根据已经配置的模型补一下它们的上下文大小配置吗";

async function direct() {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "工作区文件助手", duties: "管理工作区的文件" });
  const session = h.direct(bot!);
  h.judge("read_user_line").handle(() => ({ control: "none", control_only: false, status_only: false, objections: [] }));
  return { h, bot: bot!, session, providerId: h.store.defaultProviderId()! };
}

const window = (h: Scenario, providerId: string) =>
  h.store.catalogEntries().find((row) => row.providerId === providerId && row.name === "scenario")?.context_window;
const events = (h: Scenario, kind: string) => h.store.listWorkEvents({}).filter((event) => event.kind === kind);

test("a model's window set from your direct opens no job, and the reply ends the segment once", async () => {
  const { h, bot, session, providerId } = await direct();
  h.script(bot, session).reply(
    call(tool("update_endpoint", { id: providerId, models: [{ name: "scenario", context_window: 1_000_000 }] })),
    say("scenario 原来没有上下文大小，已补上 1,000,000。"),
  );
  const line = h.postUser(session, REQUEST);
  await h.waitIdle();

  expect(window(h, providerId)).toBe(1_000_000);
  expect(h.toolCalls(bot, "update_endpoint").map((row) => row.result?.ok)).toEqual([true]);
  expect(events(h, "plan.opened")).toEqual([]);
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  expect(h.store.getMessage(line.id).ticket_id).toBeNull();
  expect(events(h, "end.rejected")).toEqual([]);
  const replies = h.store.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE session_id = ? AND kind = 'bot'").all(session);
  expect(replies.map((row) => row.body)).toEqual(["scenario 原来没有上下文大小，已补上 1,000,000。"]);

  // Nothing is left open for the plan watch to call the Bot back to, however long it stays quiet.
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  expect(h.store.supervisorTick({ now: later }).wakes).toEqual([]);
  expect(h.unscripted()).toEqual([]);
});

test("an endpoint added from your direct waits on its card, then lands, with no job", async () => {
  const { h, bot, session } = await direct();
  h.script(bot, session).reply(
    call(tool("add_endpoint", { name: "小米", base_url: "https://mimo.example.com/v1", models: [{ name: "mimo", context_window: 1_000_000 }] })),
    say("小米端点加好了。"),
  );
  h.postUser(session, "加一个小米的端点");
  await h.waitFor(() => Boolean(h.store.db.query("SELECT 1 FROM approvals WHERE status = 'pending'").get()), { what: "the endpoint's card" });
  const card = h.store.db.query<{ id: string }, []>("SELECT id FROM approvals WHERE status = 'pending'").get()!;
  h.engine.resolveApproval(card.id, "allow_once", undefined, "sk-mimo");
  await h.waitIdle();

  expect(h.toolCalls(bot, "add_endpoint").map((row) => row.result?.ok)).toEqual([true]);
  expect(h.store.catalogEntries().find((row) => row.name === "mimo")?.context_window).toBe(1_000_000);
  expect(events(h, "plan.opened")).toEqual([]);
  expect(events(h, "end.rejected")).toEqual([]);
});

test("work in the workspace after a settings change still opens the job at its own first effect", async () => {
  const { h, bot, session, providerId } = await direct();
  h.script(bot, session).reply(
    call(tool("update_endpoint", { id: providerId, models: [{ name: "scenario", context_window: 200_000 }] })),
    call(writeFile("models.md", "scenario: 200000")),
    say("改好了，也记在 models.md 里。"),
  );
  const line = h.postUser(session, "把窗口改成 20 万，再写一份清单");
  await h.waitIdle();

  expect(h.toolCalls(bot, "write_file").map((row) => row.result?.ok)).toEqual([true]);
  expect(events(h, "plan.opened")).toHaveLength(1);
  expect(h.store.getMessage(line.id).task_id).not.toBeNull();
});

test("a stopped Bot's settings change is refused at its desk as any effect is", async () => {
  const { h, bot, session, providerId } = await direct();
  // The stop lands between the Bot's reading and its call, and is lifted before it replies.
  let stop = "";
  h.script(bot, session).handle(({ hop }) => {
    if (hop > 1) {
      h.store.liftHold(stop, { by: "user_button" });
      return say("停着，没改。");
    }
    stop = h.store.createHold({ scope: "bot", scopeId: bot.id, source: "user_button" }).id;
    return call(tool("update_endpoint", { id: providerId, models: [{ name: "scenario", context_window: 64_000 }] }));
  });
  h.postUser(session, "把窗口改成 64000");
  await h.waitIdle();

  expect(h.toolCalls(bot, "update_endpoint").map((row) => row.result?.error)).toEqual(["held"]);
  expect(window(h, providerId)).not.toBe(64_000);
  expect(events(h, "plan.opened")).toEqual([]);
});
