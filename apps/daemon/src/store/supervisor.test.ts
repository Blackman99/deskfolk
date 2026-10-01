import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoNow } from "../ids";
import { completionFailBody } from "../prompts";
import { Store } from ".";
import { migrateSchema } from "./migrate";
import { ENGINE_LEVELS } from "./schema-gate";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

// A clock well ahead of the rows the fixture writes (the store's clock can run ahead of the wall's
// in a burst of writes), so their own timestamps never move a deadline.
const T0 = Date.parse(isoNow()) + 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;

function fixture(filename?: string) {
  const store = new Store(filename ? { filename } : {});
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(ENGINE_LEVELS.supervision)]);
  const owner = store.createBot({ name: "Owner", duties: "produce", boundaries: "none" }).bot;
  const helper = store.createBot({ name: "Helper", duties: "assist", boundaries: "none" }).bot;
  const room = store.createGroup({ name: "Studio", members: [owner.id, helper.id] });
  const plan = store.openTask({ sessionId: room.id, title: "EP01" });
  store.db.run("UPDATE tasks SET created_at = ? WHERE id = ?", [at(0), plan.id]);
  const ticket = store.createTicket({ taskId: plan.id, title: "Shot 11", worker: owner.id, now: new Date(T0) });
  return { store, owner, helper, room, plan, ticket };
}
type Fixture = ReturnType<typeof fixture>;

/** A segment of `botId` on the fixture's ticket (or another), bound to its work item, in `sessionId`. */
function segment(f: Fixture, opts: { botId?: string; ticketId?: string | null; sessionId?: string } = {}) {
  const sessionId = opts.sessionId ?? f.room.id;
  const trigger = f.store.insertMessage({ sessionId, kind: "system", author: opts.botId ?? f.owner.id, body: "工作" });
  const turn = f.store.createTurn({ sessionId, botId: opts.botId ?? f.owner.id, triggerMessageId: trigger.id, taskId: f.plan.id,
    ticketId: opts.ticketId === undefined ? f.ticket.id : opts.ticketId });
  if (!turn.work_item_id) throw new Error("the fixture's segments are bound to a work item");
  return { ...turn, work_item_id: turn.work_item_id };
}

/** An ended segment, its work item set to `state`. */
function ended(f: Fixture, state: string, opts: Parameters<typeof segment>[1] = {}) {
  const turn = segment(f, opts);
  f.store.setTurnStatus(turn.id, "completed");
  f.store.db.run("UPDATE work_items SET state = ? WHERE id = ?", [state, turn.work_item_id!]);
  return turn;
}

function state(f: Fixture, workItemId: string): string {
  return f.store.db.query<{ state: string }, [string]>("SELECT state FROM work_items WHERE id = ?").get(workItemId)!.state;
}

/** Answers the queued wake the way a dispatched segment would, leaving the work idle again. */
function settle(f: Fixture, wake: { inboxSeq: number | null; workItemId: string }) {
  if (wake.inboxSeq !== null) f.store.supersedeInboxItems([wake.inboxSeq]);
  f.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [wake.workItemId]);
}

/** This boot, as `restart.announce` records it. */
function boot(f: Fixture, bootId: string, cause: "clean" | "crash" | "dev", when: string) {
  f.store.db.run(`INSERT INTO work_events (at, kind, actor, payload) VALUES (?, 'daemon.restart', 'app', ?)`,
    [when, JSON.stringify({ cause, cut: [], boot_id: bootId })]);
}

function file(f: Fixture, messageId: string, when: string) {
  f.store.db.run("UPDATE messages SET task_id = ?, created_at = ? WHERE id = ?", [f.plan.id, when, messageId]);
}

