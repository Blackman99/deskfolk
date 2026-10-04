/**
 * The supervisor in the engine (ADR 0045): its tick from the scheduler's, picking up work from the
 * line its own Continue goes from, and the legacy call-backs it retires at its level.
 */
import { afterEach, expect, test } from "bun:test";
import { completionFailBody } from "./prompts";
import { ENGINE_LEVELS } from "./store/schema-gate";
import { call, createScenario, failed, tool, writeFile, type Scenario } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function scenario(options: Parameters<typeof createScenario>[0]) {
  const h = await createScenario(options);
  open.push(h);
  return h;
}

/** A plan in your direct with one Bot, and one ticket of it the Bot is on, created `agoMs` ago. */
function job(h: Scenario, agoMs = 0) {
  const [bot] = h.createBots("Writer");
  const room = h.direct(bot!);
  const plan = h.store.openTask({ sessionId: room, title: "Report" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "Draft", worker: bot!.id });
  const then = new Date(Date.now() - agoMs).toISOString();
  h.store.db.run("UPDATE tasks SET created_at = ? WHERE id = ?", [then, plan.id]);
  h.store.db.run("UPDATE tickets SET created_at = ?, updated_at = ? WHERE id = ?", [then, then, ticket.id]);
  return { bot: bot!, room, plan, ticket };
}

test("the scheduler's tick calls a ticket nobody is moving back to its owner, once, with the facts", async () => {
  const h = await scenario({ supervision: true });
  const { bot, plan, ticket } = job(h, 130_000);
  let heard = "";
  h.script(bot).reply(({ request }) => {
    heard = request.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    return call(tool("end_turn", { reason: "nothing_new" }));
  });
  h.tick();
  await h.waitIdle();
  expect(h.turns(bot)).toHaveLength(1);
  expect(h.turns(bot)[0]).toMatchObject({ task_id: plan.id, ticket_id: ticket.id });
  expect(heard).toContain("任务 01《Draft》还没收口");
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM check_backs WHERE kind = 'supervisor'").get()).toEqual({ n: 1 });
  // Nothing else calls it back: no plan nudge, no second wake inside the same quiet.
  h.tick();
  await h.waitIdle();
  expect(h.turns(bot)).toHaveLength(1);
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM check_backs WHERE kind = 'plan_nudge'").get()).toEqual({ n: 0 });
});

test("a segment that failed needs attention, and the next tick goes on from its failure line as its Continue would", async () => {
  const h = await scenario({ supervision: true });
  const { bot, room, plan, ticket } = job(h);
  const line = h.store.postMessage(room, { body: "Write the draft" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id, ticketId: ticket.id }] });
  h.script(bot).reply(failed("endpoint_error"), call(tool("end_turn", { reason: "nothing_new" })));
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();
  const [first] = h.turns(bot);
  const failure = h.messages(room).find((message) => message.turn_id === first!.id && message.body === completionFailBody("zh", "endpoint_error"))!;
  expect(failure).toBeDefined();
  expect(h.store.db.query("SELECT state FROM work_items WHERE id = ?").get(first!.work_item_id!)).toEqual({ state: "needs_attention" });
  // Retried without you, so the failure asks nothing of you: no notification.
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'failure'").get()).toEqual({ n: 0 });
  h.tick();
  await h.waitIdle();
  const turns = h.turns(bot);
  expect(turns).toHaveLength(2);
  expect(turns[1]).toMatchObject({ trigger_message_id: failure.id, task_id: plan.id, ticket_id: ticket.id });
  expect(h.store.getMessage(failure.id).source_turn_id).toBe(turns[1]!.id);
});

test("a failed reply on no job, which nothing retries, still tells you", async () => {
  const h = await scenario({ supervision: true });
  const [bot] = h.createBots("Writer");
  const room = h.direct(bot!);
  h.script(bot!).reply(failed("endpoint_error"));
  h.postUser(room, "你好");
  await h.waitIdle();
  const [turn] = h.turns(bot!);
  expect(h.store.db.query("SELECT kind, action_state FROM notifications WHERE semantic_key = ?").get(`failure:${turn!.id}`))
    .toEqual({ kind: "failure", action_state: "open" });
});

