import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { KeyCache, type StoreContext } from "./shared";
import { Transactions } from "./transactions";
import { endAfterSubmit, finishWork, segmentLastWord } from "./end-contract";
import { createHold, holdsCovering } from "./holds";
import { HttpError } from "../errors";
import { delegateWork, getDelegation, getDelegationWait } from "./delegations";
import { queueInboxItem, deliverInboxItems, getInboxItem } from "./inbox";
import { recordWorkEvent } from "./work-events";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

/**
 * The Bot has said something to you in this segment, as nearly every segment does. The other rules are
 * weighed with it; a segment your line opened in your direct and ended with nothing said is its own case.
 */
function replied(store: Store, turn: { id: string; session_id: string; bot_id: string }) {
  store.insertMessage({ sessionId: turn.session_id, turnId: turn.id, kind: "bot", author: turn.bot_id, body: "The report is written." });
}

function fixture(status: "todo" | "doing" | "review" | "done" | "parked" = "doing") {
  const store = new Store();
  stores.push(store);
  // Pinned to the supervisor's level: from level 5 a ticket handed over is no longer its producer's obligation (ADR 0046).
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '4')");
  const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" }).bot;
  const room = store.createDirect("user", bot.id);
  const plan = store.openTask({ sessionId: room.id, title: "Report" });
  const ticket = store.createTicket({ taskId: plan.id, title: "Draft", status });
  const line = store.postMessage(room.id, { body: "Write the report" });
  const turn = store.createTurn({ sessionId: room.id, botId: bot.id, triggerMessageId: line.id, taskId: plan.id, ticketId: ticket.id });
  replied(store, turn);
  const ctx: StoreContext = {
    db: store.db, keys: new KeyCache({ get: async () => null, set: async () => {}, delete: async () => {} }, store.db),
    commit: (work) => store.transaction(work), tx: new Transactions(store.db), inboxRoot: "", activeStages: new Set(),
    keyPlan: null, legacy: { copiedKey: false },
  };
  const itemId = store.db.query<{ work_item_id: string }, [string]>("SELECT work_item_id FROM turns WHERE id = ?").get(turn.id)!.work_item_id;
  return { store, ctx, bot, room, plan, ticket, line, turn, itemId };
}

test("the unfinished-obligations bounce sends a Bot waiting on another Bot to delegate or nothing_new, not to blocked", () => {
  // Read as "what blocks you", a Bot waiting on a reviewer ended blocked, and its wait became a question card to the user.
  const f = fixture();
  const bounce = finishWork(f.ctx, { turnId: f.turn.id, reason: "done" }).bounce!;
  expect(bounce).toContain("delegate");
  expect(bounce).toContain("nothing_new");
  expect(bounce).toMatch(/blocked is only for .*the user/);
  expect(bounce).not.toContain("what blocks you");
});

test("done cannot orally close a doing ticket: one persisted bounce, then honest nothing_new without terminating the turn", () => {
  const f = fixture();
  const first = finishWork(f.ctx, { turnId: f.turn.id, reason: "done" });
  expect(first).toMatchObject({ ended: false, code: "unfinished_obligations", obligations: { tickets: [{ id: f.ticket.id, status: "doing" }] } });
  expect(first.bounce).toContain(f.ticket.id);
  expect(f.store.db.query("SELECT status, end_reason FROM turns WHERE id = ?").get(f.turn.id)).toEqual({ status: "running", end_reason: null });
  expect(f.store.db.query("SELECT state FROM work_items WHERE id = ?").get(f.itemId)).toEqual({ state: "running" });
  expect(f.store.listWorkEvents({ kind: "end.rejected" })).toHaveLength(1);
  const retry = finishWork(f.ctx, { turnId: f.turn.id, reason: "done" });
  expect(retry).toMatchObject({ ended: true, endReason: "nothing_new", state: "idle" });
  expect(f.store.db.query("SELECT status, end_reason FROM turns WHERE id = ?").get(f.turn.id)).toEqual({ status: "running", end_reason: "nothing_new" });
  expect(f.store.getTicket(f.ticket.id).status).toBe("doing");
});

function errorCode(work: () => unknown): string {
  try { work(); } catch (error) { if (error instanceof HttpError) return error.code; throw error; }
  throw new Error("expected domain refusal");
}

test("a blocked ending read as only asking an OK to go on bounces once; asked again, or with no bounce left, it goes to the user (ADR 0058)", () => {
  const f = fixture();
  const ask = "确认关键帧板没问题后我再开始生成视频";
  const first = finishWork(f.ctx, { turnId: f.turn.id, reason: "blocked", needsFromUser: ask }, { goAhead: true });
  expect(first).toMatchObject({ ended: false, code: "asks_go_ahead" });
  expect(first.bounce).toContain(`「${ask}」`);
  expect(f.store.goAheadRefused(f.turn.id)).toBe(true);
  // Told once: the same question again is the user's to answer.
  const again = finishWork(f.ctx, { turnId: f.turn.id, reason: "blocked", needsFromUser: ask }, { goAhead: true });
  expect(again).toMatchObject({ ended: true, endReason: "blocked", ask: { body: ask } });

  // Two bounces already spent this segment: the question goes up rather than the work ending needing attention.
  const g = fixture();
  for (const code of ["inbox_unacknowledged", "unfinished_obligations"]) {
    recordWorkEvent(g.ctx, { kind: "end.rejected", actor: "app", turnId: g.turn.id, payload: { code } });
  }
  expect(finishWork(g.ctx, { turnId: g.turn.id, reason: "blocked", needsFromUser: ask }, { goAhead: true }))
    .toMatchObject({ ended: true, endReason: "blocked", ask: { body: ask } });
});

