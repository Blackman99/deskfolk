import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as delegations from "./delegations";
import { KeyCache, type StoreContext } from "./shared";
import { Transactions } from "./transactions";
import { claimCheckBack } from "./check-backs";
import { addRequirement, setRequirementHere } from "./requirements";
import { createHold, liftHold, holdsCovering } from "./holds";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const NOW = "2026-09-29T08:00:00.000Z";

function fixture(filename?: string) {
  const store = new Store(filename ? { filename } : {});
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '40')");
  const from = store.createBot({ name: "导演", duties: "出片", boundaries: "none" }).bot;
  const to = store.createBot({ name: "审片", duties: "审片", boundaries: "none" }).bot;
  const room = store.createGroup({ name: "片场", members: [from.id, to.id] });
  const plan = store.openTask({ sessionId: room.id, title: "EP01" });
  const ticket = store.createTicket({ taskId: plan.id, title: "审镜头", status: "doing" });
  const message = store.postMessage(room.id, { body: "审 Shot 11" });
  const turn = store.createTurn({ sessionId: room.id, botId: from.id, triggerMessageId: message.id, taskId: plan.id, ticketId: ticket.id });
  const ctx: StoreContext = {
    db: store.db, keys: new KeyCache({ get: async () => null, set: async () => {}, delete: async () => {} }, store.db),
    commit: (work) => store.transaction(work), tx: new Transactions(store.db), inboxRoot: "", activeStages: new Set(),
    keyPlan: null, legacy: { copiedKey: false },
  };
  return { store, ctx, from, to, room, plan, ticket, turn };
}

test("delegate persists an exact-ticket recipient, wake inbox and real event wait before making its sender waiting", () => {
  const { store, ctx, from, to, room, plan, ticket, turn } = fixture();
  const result = delegations.delegateWork(ctx, { fromTurnId: turn.id, toBotId: to.id, ask: "审 Shot 11", expects: "review", now: NOW });
  expect(result.delegation).toMatchObject({ task_id: plan.id, ticket_id: ticket.id, to_bot_id: to.id, status: "open", ask: "审 Shot 11", expects: "review", created_at: NOW });
  expect(delegations.getDelegation(ctx, result.delegation.id)).toEqual(result.delegation);
  expect(result.inbox).toMatchObject({ bot_id: to.id, work_item_id: result.delegation.to_work_item_id, task_id: plan.id, ticket_id: ticket.id, turn_id: null, source: "delegation", kind: "change", priority: 3, wakes: 1, state: "queued", body_snapshot: "审 Shot 11" });
  expect(result.wait).toMatchObject({ work_item_id: result.delegation.from_work_item_id, bot_id: from.id, session_id: room.id, cause: "delegation", kind: "delegation_wait", wait_spec: { kind: "delegation", ref: result.delegation.id }, fired_at: null, voided_at: null });
  expect(delegations.getDelegationWait(ctx, result.delegation.id)).toEqual(result.wait);
  expect(store.db.query("SELECT state, waiting_on FROM work_items WHERE id = ?").get(result.delegation.from_work_item_id)).toEqual({ state: "waiting", waiting_on: JSON.stringify({ kind: "delegation", ref: result.delegation.id, since: NOW }) });
  expect(store.db.query("SELECT state, role, delegated_by, home_session_id, thread_session_id FROM work_items WHERE id = ?").get(result.delegation.to_work_item_id)).toEqual({ state: "queued", role: "review", delegated_by: result.delegation.from_work_item_id, home_session_id: room.id, thread_session_id: result.delegation.thread_session_id });
  expect(store.getSession(result.delegation.thread_session_id)).toMatchObject({ kind: "direct", thread_task_id: plan.id });
  expect(store.getSession(result.delegation.thread_session_id).participants.map((p) => p.member).sort()).toEqual([from.id, to.id].sort());
});

function recipientTurn(f: ReturnType<typeof fixture>, delegation: delegations.Delegation) {
  const message = f.store.insertMessage({ sessionId: delegation.thread_session_id, kind: "system", author: "app", body: delegation.ask });
  return f.store.createTurn({ sessionId: delegation.thread_session_id, botId: f.to.id, triggerMessageId: message.id,
    taskId: delegation.task_id, ticketId: delegation.ticket_id });
}

test("a reply satisfies the real wait and queues exactly one priority-2 result for the original work", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "审 Shot 11", expects: "review", now: NOW });
  const toTurn = recipientTurn(f, opened.delegation);
  const result = delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, answer: "Shot 11 不通过", now: "2026-09-29T08:01:00.000Z" });
  expect(result).toMatchObject({ replied: true, delegation: { status: "replied", reply_ref: `answer:${toTurn.id}` }, inbox: {
    work_item_id: opened.delegation.from_work_item_id, bot_id: f.from.id, task_id: f.plan.id, ticket_id: f.ticket.id,
    source: "delegation_reply", kind: "result", priority: 2, wakes: 1, body_snapshot: "Shot 11 不通过", state: "queued",
  } });
  expect(delegations.getDelegationWait(f.ctx, opened.delegation.id)).toMatchObject({ fired_at: null, voided_at: "2026-09-29T08:01:00.000Z", suspended_at: null });
  expect(f.store.db.query("SELECT state, waiting_on FROM work_items WHERE id = ?").get(opened.delegation.from_work_item_id)).toEqual({ state: "queued", waiting_on: null });
  const replay = delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, answer: "重复回复", now: "2026-09-29T08:02:00.000Z" });
  expect(replay.replied).toBe(false);
  expect(replay.inbox?.seq).toBe(result.inbox?.seq);
  expect(delegations.listDelegations(f.ctx, { fromWorkItemId: opened.delegation.from_work_item_id, status: "replied" })).toEqual([result.delegation]);
  expect(f.store.db.query("SELECT body_snapshot FROM inbox_items WHERE source = 'delegation_reply'").all()).toEqual([{ body_snapshot: "Shot 11 不通过" }]);
});

