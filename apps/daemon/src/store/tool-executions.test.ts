import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { KeyCache, type StoreContext } from "./shared";
import { Transactions } from "./transactions";
import { migrateToolExecutions } from "./tool-execution-migration";
import * as api from "./tool-executions";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const START = "2026-10-01T08:00:00.000Z";

async function fixture() {
  const store = new Store(); stores.push(store); store.raiseEngineLevel(null);
  const made = store.createBot({ name: "Worker", duties: "work", boundaries: "none" });
  const line = store.postMessage(made.direct_session.id, { body: "Work" });
  const plan = store.openTask({ sessionId: line.session_id, title: "Report" });
  const ticket = store.createTicket({ taskId: plan.id, title: "Draft" });
  const turn = store.createTurn({ sessionId: line.session_id, botId: made.bot.id, triggerMessageId: line.id, taskId: plan.id, ticketId: ticket.id });
  const ctx: StoreContext = { db: store.db, keys: new KeyCache({ get: async () => null, set: async () => {}, delete: async () => {} }, store.db),
    commit: (work) => store.transaction(work), tx: new Transactions(store.db), inboxRoot: "", activeStages: new Set(), keyPlan: null, legacy: { copiedKey: false } };
  migrateToolExecutions(store.db);
  const workItemId = turn.work_item_id;
  if (!workItemId) throw new Error("fixture needs an exactly bound work item");
  return { store, ctx, made, plan, ticket, turn, workItemId, api };
}

test("begin persists an exact bound effect before dispatch and grants its call identity only once", async () => {
  const f = await fixture();
  const input = { turnId: f.turn.id, toolCallId: "call-1", tool: "mcp_video_submit", sideEffect: true, now: START };
  const first = f.api.beginToolExecution(f.ctx, input);
  expect(first).toMatchObject({ begun: true, execution: { turn_id: f.turn.id, tool_call_id: "call-1", tool: "mcp_video_submit",
    bot_id: f.made.bot.id, task_id: f.plan.id, ticket_id: f.ticket.id, work_item_id: f.turn.work_item_id,
    side_effect: 1, started_at: START, finished_at: null, outcome: null, error_code: null } });
  const repeated = f.api.beginToolExecution(f.ctx, { ...input, now: "2026-10-01T08:01:00.000Z" });
  expect(repeated).toEqual({ begun: false, execution: first.execution });
  expect(f.api.getToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "call-1" })).toEqual(first.execution);
  expect(f.api.pendingToolExecutions(f.ctx, { turnId: f.turn.id })).toEqual([first.execution]);
  expect(f.store.db.query<{ name: string }, []>("PRAGMA table_info(tool_executions)").all().map((column) => column.name)).not.toContain("arguments");
});

test("a finished execution is monotonic and a duplicate cannot overwrite its first observed outcome", async () => {
  const f = await fixture();
  f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "call-1", tool: "shell", sideEffect: true, now: START });
  expect(f.api.finishToolExecution).toBeFunction();
  const finished = f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "call-1", outcome: "succeeded", now: "2026-10-01T08:01:00.000Z" });
  expect(finished).toMatchObject({ outcome: "succeeded", finished_at: "2026-10-01T08:01:00.000Z", error_code: null });
  expect(f.api.pendingToolExecutions(f.ctx, { workItemId: f.workItemId })).toEqual([]);
  const repeated = f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "call-1", outcome: "failed", errorCode: "timeout", now: "2026-10-01T08:02:00.000Z" });
  expect(repeated).toEqual(finished);
});

test("late success after authority revocation is unknown, but proven refusal never invents an effect", async () => {
  const f = await fixture();
  f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "effect", tool: "mcp_submit", sideEffect: true, now: START });
  f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "denied", tool: "shell", sideEffect: true, now: START });
  f.store.archiveBot(f.made.bot.id);
  expect(f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "effect", outcome: "succeeded", now: "2026-10-01T08:01:00.000Z" }))
    .toMatchObject({ outcome: "unknown", error_code: "authority_revoked" });
  expect(f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "denied", outcome: "refused", errorCode: "denied", now: "2026-10-01T08:01:00.000Z" }))
    .toMatchObject({ outcome: "refused", error_code: "denied" });
});