test("end reasons validate mandatory fields before writes and bound work cannot bypass a hold", () => {
  const f = fixture();
  for (const invalid of [{ reason: "maybe" }, { reason: "blocked" }, { reason: "blocked", needsFromUser: " " },
    { reason: "gave_up" }, { reason: "answered", note: 12 }, { reason: "answered", answer: {} }]) {
    expect(errorCode(() => finishWork(f.ctx, { turnId: f.turn.id, ...invalid }))).toBe("invalid_args");
    expect(f.store.listWorkEvents({ kind: "work.ended" })).toEqual([]);
  }
  const hold = createHold(f.ctx, { scope: "bot", scopeId: f.bot.id, source: "user_button" });
  expect(errorCode(() => finishWork(f.ctx, { turnId: f.turn.id, reason: "answered" }))).toBe("held");
  expect(f.store.db.query("SELECT state FROM work_items WHERE id = ?").get(f.itemId)).toEqual({ state: "running" });
  expect(holdsCovering(f.ctx, { botId: f.bot.id }).map((h) => h.id)).toEqual([hold.id]);
  const userLine = f.store.postMessage(f.room.id, { body: "What is the status?" });
  const readonly = f.store.createTurn({ sessionId: f.room.id, botId: f.bot.id, triggerMessageId: userLine.id, mode: "readonly" });
  expect(finishWork(f.ctx, { turnId: readonly.id, reason: "answered" })).toMatchObject({ ended: true, endReason: "answered", workItemId: null });
  expect(f.store.db.query("SELECT state FROM work_items WHERE id = ?").get(f.itemId)).toEqual({ state: "running" });
  expect(holdsCovering(f.ctx, { botId: f.bot.id }).map((h) => h.id)).toEqual([hold.id]);
  expect(errorCode(() => finishWork(f.ctx, { turnId: readonly.id, reason: "blocked", needsFromUser: "Resume work" }))).toBe("readonly");
});

test("the outcome table closes a desk or completed ticket, blocks explicit blockers, and never advances a ticket", () => {
  const completed = fixture("done");
  expect(finishWork(completed.ctx, { turnId: completed.turn.id, reason: "done" })).toMatchObject({ ended: true, endReason: "done", state: "closed" });
  expect(completed.store.db.query("SELECT state, closed_at FROM work_items WHERE id = ?").get(completed.itemId)).toMatchObject({ state: "closed", closed_at: expect.any(String) });
  const parked = fixture("parked");
  expect(finishWork(parked.ctx, { turnId: parked.turn.id, reason: "done" })).toMatchObject({ state: "closed" });
  const answered = fixture();
  expect(finishWork(answered.ctx, { turnId: answered.turn.id, reason: "answered" })).toMatchObject({ endReason: "answered", state: "idle" });
  const blocked = fixture();
  expect(finishWork(blocked.ctx, { turnId: blocked.turn.id, reason: "blocked", needsFromUser: "Choose the final title" })).toMatchObject({ state: "blocked", ask: { body: "Choose the final title" } });
  expect(blocked.store.getTicket(blocked.ticket.id).status).toBe("doing");
  const gaveUp = fixture();
  expect(finishWork(gaveUp.ctx, { turnId: gaveUp.turn.id, reason: "gave_up", note: "Cannot render on this machine" })).toMatchObject({ state: "blocked", notice: { code: "gave_up", body: "Cannot render on this machine" } });
  expect(gaveUp.store.listWorkEvents({ kind: "quality.gave_up" })).toHaveLength(1);
  const desk = fixture();
  desk.store.db.run("UPDATE turns SET status = 'completed', end_reason = 'answered' WHERE id = ?", [desk.turn.id]);
  const line = desk.store.postMessage(desk.room.id, { body: "Hello" });
  const turn = desk.store.createTurn({ sessionId: desk.room.id, botId: desk.bot.id, triggerMessageId: line.id, taskId: null, ticketId: null });
  replied(desk.store, turn);
  expect(finishWork(desk.ctx, { turnId: turn.id, reason: "answered" })).toMatchObject({ ended: true, state: "closed", endReason: "answered" });
});

test("an actual open delegation wait is preserved without a done bounce, while a dangling waiting flag is not fabricated into a wait", () => {
  const f = fixture();
  const other = f.store.createBot({ name: "Reader", duties: "review", boundaries: "none" }).bot;
  const room = f.store.createGroup({ name: "Review", members: [f.bot.id, other.id] });
  const line = f.store.postMessage(room.id, { body: "Review this" });
  f.store.db.run("UPDATE turns SET session_id = ? WHERE id = ?", [room.id, f.turn.id]);
  const opened = delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: other.id, ask: line.body, expects: "answer" });
  const outcome = finishWork(f.ctx, { turnId: f.turn.id, reason: "done" });
  expect(outcome).toMatchObject({ ended: true, endReason: "done", state: "waiting", obligations: { outgoingDelegations: [opened.delegation.id], waits: [opened.wait!.id] } });
  expect(outcome.bounce).toBeUndefined();
  expect(getDelegationWait(f.ctx, opened.delegation.id)?.voided_at).toBeNull();
  expect(f.store.db.query("SELECT waiting_on FROM work_items WHERE id = ?").get(f.itemId)).toEqual({ waiting_on: JSON.stringify({ kind: "delegation", ref: opened.delegation.id, since: opened.delegation.created_at }) });
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "done" })).toEqual(outcome);
  const waitingAnswer = fixture();
  const peer = waitingAnswer.store.createBot({ name: "Peer", duties: "answer", boundaries: "none" }).bot;
  const peerRoom = waitingAnswer.store.createGroup({ name: "Waiting", members: [waitingAnswer.bot.id, peer.id] });
  waitingAnswer.store.db.run("UPDATE turns SET session_id = ? WHERE id = ?", [peerRoom.id, waitingAnswer.turn.id]);
  delegateWork(waitingAnswer.ctx, { fromTurnId: waitingAnswer.turn.id, toBotId: peer.id, ask: "Answer", expects: "answer" });
  expect(finishWork(waitingAnswer.ctx, { turnId: waitingAnswer.turn.id, reason: "answered" }).state).toBe("waiting");
  const dangling = fixture();
  dangling.store.db.run("UPDATE work_items SET state = 'waiting', waiting_on = '{\"kind\":\"delegation\",\"ref\":\"missing\"}' WHERE id = ?", [dangling.itemId]);
  expect(finishWork(dangling.ctx, { turnId: dangling.turn.id, reason: "done" })).toMatchObject({ ended: false, code: "unfinished_obligations" });
});