test("delegation validates ticket, parts and in-force requirements atomically and preserves cited identities", () => {
  const f = fixture();
  const otherPlan = f.store.openTask({ sessionId: f.room.id, title: "EP02" });
  const otherTicket = f.store.createTicket({ taskId: otherPlan.id, title: "另一个任务" });
  f.store.db.run("INSERT INTO ticket_parts (id, ticket_id, key, title, declared_by) VALUES ('shot11', ?, 'shot_11', 'Shot 11', 'user')", [f.ticket.id]);
  const planRequirement = addRequirement(f.ctx, { scope: "plan", scopeId: f.plan.id, quote: "保持背景连贯", sourceKind: "board", addedBy: "user", now: NOW });
  const partRequirement = addRequirement(f.ctx, { scope: "part", scopeId: "shot11", quote: "不要跳背景", sourceKind: "board", addedBy: "user", now: NOW });
  const unrelated = addRequirement(f.ctx, { scope: "plan", scopeId: otherPlan.id, quote: "无关要求", sourceKind: "board", addedBy: "user", now: NOW });
  const waived = addRequirement(f.ctx, { scope: "plan", scopeId: f.plan.id, quote: "已免除要求", sourceKind: "board", addedBy: "user", status: "waived", now: NOW });
  const sibling = f.store.createTicket({ taskId: f.plan.id, title: "未委派的任务" });
  const siblingRequirement = addRequirement(f.ctx, { scope: "ticket", scopeId: sibling.id, quote: "别的任务才要", sourceKind: "board", addedBy: "user", now: NOW });
  const excluded = addRequirement(f.ctx, { scope: "project", scopeId: f.room.id, quote: "这里不适用的要求", sourceKind: "board", addedBy: "user", now: NOW });
  setRequirementHere(f.ctx, excluded.id, { taskId: f.plan.id, holds: false, now: NOW });
  const inherited = addRequirement(f.ctx, { scope: "project", scopeId: f.room.id, quote: "项目常规要求", sourceKind: "board", addedBy: "user", now: NOW });
  const standing = addRequirement(f.ctx, { scope: "standing", scopeId: null, quote: "常设要求", sourceKind: "board", addedBy: "user", now: NOW });
  const input = { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "审查", expects: "review" as const, now: NOW };
  for (const invalid of [{ ticketId: otherTicket.id }, { ticketId: null, partKeys: ["shot_11"] }, { partKeys: ["shot_12"] },
    { requirementIds: ["missing"] }, { requirementIds: [unrelated.id] }, { requirementIds: [waived.id] },
    { requirementIds: [excluded.id] }, { requirementIds: [siblingRequirement.id] }, { requirementIds: [partRequirement.id] }]) {
    expect(() => delegations.delegateWork(f.ctx, { ...input, ...invalid })).toThrow();
    expect(delegations.listDelegations(f.ctx)).toEqual([]);
  }
  const result = delegations.delegateWork(f.ctx, { ...input, partKeys: ["shot_11", "shot_11"], requirementIds: [planRequirement.id, partRequirement.id, planRequirement.id, inherited.id, standing.id] });
  expect(result.delegation.part_keys).toEqual(["shot_11"]);
  expect(result.delegation.requirement_ids).toEqual([planRequirement.id, partRequirement.id, inherited.id, standing.id]);
});

test("cancelling an open delegation releases its wait with one priority-2 result and prevents a late reply", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "审查旧版本", expects: "review", now: NOW });
  const toTurn = recipientTurn(f, opened.delegation);
  const cancelled = delegations.cancelDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: f.turn.id, now: "2026-09-29T08:01:00.000Z" });
  expect(cancelled).toMatchObject({ cancelled: true, delegation: { status: "cancelled" }, inbox: {
    work_item_id: opened.delegation.from_work_item_id, source: "delegation_reply", kind: "result", priority: 2, wakes: 1,
  } });
  expect(delegations.getDelegationWait(f.ctx, opened.delegation.id)?.voided_at).toBe("2026-09-29T08:01:00.000Z");
  expect(delegations.cancelDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: f.turn.id }).cancelled).toBe(false);
  expect(delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, answer: "迟到的结果" }).replied).toBe(false);
  expect(f.store.db.query("SELECT count(*) AS n FROM inbox_items WHERE source = 'delegation_reply'").get()).toEqual({ n: 1 });
});

test("threads reuse the unordered Bot pair only within one plan and continue:true creates no wait", () => {
  const f = fixture();
  const args = { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "看一眼", expects: "answer" as const, continue: true, now: NOW };
  const first = delegations.delegateWork(f.ctx, args);
  f.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [first.delegation.to_work_item_id]);
  const second = delegations.delegateWork(f.ctx, args);
  expect(second.delegation.thread_session_id).toBe(first.delegation.thread_session_id);
  expect(second.delegation.to_work_item_id).toBe(first.delegation.to_work_item_id);
  expect(f.store.db.query("SELECT state FROM work_items WHERE id = ?").get(second.delegation.to_work_item_id)).toEqual({ state: "queued" });
  expect(second.wait).toBeNull();
  expect(f.store.db.query("SELECT state, waiting_on FROM work_items WHERE id = ?").get(first.delegation.from_work_item_id)).toEqual({ state: "running", waiting_on: null });
  const toTurn = recipientTurn(f, first.delegation);
  const reverse = delegations.delegateWork(f.ctx, { ...args, fromTurnId: toTurn.id, toBotId: f.from.id });
  expect(reverse.delegation.thread_session_id).toBe(first.delegation.thread_session_id);
  const otherPlan = f.store.openTask({ sessionId: f.room.id, title: "EP02" });
  const message = f.store.postMessage(f.room.id, { body: "另一件事" });
  const otherTurn = f.store.createTurn({ sessionId: f.room.id, botId: f.from.id, triggerMessageId: message.id, taskId: otherPlan.id });
  const different = delegations.delegateWork(f.ctx, { ...args, fromTurnId: otherTurn.id });
  expect(different.delegation.thread_session_id).not.toBe(first.delegation.thread_session_id);
  const sibling = f.store.createTicket({ taskId: f.plan.id, title: "不同任务" });
  const siblingDelegation = delegations.delegateWork(f.ctx, { ...args, ticketId: sibling.id });
  expect(siblingDelegation.delegation.thread_session_id).toBe(first.delegation.thread_session_id);
  expect(siblingDelegation.delegation.to_work_item_id).not.toBe(first.delegation.to_work_item_id);
});