test("recovery facts distinguish completed receipts from pending or unknown effects without inventing external jobs", async () => {
  const f = await fixture();
  f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "done", tool: "shell", sideEffect: true, now: START });
  f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "done", outcome: "succeeded", now: "2026-10-01T08:01:00.000Z" });
  expect(f.api.executionRecoveryFacts).toBeFunction();
  expect(f.api.executionRecoveryFacts(f.ctx, { turnId: f.turn.id })).toMatchObject({ pending: [], uncertain: [], legacyAmbiguous: [], hasUncertainEffects: false, coverage: "ledger" });
  const pending = f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "pending", tool: "mcp_submit", sideEffect: true, now: START }).execution;
  const read = f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "read", tool: "mcp_read", sideEffect: false, now: START }).execution;
  const facts = f.api.executionRecoveryFacts(f.ctx, { workItemId: f.workItemId });
  expect(facts.pending).toEqual([pending, read]);
  expect(facts.uncertain).toEqual([pending]);
  expect(facts.hasUncertainEffects).toBe(true);
  expect(facts).not.toHaveProperty("externalJob");
  f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "pending", outcome: "unknown", errorCode: "network_error", now: "2026-10-01T08:02:00.000Z" });
  expect(f.api.executionRecoveryFacts(f.ctx, { turnId: f.turn.id }).uncertain).toMatchObject([{ tool_call_id: "pending", outcome: "unknown" }]);
});

test("historical shell and MCP runs without complete ledger coverage remain ambiguous even after reported success", async () => {
  const f = await fixture();
  f.store.recordTurnRun({ turnId: f.turn.id, tool: "shell", command: "legacy command", exitCode: 0, ok: true, now: new Date("2026-10-01T08:02:00.000Z") });
  f.store.recordTurnRun({ turnId: f.turn.id, tool: "mcp_submit", command: "legacy payload", exitCode: null, ok: false, error: "unreachable", now: new Date("2026-10-01T08:03:00.000Z") });
  const legacy = f.api.executionRecoveryFacts(f.ctx, { workItemId: f.workItemId });
  expect(legacy).toMatchObject({ coverage: "legacy", hasUncertainEffects: true, legacyAmbiguous: [{ tool: "shell" }, { tool: "mcp_submit" }] });
  expect(legacy.legacyAmbiguous[0]).not.toHaveProperty("command");
  f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "known-shell", tool: "shell", sideEffect: true, now: START });
  f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "known-shell", outcome: "succeeded", now: "2026-10-01T08:01:00.000Z" });
  expect(f.api.executionRecoveryFacts(f.ctx, { turnId: f.turn.id })).toMatchObject({ coverage: "partial", hasUncertainEffects: true, legacyAmbiguous: [{ tool: "mcp_submit" }] });
  // A read-only receipt cannot account for an old call whose side effect classification is unknown.
  f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "read-mcp", tool: "mcp_submit", sideEffect: false, now: START });
  f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "read-mcp", outcome: "succeeded", now: "2026-10-01T08:01:00.000Z" });
  expect(f.api.executionRecoveryFacts(f.ctx, { turnId: f.turn.id }).legacyAmbiguous).toMatchObject([{ tool: "mcp_submit" }]);
});

