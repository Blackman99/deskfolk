import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCollabTool } from "../collab-tools";
import { Store } from ".";
import * as cards from "./new-plan-cards";
import { KeyCache, type StoreContext } from "./shared";
import { Transactions } from "./transactions";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function fixture() {
  const store = new Store();
  stores.push(store);
  store.raiseEngineLevel(null);
  const { bot, direct_session } = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  const existing = store.openTask({ sessionId: direct_session.id, title: "EP01" });
  const line = store.postMessage(direct_session.id, { body: "另外写一份报告" });
  const turn = store.createTurn({ sessionId: line.session_id, botId: bot.id, triggerMessageId: line.id });
  await runCollabTool({ store, botId: bot.id, sessionId: line.session_id, turnId: turn.id, parentId: null },
    "work_on", { plan: { new: { title: "Report", quote_message_id: line.id } } });
  const taskId = store.getTurn(turn.id).task_id!;
  const ctx: StoreContext = {
    db: store.db, keys: new KeyCache({ get: async () => null, set: async () => {}, delete: async () => {} }, store.db),
    commit: (work) => store.transaction(work), tx: new Transactions(store.db), inboxRoot: "", activeStages: new Set(),
    keyPlan: null, legacy: { copiedKey: false },
  };
  return { store, ctx, bot, existing, line, turn, taskId };
}

test("a new job has one persistent visible undo/merge card linked to its opening turn and user quote", async () => {
  const h = await fixture();
  const input = { turnId: h.turn.id, taskId: h.taskId, quoteMessageId: h.line.id };
  const card = cards.createNewPlanCard(h.ctx, input);
  expect(h.store.getMessage(card.id).control).toMatchObject({
    kind: "plan_opened", task_id: h.taskId, turn_id: h.turn.id, quote_message_id: h.line.id,
    offer: ["undo_plan", "merge_plan"], merge_targets: [{ task_id: h.existing.id, title: "EP01" }],
  });
  expect(card.body).toBe("新开：Report");
  expect(h.store.db.query("SELECT hidden_from_bots, bot_only FROM messages WHERE id = ?").get(card.id))
    .toEqual({ hidden_from_bots: 1, bot_only: 0 });
  expect(cards.createNewPlanCard(h.ctx, input).id).toBe(card.id);
  expect(h.store.listWorkEvents({ kind: "plan.card_created" })).toHaveLength(1);
});

test("Undo stops the newly opened job before abandonment, preserves its words/requirements and is idempotent", async () => {
  const h = await fixture();
  const card = cards.createNewPlanCard(h.ctx, { turnId: h.turn.id, taskId: h.taskId, quoteMessageId: h.line.id });
  const quote = h.store.listQuotes({ messageId: h.line.id })[0]!;
  h.store.db.run(`INSERT INTO requirements (id, scope, scope_id, quote, source_kind, source_quote_id, status,
    last_raised_at, added_by, created_at, updated_at, origin_task_id)
    VALUES ('req', 'plan', ?, '报告要完整', 'message', ?, 'open', '2026-01-01', 'capture', '2026-01-01', '2026-01-01', ?)`,
    [h.taskId, quote.id, h.taskId]);
  let stopped = 0;
  const stop = (taskId: string) => {
    expect(h.store.db.query("SELECT COALESCE(stage, 'active') AS stage FROM tasks WHERE id = ?").get(taskId)).toEqual({ stage: "active" });
    stopped++;
    const hold = h.store.createHold({ scope: "plan", scopeId: taskId, action: "cancel", source: "user_button", liftOnNextUserMessage: false });
    h.store.stopTurn(h.turn.id, { allowGroup: true, keepCheckBacks: true });
    return hold;
  };
  const result = cards.actNewPlanCard(h.ctx, card.id, { action: "undo_plan", userActionId: "user-undo" }, stop);
  expect(result.made).toHaveLength(1);
  expect(result.lifted).toEqual([]);
  expect(h.store.getTurn(h.turn.id).status).toBe("stopped");
  expect(h.store.db.query("SELECT stage, status FROM tasks WHERE id = ?").get(h.taskId)).toEqual({ stage: "abandoned", status: "parked" });
  expect(h.store.listQuotes({ messageId: h.line.id })[0]!.body).toBe(h.line.body);
  expect(h.store.getRequirement("req").status).toBe("open");
  expect(h.store.getMessage(h.line.id).task_id).toBe(h.taskId);
  expect(h.store.getHold(result.made[0]!.id)).toMatchObject({ lifted_at: null, lift_on_next_user_message: false });
  expect(h.store.getMessage(card.id).control).toMatchObject({ acted: ["undo_plan"], user_action_id: "user-undo", retained_effects: [] });
  cards.actNewPlanCard(h.ctx, card.id, { action: "undo_plan", userActionId: "retry" }, stop);
  expect(stopped).toBe(1);
  expect(h.store.listWorkEvents({ kind: "plan.card_acted" })).toHaveLength(1);
});