test("reply results are held at the read boundary even when their delegator still has a live segment", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "审查", expects: "review", now: NOW });
  const toTurn = recipientTurn(f, opened.delegation);
  const hold = createHold(f.ctx, { scope: "bot", scopeId: f.from.id, source: "user_button", cascade: false, now: "2026-09-29T08:00:30.000Z" });
  expect(delegations.getDelegationWait(f.ctx, opened.delegation.id)).toMatchObject({ suspended_at: "2026-09-29T08:00:30.000Z", voided_at: "2026-09-29T08:00:30.000Z" });
  const replied = delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, answer: "审完了", now: "2026-09-29T08:01:00.000Z" });
  expect(replied.inbox?.state).toBe("held");
  expect(f.store.deliverInboxItems([replied.inbox!.seq], f.turn.id, 1).delivered).toEqual([]);
  expect(holdsCovering(f.ctx, { botId: f.from.id, taskId: f.plan.id })).toHaveLength(1);
  liftHold(f.ctx, hold.id, { by: "user_button", now: "2026-09-29T08:02:00.000Z" });
  expect(f.store.getInboxItem(replied.inbox!.seq)?.state).toBe("queued");
  expect(delegations.getDelegationWait(f.ctx, opened.delegation.id)).toMatchObject({ suspended_at: null, voided_at: "2026-09-29T08:01:00.000Z" });
  expect(f.store.deliverInboxItems([replied.inbox!.seq], f.turn.id, 2).delivered).toHaveLength(1);
});

test("submission replies validate durable producer lineage and reject absent submission support as a domain error", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "交付", expects: "deliverable", now: NOW });
  const toTurn = recipientTurn(f, opened.delegation);
  expect(() => delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, submissionId: "missing" })).toThrow("submission");
  // P4e owns submissions. This fixture exercises only the hand-off consumer's public lineage contract.
  f.store.db.exec(`CREATE TABLE submissions (id TEXT PRIMARY KEY, work_item_id TEXT, task_id TEXT, ticket_id TEXT,
    bot_id TEXT, turn_id TEXT, part_keys TEXT, state TEXT)`);
  f.store.db.run("INSERT INTO submissions VALUES ('wrong-producer', ?, ?, ?, ?, ?, '[]', 'in_review')", [opened.delegation.to_work_item_id, f.plan.id, f.ticket.id, f.from.id, toTurn.id]);
  expect(() => delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, submissionId: "wrong-producer" })).toThrow("submission");
  expect(delegations.getDelegation(f.ctx, opened.delegation.id).status).toBe("open");
  f.store.db.run("INSERT INTO submissions VALUES ('actual-delivery', ?, ?, ?, ?, ?, '[]', 'in_review')", [opened.delegation.to_work_item_id, f.plan.id, f.ticket.id, f.to.id, toTurn.id]);
  const result = delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, submissionId: "actual-delivery", now: "2026-09-29T08:01:00.000Z" });
  expect(result).toMatchObject({ replied: true, delegation: { status: "replied", reply_ref: "submission:actual-delivery" }, inbox: { priority: 2, body_snapshot: "Submission: actual-delivery" } });
});

test("delegation refuses unbound, readonly, absent and archived actors and cannot reply from another exact work item", () => {
  const f = fixture();
  const input = { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "审查", expects: "review" as const, now: NOW };
  const absent = f.store.createBot({ name: "不在场", duties: "其他", boundaries: "none" }).bot;
  expect(() => delegations.delegateWork(f.ctx, { ...input, toBotId: absent.id })).toThrow("present");
  expect(() => delegations.delegateWork(f.ctx, { ...input, toBotId: f.from.id })).toThrow("eligible");
  f.store.db.run("UPDATE bots SET archived_at = ? WHERE id = ?", [NOW, f.to.id]);
  expect(() => delegations.delegateWork(f.ctx, input)).toThrow("eligible");
  f.store.db.run("UPDATE bots SET archived_at = NULL WHERE id = ?", [f.to.id]);
  f.store.db.run("UPDATE turns SET mode = 'readonly' WHERE id = ?", [f.turn.id]);
  expect(() => delegations.delegateWork(f.ctx, input)).toThrow("running bound");
  f.store.db.run("UPDATE turns SET mode = 'work' WHERE id = ?", [f.turn.id]);
  const hold = createHold(f.ctx, { scope: "bot", scopeId: f.from.id, source: "user_button", now: NOW });
  expect(() => delegations.delegateWork(f.ctx, input)).toThrow("held");
  expect(delegations.listDelegations(f.ctx)).toEqual([]);
  liftHold(f.ctx, hold.id, { by: "user_button", now: NOW });
  const opened = delegations.delegateWork(f.ctx, input);
  expect(() => delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: f.turn.id, answer: "冒充" })).toThrow("only the delegated work");
  expect(() => delegations.cancelDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: "missing" })).toThrow("running bound");
  const otherTicket = f.store.createTicket({ taskId: f.plan.id, title: "不相关任务" });
  const message = f.store.postMessage(f.room.id, { body: "其他任务" });
  const wrongWorkTurn = f.store.createTurn({ sessionId: f.room.id, botId: f.to.id, triggerMessageId: message.id, taskId: f.plan.id, ticketId: otherTicket.id });
  expect(() => delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: wrongWorkTurn.id, answer: "错任务" })).toThrow("only the delegated work");
  expect(() => delegations.cancelDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: wrongWorkTurn.id })).toThrow("only a party");
  expect(delegations.getDelegation(f.ctx, opened.delegation.id).status).toBe("open");
});