function pendingEffect(f: Fixture, turnId: string, workItemId: string, tool = "mcp_submit_video") {
  f.store.db.run(`INSERT INTO tool_executions (id, work_item_id, task_id, ticket_id, bot_id, turn_id, tool_call_id, tool, side_effect, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, [`exec-${turnId}-${tool}`, workItemId, f.plan.id, f.ticket.id, f.owner.id, turnId, `call-${tool}`, tool, at(0)]);
}

// ── Ball holder ─────────────────────────────────────────────────────────────────────────────────

test("the ball is the owner's, then an open request's recipient, and picking it names no model", () => {
  const f = fixture();
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "owner", botId: f.owner.id, workItemId: null });
  const turn = segment(f);
  const delegated = f.store.delegateWork({ fromTurnId: turn.id, toBotId: f.helper.id, ask: "审一下", expects: "answer", now: at(0) });
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "delegation", botId: f.helper.id,
    workItemId: delegated.delegation.to_work_item_id, delegationId: delegated.delegation.id, since: at(0) });
  expect(f.store.db.query("SELECT 1 FROM spend").all()).toEqual([]);
});

test("the ball is yours on a question, a block, a stop or a stopped dependency, and awaiting review", () => {
  const f = fixture();
  const turn = segment(f);
  const ask = f.store.insertMessage({ sessionId: f.room.id, turnId: turn.id, kind: "ask", author: f.owner.id, body: "要哪个？" });
  f.store.db.run("UPDATE turns SET status = 'waiting_ask', pending_ask_id = ? WHERE id = ?", [ask.id, turn.id]);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "ask", ref: ask.id });
  f.store.db.run("UPDATE turns SET status = 'completed', end_reason = 'blocked', pending_ask_id = NULL WHERE id = ?", [turn.id]);
  // A blocked job's durable question is yours to answer just the same.
  f.store.db.run("UPDATE work_items SET state = 'blocked', waiting_on = ? WHERE id = ?", [JSON.stringify({ kind: "user", ref: "question-1" }), turn.work_item_id!]);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "ask", ref: "question-1" });
  f.store.db.run("UPDATE work_items SET waiting_on = NULL WHERE id = ?", [turn.work_item_id!]);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "blocked", ref: turn.work_item_id });
  f.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [turn.work_item_id!]);
  const before = f.store.createTicket({ taskId: f.plan.id, title: "前置" });
  f.store.patchTicketByUser(f.ticket.id, { dependsOn: [before.id] });
  const stop = f.store.createHold({ scope: "ticket", scopeId: before.id, source: "user_button" });
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "held_dependency", ref: before.id });
  f.store.liftHold(stop.id, { by: "user_button" });
  const own = f.store.createHold({ scope: "ticket", scopeId: f.ticket.id, source: "user_button" });
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "held", ref: f.ticket.id });
  f.store.liftHold(own.id, { by: "user_button" });
  f.store.db.run("UPDATE tickets SET status = 'review' WHERE id = ?", [f.ticket.id]);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "review", ref: f.ticket.id });
  // A check on the ticket that failed when it last ran sends it back to its owner.
  f.store.db.run(`INSERT INTO acceptance_checks (id, task_id, ticket_id, item, kind, path, source, created_at, updated_at, defined_at)
    VALUES ('check-1', ?, ?, '交出 cut.mp4', 'exists', ?, 'user', ?, ?, ?)`, [f.plan.id, f.ticket.id, `${f.ticket.dir}/cut.mp4`, at(0), at(0), at(0)]);
  f.store.db.run(`INSERT INTO acceptance_check_runs (id, check_id, task_id, cause, started_at, finished_at, outcome)
    VALUES ('run-1', 'check-1', ?, 'user', ?, ?, 'fail')`, [f.plan.id, at(0), at(0)]);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "owner", botId: f.owner.id });
});

test("with no owner who can take it the ball goes to the plan's lead, read rather than stored, else nobody's", () => {
  const f = fixture();
  f.store.db.run("UPDATE tickets SET worker = NULL, owner_bot_id = NULL WHERE id = ?", [f.ticket.id]);
  // Most turns in the plan: the helper's.
  ended(f, "idle", { botId: f.helper.id, ticketId: null });
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "lead", botId: f.helper.id });
  expect(f.store.db.query("SELECT lead_bot_id FROM tasks WHERE id = ?").get(f.plan.id)).toEqual({ lead_bot_id: null });
  f.store.db.run("UPDATE tasks SET lead_bot_id = ? WHERE id = ?", [f.owner.id, f.plan.id]);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "lead", botId: f.owner.id });
  f.store.db.run("UPDATE bots SET archived_at = ? WHERE id IN (?, ?)", [at(0), f.owner.id, f.helper.id]);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "unclaimed" });
  f.store.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [f.ticket.id]);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "closed" });
});

// ── Orphans ─────────────────────────────────────────────────────────────────────────────────────

test("an orphan is called back once, at two minutes, through a durable record and a queued wake", () => {
  const f = fixture();
  expect(f.store.supervisorTick({ now: at(2 * MIN - 1) }).wakes).toEqual([]);
  const tick = f.store.supervisorTick({ now: at(2 * MIN) });
  expect(tick.wakes).toMatchObject([{ taskId: f.plan.id, ticketId: f.ticket.id, botId: f.owner.id, cause: "orphan", noteId: null }]);
  const wake = tick.wakes[0]!;
  expect(f.store.db.query("SELECT bot_id, task_id, ticket_id, state FROM work_items WHERE id = ?").get(wake.workItemId))
    .toEqual({ bot_id: f.owner.id, task_id: f.plan.id, ticket_id: f.ticket.id, state: "queued" });
  expect(f.store.getCheckBack(wake.checkBackId)).toMatchObject({ kind: "supervisor", cause: "supervisor", work_item_id: wake.workItemId, fired_at: at(2 * MIN) });
  const inbox = f.store.getInboxItem(wake.inboxSeq!)!;
  expect(inbox).toMatchObject({ work_item_id: wake.workItemId, wakes: 1, source: "system", kind: "wake", priority: 3 });
  expect(inbox.body_snapshot).toContain("任务 01《Shot 11》还没收口");
  expect(inbox.body_snapshot).toContain("你是它的负责人");
  expect(f.store.supervisorTick({ now: at(2 * MIN + 15_000) }).wakes).toEqual([]);
  expect(f.store.dispatchableWork().map((work) => work.id)).toEqual([wake.workItemId]);
});

test("a Bot's last word after yours where you are waits ten minutes, question or not; in a thread you are not in it does not", () => {
  const f = fixture();
  const yours = f.store.postMessage(f.room.id, { body: "继续" });
  file(f, yours.id, at(MIN));
  const bots = f.store.insertMessage({ sessionId: f.room.id, kind: "bot", author: f.owner.id, body: "这一版已经摆在这里。" });
  file(f, bots.id, at(2 * MIN));
  expect(f.store.supervisorTick({ now: at(4 * MIN) }).wakes).toEqual([]);
  expect(f.store.supervisorTick({ now: at(12 * MIN - 1) }).wakes).toEqual([]);
  expect(f.store.supervisorTick({ now: at(12 * MIN) }).wakes).toHaveLength(1);

  const g = fixture();
  const thread = g.store.createBotDirect(g.owner.id, g.helper.id, null);
  const said = g.store.insertMessage({ sessionId: thread.id, kind: "bot", author: g.owner.id, body: "这一版已经摆在这里。" });
  g.store.db.run("UPDATE messages SET task_id = ?, created_at = ? WHERE id = ?", [g.plan.id, at(2 * MIN), said.id]);
  expect(g.store.supervisorTick({ now: at(4 * MIN) }).wakes).toHaveLength(1);
});

test("below the supervisor's level nothing is repaired, picked up or called back", () => {
  const f = fixture();
  f.store.db.run("UPDATE settings SET value = ? WHERE key = 'engine_level'", [String(ENGINE_LEVELS.delegation)]);
  expect(f.store.supervisorTick({ now: at(60 * MIN) })).toMatchObject({ wakes: [], messages: [], repaired: [] });
});

test("two call-backs per progress cycle: words do not renew it, a stage change or a new artifact does", () => {
  const f = fixture();
  const first = f.store.supervisorTick({ now: at(2 * MIN) }).wakes[0]!;
  settle(f, first);
  const second = f.store.supervisorTick({ now: at(4 * MIN) }).wakes[0]!;
  expect(second.workItemId).toBe(first.workItemId);
  settle(f, second);
  f.store.patchTicketByUser(f.ticket.id, { spec: "改了说明" });
  const third = f.store.supervisorTick({ now: at(6 * MIN) });
  expect(third.wakes).toEqual([]);
  expect(third.messages).toHaveLength(1);
  expect(third.messages[0]).toMatchObject({ kind: "system", session_id: f.room.id,
    control: { kind: "supervisor", code: "stalled", task_id: f.plan.id, ticket_id: f.ticket.id } });
  expect(third.messages[0]!.body).toContain("这件事停下了");
  expect(f.store.db.query("SELECT kind, fail_kind, action_state FROM notifications WHERE message_id = ?").get(third.messages[0]!.id))
    .toEqual({ kind: "failure", fail_kind: "stalled_plan", action_state: "open" });
  expect(f.store.supervisorTick({ now: at(6 * MIN + 15_000) }).messages).toEqual([]);
  // You moved the ticket on the board: a new cycle.
  f.store.patchTicketByUser(f.ticket.id, { status: "doing" });
  const renewed = f.store.supervisorTick({ now: at(8 * MIN) }).wakes;
  expect(renewed).toHaveLength(1);
  settle(f, renewed[0]!);
  settle(f, f.store.supervisorTick({ now: at(10 * MIN) }).wakes[0]!);
  expect(f.store.supervisorTick({ now: at(12 * MIN) }).wakes).toEqual([]);
  // A new file in the ticket's folder, by content hash: another.
  const turn = ended(f, "idle");
  expect(f.store.recordArtifactProgress({ turnId: turn.id, artifacts: [{ path: `${f.ticket.dir}/cut.mp4`, sha256: "a".repeat(64) }] })).toBe(1);
  expect(f.store.supervisorTick({ now: at(14 * MIN) }).wakes).toHaveLength(1);
});

test("stops, dormant plans, work that is not idle and other engagement are never called back", () => {
  for (const kind of ["held_turn", "held_bot", "dormant", "waiting", "blocked", "needs_attention", "queued", "pending_wait", "live"]) {
    const f = fixture();
    const turn = ended(f, ["held_turn", "held_bot", "dormant", "pending_wait", "live"].includes(kind) ? "idle" : kind);
    if (kind === "held_turn") f.store.createHold({ scope: "turn", scopeId: turn.id, source: "user_button" });
    if (kind === "held_bot") f.store.createHold({ scope: "bot", scopeId: f.owner.id, source: "user_button" });
    if (kind === "dormant") f.store.db.run("UPDATE tasks SET dormant_since = ? WHERE id = ?", [at(0), f.plan.id]);
    if (kind === "pending_wait") f.store.scheduleCheckBack({ botId: f.owner.id, sessionId: f.room.id, turnId: turn.id, note: "回头看", afterMinutes: 30, now: new Date(T0) });
    if (kind === "live") segment(f, { ticketId: null });
    expect(f.store.supervisorTick({ now: at(60 * MIN) }).wakes.filter((wake) => wake.cause === "orphan")).toEqual([]);
  }
});

test("a request's recipient that went idle without replying is called back with the request", () => {
  const f = fixture();
  const turn = segment(f);
  const delegated = f.store.delegateWork({ fromTurnId: turn.id, toBotId: f.helper.id, ask: "把 Shot 11 的分镜对一遍", expects: "answer", now: at(0) });
  f.store.setTurnStatus(turn.id, "completed");
  f.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [delegated.delegation.to_work_item_id]);
  f.store.supersedeInboxItems([delegated.inbox.seq]);
  const tick = f.store.supervisorTick({ now: at(3 * MIN) });
  expect(tick.wakes).toMatchObject([{ botId: f.helper.id, workItemId: delegated.delegation.to_work_item_id, cause: "orphan" }]);
  expect(f.store.getInboxItem(tick.wakes[0]!.inboxSeq!)!.body_snapshot).toContain("把 Shot 11 的分镜对一遍");
});

test("unfinished, malformed or held dependencies and an uncertain last effect keep an orphan from being called back", () => {
  for (const reason of ["unknown_effect", "malformed_dependency", "unfinished_dependency"]) {
    const f = fixture();
    const turn = ended(f, "idle");
    if (reason === "unknown_effect") pendingEffect(f, turn.id, turn.work_item_id!);
    if (reason === "malformed_dependency") f.store.db.run("UPDATE tickets SET depends_on = 'broken' WHERE id = ?", [f.ticket.id]);
    if (reason === "unfinished_dependency") {
      const before = f.store.createTicket({ taskId: f.plan.id, title: "待完成前置" });
      f.store.patchTicketByUser(f.ticket.id, { dependsOn: [before.id] });
    }
    const tick = f.store.supervisorTick({ now: at(60 * MIN) });
    expect(tick.wakes.filter((wake) => wake.ticketId === f.ticket.id)).toEqual([]);
    if (reason === "unknown_effect") {
      expect(tick.deferred).toContainEqual({ workItemId: turn.work_item_id, reason: "unknown_effect" });
      expect(tick.messages).toMatchObject([{ session_id: f.room.id, control: { kind: "supervisor", code: "unknown_effect" } }]);
      expect(tick.messages[0]!.body).toContain("mcp_submit_video");
    }
  }
});

// ── I6 and attention ────────────────────────────────────────────────────────────────────────────

test("I6: a wait with nothing behind it is repaired and picked up at once with what happened; a real or held wait stays", () => {
  for (const kind of ["invalid", "timer", "held"]) {
    const f = fixture();
    const turn = segment(f);
    f.store.setTurnStatus(turn.id, "completed");
    let ref = "missing-wait";
    if (kind === "timer") ref = f.store.scheduleCheckBack({ botId: f.owner.id, sessionId: f.room.id, turnId: turn.id, note: "真实等待", afterMinutes: 5, now: new Date(T0) }).row.id;
    f.store.db.run("UPDATE work_items SET state = 'waiting', waiting_on = ? WHERE id = ?", [JSON.stringify({ kind: "timer", ref, since: at(0) }), turn.work_item_id!]);
    if (kind === "held") f.store.createHold({ scope: "plan", scopeId: f.plan.id, source: "user_button" });
    const tick = f.store.supervisorTick({ now: at(MIN) });
    if (kind === "invalid") {
      expect(tick.repaired).toEqual([{ workItemId: turn.work_item_id, from: "waiting", reason: "wait_invalid" }]);
      expect(tick.wakes).toMatchObject([{ workItemId: turn.work_item_id, cause: "wait_invalid", noteId: null }]);
      expect(f.store.getInboxItem(tick.wakes[0]!.inboxSeq!)!.body_snapshot).toContain("这一等不再成立");
      expect(state(f, turn.work_item_id!)).toBe("queued");
      expect(f.store.listWorkEvents({ kind: "supervisor.wait_invalid" })).toHaveLength(1);
    } else {
      expect(tick.repaired).toEqual([]);
      expect(state(f, turn.work_item_id!)).toBe("waiting");
    }
  }
});

test("I6 keeps an open request's wait and repairs it once the other side's work closed", () => {
  const f = fixture();
  const turn = segment(f);
  const delegation = f.store.delegateWork({ fromTurnId: turn.id, toBotId: f.helper.id, ask: "未完成的委派", expects: "answer", now: at(0) });
  f.store.setTurnStatus(turn.id, "completed");
  expect(f.store.supervisorTick({ now: at(MIN) }).repaired).toEqual([]);
  f.store.db.run("UPDATE work_items SET state = 'closed' WHERE id = ?", [delegation.delegation.to_work_item_id]);
  expect(f.store.supervisorTick({ now: at(2 * MIN) }).repaired.map((row) => row.workItemId)).toEqual([delegation.delegation.from_work_item_id]);
});

test("from the supervisor's level an interruption needs attention; below it the work item is left as it was", () => {
  for (const level of [ENGINE_LEVELS.delegation, ENGINE_LEVELS.supervision]) {
    const f = fixture();
    f.store.db.run("UPDATE settings SET value = ? WHERE key = 'engine_level'", [String(level)]);
    const turn = segment(f);
    f.store.interruptTurnRecord(turn.id);
    expect(state(f, turn.work_item_id!)).toBe(level >= ENGINE_LEVELS.supervision ? "needs_attention" : "running");
  }
});

test("attention picks up from the segment's own line at most three times an hour, then says so once", () => {
  const f = fixture();
  const turn = segment(f);
  const { note } = f.store.interruptTurnRecord(turn.id)!;
  for (const [index, when] of [0, 5 * MIN, 10 * MIN].entries()) {
    const tick = f.store.supervisorTick({ now: at(when) });
    expect(tick.wakes).toMatchObject([{ workItemId: turn.work_item_id, cause: "needs_attention", noteId: note.id, inboxSeq: null }]);
    expect(f.store.getCheckBack(tick.wakes[0]!.checkBackId).wait_spec).toContain(`"attempt":${index + 1}`);
  }
  const spent = f.store.supervisorTick({ now: at(15 * MIN) });
  expect(spent.wakes).toEqual([]);
  expect(spent.messages).toMatchObject([{ control: { kind: "supervisor", code: "retry_budget", work_item_id: turn.work_item_id } }]);
  expect(f.store.supervisorTick({ now: at(16 * MIN) }).messages).toEqual([]);
  // An hour after the first, one more.
  expect(f.store.supervisorTick({ now: at(60 * MIN + 1) }).wakes).toHaveLength(1);
});

test("a failed segment picks up from its failure line; one whose external call has no known outcome waits and says why", () => {
  const f = fixture();
  const turn = segment(f);
  const line = f.store.insertMessage({ sessionId: f.room.id, turnId: turn.id, kind: "system", author: f.owner.id, body: completionFailBody("zh", "endpoint_error") });
  f.store.setTurnStatus(turn.id, "completed");
  f.store.markSegmentCutOff(turn.id, "endpoint_error");
  expect(f.store.supervisorTick({ now: at(0) }).wakes).toMatchObject([{ noteId: line.id, cause: "needs_attention" }]);
  const g = fixture();
  const cut = segment(g);
  pendingEffect(g, cut.id, cut.work_item_id!);
  g.store.interruptTurnRecord(cut.id);
  const tick = g.store.supervisorTick({ now: at(0) });
  expect(tick.wakes).toEqual([]);
  expect(tick.deferred).toContainEqual({ workItemId: cut.work_item_id, reason: "unknown_effect" });
  expect(tick.messages).toMatchObject([{ control: { kind: "supervisor", code: "unknown_effect" } }]);
  expect(g.store.supervisorTick({ now: at(MIN) }).messages).toEqual([]);
});

test("attention never takes the ball from an open request's recipient", () => {
  const f = fixture();
  const turn = segment(f);
  const delegation = f.store.delegateWork({ fromTurnId: turn.id, toBotId: f.helper.id, ask: "由助手持球", expects: "answer", now: at(0) });
  f.store.interruptTurnRecord(turn.id);
  f.store.db.run("UPDATE work_items SET state = 'needs_attention' WHERE id = ?", [delegation.delegation.from_work_item_id]);
  expect(f.store.supervisorTick({ now: at(10 * MIN) }).wakes.map((wake) => wake.workItemId)).not.toContain(delegation.delegation.from_work_item_id);
});

test("a running item whose segment was interrupted unseen is repaired and picked up", () => {
  const f = fixture();
  const turn = segment(f);
  f.store.db.run("UPDATE settings SET value = ? WHERE key = 'engine_level'", [String(ENGINE_LEVELS.delegation)]);
  f.store.interruptTurnRecord(turn.id);
  expect(state(f, turn.work_item_id!)).toBe("running");
  f.store.db.run("UPDATE settings SET value = ? WHERE key = 'engine_level'", [String(ENGINE_LEVELS.supervision)]);
  const tick = f.store.supervisorTick({ now: at(0) });
  expect(tick.repaired).toEqual([{ workItemId: turn.work_item_id, from: "running", reason: "lost_segment" }]);
  expect(tick.wakes).toMatchObject([{ workItemId: turn.work_item_id, cause: "needs_attention" }]);
});

test("work that needed attention before the supervisor's level was raised is left for you", () => {
  const f = fixture();
  const turn = segment(f);
  f.store.interruptTurnRecord(turn.id);
  f.store.db.run("UPDATE work_items SET updated_at = ? WHERE id = ?", [at(-MIN), turn.work_item_id]);
  f.store.db.run(`INSERT INTO work_events (at, kind, actor, payload) VALUES (?, 'engine.level_raised', 'app', ?)`,
    [at(0), JSON.stringify({ from: ENGINE_LEVELS.delegation, to: ENGINE_LEVELS.supervision })]);
  expect(f.store.supervisorTick({ now: at(10 * MIN) }).wakes).toEqual([]);
  // Interrupted again after the raise: the supervisor's.
  f.store.db.run("UPDATE work_items SET updated_at = ? WHERE id = ?", [at(MIN), turn.work_item_id]);
  expect(f.store.supervisorTick({ now: at(10 * MIN) }).wakes).toMatchObject([{ workItemId: turn.work_item_id, cause: "needs_attention" }]);
});

// ── Restarts (§5.6) ─────────────────────────────────────────────────────────────────────────────

function cutByRestart(f: Fixture, bootId: string, cause: "clean" | "crash" | "dev", when = at(0)) {
  const turn = segment(f);
  const { note } = f.store.interruptTurnRecord(turn.id)!;
  boot(f, bootId, cause, when);
  const arranged = f.store.recordSupervisorRestart({ bootId, cause, interruptedTurnIds: [turn.id], now: when });
  return { turn, note, arranged };
}

test("a clean restart picks up at once; a crash or a development restart after a minute of steady running, once", () => {
  for (const cause of ["clean", "crash", "dev"] as const) {
    const f = fixture();
    const { turn, note, arranged } = cutByRestart(f, `boot-${cause}`, cause);
    expect(arranged).toEqual([{ turnId: turn.id, workItemId: turn.work_item_id, arrangement: cause === "clean" ? "now" : "after_stable" }]);
    // Recording the same boot again records nothing more.
    f.store.recordSupervisorRestart({ bootId: `boot-${cause}`, cause, interruptedTurnIds: [turn.id], now: at(0) });
    expect(f.store.listWorkEvents({ kind: "supervisor.restart" })).toHaveLength(1);
    const early = f.store.supervisorTick({ now: at(59_999) });
    expect(early.wakes).toEqual(cause === "clean" ? [expect.objectContaining({ cause: "restart", noteId: note.id })] : []);
    if (cause !== "clean") {
      expect(early.deferred).toContainEqual({ workItemId: turn.work_item_id, reason: "restart_stability" });
      expect(f.store.supervisorTick({ now: at(60_000) }).wakes).toMatchObject([{ cause: "restart", noteId: note.id }]);
    }
    // Picked up once for this boot: the next pick-up of the same segment is ordinary attention.
    expect(f.store.supervisorTick({ now: at(2 * MIN) }).wakes).toMatchObject([{ cause: "needs_attention" }]);
  }
});

test("a development restart soon after another, or followed by one, waits for your 继续", () => {
  const f = fixture();
  boot(f, "dev-old", "dev", at(-MIN));
  const { turn, arranged } = cutByRestart(f, "dev-new", "dev");
  expect(arranged[0]!.arrangement).toBe("dev_burst");
  const tick = f.store.supervisorTick({ now: at(10 * MIN) });
  expect(tick.wakes).toEqual([]);
  expect(tick.deferred).toContainEqual({ workItemId: turn.work_item_id, reason: "dev_restart_window" });

  const g = fixture();
  const cut = cutByRestart(g, "dev-a", "dev");
  boot(g, "later", "clean", at(30_000));
  expect(g.store.supervisorTick({ now: at(10 * MIN) }).deferred).toContainEqual({ workItemId: cut.turn.work_item_id, reason: "dev_restart_window" });
});

test("不续 on the restart notice, a stop, or an external call with no known outcome keeps work a restart cut off where it is", () => {
  const f = fixture();
  const { turn, note } = cutByRestart(f, "boot-left", "clean");
  f.store.insertMessage({ sessionId: f.room.id, kind: "system", author: f.owner.id, body: "重启", hiddenFromBots: true,
    control: { kind: "restart", cause: "clean", notes: [note.id], offer: ["resume", "leave"], acted: ["leave"] } });
  expect(f.store.supervisorTick({ now: at(MIN) }).deferred).toContainEqual({ workItemId: turn.work_item_id, reason: "left_by_user" });

  const g = fixture();
  const held = segment(g);
  g.store.interruptTurnRecord(held.id);
  g.store.createHold({ scope: "bot", scopeId: g.owner.id, source: "user_button" });
  boot(g, "boot-held", "clean", at(0));
  expect(g.store.recordSupervisorRestart({ bootId: "boot-held", cause: "clean", interruptedTurnIds: [held.id], now: at(0) })[0]!.arrangement).toBe("held");
  expect(g.store.supervisorTick({ now: at(MIN) }).wakes).toEqual([]);

  const h = fixture();
  const unsure = segment(h);
  pendingEffect(h, unsure.id, unsure.work_item_id!);
  h.store.interruptTurnRecord(unsure.id);
  boot(h, "boot-unsure", "clean", at(0));
  expect(h.store.recordSupervisorRestart({ bootId: "boot-unsure", cause: "clean", interruptedTurnIds: [unsure.id], now: at(0) })[0]!.arrangement).toBe("unknown_effect");
  const tick = h.store.supervisorTick({ now: at(MIN) });
  expect(tick.deferred).toContainEqual({ workItemId: unsure.work_item_id, reason: "unknown_effect" });
  // The restart notice already says so: no second line.
  expect(tick.messages).toEqual([]);
});

test("a segment interrupted before this boot that no record names follows this boot's restart policy", () => {
  const f = fixture();
  const turn = segment(f);
  const { note } = f.store.interruptTurnRecord(turn.id)!;
  f.store.db.run("UPDATE turns SET created_at = ? WHERE id = ?", [at(0), turn.id]);
  boot(f, "crash-unrecorded", "crash", at(10_000));
  expect(f.store.supervisorTick({ now: at(30_000) }).deferred).toContainEqual({ workItemId: turn.work_item_id, reason: "restart_stability" });
  expect(f.store.supervisorTick({ now: at(70_000) }).wakes).toMatchObject([{ cause: "restart", noteId: note.id }]);
});

test("restart deadlines and pick-up counts survive reopening the database", () => {
  const root = mkdtempSync(join(tmpdir(), "supervisor-reopen-"));
  try {
    const f = fixture(join(root, "state.sqlite"));
    const { turn } = cutByRestart(f, "crash-durable", "crash");
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = new Store({ filename: join(root, "state.sqlite") });
    stores.push(reopened);
    expect(reopened.supervisorTick({ now: at(59_999) }).wakes).toEqual([]);
    expect(reopened.supervisorTick({ now: at(60_000) }).wakes).toMatchObject([{ workItemId: turn.work_item_id, cause: "restart" }]);
    expect(reopened.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    for (const store of stores.splice(0)) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restart notice whose every line was continued is marked done and its notification resolved", () => {
  const f = fixture();
  const { note } = cutByRestart(f, "boot-settle", "clean");
  const notice = f.store.insertMessage({ sessionId: f.room.id, kind: "system", author: f.owner.id, body: "重启", hiddenFromBots: true,
    control: { kind: "restart", cause: "clean", notes: [note.id], offer: ["resume", "leave"] } });
  f.store.createNotification({ semantic_key: `restart:${notice.id}`, kind: "interrupted", session_id: f.room.id, message_id: notice.id, action_state: "open" });
  expect(f.store.settleRestartNotices([note.id])).toEqual([]);
  f.store.claimInterruptContinue(note.id);
  expect(f.store.settleRestartNotices([note.id])).toMatchObject([{ id: notice.id, control: { kind: "restart", acted: ["resume"] } }]);
  expect(f.store.db.query("SELECT action_state FROM notifications WHERE semantic_key = ?").get(`restart:${notice.id}`)).toEqual({ action_state: "resolved" });
  expect(f.store.settleRestartNotices([note.id])).toEqual([]);
});

// ── Writes in one transaction, progress facts, migration ────────────────────────────────────────

test("a tick's repairs and wakes roll back together when the inbox write fails", () => {
  const f = fixture();
  f.store.db.exec(`CREATE TRIGGER refuse_supervisor_inbox BEFORE INSERT ON inbox_items WHEN NEW.source = 'system' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  expect(() => f.store.supervisorTick({ now: at(2 * MIN) })).toThrow("injected");
  expect(f.store.db.query("SELECT 1 FROM check_backs WHERE kind = 'supervisor'").get()).toBeNull();
  expect(f.store.db.query("SELECT 1 FROM work_items WHERE task_id = ?").get(f.plan.id)).toBeNull();
});