test("ending records actual inbox dispositions, bounces for unread-for dispositions and unacknowledged user mail", () => {
  const f = fixture();
  const mail = queueInboxItem(f.ctx, { botId: f.bot.id, sessionId: f.room.id, turnId: f.turn.id, workItemId: f.itemId,
    taskId: f.plan.id, ticketId: f.ticket.id, messageId: null, author: "user", body: "Keep it short", source: "user", kind: "change", priority: 1 });
  const annotation = queueInboxItem(f.ctx, { botId: f.bot.id, sessionId: f.room.id, turnId: f.turn.id,
    taskId: f.plan.id, ticketId: f.ticket.id, messageId: null, author: "user", body: "Wrong title", source: "annotation", kind: "change", priority: 1 });
  deliverInboxItems(f.ctx, [mail.seq, annotation.seq], f.turn.id, 1);
  const first = finishWork(f.ctx, { turnId: f.turn.id, reason: "answered", inbox: [{ id: `U${mail.seq}`, disposition: "adopted", note: "Trimmed" }] });
  expect(first).toMatchObject({ ended: false, code: "inbox_unacknowledged", dispositions: { recorded: [`U${mail.seq}`], notRecorded: [] }, unacknowledgedInbox: [`U${annotation.seq}`] });
  expect(getInboxItem(f.ctx, mail.seq)).toMatchObject({ state: "adopted", disposition_note: "Trimmed" });
  const corrected = finishWork(f.ctx, { turnId: f.turn.id, reason: "answered", inbox: [{ id: `U${annotation.seq}`, disposition: "declined", note: "Title is required" }] });
  expect(corrected).toMatchObject({ ended: true, state: "idle", dispositions: { recorded: [`U${annotation.seq}`] } });
  expect(getInboxItem(f.ctx, annotation.seq)?.state).toBe("declined");
  // An id that names no mail (the line that woke it, say) records nothing and asks for nothing: the ending stands.
  const unread = fixture();
  const nothing = finishWork(unread.ctx, { turnId: unread.turn.id, reason: "answered", inbox: [{ id: "U999999", disposition: "answered" }] });
  expect(nothing).toMatchObject({ ended: true, dispositions: { recorded: [], notRecorded: [{ id: "U999999" }] } });
  // A wrong word on mail it did read still sends the ending back.
  const misread = fixture();
  const letter = queueInboxItem(misread.ctx, { botId: misread.bot.id, sessionId: misread.room.id, turnId: misread.turn.id, workItemId: misread.itemId,
    taskId: misread.plan.id, ticketId: misread.ticket.id, messageId: null, author: "user", body: "Keep it short", source: "user", kind: "change", priority: 1 });
  deliverInboxItems(misread.ctx, [letter.seq], misread.turn.id, 1);
  const wrong = finishWork(misread.ctx, { turnId: misread.turn.id, reason: "answered", inbox: [{ id: `U${letter.seq}`, disposition: "ok" }] });
  expect(wrong).toMatchObject({ ended: false, code: "invalid_inbox_disposition", dispositions: { recorded: [], notRecorded: [{ id: `U${letter.seq}` }] } });
});

test("answered with a real answer replies to only the current exact answer recipient, not an unread review or another ticket", () => {
  const f = fixture();
  const reader = f.store.createBot({ name: "Reader", duties: "read", boundaries: "none" }).bot;
  const room = f.store.createGroup({ name: "Team", members: [f.bot.id, reader.id] });
  f.store.db.run("UPDATE turns SET session_id = ? WHERE id = ?", [room.id, f.turn.id]);
  const answer = delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: reader.id, ask: "What is the title?", expects: "answer", continue: true });
  const review = delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: reader.id, ask: "Approve the draft", expects: "review", continue: true });
  const sibling = f.store.createTicket({ taskId: f.plan.id, title: "Other draft" });
  const other = delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: reader.id, ticketId: sibling.id, ask: "Other title?", expects: "answer", continue: true });
  const line = f.store.insertMessage({ sessionId: answer.delegation.thread_session_id, kind: "system", author: "app", body: "Read this" });
  const turn = f.store.createTurn({ sessionId: answer.delegation.thread_session_id, botId: reader.id, triggerMessageId: line.id, taskId: f.plan.id, ticketId: f.ticket.id });
  const result = finishWork(f.ctx, { turnId: turn.id, reason: "answered", answer: "Quarterly Report" });
  // The review asked on the same ticket is still in line, unread: it is this work's next step, so the work stays queued.
  expect(result).toMatchObject({ ended: true, state: "queued", replies: [{ delegation: { id: answer.delegation.id, status: "replied" }, inbox: { body_snapshot: "Quarterly Report", source: "delegation_reply", source_turn_id: f.turn.id } }] });
  expect(getDelegation(f.ctx, review.delegation.id).status).toBe("open");
  expect(getDelegation(f.ctx, other.delegation.id).status).toBe("open");
  expect(f.store.getTurn(turn.id).status).toBe("running");
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "answered", answer: "Quarterly Report" })).toEqual(result);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE source = 'delegation_reply'").get()).toEqual({ n: 1 });
});

function reviewRequest(status: "doing" | "review" = "doing") {
  const f = fixture(status);
  const reader = f.store.createBot({ name: "Reader", duties: "review", boundaries: "none" }).bot;
  const room = f.store.createGroup({ name: "Team", members: [f.bot.id, reader.id] });
  f.store.db.run("UPDATE turns SET session_id = ? WHERE id = ?", [room.id, f.turn.id]);
  const asked = delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: reader.id, ask: "Pre-review the storyboard, do not shoot yet", expects: "review" });
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "done" })).toMatchObject({ ended: true, state: "waiting" });
  const thread = asked.delegation.thread_session_id;
  const line = f.store.insertMessage({ sessionId: thread, kind: "system", author: reader.id, body: asked.delegation.ask });
  const turn = f.store.createTurn({ sessionId: thread, botId: reader.id, triggerMessageId: line.id, taskId: f.plan.id, ticketId: f.ticket.id });
  deliverInboxItems(f.ctx, [asked.delegation.request_inbox_seq!], turn.id, 1);
  return { ...f, reader, thread, delegation: asked.delegation, request: `B${asked.delegation.request_inbox_seq}`, reviewTurn: turn };
}

test("a review request with nothing handed over is answered in words, after one bounce for a verdict left in the thread", () => {
  const f = reviewRequest();
  const said = finishWork(f.ctx, { turnId: f.reviewTurn.id, reason: "answered", inbox: [{ id: f.request, disposition: "answered", note: "Sent the verdict" }] });
  expect(said).toMatchObject({ ended: false, code: "unanswered_request" });
  expect(said.bounce).toContain(f.request);
  expect(said.bounce).toContain("Writer");
  expect(said.bounce).toContain("answer");
  expect(getDelegation(f.ctx, f.delegation.id).status).toBe("open");
  const answered = finishWork(f.ctx, { turnId: f.reviewTurn.id, reason: "answered", answer: "Passed: all six points hold" });
  expect(answered).toMatchObject({ ended: true, state: "idle", replies: [{ delegation: { id: f.delegation.id, status: "replied" },
    inbox: { bot_id: f.bot.id, body_snapshot: "Passed: all six points hold", source: "delegation_reply", kind: "result" } }] });
  expect(getDelegationWait(f.ctx, f.delegation.id)?.voided_at).not.toBeNull();
  expect(f.store.db.query("SELECT state, waiting_on FROM work_items WHERE id = ?").get(f.itemId)).toEqual({ state: "queued", waiting_on: null });
});