test("a Bot present in the plan home is eligible from its owner's private work segment", () => {
  const f = fixture();
  f.store.setTurnStatus(f.turn.id, "completed");
  const direct = f.store.listSessions().find((s) => s.kind === "direct" && s.participants.some((p) => p.member === f.from.id) && s.participants.some((p) => p.member === "user"))!;
  const ticket = f.store.createTicket({ taskId: f.plan.id, title: "私聊里开始的任务" });
  const message = f.store.postMessage(direct.id, { body: "把规划里的审查交给审片" });
  const turn = f.store.createTurn({ sessionId: direct.id, botId: f.from.id, triggerMessageId: message.id, taskId: f.plan.id, ticketId: ticket.id });
  const result = delegations.delegateWork(f.ctx, { fromTurnId: turn.id, toBotId: f.to.id, ask: "审查", expects: "review", now: NOW });
  expect(result.delegation).toMatchObject({ task_id: f.plan.id, ticket_id: ticket.id, to_bot_id: f.to.id });
  expect(f.store.db.query("SELECT home_session_id FROM work_items WHERE id = ?").get(result.delegation.to_work_item_id)).toEqual({ home_session_id: f.room.id });
});

test("real old-schema migration and reopen preserve delegation identities, waiting and hold claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "delegations-migration-"));
  const filename = join(root, "state.sqlite");
  try {
    const old = new Database(filename, { create: true });
    old.exec(await Bun.file(join(import.meta.dir, "fixtures", "schema-pre-quotes.sql")).text());
    old.close();
    const f = fixture(filename);
    const result = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "等真实结果", expects: "answer", now: NOW });
    createHold(f.ctx, { scope: "bot", scopeId: f.from.id, source: "user_button", now: NOW });
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = new Store({ filename });
    stores.push(reopened);
    const ctx = { ...f.ctx, db: reopened.db, commit: <T>(work: () => T): T => reopened.transaction(work) };
    expect(delegations.getDelegation(ctx, result.delegation.id)).toEqual(result.delegation);
    expect(delegations.getDelegationWait(ctx, result.delegation.id)).toMatchObject({ suspended_at: NOW, fired_at: null, work_item_id: result.delegation.from_work_item_id });
    expect(claimCheckBack(ctx, result.wait!.id, new Date("2026-10-06T08:00:00.000Z"))).toBeNull();
    expect(reopened.getSession(result.delegation.thread_session_id)).toMatchObject({ kind: "direct", thread_task_id: f.plan.id });
    expect(reopened.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(reopened.db.query("SELECT state FROM work_items WHERE id = ?").get(result.delegation.from_work_item_id)).toEqual({ state: "waiting" });
  } finally {
    for (const store of stores.splice(0)) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a hand-off supersedes its unread ask without consuming another request for the same work", () => {
  const f = fixture();
  const input = { fromTurnId: f.turn.id, toBotId: f.to.id, expects: "answer" as const, continue: true, now: NOW };
  const first = delegations.delegateWork(f.ctx, { ...input, ask: "旧请求" });
  const second = delegations.delegateWork(f.ctx, { ...input, ask: "仍要回答的请求" });
  delegations.cancelDelegation(f.ctx, { delegationId: first.delegation.id, fromTurnId: f.turn.id, now: "2026-09-29T08:01:00.000Z" });
  expect(f.store.getInboxItem(first.inbox.seq)?.state).toBe("superseded");
  expect(f.store.getInboxItem(second.inbox.seq)?.state).toBe("queued");
});

test("a turn-only hold continues covering its delegation result after the delegating segment ended", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "等结果", expects: "answer", now: NOW });
  f.store.setTurnStatus(f.turn.id, "completed");
  createHold(f.ctx, { scope: "turn", scopeId: f.turn.id, source: "user_button", cascade: false, now: NOW });
  const toTurn = recipientTurn(f, opened.delegation);
  const result = delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, answer: "结果来了", now: "2026-09-29T08:01:00.000Z" });
  expect(result.inbox?.state).toBe("held");
  expect(f.store.getInboxItem(result.inbox!.seq)?.turn_id).toBe(f.turn.id);
});

test("a result routes to the current exact-work segment and obeys its hold instead of only its original source", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "等结果", expects: "answer", now: NOW });
  f.store.setTurnStatus(f.turn.id, "completed");
  const trigger = f.store.postMessage(f.room.id, { body: "继续这件工作" });
  const current = f.store.createTurn({ sessionId: f.room.id, botId: f.from.id, triggerMessageId: trigger.id, taskId: f.plan.id, ticketId: f.ticket.id });
  const toTurn = recipientTurn(f, opened.delegation);
  const hold = createHold(f.ctx, { scope: "turn", scopeId: current.id, source: "user_button", cascade: false, now: NOW });
  const result = delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, answer: "结果到了", now: "2026-09-29T08:01:00.000Z" });
  expect(result.inbox).toMatchObject({ state: "held", turn_id: current.id, source_turn_id: f.turn.id });
  expect(f.store.deliverInboxItems([result.inbox!.seq], current.id, 1).delivered).toEqual([]);
  liftHold(f.ctx, hold.id, { by: "user_button", now: "2026-09-29T08:02:00.000Z" });
  expect(f.store.deliverInboxItems([result.inbox!.seq], current.id, 2).delivered).toHaveLength(1);
});