test("artifact progress is a new content hash in the job's folder, nothing else", () => {
  const f = fixture();
  const turn = ended(f, "idle");
  const hash = "b".repeat(64);
  expect(f.store.recordArtifactProgress({ turnId: turn.id, artifacts: [
    { path: `${f.ticket.dir}/cut.mp4`, sha256: hash },
    { path: "elsewhere/cut.mp4", sha256: hash },
    { path: `${f.ticket.dir}/../escape.mp4`, sha256: hash },
    { path: `${f.ticket.dir}/scratch/notes.txt`, sha256: hash },
    { path: `${f.ticket.dir}/bad.mp4`, sha256: "not a hash" },
  ] })).toBe(1);
  expect(f.store.recordArtifactProgress({ turnId: turn.id, artifacts: [{ path: `${f.ticket.dir}/cut.mp4`, sha256: hash }] })).toBe(0);
  expect(f.store.recordArtifactProgress({ turnId: turn.id, artifacts: [{ path: `${f.ticket.dir}/cut.mp4`, sha256: "c".repeat(64) }] })).toBe(1);
  expect(f.store.listWorkEvents({ kind: "artifact.changed" }).map((event) => event.payload.sha256)).toEqual([hash, "c".repeat(64)]);
});

test("a check's first pass is progress once per definition; one a model judges must pass twice in a row", () => {
  const f = fixture();
  f.store.db.run(`INSERT INTO acceptance_checks (id, task_id, ticket_id, item, kind, path, source, created_at, updated_at, defined_at)
    VALUES ('app-check', ?, ?, '交出', 'exists', 'x', 'user', ?, ?, ?), ('judged', ?, ?, '衔接', 'continuity', NULL, 'user', ?, ?, ?)`,
    [f.plan.id, f.ticket.id, at(0), at(0), at(0), f.plan.id, f.ticket.id, at(0), at(0), at(0)]);
  const run = (check: string, outcome: "pass" | "fail", ms: number) => {
    const started = f.store.beginCheckRun(check, "user", new Date(T0 + ms));
    f.store.finishCheckRun(started.id, { outcome, exitCode: null, detail: "", output: null }, new Date(T0 + ms + 1));
  };
  run("app-check", "pass", 1_000);
  run("app-check", "pass", 2_000);
  run("judged", "pass", 1_000);
  run("judged", "fail", 2_000);
  run("judged", "pass", 3_000);
  expect(f.store.listWorkEvents({ kind: "check.first_passed" }).map((event) => event.payload.check_id)).toEqual(["app-check"]);
  run("judged", "pass", 4_000);
  expect(f.store.listWorkEvents({ kind: "check.first_passed" }).map((event) => [event.payload.check_id, event.payload.source, event.payload.consecutive_passes]))
    .toEqual([["app-check", "app", 1], ["judged", "model", 2]]);
});