test("a review request whose submission waits for review is not closed in words and does not bounce", () => {
  const f = reviewRequest();
  f.store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, bot_id, origin, artifacts, state, created_at, updated_at)
    VALUES ('sub-1', ?, ?, ?, ?, 'submit', '[]', 'in_review', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`, [f.itemId, f.plan.id, f.ticket.id, f.bot.id]);
  expect(finishWork(f.ctx, { turnId: f.reviewTurn.id, reason: "answered", answer: "Looks fine" })).toMatchObject({ ended: true, replies: [] });
  expect(getDelegation(f.ctx, f.delegation.id).status).toBe("open");
});

test("a done or prose ending over a read request says how to answer it", () => {
  const f = reviewRequest();
  const spoken = finishWork(f.ctx, { turnId: f.reviewTurn.id, reason: "done" });
  expect(spoken).toMatchObject({ ended: false, code: "unfinished_obligations" });
  expect(spoken.bounce).toContain(`To answer ${f.request}, end with reason answered and your reply in answer.`);
});

test("pure text bounces once on facts, then releases idle, while desk text defaults to answered", () => {
  const f = fixture("review");
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "answered" }, { pureText: true })).toMatchObject({ ended: false, code: "unfinished_obligations" });
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "answered" }, { pureText: true })).toMatchObject({ ended: true, state: "idle", endReason: "nothing_new" });
  const desk = fixture();
  desk.store.db.run("UPDATE turns SET status = 'completed', end_reason = 'answered' WHERE id = ?", [desk.turn.id]);
  const line = desk.store.postMessage(desk.room.id, { body: "Hello" });
  const turn = desk.store.createTurn({ sessionId: desk.room.id, botId: desk.bot.id, triggerMessageId: line.id, taskId: null, ticketId: null });
  expect(finishWork(desk.ctx, { turnId: turn.id, reason: "done" }, { pureText: true, closing: "Hello. What can I do for you?" }))
    .toMatchObject({ ended: true, endReason: "answered", state: "closed" });
});

test("the third contract rejection ends needs_attention using durable local and parent-wide budgets", () => {
  const f = fixture();
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "answered", inbox: "bad" })).toMatchObject({ ended: false, code: "invalid_inbox_disposition" });
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "answered", inbox: "bad" })).toMatchObject({ ended: false });
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "answered", inbox: "bad" })).toMatchObject({ ended: true, state: "needs_attention", endReason: "needs_attention", code: "contract_budget" });
  expect(f.store.listWorkEvents({ kind: "end.rejected" })).toHaveLength(2);
  expect(f.store.getTurn(f.turn.id).status).toBe("running");
  const global = fixture();
  expect(finishWork(global.ctx, { turnId: global.turn.id, reason: "done" }, { contractBounces: 2 })).toMatchObject({ ended: true, state: "needs_attention", code: "contract_budget" });
  const filing = fixture();
  filing.store.db.run("UPDATE turns SET filing_bounces = 2 WHERE id = ?", [filing.turn.id]);
  expect(finishWork(filing.ctx, { turnId: filing.turn.id, reason: "done" })).toMatchObject({ ended: true, state: "needs_attention" });
});

function nextTurn(f: ReturnType<typeof fixture>) {
  f.store.db.run("UPDATE turns SET status = 'completed' WHERE work_item_id = ? AND status = 'running'", [f.itemId]);
  const line = f.store.postMessage(f.room.id, { body: "Continue" });
  const turn = f.store.createTurn({ sessionId: f.room.id, botId: f.bot.id, triggerMessageId: line.id, taskId: f.plan.id, ticketId: f.ticket.id });
  replied(f.store, turn);
  return turn;
}

test("two consecutive no-progress endings block the same work item, with one persisted ending per segment", () => {
  const f = fixture();
  const first = finishWork(f.ctx, { turnId: f.turn.id, reason: "nothing_new" });
  expect(first).toMatchObject({ ended: true, state: "idle", noProgressCount: 1 });
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "nothing_new" })).toMatchObject({ state: "idle", noProgressCount: 1 });
  expect(f.store.listWorkEvents({ kind: "work.ended" })).toHaveLength(1);
  f.store.patchTicket(f.ticket.id, { spec: "More prose does not count" });
  recordWorkEvent(f.ctx, { kind: "work.bound", actor: "app", taskId: f.plan.id, ticketId: f.ticket.id, payload: { work_item_id: f.itemId } });
  const turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ ended: true, state: "blocked", endReason: "nothing_new", noProgressCount: 2, notice: { code: "no_progress" } });
  expect(f.store.getTicket(f.ticket.id).status).toBe("doing");
  expect(f.store.listWorkEvents({ kind: "work.ended" })).toHaveLength(2);
});

test("authoritative ticket/part progress and durable new-artifact events reset the no-progress streak; answered breaks consecutiveness", () => {
  const f = fixture();
  finishWork(f.ctx, { turnId: f.turn.id, reason: "nothing_new" });
  f.store.patchTicket(f.ticket.id, { status: "review" });
  let turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ state: "idle", noProgressCount: 1 });
  f.store.db.run("INSERT INTO ticket_parts (id, ticket_id, key, title, declared_by) VALUES ('part-1', ?, 'part-1', 'Part 1', 'user')", [f.ticket.id]);
  turn = nextTurn(f);
  finishWork(f.ctx, { turnId: turn.id, reason: "answered" });
  turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ state: "idle", noProgressCount: 1 });
  f.store.db.run("UPDATE ticket_parts SET stage = 'submitted' WHERE id = 'part-1'");
  turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ state: "idle", noProgressCount: 1 });
  recordWorkEvent(f.ctx, { kind: "artifact.changed", actor: "app", taskId: f.plan.id, ticketId: f.ticket.id,
    payload: { work_item_id: f.itemId, path: `${f.ticket.dir}/report.md`, hash: "a-real-new-content-hash" } });
  turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ state: "idle", noProgressCount: 1 });
});

test("implicit submission exposes only this segment's safe ticket citations, never fakes hash checks or ticket advancement", () => {
  const f = fixture();
  const path = `${f.ticket.dir}/report.md`;
  const candidate = f.store.insertMessage({ sessionId: f.room.id, turnId: f.turn.id, kind: "bot", author: f.bot.id,
    body: "Report attached", paths: [path, `${f.ticket.dir}/../elsewhere.md`, `${f.ticket.dir}/scratch/notes.md`, `${f.ticket.dir}/ticket.md`, `${f.ticket.dir}-other/report.md`, `${f.ticket.dir}/scratch\\notes.md`, `${f.ticket.dir}/sub\\..\\..\\other/report.md`] });
  f.store.insertMessage({ sessionId: f.room.id, kind: "bot", author: f.bot.id, body: "Old citation", paths: [`${f.ticket.dir}/old.md`] });
  f.store.insertMessage({ sessionId: f.room.id, turnId: f.turn.id, kind: "user", author: "user", body: "User input", paths: [`${f.ticket.dir}/input.md`] });
  const result = finishWork(f.ctx, { turnId: f.turn.id, reason: "done" });
  expect(result).toMatchObject({ ended: false, code: "unfinished_obligations", implicitSubmission: { implemented: false,
    candidates: [{ path, messageId: candidate.id, attachmentId: expect.any(String) }], requires: ["exists", "new_content_hash", "bound_checks", "stored_submission"] } });
  expect(f.store.getTicket(f.ticket.id).status).toBe("doing");
});

test("replayed accepted endings preserve cards/notice metadata, and readonly pure text defaults to answered", () => {
  const blocked = fixture();
  const input = { turnId: blocked.turn.id, reason: "blocked", needsFromUser: "Choose a title" };
  const first = finishWork(blocked.ctx, input);
  expect(finishWork(blocked.ctx, input)).toEqual(first);
  expect(blocked.store.listWorkEvents({ kind: "work.ended" })).toHaveLength(1);
  const gaveUp = fixture();
  const giveUp = { turnId: gaveUp.turn.id, reason: "gave_up", note: "Cannot finish" };
  const notice = finishWork(gaveUp.ctx, giveUp);
  expect(finishWork(gaveUp.ctx, giveUp)).toEqual(notice);
  expect(gaveUp.store.listWorkEvents({ kind: "quality.gave_up" })).toHaveLength(1);
  const readonly = fixture();
  createHold(readonly.ctx, { scope: "bot", scopeId: readonly.bot.id, source: "user_button" });
  const line = readonly.store.postMessage(readonly.room.id, { body: "Status?" });
  const turn = readonly.store.createTurn({ sessionId: readonly.room.id, botId: readonly.bot.id, triggerMessageId: line.id, mode: "readonly" });
  expect(finishWork(readonly.ctx, { turnId: turn.id, reason: "done" }, { pureText: true })).toMatchObject({ ended: true, endReason: "answered", workItemId: null });
});

test("missing reasons, terminal turns, mismatched bindings and unrelated ticket progress cannot fabricate completion", () => {
  const f = fixture();
  expect(errorCode(() => finishWork(f.ctx, { turnId: f.turn.id, reason: undefined }))).toBe("invalid_args");
  const sibling = f.store.createTicket({ taskId: f.plan.id, title: "Sibling" });
  finishWork(f.ctx, { turnId: f.turn.id, reason: "nothing_new" });
  recordWorkEvent(f.ctx, { kind: "artifact.changed", actor: "app", taskId: f.plan.id, ticketId: sibling.id, payload: { hash: "unrelated" } });
  const turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" }).state).toBe("blocked");
  f.store.db.run("UPDATE turns SET status = 'completed' WHERE id = ?", [turn.id]);
  expect(errorCode(() => finishWork(f.ctx, { turnId: turn.id, reason: "answered" }))).toBe("turn_ended");
  const mismatch = fixture();
  mismatch.store.db.run("UPDATE work_items SET ticket_id = NULL WHERE id = ?", [mismatch.itemId]);
  expect(errorCode(() => finishWork(mismatch.ctx, { turnId: mismatch.turn.id, reason: "answered" }))).toBe("invalid_args");
  expect(mismatch.store.db.query("SELECT status, end_reason FROM turns WHERE id = ?").get(mismatch.turn.id)).toEqual({ status: "running", end_reason: null });
});

test("a waiting item needs its own exact open wait, not an unrelated legacy timer or fabricated future job", () => {
  const f = fixture();
  f.store.db.run("INSERT INTO check_backs (id, bot_id, session_id, turn_id, task_id, ticket_id, note, due_at, created_at) VALUES ('old-timer', ?, ?, ?, ?, ?, 'Look later', '2026-09-30T00:00:00Z', '2026-09-29T00:00:00Z')", [f.bot.id, f.room.id, f.turn.id, f.plan.id, f.ticket.id]);
  f.store.db.run("UPDATE work_items SET state = 'waiting', waiting_on = '{\"kind\":\"delegation\",\"ref\":\"missing\"}' WHERE id = ?", [f.itemId]);
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "done" })).toMatchObject({ ended: false, code: "unfinished_obligations" });
  const job = fixture();
  job.store.db.run("INSERT INTO check_backs (id, bot_id, session_id, turn_id, task_id, ticket_id, work_item_id, note, due_at, created_at, wait_spec) VALUES ('future-job', ?, ?, ?, ?, ?, ?, 'Job', '2026-09-30T00:00:00Z', '2026-09-29T00:00:00Z', '{\"kind\":\"job\",\"ref\":\"nonexistent\"}')", [job.bot.id, job.room.id, job.turn.id, job.plan.id, job.ticket.id, job.itemId]);
  job.store.db.run("UPDATE work_items SET state = 'waiting', waiting_on = '{\"kind\":\"job\",\"ref\":\"nonexistent\"}' WHERE id = ?", [job.itemId]);
  expect(finishWork(job.ctx, { turnId: job.turn.id, reason: "done" })).toMatchObject({ ended: false, obligations: { waits: [] } });
});

test("declaring more todo work is not progress and cannot reset a no-progress streak", () => {
  const f = fixture();
  finishWork(f.ctx, { turnId: f.turn.id, reason: "nothing_new" });
  f.store.db.run("INSERT INTO ticket_parts (id, ticket_id, key, title, declared_by) VALUES ('more-todo', ?, 'more', 'More work', 'user')", [f.ticket.id]);
  const turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ state: "blocked", noProgressCount: 2 });
});

test("explicit sibling work-item provenance overrides broad plan progress and desks match their exact home conversation", () => {
  const f = fixture();
  finishWork(f.ctx, { turnId: f.turn.id, reason: "nothing_new" });
  recordWorkEvent(f.ctx, { kind: "artifact.changed", actor: "app", taskId: f.plan.id,
    payload: { work_item_id: "different-work", hash: "sibling-artifact" } });
  const turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ state: "blocked", noProgressCount: 2 });
  const desk = fixture();
  desk.store.db.run("UPDATE turns SET status = 'completed', end_reason = 'answered' WHERE id = ?", [desk.turn.id]);
  const line = desk.store.postMessage(desk.room.id, { body: "Hello" });
  const answer = desk.store.createTurn({ sessionId: desk.room.id, botId: desk.bot.id, triggerMessageId: line.id, taskId: null, ticketId: null });
  const peer = desk.store.createBot({ name: "Desk peer", duties: "other", boundaries: "none" }).bot;
  const otherRoom = desk.store.createGroup({ name: "Other room", members: [desk.bot.id, peer.id] });
  desk.store.db.run("UPDATE work_items SET home_session_id = ? WHERE id = (SELECT work_item_id FROM turns WHERE id = ?)", [otherRoom.id, answer.id]);
  expect(errorCode(() => finishWork(desk.ctx, { turnId: answer.id, reason: "answered" }))).toBe("invalid_args");
});

test("trusted current-segment progress counts zero quiet endings, while shared exact-ticket review progress is relevant", () => {
  const f = fixture();
  recordWorkEvent(f.ctx, { kind: "artifact.changed", actor: "app", taskId: f.plan.id, ticketId: f.ticket.id, turnId: f.turn.id,
    payload: { work_item_id: f.itemId, hash: "actual-new-artifact" } });
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "nothing_new" })).toMatchObject({ state: "idle", noProgressCount: 0 });
  let turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ state: "idle", noProgressCount: 1 });
  recordWorkEvent(f.ctx, { kind: "review.recorded", actor: "app", taskId: f.plan.id, ticketId: f.ticket.id,
    payload: { work_item_id: "reviewer-work", verdict: "unknown" } });
  turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ state: "idle", noProgressCount: 1 });
  recordWorkEvent(f.ctx, { kind: "artifact.changed", actor: "app", turnId: turn.id, payload: { hash: "unscoped-cannot-reset" } });
  turn = nextTurn(f);
  expect(finishWork(f.ctx, { turnId: turn.id, reason: "nothing_new" })).toMatchObject({ state: "blocked", noProgressCount: 2 });
});

test("a late end-write failure rolls back actual user dispositions and delegated replies together", () => {
  const f = fixture();
  const reader = f.store.createBot({ name: "Reader", duties: "read", boundaries: "none" }).bot;
  const room = f.store.createGroup({ name: "Team", members: [f.bot.id, reader.id] });
  f.store.db.run("UPDATE turns SET session_id = ? WHERE id = ?", [room.id, f.turn.id]);
  const opened = delegateWork(f.ctx, { fromTurnId: f.turn.id, toBotId: reader.id, ask: "Title?", expects: "answer", continue: true });
  const line = f.store.insertMessage({ sessionId: opened.delegation.thread_session_id, kind: "system", author: "app", body: "Read this" });
  const turn = f.store.createTurn({ sessionId: opened.delegation.thread_session_id, botId: reader.id, triggerMessageId: line.id, taskId: f.plan.id, ticketId: f.ticket.id });
  const mail = queueInboxItem(f.ctx, { botId: reader.id, sessionId: opened.delegation.thread_session_id, turnId: turn.id,
    taskId: f.plan.id, ticketId: f.ticket.id, messageId: null, author: "user", body: "Answer clearly", source: "user", kind: "change", priority: 1 });
  deliverInboxItems(f.ctx, [mail.seq], turn.id, 1);
  f.store.db.exec("CREATE TRIGGER fail_end_write BEFORE INSERT ON work_events WHEN NEW.kind = 'work.ended' BEGIN SELECT RAISE(ABORT, 'injected late failure'); END");
  expect(() => finishWork(f.ctx, { turnId: turn.id, reason: "answered", answer: "Quarterly Report",
    inbox: [{ id: `U${mail.seq}`, disposition: "adopted" }] })).toThrow("injected late failure");
  expect(getInboxItem(f.ctx, mail.seq)?.state).toBe("delivered");
  expect(getDelegation(f.ctx, opened.delegation.id).status).toBe("open");
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE source = 'delegation_reply'").get()).toEqual({ n: 0 });
  expect(f.store.db.query("SELECT status, end_reason FROM turns WHERE id = ?").get(turn.id)).toEqual({ status: "running", end_reason: null });
});

test("ending right after saying the work is under way bounces once, then ends with a line the user sees", () => {
  // 2026-10-03: the video group's director said 「正在编写…」 and ended done; its one ticket still read
  // handed over, so nothing was open, nothing woke it, and the group showed nothing at all.
  const f = fixture("review");
  f.store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '5')");
  f.store.insertMessage({ sessionId: f.room.id, sourceTurnId: f.turn.id, kind: "bot", author: f.bot.id,
    body: "已确认重新启动。正在编写全新第 1 集设定集与剧本分镜方案。" });
  const first = finishWork(f.ctx, { turnId: f.turn.id, reason: "done" });
  expect(first).toMatchObject({ ended: false, code: "promised_later" });
  expect(first.bounce).toContain("正在编写");
  expect(first.bounce).toContain("check_back");
  expect(f.store.db.query("SELECT status, end_reason FROM turns WHERE id = ?").get(f.turn.id)).toEqual({ status: "running", end_reason: null });
  const second = finishWork(f.ctx, { turnId: f.turn.id, reason: "done" });
  expect(second).toMatchObject({ ended: true, endReason: "done", state: "idle", notice: { code: "promised_later" } });
  expect(second.notice!.body).toContain("Writer");
  expect(second.notice!.body).toContain("正在编写");
});

test("a promise someone picks up, a later word that is no promise, or a read-only answer ends as before", () => {
  const named = fixture("done");
  const editor = named.store.createBot({ name: "Editor", duties: "edit", boundaries: "none" }).bot;
  named.store.insertMessage({ sessionId: named.room.id, sourceTurnId: named.turn.id, kind: "bot", author: named.bot.id,
    body: `@${editor.name} 接下来开始写分镜，交给你了` });
  expect(finishWork(named.ctx, { turnId: named.turn.id, reason: "done" })).toMatchObject({ ended: true, endReason: "done" });
  const delivered = fixture("done");
  delivered.store.insertMessage({ sessionId: delivered.room.id, sourceTurnId: delivered.turn.id, kind: "bot", author: delivered.bot.id, body: "正在编写设定集。" });
  delivered.store.insertMessage({ sessionId: delivered.room.id, turnId: delivered.turn.id, kind: "bot", author: delivered.bot.id, body: "设定集写好了，在 bible.md。" });
  expect(finishWork(delivered.ctx, { turnId: delivered.turn.id, reason: "done" })).toMatchObject({ ended: true, endReason: "done" });
  const quiet = fixture("done");
  expect(finishWork(quiet.ctx, { turnId: quiet.turn.id, reason: "done" })).toMatchObject({ ended: true, endReason: "done" });
});

test("a pure-text closing reply is weighed by the words about to go out, not by what was said before", () => {
  const f = fixture("done");
  f.store.insertMessage({ sessionId: f.room.id, sourceTurnId: f.turn.id, kind: "bot", author: f.bot.id, body: "收到。" });
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "done" }, { pureText: true, closing: "正在核验 18 张起止帧，结论随后。" }))
    .toMatchObject({ ended: false, code: "promised_later" });
  const done = fixture("done");
  done.store.insertMessage({ sessionId: done.room.id, sourceTurnId: done.turn.id, kind: "bot", author: done.bot.id, body: "正在核验 18 张起止帧。" });
  expect(finishWork(done.ctx, { turnId: done.turn.id, reason: "done" }, { pureText: true, closing: "核验完了：18 张都对得上。" }))
    .toMatchObject({ ended: true, endReason: "done" });
  // A no-work closer goes out as nothing: what the user last read is the line before it.
  const closer = fixture("done");
  closer.store.insertMessage({ sessionId: closer.room.id, sourceTurnId: closer.turn.id, kind: "bot", author: closer.bot.id, body: "正在核验 18 张起止帧。" });
  expect(finishWork(closer.ctx, { turnId: closer.turn.id, reason: "done" }, { pureText: true, closing: "" }))
    .toMatchObject({ ended: false, code: "promised_later" });
});

test("mail queued on the work while its segment ran keeps the work queued at the end, so it is dispatched", () => {
  // Real-model run, 2026-10-04: the poster's reviewer was mid-review when the lead handed in a newer
  // version; its review request was queued on the same work, the review segment then ended
  // nothing_new and set the work idle. Nothing dispatches mail on idle work, and the queued mail kept
  // the supervisor from calling the reviewer back: the review never happened.
  const f = fixture();
  f.store.queueWork({ botId: f.bot.id, sessionId: f.room.id, taskId: f.plan.id, ticketId: f.ticket.id, messageId: null, author: "app",
    body: "（应用）请审查新交的一版", source: "review", kind: "change", priority: 2, notice: false });
  expect(finishWork(f.ctx, { turnId: f.turn.id, reason: "answered" })).toMatchObject({ ended: true, state: "queued" });
  f.store.db.run("UPDATE turns SET status = 'completed' WHERE id = ?", [f.turn.id]);
  expect(f.store.dispatchableWork().map((work) => work.id)).toEqual([f.itemId]);
  // With nothing queued it goes idle as before.
  const g = fixture();
  expect(finishWork(g.ctx, { turnId: g.turn.id, reason: "answered" })).toMatchObject({ state: "idle" });
});

/** A segment a line of yours opens in your direct, which has said nothing to you yet. */
function yourLine(f: ReturnType<typeof fixture>, body = "OpenSSF criticality score 从哪里获取", job: { taskId: string; ticketId: string } | null = null) {
  f.store.db.run("UPDATE turns SET status = 'completed', end_reason = 'answered' WHERE id = ?", [f.turn.id]);
  const line = f.store.postMessage(f.room.id, { body });
  return f.store.createTurn({ sessionId: f.room.id, botId: f.bot.id, triggerMessageId: line.id, taskId: job?.taskId ?? null, ticketId: job?.ticketId ?? null });
}

test("a segment your line opened in your direct that ends with nothing said to you bounces once, then ends with a line you see", () => {
  // 2026-10-07: 通识 ended answered with its whole answer in end_turn's answer, which goes only to a
  // Bot that asked; the contract took it, nothing was posted, and the line stood with no reply.
  const f = fixture();
  const turn = yourLine(f);
  const first = finishWork(f.ctx, { turnId: turn.id, reason: "answered", answer: "从 ossf/criticality_score 的公开数据集获取",
    inbox: [{ id: "U13", disposition: "answered" }] });
  expect(first).toMatchObject({ ended: false, code: "said_nothing" });
  expect(first.bounce).toContain("Your answer reached nobody");
  expect(first.bounce).toContain("write the reply as plain text, with no tool call");
  expect(f.store.db.query("SELECT status, end_reason FROM turns WHERE id = ?").get(turn.id)).toEqual({ status: "running", end_reason: null });
  const second = finishWork(f.ctx, { turnId: turn.id, reason: "answered" });
  expect(second).toMatchObject({ ended: true, endReason: "answered", state: "closed", notice: { code: "said_nothing" } });
  expect(second.notice!.body).toBe("Writer这一轮没有回复你就结束了。要它回答，再说一次。");
});

test("the bounce says why nothing reached you, and with no bounce left the ending goes through with the line at once", () => {
  const prose = fixture();
  const thanks = yourLine(prose, "谢谢");
  // A reply that was empty, or only said it was already answered, goes out as nothing.
  expect(finishWork(prose.ctx, { turnId: thanks.id, reason: "done" }, { pureText: true, closing: "" }).bounce).toContain("Your reply did not go out");
  const ended = fixture();
  const line = yourLine(ended);
  expect(finishWork(ended.ctx, { turnId: line.id, reason: "nothing_new", note: "已回答" }).bounce).toContain("You ended without a word to the user");
  const spent = fixture();
  const late = yourLine(spent);
  for (const code of ["inbox_unacknowledged", "unfinished_obligations"]) {
    recordWorkEvent(spent.ctx, { kind: "end.rejected", actor: "app", turnId: late.id, payload: { code } });
  }
  expect(finishWork(spent.ctx, { turnId: late.id, reason: "answered" })).toMatchObject({ ended: true, endReason: "answered", notice: { code: "said_nothing" } });
});

test("a segment that put something in front of you, or that no line of yours in your direct opened, ends as before", () => {
  const ends = (f: ReturnType<typeof fixture>, turnId: string, reason: "answered" | "done", opts: Parameters<typeof finishWork>[2] = {}) => {
    const result = finishWork(f.ctx, { turnId, reason }, opts);
    expect(result).toMatchObject({ ended: true, endReason: opts.pureText ? expect.any(String) : reason });
    expect(result.notice).toBeUndefined();
  };
  // A message of its own there with words in it, a reply about to go out, words handed over for your card.
  const said = fixture();
  const reply = yourLine(said);
  said.store.insertMessage({ sessionId: said.room.id, sourceTurnId: reply.id, kind: "bot", author: said.bot.id, body: "可以从公开数据集获取。" });
  ends(said, reply.id, "answered");
  const prose = fixture();
  ends(prose, yourLine(prose).id, "done", { pureText: true, closing: "可以从公开数据集获取。" });
  const handed = fixture("done");
  const words = yourLine(handed, "给这份报告起个标题", { taskId: handed.plan.id, ticketId: handed.ticket.id });
  handed.store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, bot_id, turn_id, origin, artifacts, content, state, created_at, updated_at)
    VALUES ('sub-words', ?, ?, ?, ?, ?, 'answer', '[]', '季度报告', 'approved', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')`,
    [words.work_item_id ?? null, handed.plan.id, handed.ticket.id, handed.bot.id, words.id]);
  ends(handed, words.id, "done");
  // A read-only answer has its own line; a routine's line, or a line in a group, is not your direct.
  const held = fixture();
  held.store.db.run("UPDATE turns SET status = 'completed', end_reason = 'answered' WHERE id = ?", [held.turn.id]);
  const asked = held.store.postMessage(held.room.id, { body: "进展如何？" });
  ends(held, held.store.createTurn({ sessionId: held.room.id, botId: held.bot.id, triggerMessageId: asked.id, mode: "readonly" }).id, "answered");
  const routine = fixture();
  routine.store.db.run("UPDATE turns SET status = 'completed', end_reason = 'answered' WHERE id = ?", [routine.turn.id]);
  const due = routine.store.insertMessage({ sessionId: routine.room.id, kind: "system", author: routine.bot.id, body: "日程「每日简报」：汇总今日动态" });
  ends(routine, routine.store.createTurn({ sessionId: routine.room.id, botId: routine.bot.id, triggerMessageId: due.id, taskId: null, ticketId: null }).id, "answered");
  const group = fixture();
  const peer = group.store.createBot({ name: "Reader", duties: "read", boundaries: "none" }).bot;
  const room = group.store.createGroup({ name: "Team", members: [group.bot.id, peer.id] });
  const named = group.store.postMessage(room.id, { body: "@Writer 看一下" });
  ends(group, group.store.createTurn({ sessionId: room.id, botId: group.bot.id, triggerMessageId: named.id, taskId: null, ticketId: null }).id, "answered");
});