test("adoption keeps source-turn hold provenance and lifting the destination hold alone cannot release it", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "等结果", expects: "answer", now: NOW });
  f.store.setTurnStatus(f.turn.id, "completed");
  const trigger = f.store.postMessage(f.room.id, { body: "下一段" });
  const current = f.store.createTurn({ sessionId: f.room.id, botId: f.from.id, triggerMessageId: trigger.id, taskId: f.plan.id, ticketId: f.ticket.id });
  const toTurn = recipientTurn(f, opened.delegation);
  const result = delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, answer: "尚未读到的结果" });
  expect(result.inbox).toMatchObject({ state: "queued", turn_id: current.id, source_turn_id: f.turn.id });
  const sourceHold = createHold(f.ctx, { scope: "turn", scopeId: f.turn.id, source: "user_button", cascade: false, now: NOW });
  const targetHold = createHold(f.ctx, { scope: "turn", scopeId: current.id, source: "user_button", cascade: false, now: NOW });
  expect(f.store.deliverInboxItems([result.inbox!.seq], current.id, 1).delivered).toEqual([]);
  liftHold(f.ctx, targetHold.id, { by: "user_button", now: "2026-09-29T08:02:00.000Z" });
  expect(f.store.getInboxItem(result.inbox!.seq)?.state).toBe("held");
  expect(f.store.adoptWaitingInbox({ botId: f.from.id, sessionId: f.room.id, turnId: current.id })).toEqual([]);
  liftHold(f.ctx, sourceHold.id, { by: "user_button", now: "2026-09-29T08:03:00.000Z" });
  f.store.setTurnStatus(current.id, "completed");
  const nextTrigger = f.store.postMessage(f.room.id, { body: "再下一段" });
  const next = f.store.createTurn({ sessionId: f.room.id, botId: f.from.id, triggerMessageId: nextTrigger.id, taskId: f.plan.id, ticketId: f.ticket.id });
  expect(f.store.adoptWaitingInbox({ botId: f.from.id, sessionId: f.room.id, turnId: next.id })).toMatchObject([{ source_turn_id: f.turn.id, turn_id: next.id }]);
  const again = createHold(f.ctx, { scope: "turn", scopeId: f.turn.id, source: "user_button", cascade: false, now: NOW });
  expect(f.store.deliverInboxItems([result.inbox!.seq], next.id, 2).delivered).toEqual([]);
  liftHold(f.ctx, again.id, { by: "user_button", now: "2026-09-29T08:04:00.000Z" });
  expect(f.store.deliverInboxItems([result.inbox!.seq], next.id, 3).delivered).toHaveLength(1);
});

test("direct delivery into a held actual target cannot bypass its hold by naming an unheld stored route", () => {
  const f = fixture();
  const item = f.store.queueInboxItem({ botId: f.from.id, sessionId: f.room.id, turnId: f.turn.id,
    taskId: f.plan.id, ticketId: f.ticket.id, messageId: null, author: f.to.id, body: "尚未归到新段的结果",
    source: "delegation_reply", kind: "result", priority: 2 });
  f.store.setTurnStatus(f.turn.id, "completed");
  const trigger = f.store.postMessage(f.room.id, { body: "新段" });
  const actual = f.store.createTurn({ sessionId: f.room.id, botId: f.from.id, triggerMessageId: trigger.id, taskId: f.plan.id, ticketId: f.ticket.id });
  const hold = createHold(f.ctx, { scope: "turn", scopeId: actual.id, source: "user_button", cascade: false, now: NOW });
  const delivered = f.store.deliverInboxItems([item.seq], actual.id, 1);
  expect(delivered.delivered).toEqual([]);
  expect(delivered.held).toHaveLength(1);
  liftHold(f.ctx, hold.id, { by: "user_button", now: "2026-09-29T08:01:00.000Z" });
  expect(f.store.deliverInboxItems([item.seq], actual.id, 2).delivered).toHaveLength(1);
});

test("explicit cascade targets in held_scopes block a recipient reply and keep both waits and asks held", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "等审片", expects: "review", now: NOW });
  const toTurn = recipientTurn(f, opened.delegation);
  const hold = createHold(f.ctx, { scope: "bot", scopeId: f.from.id, source: "user_button", cascade: true,
    targets: [{ scope: "bot_plan", id: `${f.to.id}:${f.plan.id}` }], now: NOW });
  expect(() => delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, answer: "不能越过连带叫停" })).toThrow("held");
  expect(delegations.getDelegation(f.ctx, opened.delegation.id).status).toBe("open");
  expect(delegations.getDelegationWait(f.ctx, opened.delegation.id)?.suspended_at).toBe(NOW);
  expect(f.store.deliverInboxItems([opened.inbox.seq], toTurn.id, 1).delivered).toEqual([]);
  liftHold(f.ctx, hold.id, { by: "user_button", now: "2026-09-29T08:01:00.000Z" });
  expect(delegations.getDelegationWait(f.ctx, opened.delegation.id)).toMatchObject({ suspended_at: null, voided_at: null });
  expect(delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: toTurn.id, answer: "恢复后交回" }).replied).toBe(true);
});

test("thread reuse refuses same-plan directs with an extra present user or Bot", () => {
  const f = fixture();
  const input = { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "仍需精确两人线程", expects: "answer" as const, continue: true, now: NOW };
  const first = delegations.delegateWork(f.ctx, input);
  f.store.db.run("INSERT INTO session_participants (session_id, member, joined_at) VALUES (?, 'user', ?)", [first.delegation.thread_session_id, NOW]);
  const second = delegations.delegateWork(f.ctx, input);
  expect(second.delegation.thread_session_id).not.toBe(first.delegation.thread_session_id);
  const extra = f.store.createBot({ name: "第三位", duties: "旁观", boundaries: "none" }).bot;
  f.store.db.run("INSERT INTO session_participants (session_id, member, joined_at) VALUES (?, ?, ?)", [second.delegation.thread_session_id, extra.id, NOW]);
  const third = delegations.delegateWork(f.ctx, input);
  expect(third.delegation.thread_session_id).not.toBe(second.delegation.thread_session_id);
  expect(f.store.getSession(third.delegation.thread_session_id).participants.map((p) => p.member).sort()).toEqual([f.from.id, f.to.id].sort());
});