test("started effects in any segment of the new job are retained honestly, including failed shell and in-flight writes", async () => {
  const h = await fixture();
  const card = cards.createNewPlanCard(h.ctx, { turnId: h.turn.id, taskId: h.taskId, quoteMessageId: h.line.id });
  h.store.recordTurnRun({ turnId: h.turn.id, tool: "shell", command: "exit 1", exitCode: 1, ok: false });
  h.store.setTurnStatus(h.turn.id, "completed");
  const followup = h.store.createTurn({ sessionId: h.line.session_id, botId: h.bot.id, triggerMessageId: h.line.id, taskId: h.taskId });
  cards.recordNewPlanEffectStarted(h.ctx, { turnId: followup.id, tool: "write_file", toolCallId: "write-1" });
  cards.recordNewPlanEffectStarted(h.ctx, { turnId: followup.id, tool: "write_file", toolCallId: "write-1" });
  const result = cards.actNewPlanCard(h.ctx, card.id, { action: "undo_plan", userActionId: "stop-retain" }, (taskId) => {
    const hold = h.store.createHold({ scope: "plan", scopeId: taskId, source: "user_button", liftOnNextUserMessage: false });
    h.store.stopTurn(followup.id, { allowGroup: true, keepCheckBacks: true });
    return hold;
  });
  expect(result.lifted).toEqual([]);
  expect(h.store.turnRuns(h.turn.id)).toHaveLength(1);
  expect(h.store.getMessage(card.id).control).toMatchObject({ retained_effects: ["shell", "write_file"] });
  expect(h.store.listWorkEvents({ kind: "plan.effect_started" })).toHaveLength(1);
  expect(h.store.listWorkEvents({ kind: "plan.card_acted" })[0]!.payload).toMatchObject({ retained_effects: ["shell", "write_file"], artifacts_retained: true });
});

test("Merge corrects only the quoted message via refile, preserves other filings and turn provenance, never lifts target holds", async () => {
  const h = await fixture();
  const other = h.store.openTask({ sessionId: h.line.session_id, title: "Shared" });
  h.store.refileMessage(h.line.id, { filings: [{ taskId: h.taskId }, { taskId: other.id }], userActionId: "multi" });
  const card = cards.createNewPlanCard(h.ctx, { turnId: h.turn.id, taskId: h.taskId, quoteMessageId: h.line.id });
  const hold = h.store.createHold({ scope: "plan", scopeId: h.existing.id, source: "user_button", liftOnNextUserMessage: false });
  cards.actNewPlanCard(h.ctx, card.id, { action: "merge_plan", taskId: h.existing.id, userActionId: "merge" }, (taskId) => {
    const stop = h.store.createHold({ scope: "plan", scopeId: taskId, source: "user_button", liftOnNextUserMessage: false });
    h.store.stopTurn(h.turn.id, { allowGroup: true, keepCheckBacks: true });
    return stop;
  });
  expect(h.store.getMessage(h.line.id).filings?.map((f) => f.task_id)).toEqual([h.existing.id, other.id]);
  expect(h.store.getTurn(h.turn.id).task_id).toBe(h.taskId);
  expect(h.store.getTurn(h.turn.id).ticket_id).not.toBeNull();
  expect(h.store.getMessage(card.id).task_id).toBe(h.taskId);
  expect(h.store.getMessage(card.id).control).toMatchObject({ acted: ["merge_plan"], merged_into: h.existing.id });
  expect(h.store.getHold(hold.id).lifted_at).toBeNull();
  const corrections = h.store.db.query<{ task_id: string; state: string }, [string, string]>(
    "SELECT task_id, state FROM inbox_items WHERE message_id = ? AND source = 'system' AND task_id = ?").all(h.line.id, h.existing.id);
  expect(corrections.length).toBeGreaterThan(0);
  for (const correction of corrections) expect(correction).toEqual({ task_id: h.existing.id, state: "held" });
});

