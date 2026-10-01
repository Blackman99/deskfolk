import { afterEach, expect, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { Store } from "./store";
import { runCollabTool } from "./collab-tools";
import { memoryKeyStore } from "./secrets";
import { call, createScenario, endTurn } from "./test-kit/scenario";
import { join } from "node:path";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });
async function start() {
  const store = new Store({ endpointKey: memoryKeyStore() });
  store.raiseEngineLevel(null);
  const api = createLocalApi({ store, token: "card-test", schedule: false });
  const events: ClientEvent[] = [];
  api.subscribeSync((frame) => { if (frame.type === "event") events.push(frame.payload); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  const origin = `http://${server.hostname}:${server.port}`;
  const request = (messageId: string, body: unknown, token = "card-test") => fetch(`${origin}/v1/messages/${messageId}/control`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const { bot, direct_session } = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const existing = store.openTask({ sessionId: direct_session.id, title: "EP01" });
  const line = store.postMessage(direct_session.id, { body: "另外写份报告" });
  const turn = store.createTurn({ sessionId: line.session_id, botId: bot.id, triggerMessageId: line.id });
  await runCollabTool({ store, botId: bot.id, sessionId: line.session_id, turnId: turn.id, parentId: null },
    "work_on", { plan: { new: { title: "Report", quote_message_id: line.id } } });
  const taskId = store.getTurn(turn.id).task_id!;
  const card = store.createNewPlanCard({ turnId: turn.id, taskId, quoteMessageId: line.id });
  return { store, api, request, events, origin, line, turn, card, taskId, existing };
}

test("Undo during a real running job aborts the runner, preserves its written artifact and prevents the next effect", async () => {
  const h = await createScenario({ workItems: true });
  const waiting = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  try {
    const [bot] = h.createBots("Writer");
    const session = h.direct(bot!);
    h.script(bot!).reply(call({ name: "shell", args: { command: "printf 'kept draft' > report.md" } }), async () => {
      reached.resolve(); await waiting.promise; return call({ name: "shell", args: { command: "printf 'must not happen' > after.md" } }, endTurn());
    });
    h.postUser(session, "Write a report");
    await reached.promise;
    const card = h.messages(session).find((message) => message.control?.kind === "plan_opened")!;
    const turn = h.turns(bot!)[0]!;
    expect(h.toolCalls(bot!, "shell")[0]?.result).toMatchObject({ ok: true });
    h.store.actNewPlanCard(card.id, { action: "undo_plan", userActionId: "running-user" }, (taskId) =>
      h.engine.createHold({ scope: "plan", scopeId: taskId, action: "cancel", liftOnNextUserMessage: false }));
    expect(h.store.getTurn(turn.id).status).toBe("stopped");
    waiting.resolve();
    await h.waitIdle();
    expect(h.toolCalls(bot!, "shell")).toHaveLength(1);
    expect(await Bun.file(join(h.root, h.store.getTicket(turn.ticket_id!).dir, "report.md")).text()).toBe("kept draft");
    expect(h.store.getMessage(card.id).control).toMatchObject({ acted: ["undo_plan"], retained_effects: ["shell"] });
  } finally { waiting.resolve(); await h.close(); }
});

test("authenticated new-plan Undo uses real engine stops before abandon and persists the card in client events", async () => {
  const h = await start();
  const before = h.api.syncCursor();
  expect((await h.request(h.card.id, { action: "undo_plan" }, "wrong")).status).toBe(401);
  const result = await h.request(h.card.id, { action: "undo_plan" });
  const resultBody = await result.json();
  expect({ status: result.status, body: resultBody }).toMatchObject({ status: 200 });
  expect(resultBody).toMatchObject({ made: [{ scope: "plan", scope_id: h.taskId, lifted_at: null }], lifted: [] });
  expect(h.store.getTurn(h.turn.id).status).toBe("stopped");
  expect(h.store.db.query("SELECT stage FROM tasks WHERE id = ?").get(h.taskId)).toEqual({ stage: "abandoned" });
  expect(h.store.getMessage(h.card.id).control).toMatchObject({ kind: "plan_opened", acted: ["undo_plan"], user_action_id: expect.any(String) });
  const lastEvent = h.events.filter((e) => e.event === "message.upsert" && e.id === h.card.id).at(-1);
  expect(lastEvent?.event === "message.upsert" ? lastEvent.control : undefined)
    .toMatchObject({ kind: "plan_opened", acted: ["undo_plan"] });
  const replay = await fetch(`${h.origin}/v1/events/catchup?event_instance_id=${before.event_instance_id}&after_seq=${before.watermark_seq}`,
    { headers: { Authorization: "Bearer card-test" } });
  const catchup = await replay.json() as { events: Array<{ payload: ClientEvent }> };
  const replayEvent = catchup.events.map((e) => e.payload).filter((e) => e.event === "message.upsert" && e.id === h.card.id).at(-1);
  expect(replayEvent?.event === "message.upsert" ? replayEvent.control : undefined)
    .toMatchObject({ kind: "plan_opened", acted: ["undo_plan"] });
  expect((await h.request(h.card.id, { action: "undo_plan" })).status).toBe(200);
  expect(h.store.listHolds()).toHaveLength(1);
});

test("Merge accepts only a confirmed card target, migrates source requirements and preserves execution ownership", async () => {
  const h = await start();
  const quote = h.store.listQuotes({ messageId: h.line.id })[0]!;
  h.store.transaction(() => h.store.db.run(`INSERT INTO requirements (id, scope, scope_id, quote, source_kind, source_quote_id, status,
    last_raised_at, added_by, created_at, updated_at, origin_task_id)
    VALUES ('req', 'plan', ?, '报告完整', 'message', ?, 'open', '2026-01-01', 'capture', '2026-01-01', '2026-01-01', ?)`,
    [h.taskId, quote.id, h.taskId]));
  const targetHold = h.store.createHold({ scope: "plan", scopeId: h.existing.id, source: "user_button" });
  for (const body of [null, [], {}, { action: "undo" }, { action: "merge_plan" }, { action: "merge_plan", task_id: h.taskId },
    { action: "undo_plan", task_id: h.existing.id }, { action: "undo_plan", user_action_id: "spoof" }]) {
    expect((await h.request(h.card.id, body)).status).toBe(422);
    expect(h.store.getTurn(h.turn.id).status).toBe("running");
  }
  const response = await h.request(h.card.id, { action: "merge_plan", task_id: h.existing.id });
  expect(response.status).toBe(200);
  expect(h.store.getMessage(h.line.id).task_id).toBe(h.existing.id);
  expect(h.store.getRequirement("req")).toMatchObject({ scope_id: h.existing.id, origin_task_id: h.existing.id, status: "open" });
  expect(h.store.getTurn(h.turn.id).task_id).toBe(h.taskId);
  expect(h.store.getHold(targetHold.id).lifted_at).toBeNull();
  expect(h.store.getMessage(h.card.id).control).toMatchObject({ acted: ["merge_plan"], merged_into: h.existing.id });
  expect(h.events.filter((e) => e.event === "attribution.changed")).toHaveLength(1);
});