test("invalid continuation or timestamp is rejected before creating work or waits", () => {
  const f = fixture();
  const input = { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "审查", expects: "review" as const };
  // Malformed JSON can reach the domain through an untyped tool boundary.
  const malformed: Parameters<typeof delegations.delegateWork>[1] = JSON.parse(JSON.stringify({ ...input, continue: "false" }));
  expect(() => delegations.delegateWork(f.ctx, malformed)).toThrow("continue");
  expect(() => delegations.delegateWork(f.ctx, { ...input, now: "not-a-date" })).toThrow("now");
  expect(delegations.listDelegations(f.ctx)).toEqual([]);
});

test("archiving a recipient cancels its incoming hand-offs atomically and wakes the original sender once under holds", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "尚未返回的工作", expects: "answer", now: NOW });
  f.store.setTurnStatus(f.turn.id, "completed");
  const hold = createHold(f.ctx, { scope: "bot", scopeId: f.from.id, source: "user_button", now: NOW });
  const result = delegations.cancelDelegationsForBot(f.ctx, { botId: f.to.id, now: "2026-09-29T08:01:00.000Z" });
  expect(result.delegations).toMatchObject([{ id: opened.delegation.id, status: "cancelled", reply_ref: `bot_archived:${f.to.id}` }]);
  expect(result.inbox).toMatchObject([{ bot_id: f.from.id, work_item_id: opened.delegation.from_work_item_id,
    source: "delegation_reply", priority: 2, wakes: 1, state: "held", source_turn_id: f.turn.id }]);
  expect(delegations.getDelegationWait(f.ctx, opened.delegation.id)).toMatchObject({ fired_at: null, suspended_at: null, voided_at: "2026-09-29T08:01:00.000Z" });
  expect(f.store.getInboxItem(opened.inbox.seq)?.state).toBe("superseded");
  expect(delegations.cancelDelegationsForBot(f.ctx, { botId: f.to.id })).toEqual({ delegations: [], inbox: [] });
  liftHold(f.ctx, hold.id, { by: "user_button" });
  expect(f.store.getInboxItem(result.inbox[0]!.seq)?.state).toBe("queued");
});

test("archiving a delegator also cancels its outgoing requests without waking the archived Bot or another request", () => {
  const f = fixture();
  const first = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "归档前派出去的工作", expects: "answer", now: NOW });
  const toTurn = recipientTurn(f, first.delegation);
  const reverse = delegations.delegateWork(f.ctx, { fromTurnId: toTurn.id, toBotId: f.from.id, ask: "等导演答复", expects: "answer", now: NOW });
  const result = delegations.cancelDelegationsForBot(f.ctx, { botId: f.from.id, now: "2026-09-29T08:01:00.000Z" });
  expect(result.delegations.map((row) => row.id).sort()).toEqual([first.delegation.id, reverse.delegation.id].sort());
  expect(result.inbox.find((row) => row.bot_id === f.from.id)?.wakes).toBe(0);
  expect(result.inbox.find((row) => row.bot_id === f.to.id)?.wakes).toBe(1);
  expect(delegations.getDelegationWait(f.ctx, first.delegation.id)?.voided_at).toBe("2026-09-29T08:01:00.000Z");
  expect(delegations.getDelegationWait(f.ctx, reverse.delegation.id)?.voided_at).toBe("2026-09-29T08:01:00.000Z");
});

test("clearing a delegation thread cancels its requests with durable priority-2 results but never wakes either Bot", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "即将清空的委派", expects: "answer", now: NOW });
  const result = delegations.cancelDelegationsForSession(f.ctx, { sessionId: opened.delegation.thread_session_id, now: "2026-09-29T08:01:00.000Z" });
  expect(result.delegations).toMatchObject([{ id: opened.delegation.id, status: "cancelled", reply_ref: `session_cleared:${opened.delegation.thread_session_id}` }]);
  expect(result.inbox).toMatchObject([{ priority: 2, wakes: 0, work_item_id: opened.delegation.from_work_item_id }]);
  expect(f.store.getInboxItem(opened.inbox.seq)?.state).toBe("superseded");
  expect(delegations.getDelegationWait(f.ctx, opened.delegation.id)).toMatchObject({ voided_at: "2026-09-29T08:01:00.000Z", suspended_at: null });
  expect(delegations.cancelDelegationsForSession(f.ctx, { sessionId: opened.delegation.thread_session_id })).toEqual({ delegations: [], inbox: [] });
});

test("clearing the original home cancels only its durable hand-offs and leaves unrelated plans open", () => {
  const f = fixture();
  const first = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "将被清空的规划", expects: "answer", now: NOW });
  const otherRoom = f.store.createGroup({ name: "另一个会话", members: [f.from.id, f.to.id] });
  const otherPlan = f.store.openTask({ sessionId: otherRoom.id, title: "其他规划" });
  const otherMessage = f.store.postMessage(otherRoom.id, { body: "别的事" });
  const otherTurn = f.store.createTurn({ sessionId: otherRoom.id, botId: f.from.id, triggerMessageId: otherMessage.id, taskId: otherPlan.id });
  const other = delegations.delegateWork(f.ctx, { fromTurnId: otherTurn.id, toBotId: f.to.id, ask: "不能误取消", expects: "answer", now: NOW });
  const result = delegations.cancelDelegationsForSession(f.ctx, { sessionId: f.room.id, now: "2026-09-29T08:01:00.000Z" });
  expect(result.delegations.map((row) => row.id)).toEqual([first.delegation.id]);
  expect(result.inbox[0]?.wakes).toBe(0);
  expect(delegations.getDelegation(f.ctx, other.delegation.id).status).toBe("open");
});