test("a ticket's stage changes are logged, its worker is its owner, and its dependencies stay within its plan without loops", () => {
  const f = fixture();
  f.store.patchTicketByUser(f.ticket.id, { status: "doing", worker: f.helper.id });
  expect(f.store.listWorkEvents({ kind: "ticket.stage_changed" }).map((event) => [event.actor, event.payload.before, event.payload.after, event.payload.source]))
    .toEqual([["user", "todo", "doing", "user"]]);
  expect(f.store.getTicket(f.ticket.id)).toMatchObject({ worker: f.helper.id, owner_bot_id: f.helper.id, depends_on: [] });
  const second = f.store.createTicket({ taskId: f.plan.id, title: "第二镜" });
  const other = f.store.openTask({ sessionId: f.room.id, title: "EP02" });
  const elsewhere = f.store.createTicket({ taskId: other.id, title: "别处" });
  expect(() => f.store.patchTicketByUser(f.ticket.id, { dependsOn: [f.ticket.id] })).toThrow("itself");
  expect(() => f.store.patchTicketByUser(f.ticket.id, { dependsOn: [elsewhere.id] })).toThrow("same plan");
  expect(() => f.store.patchTicketByUser(f.ticket.id, { dependsOn: "x" })).toThrow("list of ticket ids");
  f.store.patchTicketByUser(f.ticket.id, { dependsOn: [second.id, second.id] });
  expect(f.store.getTicket(f.ticket.id).depends_on).toEqual([second.id]);
  expect(() => f.store.patchTicketByUser(second.id, { dependsOn: [f.ticket.id] })).toThrow("wait for each other");
});