test("invalid or stale merges refuse before stopping or changing the source", async () => {
  const h = await fixture();
  const card = cards.createNewPlanCard(h.ctx, { turnId: h.turn.id, taskId: h.taskId, quoteMessageId: h.line.id });
  const foreignBot = h.store.createBot({ name: "Other", duties: "work", boundaries: "stay" });
  const foreign = h.store.openTask({ sessionId: foreignBot.direct_session.id, title: "Foreign" });
  for (const taskId of [undefined, 12, h.taskId, foreign.id, "missing"]) {
    expect(() => cards.actNewPlanCard(h.ctx, card.id, { action: "merge_plan", taskId, userActionId: "bad" }, () => {
      throw new Error("must not stop");
    })).toThrow("choose an existing job");
  }
  h.store.refileMessage(h.line.id, { filings: [{ taskId: h.existing.id }], userActionId: "corrected" });
  expect(() => cards.actNewPlanCard(h.ctx, card.id, { action: "merge_plan", taskId: h.existing.id, userActionId: "stale" }, () => {
    throw new Error("must not stop");
  })).toThrow("already been corrected");
  expect(h.store.listHolds()).toEqual([]);
  expect(h.store.getTurn(h.turn.id).status).toBe("running");
  expect(h.store.getMessage(card.id).control?.acted).toBeUndefined();
});

test("a captured desk may open a card for its durably queued new job without binding a third live turn", async () => {
  const h = await fixture();
  const queuedLine = h.store.postMessage(h.line.session_id, { body: "另外做字幕" });
  const desk = h.store.createTurn({ sessionId: queuedLine.session_id, botId: h.bot.id, triggerMessageId: queuedLine.id });
  const queuedPlan = h.store.openTask({ sessionId: queuedLine.session_id, title: "Subtitles" });
  h.store.fileMessage(queuedLine.id, { botId: h.bot.id, botSelection: [{ taskId: queuedPlan.id }] });
  const work = h.store.findOrCreateWorkItem({ botId: h.bot.id, sessionId: queuedLine.session_id, taskId: queuedPlan.id, ticketId: null });
  h.store.db.run("UPDATE work_items SET state = 'queued' WHERE id = ?", [work.id]);
  const card = cards.createNewPlanCard(h.ctx, { turnId: desk.id, taskId: queuedPlan.id, quoteMessageId: queuedLine.id });
  expect(card.control).toMatchObject({ kind: "plan_opened", task_id: queuedPlan.id, turn_id: desk.id });
  expect(h.store.getTurn(desk.id)).toMatchObject({ task_id: null, mode: "desk" });
});

