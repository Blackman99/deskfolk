/**
 * A line read as done in place opens no job (2026-10-08, live at engine level 8). In your direct with
 * 工作区文件助手 you asked 「你能根据已经配置的模型补一下它们的上下文大小配置吗」. Its update_endpoint was
 * the desk's first effect, so it opened a job of the line's name with a ticket to produce. The change
 * was made and the Bot said so, but nothing can be handed over on a ticket whose work is a setting:
 * the ending was sent back (unfinished_obligations) and closed as nothing_new, the ticket still 待做;
 * ten minutes later the plan watch called the Bot back (「还没收口……接着做」, a line only the Bot sees)
 * and it posted the same answer again; that second ending with no progress put up
 * 「……连续两次结束都没有进展……先停下等你」.
 *
 * Whether a line needs a job is read by the model that reads where it belongs (ADR 0057): new work
 * opens one at its first effect, something done in place — a question, a look-up, a setting, a
 * small action — none, whatever tools it takes. No tool name decides it.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, READ_AS_NEW, say, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const REQUEST = "你能根据已经配置的模型补一下它们的上下文大小配置吗";
const IN_PLACE = { about: "in_place" };

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
const setWindow = (providerId: string, size: number) => call(tool("update_endpoint", { id: providerId, models: [{ name: "scenario", context_window: size }] }));

test("a line read as done in place sets the window with no job, and the reply ends the segment once", async () => {
  const { h, bot, session, providerId } = await direct();
  // With no job open the line is still read, with nothing to choose from: new work or done in place.
  const shown: unknown[] = [];
  h.judge("read_filing").handle(({ payload }) => {
    shown.push((payload as { jobs?: unknown[] }).jobs);
    return IN_PLACE;
  });
  h.script(bot, session).reply(setWindow(providerId, 1_000_000), say("scenario 原来没有上下文大小，已补上 1,000,000。"));
  const line = h.postUser(session, REQUEST);
  await h.waitIdle();

  expect(shown).toEqual([[]]);
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

test("a look-up command before the change opens no job either: the reading decides, not the tool", async () => {
  const { h, bot, session, providerId } = await direct();
  h.judge("read_filing").reply(IN_PLACE);
  h.script(bot, session).reply(
    call(tool("shell", { command: "echo 'MiMo context: 1M'" })),
    setWindow(providerId, 1_000_000),
    say("查到是 1M，已补上。"),
  );
  h.postUser(session, REQUEST);
  await h.waitIdle();

  expect(h.toolCalls(bot, "shell").map((row) => row.result?.ok)).toEqual([true]);
  expect(window(h, providerId)).toBe(1_000_000);
  expect(events(h, "plan.opened")).toEqual([]);
  expect(events(h, "end.rejected")).toEqual([]);
  expect(h.turns(bot).map((turn) => [turn.mode, turn.status])).toEqual([["desk", "completed"]]);
});

test("beside open jobs, a line read as done in place is not held up for a choice", async () => {
  const { h, bot, session, providerId } = await direct();
  for (const title of ["海报", "周报"]) h.store.openTask({ sessionId: session, title });
  h.judge("read_filing").reply(IN_PLACE);
  h.script(bot, session).reply(setWindow(providerId, 200_000), say("改好了。"));
  h.postUser(session, "把模型窗口改成 20 万");
  await h.waitIdle();

  expect(h.toolCalls(bot, "update_endpoint").map((row) => row.result?.ok)).toEqual([true]);
  expect(events(h, "plan.opened")).toEqual([]);
});

test("a line read as new work opens its job at the first effect, a setting included", async () => {
  const { h, bot, session, providerId } = await direct();
  h.judge("read_filing").reply(READ_AS_NEW);
  h.script(bot, session).reply(setWindow(providerId, 200_000), call(writeFile("models.md", "scenario: 200000")), say("改好了，清单在 models.md。"));
  const line = h.postUser(session, "把窗口改成 20 万，再写一份模型清单给我");
  await h.waitIdle();

  expect(events(h, "plan.opened")).toHaveLength(1);
  expect(h.store.getMessage(line.id).task_id).not.toBeNull();
});

test("a line no model read keeps the rule: the first effect opens a job", async () => {
  const { h, bot, session, providerId } = await direct();
  h.script(bot, session).reply(setWindow(providerId, 200_000), call(tool("end_turn", { reason: "nothing_new" })));
  h.postUser(session, REQUEST);
  await h.waitIdle();

  expect(h.judgeCalls("read_filing").map((row) => row.scripted)).toEqual([false]);
  expect(events(h, "plan.opened")).toHaveLength(1);
});

test("an endpoint added in place waits on its card, then lands, with no job", async () => {
  const { h, bot, session } = await direct();
  h.judge("read_filing").reply(IN_PLACE);
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

test("a stopped Bot's call on a line read as done in place is refused as any effect is", async () => {
  const { h, bot, session, providerId } = await direct();
  h.judge("read_filing").reply(IN_PLACE);
  // The stop lands between the Bot's reading and its call, and is lifted before it replies.
  let stop = "";
  h.script(bot, session).handle(({ hop }) => {
    if (hop > 1) {
      h.store.liftHold(stop, { by: "user_button" });
      return say("停着，没改。");
    }
    stop = h.store.createHold({ scope: "bot", scopeId: bot.id, source: "user_button" }).id;
    return setWindow(providerId, 64_000);
  });
  h.postUser(session, "把窗口改成 64000");
  await h.waitIdle();

  expect(h.toolCalls(bot, "update_endpoint").map((row) => row.result?.error)).toEqual(["held"]);
  expect(window(h, providerId)).not.toBe(64_000);
  expect(events(h, "plan.opened")).toEqual([]);
});