test("the migration adds the owner and dependency columns and imports owners once, only from Bots that can still take the work", () => {
  const f = fixture();
  const columns = f.store.db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().map((column) => column.name);
  expect(columns).toContain("owner_bot_id");
  expect(columns).toContain("depends_on");
  const historic = f.store.createTicket({ taskId: f.plan.id, title: "历史任务" });
  ended(f, "idle", { botId: f.helper.id, ticketId: historic.id });
  f.store.db.run("UPDATE tickets SET owner_bot_id = NULL WHERE id IN (?, ?)", [historic.id, f.ticket.id]);
  f.store.db.run("DELETE FROM settings WHERE key = 'supervisor_owners_imported'");
  migrateSchema(f.store.db);
  expect(f.store.db.query("SELECT owner_bot_id, depends_on FROM tickets WHERE id = ?").get(historic.id)).toEqual({ owner_bot_id: f.helper.id, depends_on: "[]" });
  expect(f.store.db.query("SELECT owner_bot_id FROM tickets WHERE id = ?").get(f.ticket.id)).toEqual({ owner_bot_id: f.owner.id });
  expect(f.store.db.query("SELECT lead_bot_id FROM tasks WHERE id = ?").get(f.plan.id)).toEqual({ lead_bot_id: null });
  f.store.db.run("UPDATE tickets SET owner_bot_id = NULL WHERE id = ?", [historic.id]);
  migrateSchema(f.store.db);
  expect(f.store.db.query("SELECT owner_bot_id FROM tickets WHERE id = ?").get(historic.id)).toEqual({ owner_bot_id: null });
});