test("delegation descendants follow durable reused-work edges and stop safely at cycles and closed work", () => {
  const f = fixture();
  const third = f.store.createBot({ name: "制片", duties: "统筹", boundaries: "none" }).bot;
  f.store.db.run("INSERT INTO session_participants (session_id, member, joined_at) VALUES (?, ?, ?)", [f.room.id, third.id, NOW]);
  const input = { ask: "继续委派", expects: "answer" as const, continue: true, now: NOW };
  const aToB = delegations.delegateWork(f.ctx, { ...input, fromTurnId: f.turn.id, toBotId: f.to.id });
  const bTurn = recipientTurn(f, aToB.delegation);
  const bToC = delegations.delegateWork(f.ctx, { ...input, fromTurnId: bTurn.id, toBotId: third.id });
  const cMessage = f.store.insertMessage({ sessionId: bToC.delegation.thread_session_id, kind: "system", author: "app", body: "继续" });
  const cTurn = f.store.createTurn({ sessionId: bToC.delegation.thread_session_id, botId: third.id, triggerMessageId: cMessage.id, taskId: f.plan.id, ticketId: f.ticket.id });
  const cToB = delegations.delegateWork(f.ctx, { ...input, fromTurnId: cTurn.id, toBotId: f.to.id });
  expect(cToB.delegation.to_work_item_id).toBe(aToB.delegation.to_work_item_id);
  const descendants = delegations.delegationDescendants(f.ctx, [bToC.delegation.to_work_item_id]);
  expect(descendants.map((work) => work.id)).toEqual([aToB.delegation.to_work_item_id]);
  expect(descendants[0]).toMatchObject({ bot_id: f.to.id, task_id: f.plan.id, ticket_id: f.ticket.id });
  expect(delegations.delegationDescendants(f.ctx, [aToB.delegation.from_work_item_id]).map((work) => work.id).sort()).toEqual([aToB.delegation.to_work_item_id, bToC.delegation.to_work_item_id].sort());
  expect(delegations.delegationDescendants(f.ctx, ["missing", "missing"])).toEqual([]);
  delegations.cancelDelegation(f.ctx, { delegationId: cToB.delegation.id, fromTurnId: cTurn.id });
  expect(delegations.delegationDescendants(f.ctx, [bToC.delegation.to_work_item_id])).toEqual([]);
  f.store.db.run("UPDATE work_items SET state = 'closed' WHERE id = ?", [bToC.delegation.to_work_item_id]);
  expect(delegations.delegationDescendants(f.ctx, [aToB.delegation.from_work_item_id]).map((work) => work.id)).toEqual([aToB.delegation.to_work_item_id]);
});

test("lifecycle cancellation rolls back all affected hand-offs if result persistence fails", () => {
  const f = fixture();
  const first = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "第一条", expects: "answer", continue: true, now: NOW });
  const second = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "第二条", expects: "answer", now: NOW });
  f.store.db.exec(`CREATE TRIGGER reject_lifecycle_result BEFORE INSERT ON inbox_items
    WHEN NEW.source = 'delegation_reply' AND NEW.body_snapshot LIKE '%第二条%'
    BEGIN SELECT RAISE(ABORT, 'injected-result-failure'); END`);
  expect(() => delegations.cancelDelegationsForBot(f.ctx, { botId: f.to.id, now: "2026-09-29T08:01:00.000Z" })).toThrow("injected-result-failure");
  expect(delegations.getDelegation(f.ctx, first.delegation.id).status).toBe("open");
  expect(delegations.getDelegation(f.ctx, second.delegation.id).status).toBe("open");
  expect(f.store.getInboxItem(first.inbox.seq)?.state).toBe("queued");
  expect(delegations.getDelegationWait(f.ctx, second.delegation.id)?.voided_at).toBeNull();
  expect(f.store.db.query("SELECT 1 FROM inbox_items WHERE source = 'delegation_reply'").get()).toBeNull();
});

test("malformed descendants input is refused and cross-plan edge corruption never widens the cascade", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "有效边", expects: "answer", now: NOW });
  const malformed: string[] = JSON.parse('[7]');
  expect(() => delegations.delegationDescendants(f.ctx, malformed)).toThrow("fromWorkItemIds");
  const otherPlan = f.store.openTask({ sessionId: f.room.id, title: "不相关规划" });
  f.store.db.run("UPDATE delegations SET task_id = ? WHERE id = ?", [otherPlan.id, opened.delegation.id]);
  expect(delegations.delegationDescendants(f.ctx, [opened.delegation.from_work_item_id])).toEqual([]);
});

test("cascade scope snapshots include waiting roots and only durable descendants, not another Bot's unrelated work", () => {
  const f = fixture();
  const delegated = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "连带停的工作", expects: "answer", now: NOW });
  f.store.setTurnStatus(f.turn.id, "completed");
  const unrelated = f.store.openTask({ sessionId: f.room.id, title: "另一件事" });
  const message = f.store.postMessage(f.room.id, { body: "另一件事" });
  f.store.createTurn({ sessionId: f.room.id, botId: f.to.id, triggerMessageId: message.id, taskId: unrelated.id });
  const expected = [{ scope: "bot_plan" as const, id: `${f.to.id}:${f.plan.id}` }];
  for (const subject of [{ scope: "bot", id: f.from.id }, { scope: "bot_plan", id: `${f.from.id}:${f.plan.id}` },
    { scope: "turn", id: f.turn.id }]) {
    const input: Parameters<typeof delegations.delegationCascadeTargets>[1] = JSON.parse(JSON.stringify(subject));
    expect(delegations.delegationCascadeTargets(f.ctx, input)).toEqual(expected);
  }
  expect(delegations.delegationCascadeTargets(f.ctx, { scope: "global", id: null })).toEqual([]);
  expect(delegations.delegationCascadeTargets(f.ctx, { scope: "ticket", id: f.ticket.id })).toEqual([]);
  expect(delegations.delegationCascadeTargets(f.ctx, { scope: "plan", id: f.plan.id })).toEqual([]);
  expect(delegations.delegationCascadeTargets(f.ctx, { scope: "session", id: f.room.id })).toEqual([]);
  expect(() => delegations.delegationCascadeTargets(f.ctx, { scope: "bot_plan", id: `${f.from.id}:missing` })).toThrow();
  expect(() => delegations.delegationCascadeTargets(f.ctx, { scope: "turn", id: "missing" })).toThrow();
  expect(delegations.getDelegation(f.ctx, delegated.delegation.id).status).toBe("open");
});