test("files alone are no reply: written, carried on a line with no words, or handed over, the ending is sent back once", () => {
  // 2026-10-07: 视频导演 answered 「水印去不掉吗」 with a video and 「它支持传参考图吗」 with two, not a
  // word to either; files it wrote, a line carrying only them and a hand-over each let the ending through.
  const written = fixture();
  const first = finishWork(written.ctx, { turnId: yourLine(written, "水印去不掉吗").id, reason: "answered" }, { written: ["work/clips/nowm.mp4"] });
  expect(first).toMatchObject({ ended: false, code: "said_nothing" });
  expect(first.bounce).toContain("You ended with files and no words");
  expect(first.bounce).toContain("write the reply as plain text, with no tool call");

  const shown = fixture();
  const line = yourLine(shown, "水印去不掉吗");
  shown.store.insertMessage({ sessionId: shown.room.id, turnId: line.id, kind: "bot", author: shown.bot.id, body: "", paths: ["work/clips/nowm.mp4"] });
  expect(finishWork(shown.ctx, { turnId: line.id, reason: "answered" })).toMatchObject({ ended: false, code: "said_nothing" });

  const handed = fixture("done");
  const clips = yourLine(handed, "它支持传参考图吗", { taskId: handed.plan.id, ticketId: handed.ticket.id });
  handed.store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, bot_id, turn_id, origin, artifacts, state, created_at, updated_at)
    VALUES ('sub-clips', ?, ?, ?, ?, ?, 'submit', ?, 'submitted', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')`,
    [clips.work_item_id ?? null, handed.plan.id, handed.ticket.id, handed.bot.id, clips.id, JSON.stringify([{ path: `${handed.ticket.dir}/i2v.mp4`, sha256: "a".repeat(64) }])]);
  const third = finishWork(handed.ctx, { turnId: clips.id, reason: "done" });
  expect(third).toMatchObject({ ended: false, code: "said_nothing" });
  expect(third.bounce).toContain("You ended with files and no words");
});