test("a quickly delivered new job still accepts Undo or quoted-message Merge without deleting past evidence", async () => {
  for (const action of ["undo_plan", "merge_plan"] as const) {
    const h = await fixture();
    const card = cards.createNewPlanCard(h.ctx, { turnId: h.turn.id, taskId: h.taskId, quoteMessageId: h.line.id });
    h.store.setTurnStatus(h.turn.id, "completed");
    h.store.db.run("UPDATE tasks SET stage = 'delivered', status = 'done' WHERE id = ?", [h.taskId]);
    const result = cards.actNewPlanCard(h.ctx, card.id, { action, taskId: action === "merge_plan" ? h.existing.id : undefined,
      userActionId: "delivered-correction" }, (taskId) => h.store.createHold({ scope: "plan", scopeId: taskId, source: "user_button", liftOnNextUserMessage: false }));
    expect(result.lifted).toEqual([]);
    expect(h.store.db.query("SELECT stage FROM tasks WHERE id = ?").get(h.taskId)).toEqual({ stage: "abandoned" });
    expect(h.store.getTurn(h.turn.id)).toMatchObject({ task_id: h.taskId, status: "completed" });
    expect(h.store.listQuotes({ messageId: h.line.id })[0]!.body).toBe(h.line.body);
  }
});

test("a card cannot offer abandonment of an existing job merely because a turn is bound to it", async () => {
  const h = await fixture();
  const line = h.store.postMessage(h.line.session_id, { body: "Continue EP01" });
  const turn = h.store.createTurn({ sessionId: line.session_id, botId: h.bot.id, triggerMessageId: line.id, taskId: h.existing.id });
  expect(() => cards.createNewPlanCard(h.ctx, { turnId: turn.id, taskId: h.existing.id, quoteMessageId: line.id }))
    .toThrow("new-plan card");
});

test("a persistent card, kept file and its acted provenance survive database reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "new-plan-card-"));
  const filename = join(root, "state.sqlite");
  let store = new Store({ filename });
  try {
    store.raiseEngineLevel(null);
    const { bot, direct_session } = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const line = store.postMessage(direct_session.id, { body: "Write a report" });
    const turn = store.createTurn({ sessionId: line.session_id, botId: bot.id, triggerMessageId: line.id });
    await runCollabTool({ store, botId: bot.id, sessionId: line.session_id, turnId: turn.id, parentId: null },
      "work_on", { plan: { new: { title: "Report", quote_message_id: line.id } } });
    const taskId = store.getTurn(turn.id).task_id!;
    const card = store.createNewPlanCard({ turnId: turn.id, taskId, quoteMessageId: line.id });
    const artifact = join(root, "report.md");
    await Bun.write(artifact, "kept draft");
    store.recordNewPlanEffectStarted({ turnId: turn.id, tool: "write_file", toolCallId: "file" });
    store.actNewPlanCard(card.id, { action: "undo_plan", userActionId: "persisted" }, (id) => {
      const hold = store.createHold({ scope: "plan", scopeId: id, source: "user_button", liftOnNextUserMessage: false });
      store.stopTurn(turn.id, { allowGroup: true, keepCheckBacks: true });
      return hold;
    });
    store.close();
    store = new Store({ filename });
    expect(store.getMessage(card.id).control).toMatchObject({ acted: ["undo_plan"], user_action_id: "persisted", retained_effects: ["write_file"] });
    expect(store.db.query("SELECT stage FROM tasks WHERE id = ?").get(taskId)).toEqual({ stage: "abandoned" });
    expect(store.listQuotes({ messageId: line.id })[0]!.body).toBe("Write a report");
    expect(await Bun.file(artifact).text()).toBe("kept draft");
    expect(store.listHolds({ inForce: true })).toHaveLength(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed stop cannot abandon the job and rolls back its hold", async () => {
  const h = await fixture();
  const card = cards.createNewPlanCard(h.ctx, { turnId: h.turn.id, taskId: h.taskId, quoteMessageId: h.line.id });
  expect(() => cards.actNewPlanCard(h.ctx, card.id, { action: "undo_plan", userActionId: "not-stopped" }, (taskId) =>
    h.store.createHold({ scope: "plan", scopeId: taskId, source: "user_button", liftOnNextUserMessage: false }))).toThrow("held and stopped");
  expect(h.store.listHolds()).toEqual([]);
  expect(h.store.getTask(h.taskId).status).toBe("active");
  expect(h.store.getMessage(card.id).control?.acted).toBeUndefined();
});