test("cascade targets retain an ended closed source's open edges across tickets and deduplicate downstream Bot-plan scopes", () => {
  const f = fixture();
  const sibling = f.store.createTicket({ taskId: f.plan.id, title: "下游任务" });
  const input = { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "下游协作", expects: "answer" as const, continue: true, now: NOW };
  const first = delegations.delegateWork(f.ctx, input);
  delegations.delegateWork(f.ctx, { ...input, ticketId: sibling.id });
  f.store.setTurnStatus(f.turn.id, "completed");
  f.store.db.run("UPDATE work_items SET state = 'closed' WHERE id = ?", [first.delegation.from_work_item_id]);
  const expected = [{ scope: "bot_plan" as const, id: `${f.to.id}:${f.plan.id}` }];
  expect(delegations.delegationCascadeTargets(f.ctx, { scope: "turn", id: f.turn.id })).toEqual(expected);
  expect(delegations.delegationCascadeTargets(f.ctx, { scope: "ticket", id: f.ticket.id })).toEqual(expected);
  expect(delegations.delegationCascadeTargets(f.ctx, { scope: "bot_plan", id: `${f.from.id}:${f.plan.id}` })).toEqual(expected);
});

test("delegating to already-live exact work reaches its current boundary inbox without reopening its segment", () => {
  const f = fixture();
  const trigger = f.store.postMessage(f.room.id, { body: "审片已有任务" });
  const current = f.store.createTurn({ sessionId: f.room.id, botId: f.to.id, triggerMessageId: trigger.id, taskId: f.plan.id, ticketId: f.ticket.id });
  const request = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "现有工作里追加检查", expects: "answer", continue: true, now: NOW });
  expect(request.inbox.turn_id).toBe(current.id);
  expect(f.store.queuedForTurn(current.id)).toMatchObject([{ seq: request.inbox.seq, work_item_id: request.delegation.to_work_item_id }]);
  expect(f.store.db.query("SELECT state FROM work_items WHERE id = ?").get(request.delegation.to_work_item_id)).toEqual({ state: "running" });
  expect(f.store.listLiveTurns({ botId: f.to.id })).toHaveLength(1);
  const sibling = f.store.createTicket({ taskId: f.plan.id, title: "待下一段的其他任务" });
  const different = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ticketId: sibling.id, ask: "别的任务不能投错段", expects: "answer", continue: true, now: NOW });
  expect(different.inbox.turn_id).toBeNull();
  const hold = createHold(f.ctx, { scope: "turn", scopeId: current.id, source: "user_button", cascade: false, now: NOW });
  const held = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "不能越过接收段叫停", expects: "answer", continue: true, now: NOW });
  expect(held.inbox).toMatchObject({ state: "held", turn_id: current.id });
  expect(f.store.deliverInboxItems([held.inbox.seq], current.id, 1).delivered).toEqual([]);
  liftHold(f.ctx, hold.id, { by: "user_button" });
});

test("a continue:true delegation result queues its idle sender for dispatch after an answered segment", () => {
  const f = fixture();
  const opened = delegations.delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: f.to.id, ask: "稍后交回答案", expects: "answer", continue: true, now: NOW });
  expect(opened.wait).toBeNull();
  const ended = f.store.finishWork({ turnId: f.turn.id, reason: "answered" });
  expect(ended).toMatchObject({ ended: true, state: "idle" });
  f.store.setTurnStatus(f.turn.id, "completed");
  const helper = recipientTurn(f, opened.delegation);
  const result = delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: helper.id, answer: "稍后的答案", now: "2026-09-29T08:01:00.000Z" });
  expect(result.inbox).toMatchObject({ priority: 2, wakes: 1, work_item_id: opened.delegation.from_work_item_id });
  expect(f.store.dispatchableWork().map((work) => work.id)).toContain(opened.delegation.from_work_item_id);
  expect(f.store.db.query("SELECT state FROM work_items WHERE id = ?").get(opened.delegation.from_work_item_id)).toEqual({ state: "queued" });
  expect(delegations.replyDelegation(f.ctx, { delegationId: opened.delegation.id, fromTurnId: helper.id, answer: "重复答案" }).replied).toBe(false);
  expect(f.store.db.query("SELECT count(*) AS n FROM inbox_items WHERE source = 'delegation_reply'").get()).toEqual({ n: 1 });
});

test("an unresolved delegation is an event wait, never a clock claim even after a week", () => {
  const { ctx, to, turn } = fixture();
  const result = delegations.delegateWork(ctx, { fromTurnId: turn.id, toBotId: to.id, ask: "等审查", expects: "review", now: NOW });
  expect(claimCheckBack(ctx, result.wait!.id, new Date("2026-10-06T08:00:00.000Z"))).toBeNull();
  expect(delegations.getDelegationWait(ctx, result.delegation.id)).toMatchObject({ fired_at: null, voided_at: null });
});