test("submit does not end a segment your line opened in your direct before a word of it reaches you; once one has, it does", () => {
  // 2026-10-07 13:45: 「这个视频生成跟 Grok 的比哪个好」 got three clips handed over, submit ended the
  // segment there, and the answer the Bot had written never went out.
  const f = fixture("done");
  const turn = yourLine(f, "这个视频生成跟 Grok 的比哪个好", { taskId: f.plan.id, ticketId: f.ticket.id });
  f.store.insertMessage({ sessionId: f.room.id, turnId: turn.id, kind: "bot", author: f.bot.id, body: "", paths: [`${f.ticket.dir}/grok_cmp_cat.mp4`] });
  const held = endAfterSubmit(f.ctx, turn.id);
  expect(held.ended).toBe(false);
  expect(held.reason).toContain("no word of yours has reached them");
  expect(held.reason).toContain("plain text, with no tool call");
  // Nothing is counted against it, and the segment goes on.
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM work_events WHERE turn_id = ? AND kind = 'end.rejected'").get(turn.id)).toEqual({ n: 0 });
  expect(f.store.db.query("SELECT status, end_reason FROM turns WHERE id = ?").get(turn.id)).toEqual({ status: "running", end_reason: null });

  f.store.insertMessage({ sessionId: f.room.id, turnId: turn.id, kind: "bot", author: f.bot.id, body: "两者整体差不多，做连续镜头更推荐 Grok。" });
  expect(endAfterSubmit(f.ctx, turn.id)).toEqual({ ended: true });

  // A segment no line of yours opened ends at submit as before.
  const g = fixture("done");
  g.store.db.run("UPDATE turns SET status = 'completed', end_reason = 'answered' WHERE id = ?", [g.turn.id]);
  const due = g.store.insertMessage({ sessionId: g.room.id, kind: "system", author: g.bot.id, body: "回看：对比片子" });
  const woken = g.store.createTurn({ sessionId: g.room.id, botId: g.bot.id, triggerMessageId: due.id, taskId: g.plan.id, ticketId: g.ticket.id });
  expect(endAfterSubmit(g.ctx, woken.id)).toEqual({ ended: true });
});

test("the segment's last word is the newest line that says something, not one that only carries files", () => {
  const f = fixture();
  const turn = yourLine(f, "对比结果呢");
  f.store.insertMessage({ sessionId: f.room.id, turnId: turn.id, kind: "bot", author: f.bot.id, body: "结论随后发你。" });
  f.store.insertMessage({ sessionId: f.room.id, turnId: turn.id, kind: "bot", author: f.bot.id, body: "", paths: ["work/clips/a.mp4"] });
  expect(segmentLastWord(f.ctx, turn.id)).toBe("结论随后发你。");
});