test("begin refuses a held, terminal, mismatched or dormant actor without persisting a start", async () => {
  const f = await fixture();
  const input = { turnId: f.turn.id, toolCallId: "refused-start", tool: "shell", sideEffect: true, now: START };
  f.store.db.run("UPDATE tasks SET dormant_since = ? WHERE id = ?", [START, f.plan.id]);
  expect(() => f.api.beginToolExecution(f.ctx, input)).toThrow("no longer owns executable work");
  expect(f.api.pendingToolExecutions(f.ctx, { turnId: f.turn.id })).toEqual([]);
  f.store.db.run("UPDATE tasks SET dormant_since = NULL WHERE id = ?", [f.plan.id]);
  const hold = f.store.createHold({ scope: "turn", scopeId: f.turn.id, source: "user_button" });
  expect(() => f.api.beginToolExecution(f.ctx, input)).toThrow("held");
  f.store.liftHold(hold.id, { by: "user_button" });
  f.store.db.run("UPDATE work_items SET ticket_id = NULL WHERE id = ?", [f.workItemId]);
  expect(() => f.api.beginToolExecution(f.ctx, input)).toThrow("no longer owns executable work");
  f.store.db.run("UPDATE work_items SET ticket_id = ? WHERE id = ?", [f.ticket.id, f.workItemId]);
  f.store.setTurnStatus(f.turn.id, "interrupted");
  expect(() => f.api.beginToolExecution(f.ctx, input)).toThrow("no longer owns executable work");
  expect(f.api.pendingToolExecutions(f.ctx, { turnId: f.turn.id })).toEqual([]);
});

test("exact readers and write validation never widen scope or overwrite a call descriptor", async () => {
  const f = await fixture();
  const input = { turnId: f.turn.id, toolCallId: "identity", tool: "shell", sideEffect: true, now: START };
  const begun = f.api.beginToolExecution(f.ctx, input);
  expect(() => f.api.beginToolExecution(f.ctx, { ...input, tool: "mcp_other" })).toThrow("another execution");
  expect(() => f.api.beginToolExecution(f.ctx, { ...input, sideEffect: false })).toThrow("another execution");
  expect(() => f.api.beginToolExecution(f.ctx, { ...input, toolCallId: "other", now: "invalid" })).toThrow("timestamp");
  expect(() => f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "identity", outcome: "failed", errorCode: "Authorization: secret token" })).toThrow("stable code");
  expect(() => f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "identity", outcome: "failed", now: "2026-09-30T08:00:00.000Z" })).toThrow("before it started");
  expect(() => f.api.finishToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "not-started", outcome: "unknown" })).toThrow("not started");
  expect(() => f.api.pendingToolExecutions(f.ctx, {})).toThrow("exact turn or work item");
  expect(() => f.api.executionRecoveryFacts(f.ctx, {})).toThrow("exact turn or work item");
  expect(f.api.pendingToolExecutions(f.ctx, { turnId: f.turn.id, workItemId: "unrelated" })).toEqual([]);
  expect(f.api.pendingToolExecutions(f.ctx, { turnId: "unrelated", workItemId: f.workItemId })).toEqual([]);
  expect(f.api.getToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "identity" })).toEqual(begun.execution);
});

test("starts roll back with their outer business transaction and additive migration preserves durable uncertain evidence", async () => {
  const f = await fixture();
  expect(() => f.store.transaction(() => {
    f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "rolled-back", tool: "shell", sideEffect: true, now: START });
    throw new Error("business rollback");
  })).toThrow("business rollback");
  expect(f.api.pendingToolExecutions(f.ctx, { turnId: f.turn.id })).toEqual([]);
  const begun = f.api.beginToolExecution(f.ctx, { turnId: f.turn.id, toolCallId: "retained", tool: "mcp_submit", sideEffect: true, now: START });
  migrateToolExecutions(f.store.db);
  expect(f.api.pendingToolExecutions(f.ctx, { workItemId: f.workItemId })).toEqual([begun.execution]);
  f.store.clearSessionMessages(f.made.direct_session.id);
  expect(f.api.executionRecoveryFacts(f.ctx, { workItemId: f.workItemId })).toMatchObject({ hasUncertainEffects: true, uncertain: [{ tool_call_id: "retained", outcome: null }] });
  expect(f.store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