test("a ticket that went quiet before the supervisor's level was raised is left alone until something happens in it", async () => {
  const h = await scenario({ supervision: true });
  const { bot, room, plan, ticket } = job(h, 130_000);
  // Raised after the job went quiet, as when a database with old open plans is upgraded.
  h.store.db.run("INSERT INTO work_events (at, kind, actor, payload) VALUES (?, 'engine.level_raised', 'app', ?)",
    [new Date(Date.now() - 60_000).toISOString(), JSON.stringify({ from: ENGINE_LEVELS.delegation, to: ENGINE_LEVELS.supervision })]);
  h.script(bot).reply(call(tool("end_turn", { reason: "nothing_new" })));
  h.tick(new Date(Date.now() + 60 * 60_000));
  await h.waitIdle();
  expect(h.turns(bot)).toEqual([]);
  // You touch it on the board: from then on it is watched like any other.
  h.store.patchTicketByUser(ticket.id, { status: "doing" });
  h.tick(new Date(Date.now() + 3 * 60_000));
  await h.waitIdle();
  expect(h.turns(bot).map((turn) => [turn.task_id, turn.ticket_id])).toEqual([[plan.id, ticket.id]]);
  expect(room).toBeString();
});

test("what a segment writes into its ticket's folder is progress by content hash, recorded when it ends", async () => {
  const h = await scenario({ supervision: true });
  const { bot, room, plan, ticket } = job(h);
  const line = h.store.postMessage(room, { body: "Write the draft" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id, ticketId: ticket.id }] });
  h.script(bot).reply(call(writeFile(`${ticket.dir}/draft.md`, "first")), call(writeFile(`${ticket.dir}/draft.md`, "first")),
    call(tool("end_turn", { reason: "nothing_new" })));
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();
  const changed = h.store.listWorkEvents({ kind: "artifact.changed" });
  expect(changed.map((event) => [event.ticket_id, event.payload.path])).toEqual([[ticket.id, `${ticket.dir}/draft.md`]]);
  expect(String(changed[0]!.payload.sha256)).toMatch(/^[0-9a-f]{64}$/);
  expect(h.store.executionRecoveryFacts({ turnId: h.turns(bot)[0]!.id }).executions.map((row) => [row.tool, row.outcome]))
    .toEqual([["write_file", "succeeded"], ["write_file", "succeeded"]]);
});

test("the app's own call-backs of the levels before stay below the supervisor's level and are voided at it", async () => {
  for (const level of ["delegation", "supervision"] as const) {
    const h = await scenario({ [level]: true });
    const { bot, room, plan, ticket } = job(h);
    const nudge = h.store.bookPlanNudge({ botId: bot.id, sessionId: room, taskId: plan.id, ticketId: ticket.id, note: "规划静下来了" });
    h.script(bot).reply(call(tool("end_turn", { reason: "nothing_new" })));
    h.tick(new Date(Date.now() + 5_000));
    await h.waitIdle();
    const row = h.store.getCheckBack(nudge.id);
    if (level === "delegation") {
      expect(row.fired_at).not.toBeNull();
      expect(h.turns(bot)).toHaveLength(1);
    } else {
      expect(row).toMatchObject({ fired_at: null, fired_turn_id: null });
      expect(row.voided_at).not.toBeNull();
      expect(h.turns(bot)).toHaveLength(0);
    }
  }
});

test("a blocked job's question card is a supervisor-level feature; below it the Bot's need is a plain line", async () => {
  const h = await scenario({ delegation: true });
  const { bot, room, plan, ticket } = job(h);
  const line = h.store.postMessage(room, { body: "Write the draft" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id, ticketId: ticket.id }] });
  h.script(bot).reply(call(tool("end_turn", { reason: "blocked", needs_from_user: "Which audience?" })));
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();
  const need = h.messages(room).find((message) => message.body === "Which audience?")!;
  expect(need.kind).toBe("system");
  expect(need.control).toBeUndefined();
  expect(h.store.db.query("SELECT waiting_on FROM work_items WHERE id = ?").get(h.turns(bot)[0]!.work_item_id!)).toEqual({ waiting_on: null });
});
