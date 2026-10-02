import { afterEach, expect, test } from "bun:test";
import { isoNow } from "../ids";
import { Store } from ".";
import { filenamePartNumbers } from "./filing";
import { ENGINE_LEVELS } from "./schema-gate";
import { createHold, liftHold } from "./holds";
import { superviseSubmissions, UNREVIEWED_AFTER_MS } from "./submissions";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const later = (ms: number) => new Date(Date.parse(isoNow()) + ms).toISOString();

function fixture(level: number = ENGINE_LEVELS.submissions) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const producer = store.createBot({ name: "Director", duties: "cut", boundaries: "none" }).bot;
  const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" }).bot;
  const room = store.createGroup({ name: "Studio", members: [producer.id, reviewer.id] });
  const plan = store.openTask({ sessionId: room.id, title: "EP01" });
  const ticket = store.createTicket({ taskId: plan.id, title: "06 母带", worker: producer.id });
  const ctx = (store as unknown as { ctx: Parameters<typeof superviseSubmissions>[0] }).ctx;
  return { store, ctx, producer, reviewer, room, plan, ticket };
}
type Fixture = ReturnType<typeof fixture>;

function segment(f: Fixture, botId: string = f.producer.id, ticketId: string | null = f.ticket.id) {
  const trigger = f.store.insertMessage({ sessionId: f.room.id, kind: "system", author: botId, body: "工作" });
  const turn = f.store.createTurn({ sessionId: f.room.id, botId, triggerMessageId: trigger.id, taskId: f.plan.id, ticketId });
  if (!turn.work_item_id) throw new Error("bound segments only");
  return { ...turn, work_item_id: turn.work_item_id };
}

function submit(f: Fixture, turnId: string, files: Array<[string, string]>, origin: "submit" | "implicit" = "submit") {
  return f.store.prepareSubmission({ turnId, origin, artifacts: files.map(([path, sha256]) => ({ path, sha256 })) });
}

function ticketRow(f: Fixture) {
  return f.store.db.query<{ status: string; stage: string | null }, [string]>("SELECT status, stage FROM tickets WHERE id = ?").get(f.ticket.id)!;
}

/** A check of yours on the ticket's master that last ran with `outcome`. */
function gate(f: Fixture, outcome: "pass" | "fail") {
  const id = `check-${outcome}-${Math.random().toString(36).slice(2)}`;
  const now = isoNow();
  f.store.db.run(`INSERT INTO acceptance_checks (id, task_id, ticket_id, item, kind, path, source, created_at, updated_at, defined_at)
    VALUES (?, ?, ?, '母带存在', 'exists', ?, 'user', ?, ?, ?)`, [id, f.plan.id, f.ticket.id, `${f.ticket.dir}/EP01_MASTER.mp4`, now, now, now]);
  run(f, id, outcome);
  return { id };
}

/** A check from your words, not confirmed, standing on `quoteId` and bound to the master. */
function proposal(f: Fixture, quoteId: string) {
  const id = `derived-${Math.random().toString(36).slice(2)}`;
  const now = isoNow();
  f.store.db.run(`INSERT INTO acceptance_checks (id, task_id, ticket_id, item, kind, path, source, created_at, updated_at, defined_at, origin, measure,
      quote_id, bind_kind, bind_glob, derived_state)
    VALUES (?, ?, NULL, '时长约 2 分钟', 'exists', ?, 'user', ?, ?, ?, 'derived', '{"dimension":"duration","min":108,"max":132}', ?, 'glob', '*MASTER*', 'proposed')`,
  [id, f.plan.id, `${f.ticket.dir}/EP01_MASTER.mp4`, now, now, now, quoteId]);
  return { id };
}

function run(f: Fixture, checkId: string, outcome: "pass" | "fail", detail = "") {
  const started = f.store.beginCheckRun(checkId, "settle");
  f.store.finishCheckRun(started.id, { outcome, exitCode: null, detail, output: null });
}

/** A requirement in the ledger, raised `times` times, standing on a quote of yours; returns it and its quote. */
function requirement(f: Fixture, id: string, opts: { times?: number; category?: string } = {}) {
  const quote = `quote-${id}`;
  f.store.db.run(`INSERT INTO user_quotes (id, body, via, session_id, task_id, created_at) VALUES (?, ?, 'message', ?, ?, ?)`,
    [quote, `要求 ${id}`, f.room.id, f.plan.id, isoNow()]);
  f.store.db.run(`INSERT INTO requirements (id, scope, scope_id, quote, category, source_kind, source_quote_id, status, times_raised,
    last_raised_at, added_by, created_at, updated_at, origin_task_id)
    VALUES (?, 'plan', ?, ?, ?, 'message', ?, 'open', ?, '2026-01-01', 'scribe', '2026-01-01', '2026-01-01', ?)`,
    [id, f.plan.id, `要求 ${id}`, opts.category ?? null, quote, opts.times ?? 1, f.plan.id]);
  f.store.db.run(`INSERT INTO requirement_mentions (id, requirement_id, quote_id, created_at) VALUES (?, ?, ?, ?)`, [`m-${id}`, id, quote, isoNow()]);
  return { id, quote };
}

/** A segment's route on `model`, so a review knows which model it ran on. */
function onModel(f: Fixture, turnId: string, model: string) {
  f.store.db.run(`INSERT INTO turn_route_decisions (turn_id, session_id, bot_id, trigger_message_id, model, thinking_level, signature, created_at)
    SELECT id, session_id, bot_id, trigger_message_id, ?, 'high', 'sig', created_at FROM turns WHERE id = ?`, [model, turnId]);
}

/** A submission of the master, checked, waiting with its reviewer (or with none). */
function handedOver(f: Fixture, opts: { reviewer?: boolean; model?: string } = {}) {
  if (opts.reviewer) f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  const produced = segment(f);
  if (opts.model) onModel(f, produced.id, opts.model);
  const { submission } = submit(f, produced.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_A]])!;
  f.store.settleSubmissionChecks(submission.id);
  return { produced, submission };
}

test("a submission is refused below level 5, off a ticket, outside its ticket's folder or in the app's own folders", () => {
  const low = fixture(ENGINE_LEVELS.supervision);
  const lowTurn = segment(low);
  expect(() => submit(low, lowTurn.id, [[`${low.ticket.dir}/EP01_MASTER.mp4`, HASH_A]])).toThrow("not on at this engine level");

  const f = fixture();
  const planLevel = segment(f, f.producer.id, null);
  expect(() => submit(f, planLevel.id, [[`${f.plan.dir}/x.mp4`, HASH_A]])).toThrow("bind this segment to the ticket");
  f.store.setTurnStatus(planLevel.id, "completed");
  const other = f.store.createTicket({ taskId: f.plan.id, title: "07 字幕", worker: f.producer.id });
  const turn = segment(f);
  expect(() => submit(f, turn.id, [["elsewhere/x.mp4", HASH_A]])).toThrow("not this ticket's to hand over");
  expect(() => submit(f, turn.id, [[`${f.ticket.dir}/../x.mp4`, HASH_A]])).toThrow("not this ticket's to hand over");
  // Another ticket's file is not this ticket's work.
  expect(() => submit(f, turn.id, [[`${other.dir}/sub.srt`, HASH_A]])).toThrow("not another ticket's folder");
  expect(() => submit(f, turn.id, [[`${f.ticket.dir}/scratch/x.mp4`, HASH_A]])).toThrow("keeps for itself");
  expect(() => submit(f, turn.id, [[`${f.ticket.dir}/x.mp4`, "nothex"]])).toThrow("content hash");
  expect(f.store.listSubmissions({ taskId: f.plan.id })).toEqual([]);
  // The workspace's shared assets/ and the plan's own folder (its deliverables/) may be handed over
  // explicitly; implicitly only the ticket's own folder.
  expect(submit(f, turn.id, [["assets/render/EP01_cut.mp4", HASH_A]])!.submission.artifacts).toEqual([{ path: "assets/render/EP01_cut.mp4", sha256: HASH_A }]);
  expect(submit(f, turn.id, [[`${f.plan.dir}/deliverables/EP01_MASTER.mp4`, HASH_A]])!.submission.artifacts)
    .toEqual([{ path: `${f.plan.dir}/deliverables/EP01_MASTER.mp4`, sha256: HASH_A }]);
  expect(() => submit(f, turn.id, [["assets/render/EP01_cut.mp4", HASH_B]], "implicit")).toThrow("not in this ticket's folder");
  expect(() => submit(f, turn.id, [[`${f.plan.dir}/deliverables/EP01_MASTER.mp4`, HASH_B]], "implicit")).toThrow("not in this ticket's folder");
});

test("a submission records its files and parts, moves a todo ticket to doing, and an implicit one needs a new content hash", () => {
  const f = fixture();
  f.store.db.run("UPDATE tickets SET status = 'todo' WHERE id = ?", [f.ticket.id]);
  const turn = segment(f);
  const first = submit(f, turn.id, [[`${f.ticket.dir}/EP01_shot_07.mp4`, HASH_A]], "implicit")!;
  expect(first.submission).toMatchObject({ origin: "implicit", state: "checking", part_keys: ["shot_07"], bot_id: f.producer.id, awaiting: null,
    artifacts: [{ path: `${f.ticket.dir}/EP01_shot_07.mp4`, sha256: HASH_A }] });
  expect(ticketRow(f)).toEqual({ status: "doing", stage: "doing" });
  expect(f.store.db.query("SELECT key, attempts, current_artifact, stage FROM ticket_parts WHERE ticket_id = ?").all(f.ticket.id))
    .toEqual([{ key: "shot_07", attempts: 1, current_artifact: `${f.ticket.dir}/EP01_shot_07.mp4`, stage: "in_progress" }]);
  // The same bytes again hand nothing over; new bytes supersede the open one.
  expect(submit(f, turn.id, [[`${f.ticket.dir}/EP01_shot_07.mp4`, HASH_A]], "implicit")).toBeNull();
  const second = submit(f, turn.id, [[`${f.ticket.dir}/EP01_shot_07.mp4`, HASH_B]], "implicit")!;
  expect(f.store.getSubmission(first.submission.id).state).toBe("superseded");
  expect(second.submission.state).toBe("checking");
  expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'submission.created'").get()!.n).toBe(2);
});

test("an implicit submission is the producer's only — never the reviewer's notes, a review-woken segment's, or a stranger's", () => {
  const f = fixture();
  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  const notes: Array<[string, string]> = [[`${f.ticket.dir}/review-notes.md`, HASH_A]];
  // The ticket's reviewer.
  const reviewing = segment(f, f.reviewer.id);
  expect(submit(f, reviewing.id, notes, "implicit")).toBeNull();
  f.store.setTurnStatus(reviewing.id, "completed");
  // A third Bot on the ticket without a request for a deliverable.
  const third = f.store.createBot({ name: "Third", duties: "help", boundaries: "none" }).bot;
  f.store.addMember(f.room.id, third.id);
  const stranger = segment(f, third.id);
  expect(submit(f, stranger.id, notes, "implicit")).toBeNull();
  f.store.setTurnStatus(stranger.id, "completed");
  // A segment woken by a request to review, even of a Bot that is not the ticket's reviewer.
  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: null });
  const woken = segment(f, third.id);
  f.store.db.run(`INSERT INTO inbox_items (id, bot_id, session_id, turn_id, task_id, ticket_id, author, body_snapshot, source, kind, priority, state, created_at, delivered_turn_id)
    VALUES ('review-ask', ?, ?, ?, ?, ?, 'app', '请审查', 'review', 'change', 2, 'delivered', ?, ?)`, [third.id, f.room.id, woken.id, f.plan.id, f.ticket.id, isoNow(), woken.id]);
  expect(submit(f, woken.id, notes, "implicit")).toBeNull();
  f.store.setTurnStatus(woken.id, "completed");
  expect(f.store.listSubmissions({ taskId: f.plan.id })).toEqual([]);
  // The owner hands over.
  const owner = segment(f);
  expect(submit(f, owner.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_A]], "implicit")).not.toBeNull();
});

test("a failing gate sends the submission back; passing, it waits for the no-reviewer path or goes to the reviewer's queue", () => {
  const f = fixture();
  const turn = segment(f);
  const failing = submit(f, turn.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_A]])!;
  const check = gate(f, "fail");
  expect(f.store.submissionCheckIds(failing.submission)).toEqual([check.id]);
  const back = f.store.settleSubmissionChecks(failing.submission.id);
  expect(back).toMatchObject({ state: "checks_failed", failures: [{ check_id: check.id, gate: true, outcome: "fail" }] });
  expect(ticketRow(f)).toEqual({ status: "doing", stage: "doing" });

  const passing = submit(f, turn.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_B]])!;
  run(f, check.id, "pass");
  expect(f.store.settleSubmissionChecks(passing.submission.id)).toMatchObject({ state: "submitted", reviewer: null });
  expect(ticketRow(f)).toEqual({ status: "review", stage: "submitted" });

  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  const reviewed = submit(f, turn.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, "c".repeat(64)]])!;
  run(f, check.id, "pass");
  expect(f.store.settleSubmissionChecks(reviewed.submission.id)).toMatchObject({ state: "in_review", reviewer: f.reviewer.id });
  expect(ticketRow(f)).toEqual({ status: "review", stage: "in_review" });
  const asked = f.store.db.query<{ source: string; priority: number; state: string; body_snapshot: string }, [string]>(
    "SELECT source, priority, state, body_snapshot FROM inbox_items WHERE bot_id = ?").all(f.reviewer.id);
  expect(asked).toMatchObject([{ source: "review", priority: 2, state: "queued" }]);
  expect(asked[0]!.body_snapshot).toContain(reviewed.submission.id);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "reviewer", botId: f.reviewer.id, submissionId: reviewed.submission.id });
});

test("a reviewer cannot be the ticket's owner", () => {
  const f = fixture();
  expect(() => f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.producer.id })).toThrow("cannot be its owner");
});

test("a check from your words never blocks an approval, however often you said it; only a failing gate does", () => {
  const f = fixture();
  const { submission } = handedOver(f, { reviewer: true, model: "maker-model" });
  const said = requirement(f, "R-other", { times: 1 });
  const offer = proposal(f, said.quote);
  run(f, offer.id, "fail", "107.00 秒，要时长 108–132 秒");
  const reviewing = segment(f, f.reviewer.id);
  onModel(f, reviewing.id, "checker-model");
  const checks = f.store.submissionCheckResults([offer.id], submission.created_at);
  expect(checks).toMatchObject([{ gate: false, outcome: "fail" }]);
  expect(f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve", checks,
    verdicts: [{ requirement_id: "R-other", verdict: "pass", evidence: ["量过：时长够了"] }] })).toMatchObject({ ok: true, outcome: "approve" });

  const g = fixture();
  const blocked = handedOver(g, { reviewer: true });
  const check = gate(g, "fail");
  const reviewer = segment(g, g.reviewer.id);
  const refused = g.store.reviewSubmission({ turnId: reviewer.id, outcome: "approve", checks: g.store.submissionCheckResults([check.id], blocked.submission.created_at) });
  expect(refused).toMatchObject({ ok: false, code: "review_refused" });
  expect(g.store.getSubmission(blocked.submission.id).state).toBe("in_review");
});

test("a review: required items (raised twice, about the picture) need a pass with evidence, and a picture of this job read after the submission", () => {
  const f = fixture();
  const { submission } = handedOver(f, { reviewer: true, model: "maker-model" });
  expect(() => f.store.reviewSubmission({ turnId: segment(f).id, submissionId: submission.id, outcome: "approve" })).toThrow();
  const reviewing = segment(f, f.reviewer.id);
  onModel(f, reviewing.id, "other-model");
  requirement(f, "R-twice", { times: 2 });
  requirement(f, "R-picture", { category: "画面" });
  requirement(f, "R-once");
  const missing = f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve",
    verdicts: [{ requirement_id: "R-twice", verdict: "pass" }, { requirement_id: "R-once", verdict: "n/a" }] });
  expect(missing.ok ? [] : missing.reasons).toEqual([
    expect.stringContaining("R-twice 「要求 R-twice」 must be judged (raised): it needs pass with evidence, not pass without evidence"),
    expect.stringContaining("R-picture 「要求 R-picture」 must be judged (visual)"),
  ]);
  const verdicts = [{ requirement_id: "R-twice", verdict: "pass", evidence: ["量过 120 秒"] }, { requirement_id: "R-picture", verdict: "pass", evidence: ["看了第 3 帧"] }];
  // A picture outside this job's folder is no evidence.
  expect(f.store.recordFrameRead({ turnId: reviewing.id, path: "unrelated.png" })).toBe(true);
  const unseen = f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve", verdicts });
  expect(unseen.ok ? [] : unseen.reasons).toEqual([expect.stringContaining("read frames of this delivery")]);
  expect(f.store.recordFrameRead({ turnId: reviewing.id, path: `${f.ticket.dir}/frames/007.png` })).toBe(true);
  expect(f.store.recordFrameRead({ turnId: reviewing.id, path: `${f.ticket.dir}/frames/007.png` })).toBe(false);
  expect(f.store.recordFrameRead({ turnId: reviewing.id, path: `${f.ticket.dir}/notes.md` })).toBe(false);
  // A reviewer on another model passes it on its own judgment.
  const approved = f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve", verdicts });
  expect(approved).toMatchObject({ ok: true, outcome: "approve", submission: { state: "approved", reviews: [{ same_model: false, reviewer_bot_id: f.reviewer.id }] } });
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
  // The plan is delivered the way a done plan always is: its spec says done, and it closes.
  expect(f.store.db.query("SELECT stage, status, closed_at IS NOT NULL AS closed, json_extract(spec, '$.status') AS spec FROM tasks WHERE id = ?").get(f.plan.id))
    .toEqual({ stage: "delivered", status: "done", closed: 1, spec: "done" });
  expect(f.store.db.query("SELECT wakes, source FROM inbox_items WHERE bot_id = ? AND source = 'review'").all(f.producer.id)).toEqual([{ wakes: 0, source: "review" }]);
});

test("a same-model pass on what you raised twice, with no passing check behind it, waits on you; your word on the card approves it", () => {
  const f = fixture();
  const { submission } = handedOver(f, { reviewer: true, model: "same-model" });
  const said = requirement(f, "R-9", { times: 2 });
  const offer = proposal(f, said.quote);
  run(f, offer.id, "fail", "107.00 秒，要时长 108–132 秒");
  const reviewing = segment(f, f.reviewer.id);
  onModel(f, reviewing.id, "same-model");
  const result = f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve", verdicts: [{ requirement_id: "R-9", verdict: "pass", evidence: ["约 2 分钟"] }] });
  expect(result).toMatchObject({ ok: false, code: "awaiting_user" });
  if (result.ok || result.code !== "awaiting_user") throw new Error("expected to wait on you");
  expect(result.reasons.join(" ")).toContain("107.00 秒，要时长 108–132 秒");
  const card = result.card!;
  expect(card.control).toEqual({ kind: "review_item", submission_id: submission.id, task_id: f.plan.id, ticket_id: f.ticket.id,
    requirement_ids: ["R-9"], check_ids: [offer.id], checks_passing: false, offer: ["confirm_check", "confirm_item", "remove_item"] });
  expect(card.body).toContain("107.00 秒，要时长 108–132 秒");
  // The ball is yours; the producer is told nothing, and nothing asks it to recut.
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "review", ref: card.id });
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE bot_id = ? AND source = 'review'").get(f.producer.id)).toEqual({ n: 0 });
  expect(f.store.getSubmission(submission.id)).toMatchObject({ state: "in_review", awaiting: { requirement_ids: ["R-9"], message_id: card.id } });
  expect(f.store.db.query("SELECT kind, action_state FROM notifications WHERE semantic_key = ?").get(`review_item:${card.id}`)).toEqual({ kind: "ask", action_state: "open" });
  // A second review of it is not taken while it waits on you.
  expect(() => f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve" })).toThrow("waits on the user");

  const answered = f.store.answerReviewCard(card.id, "confirm_item");
  expect(answered.submission).toMatchObject({ state: "approved", awaiting: null, reviews: [{ same_model: true, outcome: "approve" }] });
  expect(answered.message.control).toMatchObject({ acted: ["confirm_item"] });
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
  expect(f.store.db.query("SELECT action_state FROM notifications WHERE semantic_key = ?").get(`review_item:${card.id}`)).toEqual({ action_state: "resolved" });
  expect(() => f.store.answerReviewCard(card.id, "remove_item")).toThrow("no longer offers");
});

test("removing the item on the card stops requiring it here and approves; a passing check behind it needs no card at all", () => {
  const f = fixture();
  const { submission } = handedOver(f, { reviewer: true, model: "same-model" });
  requirement(f, "R-9", { times: 2 });
  const reviewing = segment(f, f.reviewer.id);
  onModel(f, reviewing.id, "same-model");
  const result = f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve", verdicts: [{ requirement_id: "R-9", verdict: "pass", evidence: ["看过"] }] });
  if (result.ok || result.code !== "awaiting_user") throw new Error("expected to wait on you");
  expect(result.card!.control).toMatchObject({ offer: ["confirm_item", "remove_item"], check_ids: [] });
  expect(f.store.answerReviewCard(result.card!.id, "remove_item").submission.state).toBe("approved");
  expect(f.store.db.query("SELECT status FROM requirements WHERE id = 'R-9'").get()).toEqual({ status: "waived" });

  const g = fixture();
  const backed = handedOver(g, { reviewer: true, model: "same-model" });
  const said = requirement(g, "R-9", { times: 2 });
  const offer = proposal(g, said.quote);
  // A check in force (you confirmed it) that passes backs it; a passing proposal does not.
  g.store.db.run("UPDATE acceptance_checks SET derived_state = 'active' WHERE id = ?", [offer.id]);
  run(g, offer.id, "pass", "120.00 秒");
  const reviewer = segment(g, g.reviewer.id);
  onModel(g, reviewer.id, "same-model");
  // The checks as the engine runs them again before an approval.
  const checks = g.store.submissionCheckResults([offer.id], backed.submission.created_at);
  expect(g.store.reviewSubmission({ turnId: reviewer.id, outcome: "approve", checks, verdicts: [{ requirement_id: "R-9", verdict: "pass", evidence: ["120 秒"] }] }))
    .toMatchObject({ ok: true, submission: { id: backed.submission.id, state: "approved" } });
});

test("with a reviewer set only it reviews; with none, only a Bot in the plan's conversation; never the producer", () => {
  const f = fixture();
  const third = f.store.createBot({ name: "Third", duties: "help", boundaries: "none" }).bot;
  f.store.addMember(f.room.id, third.id);
  const { submission } = handedOver(f, { reviewer: true });
  const byThird = segment(f, third.id);
  expect(() => f.store.reviewSubmission({ turnId: byThird.id, submissionId: submission.id, outcome: "approve" })).toThrow("this ticket's reviewer is Reviewer");
  f.store.setTurnStatus(byThird.id, "completed");

  const g = fixture();
  const loose = handedOver(g);
  const outsider = g.store.createBot({ name: "Outsider", duties: "other", boundaries: "none" }).bot;
  const dm = g.store.createDirect("user", outsider.id);
  const trigger = g.store.insertMessage({ sessionId: dm.id, kind: "system", author: outsider.id, body: "看看" });
  const elsewhere = g.store.createTurn({ sessionId: dm.id, botId: outsider.id, triggerMessageId: trigger.id });
  expect(() => g.store.reviewSubmission({ turnId: elsewhere.id, submissionId: loose.submission.id, outcome: "approve" })).toThrow("only a Bot in this plan's conversation");
  const member = segment(g, g.reviewer.id);
  expect(g.store.reviewSubmission({ turnId: member.id, submissionId: loose.submission.id, outcome: "reject", note: "重做" })).toMatchObject({ ok: true, outcome: "reject" });
});

test("your board status supersedes the hand-overs waiting on the ticket, and a review then finds nothing to judge", () => {
  const f = fixture();
  const { submission } = handedOver(f, { reviewer: true });
  const reviewing = segment(f, f.reviewer.id);
  f.store.patchTicketByUser(f.ticket.id, { status: "done" });
  expect(f.store.getSubmission(submission.id).state).toBe("superseded");
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
  expect(() => f.store.reviewSubmission({ turnId: reviewing.id, submissionId: submission.id, outcome: "reject", note: "重做" })).toThrow("nothing to review");
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
});

test("from level 5 the organizer neither moves a ticket's status nor marks the plan done; a new ticket it opens is to do", () => {
  const f = fixture();
  const { submission } = handedOver(f);
  const spec = { kind: "x", goal: "EP01", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "done" as const };
  f.store.applyOrganizerResult({ sessionId: f.room.id, current: f.store.getTask(f.plan.id),
    result: { decision: "continue", resumePlanId: null, spec, tickets: [{ id: f.ticket.id, spec: "", status: "done" }, { id: "new-1", title: "08 海报", spec: "", status: "done" }], messageTicket: null },
    source: { messageId: null, turnId: null, messageBody: "" }, settle: true });
  expect(ticketRow(f)).toEqual({ status: "review", stage: "submitted" });
  // A new ticket it reads as done opens to do, and its "done" becomes the organizer's submission on it.
  const poster = f.store.listTickets(f.plan.id).find((ticket) => ticket.title === "08 海报")!;
  expect(f.store.listSubmissions({ ticketId: poster.id })).toMatchObject([{ origin: "organizer", state: "submitted", artifacts: [] }]);
  expect(f.store.db.query("SELECT payload FROM work_events WHERE kind = 'ticket.stage_changed' AND ticket_id = ? ORDER BY seq LIMIT 1").get(poster.id))
    .toEqual({ payload: expect.stringContaining('"after":"submitted"') });
  expect(f.store.db.query("SELECT status FROM tasks WHERE id = ?").get(f.plan.id)).toEqual({ status: "active" });
  expect(f.store.getSubmission(submission.id).state).toBe("submitted");

  const low = fixture(ENGINE_LEVELS.supervision);
  low.store.applyOrganizerResult({ sessionId: low.room.id, current: low.store.getTask(low.plan.id),
    result: { decision: "continue", resumePlanId: null, spec, tickets: [{ id: low.ticket.id, spec: "", status: "done" }], messageTicket: null },
    source: { messageId: null, turnId: null, messageBody: "" }, settle: true });
  expect(low.store.getTicket(low.ticket.id).status).toBe("done");
});

test("with no reviewer the tick reads the checks as they are now — a gate failing since sends it back to its producer", () => {
  const f = fixture();
  const { produced, submission } = handedOver(f);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "app", reason: "approval", ref: submission.id });
  expect(superviseSubmissions(f.ctx, isoNow()).moved).toEqual([]);
  gate(f, "fail");
  expect(superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000)).moved).toMatchObject([{ id: submission.id, state: "checks_failed" }]);
  expect(ticketRow(f)).toEqual({ status: "doing", stage: "rework" });
  const told = f.store.db.query<{ body_snapshot: string; wakes: number }, [string]>("SELECT body_snapshot, wakes FROM inbox_items WHERE bot_id = ? AND source = 'review'").all(f.producer.id);
  expect(told).toMatchObject([{ wakes: 1 }]);
  expect(told[0]!.body_snapshot).toContain("母带存在");
  void produced;
});

test("with no reviewer, a required item nothing backs asks you; dropping it on the board lets the next tick approve", () => {
  const f = fixture();
  const { submission } = handedOver(f);
  requirement(f, "R-picture", { category: "画面" });
  const tick = superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(tick.moved).toMatchObject([{ id: submission.id, state: "submitted", awaiting: { requirement_ids: ["R-picture"], review: null } }]);
  expect(tick.messages).toHaveLength(1);
  expect(tick.messages[0]!.body).toContain("没有审查者");
  // The next tick asks nothing new.
  expect(superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 2_000)).messages).toEqual([]);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE bot_id = ?").get(f.producer.id)).toEqual({ n: 0 });
  // You drop the requirement on the board, not on the card: taken up again — a file hand-over with
  // no active gate still waits on your approve/reject card, not an automatic approval;
  // the required-items card is let go either way.
  f.store.waiveRequirement("R-picture", { taskId: f.plan.id });
  const next = superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 3_000));
  expect(next.moved).toMatchObject([{ id: submission.id, state: "submitted", awaiting: { kind: "approval" } }]);
  expect(f.store.getMessage(tick.messages[0]!.id).control).toMatchObject({ kind: "review_item", offer: [] });
  const approvalCardId = f.store.getSubmission(submission.id).awaiting!.message_id!;
  expect(f.store.answerReviewCard(approvalCardId, "approve").submission.state).toBe("approved");
});

test("nothing is approved under a stop of yours over the job, nor in a dormant plan", () => {
  const f = fixture();
  const { submission } = handedOver(f);
  const hold = createHold(f.ctx, { scope: "plan", scopeId: f.plan.id, source: "user_button" });
  const due = later(UNREVIEWED_AFTER_MS + 1_000);
  expect(superviseSubmissions(f.ctx, due).moved).toEqual([]);
  liftHold(f.ctx, hold.id, { by: "user_button" });
  f.store.db.run("UPDATE tasks SET dormant_since = ? WHERE id = ?", [isoNow(), f.plan.id]);
  expect(superviseSubmissions(f.ctx, due).moved).toEqual([]);
  f.store.db.run("UPDATE tasks SET dormant_since = NULL WHERE id = ?", [f.plan.id]);
  // No active gate backs this file hand-over, so it waits on your approve/reject card rather than
  // approving itself — the point here is that it is taken up at all once free.
  expect(superviseSubmissions(f.ctx, due).moved).toMatchObject([{ id: submission.id, state: "submitted", awaiting: { kind: "approval" } }]);
});

test("the supervisor's tick takes on submissions only from level 5", () => {
  const f = fixture();
  const { submission } = handedOver(f);
  const tick = f.store.supervisorTick({ now: later(UNREVIEWED_AFTER_MS + 1_000) });
  expect(tick.approved.map((row) => row.id)).toEqual([submission.id]);
  expect(tick.unsupported).toEqual(["external_jobs"]);
  f.store.db.run("UPDATE settings SET value = '4' WHERE key = 'engine_level'");
  expect(f.store.supervisorTick({ now: later(UNREVIEWED_AFTER_MS + 2_000) })).toMatchObject({ approved: [], unsupported: ["external_jobs", "reviewer_assignment"] });
});

test("a rejection sends the ticket and its parts to rework and wakes the producer", () => {
  const f = fixture();
  const produced = segment(f);
  f.store.setTurnStatus(produced.id, "completed");
  f.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [produced.work_item_id]);
  const { submission } = submit(f, produced.id, [[`${f.ticket.dir}/EP01_shot_03.mp4`, HASH_A]], "implicit")!;
  f.store.settleSubmissionChecks(submission.id);
  const reviewing = segment(f, f.reviewer.id);
  const rejected = f.store.reviewSubmission({ turnId: reviewing.id, outcome: "reject", note: "第 3 镜左右手反了",
    verdicts: [{ requirement_id: "R-x", verdict: "fail", evidence: ["frame 12"] }] });
  expect(rejected).toMatchObject({ ok: true, outcome: "reject", submission: { state: "rejected" } });
  expect(ticketRow(f)).toEqual({ status: "doing", stage: "rework" });
  expect(f.store.db.query("SELECT stage FROM ticket_parts WHERE ticket_id = ?").all(f.ticket.id)).toEqual([{ stage: "rework" }]);
  expect(f.store.db.query("SELECT state FROM work_items WHERE id = ?").get(produced.work_item_id)).toEqual({ state: "queued" });
  const told = f.store.db.query<{ body_snapshot: string; wakes: number }, [string]>("SELECT body_snapshot, wakes FROM inbox_items WHERE bot_id = ? AND source = 'review'").all(f.producer.id);
  expect(told).toMatchObject([{ wakes: 1 }]);
  expect(told[0]!.body_snapshot).toContain("第 3 镜左右手反了");
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "owner", botId: f.producer.id });
});

test("from level 5 a handed-over ticket is not its producer's obligation, and its work closes only once approved", () => {
  const f = fixture();
  const turn = segment(f);
  const { submission } = submit(f, turn.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_A]])!;
  f.store.settleSubmissionChecks(submission.id);
  expect(f.store.finishWork({ turnId: turn.id, reason: "done" })).toMatchObject({ ended: true, endReason: "done", state: "idle", obligations: { tickets: [] } });

  const g = fixture();
  const ending = segment(g);
  expect(g.store.endAfterSubmit(ending.id)).toEqual({ ended: false, reason: expect.stringContaining("open requests, waits or tickets") });
  const { submission: handed } = submit(g, ending.id, [[`${g.ticket.dir}/EP01_MASTER.mp4`, HASH_A]])!;
  g.store.settleSubmissionChecks(handed.id);
  expect(g.store.endAfterSubmit(ending.id)).toEqual({ ended: true });
  expect(g.store.db.query("SELECT end_reason FROM turns WHERE id = ?").get(ending.id)).toEqual({ end_reason: "done" });
  expect(g.store.db.query("SELECT state FROM work_items WHERE id = ?").get(ending.work_item_id)).toEqual({ state: "idle" });
});

test("a status written on the board moves the stage with it, and an observed hand-over no longer moves the ticket at level 5", () => {
  const f = fixture();
  const turn = segment(f);
  const { submission } = submit(f, turn.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_A]])!;
  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  f.store.settleSubmissionChecks(submission.id);
  expect(ticketRow(f)).toEqual({ status: "review", stage: "in_review" });
  f.store.patchTicketByUser(f.ticket.id, { status: "doing" });
  expect(ticketRow(f)).toEqual({ status: "doing", stage: "doing" });
  f.store.observeTicketWork({ ticketId: f.ticket.id, botId: f.producer.id, turnId: turn.id, seen: "delivered" });
  expect(ticketRow(f)).toEqual({ status: "doing", stage: "doing" });

  const low = fixture(ENGINE_LEVELS.supervision);
  low.store.observeTicketWork({ ticketId: low.ticket.id, botId: low.producer.id, seen: "delivered" });
  expect(low.store.db.query("SELECT status, stage FROM tickets WHERE id = ?").get(low.ticket.id)).toEqual({ status: "review", stage: null });
});

test("a ticket in review from before level 5, with no submission, still awaits your review", () => {
  const f = fixture();
  f.store.db.run("UPDATE tickets SET status = 'review' WHERE id = ?", [f.ticket.id]);
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "review", ref: f.ticket.id });
});

test("the reviewer can also be the one an open request to review asks", () => {
  const f = fixture();
  const turn = segment(f);
  f.store.delegateWork({ fromTurnId: turn.id, toBotId: f.reviewer.id, ask: "审一下母带", expects: "review", continue: true });
  const { submission } = submit(f, turn.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_A]])!;
  expect(f.store.settleSubmissionChecks(submission.id)).toMatchObject({ state: "in_review", reviewer: f.reviewer.id });
});

test("parts passed and the reviewer setting show on the board only from level 5", () => {
  const f = fixture();
  f.store.db.run(`INSERT INTO ticket_parts (id, ticket_id, key, title, declared_by, stage) VALUES ('p1', ?, 'shot_07', 'Shot 07', 'filename', 'approved')`, [f.ticket.id]);
  expect(f.store.taskDetail(f.plan.id, () => true)).toMatchObject({ submissions_on: true, tickets: [{ parts: { total: 1, approved: 1 } }] });
  const low = fixture(ENGINE_LEVELS.supervision);
  low.store.db.run(`INSERT INTO ticket_parts (id, ticket_id, key, title, declared_by) VALUES ('p1', ?, 'shot_07', 'Shot 07', 'filename')`, [low.ticket.id]);
  const detail = low.store.taskDetail(low.plan.id, () => true);
  expect(detail.submissions_on).toBeUndefined();
  expect(detail.tickets[0]!.parts).toBeUndefined();
});

test("part numbers come from shot, C and 镜 names, digits or Chinese, and not from words that merely end in c", () => {
  expect(filenamePartNumbers("work/x/EP01_shot_07.mp4")).toEqual([7]);
  expect(filenamePartNumbers("C12_v2.mp4")).toEqual([12]);
  expect(filenamePartNumbers("镜头三.png")).toEqual([3]);
  expect(filenamePartNumbers("第十二镜.mp4")).toEqual([12]);
  expect(filenamePartNumbers("music01.mp3")).toEqual([]);
  expect(filenamePartNumbers("EP01_MASTER.mp4")).toEqual([]);
});

const DONE_SPEC = { kind: "x", goal: "EP01", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" as const };
/** The organizer's settle reading `ticketId` as done, on `f`'s own plan and session. */
function organizerSettlesDone(f: Fixture, ticketId: string) {
  return f.store.applyOrganizerResult({ sessionId: f.room.id, current: f.store.getTask(f.plan.id),
    result: { decision: "continue", resumePlanId: null, spec: DONE_SPEC, tickets: [{ id: ticketId, spec: "", status: "done" }], messageTicket: null },
    source: { messageId: null, turnId: null, messageBody: "" }, settle: true });
}

test("the organizer's done on a ticket nothing was handed over on goes the no-reviewer way — checks, a card for an unbacked required item, never straight to approved", () => {
  const f = fixture();
  const settleDone = (ticketId: string) => organizerSettlesDone(f, ticketId);
  settleDone(f.ticket.id);
  const [reading] = f.store.listSubmissions({ ticketId: f.ticket.id });
  expect(reading).toMatchObject({ origin: "organizer", state: "submitted", bot_id: f.producer.id, artifacts: [] });
  expect(ticketRow(f)).toEqual({ status: "review", stage: "submitted" });
  // Said again, nothing more is made.
  settleDone(f.ticket.id);
  expect(f.store.listSubmissions({ ticketId: f.ticket.id })).toHaveLength(1);
  // A required item about the picture with nothing behind it: the next tick asks you, with no reviewer to ask instead.
  requirement(f, "R-picture", { category: "画面" });
  const tick = superviseSubmissions(f.ctx, later(1_000));
  expect(tick.messages).toHaveLength(1);
  expect(f.store.getSubmission(reading!.id)).toMatchObject({ state: "submitted", awaiting: { requirement_ids: ["R-picture"], review: null, kind: "items" } });
  // Confirming the item backs it, but an organizer's reading with no reviewer still never jumps
  // straight to approved: a second card asks you to approve it outright.
  const confirmed = f.store.answerReviewCard(tick.messages[0]!.id, "confirm_item");
  expect(confirmed.submission).toMatchObject({ state: "submitted", awaiting: { requirement_ids: [], kind: "approval" } });
  expect(ticketRow(f)).toEqual({ status: "review", stage: "submitted" });
  const approvalCardId = confirmed.submission.awaiting!.message_id!;
  expect(f.store.getMessage(approvalCardId).control).toMatchObject({ kind: "review_item", requirement_ids: [], check_ids: [], offer: ["approve", "reject"] });
  expect(f.store.answerReviewCard(approvalCardId, "approve").submission.state).toBe("approved");
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });

  // Nothing required and no reviewer: still a card, not an automatic approval — a failing gate sends it back instead.
  const g = fixture();
  gate(g, "fail");
  organizerSettlesDone(g, g.ticket.id);
  const [graded] = g.store.listSubmissions({ ticketId: g.ticket.id });
  // Its gate has no run since the reading: the tick waits and asks for one.
  expect(superviseSubmissions(g.ctx, later(1_000))).toMatchObject({ moved: [], toRun: [{ taskId: g.plan.id }] });
  const [check] = g.store.listChecks(g.plan.id);
  run(g, check!.id, "fail");
  expect(superviseSubmissions(g.ctx, later(2_000)).moved).toMatchObject([{ id: graded!.id, state: "checks_failed" }]);
  expect(g.store.db.query("SELECT status, stage FROM tickets WHERE id = ?").get(g.ticket.id)).toEqual({ status: "doing", stage: "rework" });

  // Passing, nothing required: a card asks you to approve it, not an automatic approval.
  const i = fixture();
  organizerSettlesDone(i, i.ticket.id);
  const [clean] = i.store.listSubmissions({ ticketId: i.ticket.id });
  const cleanTick = superviseSubmissions(i.ctx, later(1_000));
  expect(cleanTick.messages).toHaveLength(1);
  expect(i.store.getSubmission(clean!.id)).toMatchObject({ state: "submitted", awaiting: { kind: "approval", message_id: cleanTick.messages[0]!.id } });
  expect(cleanTick.messages[0]!.control).toMatchObject({ offer: ["approve", "reject"] });
  expect(cleanTick.messages[0]!.body).toContain("整理跳认为这张任务做完了");
  // The next tick asks nothing new: the same card stands, waiting on you alone.
  expect(superviseSubmissions(i.ctx, later(2_000)).messages).toEqual([]);
  // 退回 sends it to rework like any other reject; the producer is a Bot, so it is woken.
  expect(i.store.answerReviewCard(cleanTick.messages[0]!.id, "reject").submission.state).toBe("rejected");
  expect(i.store.db.query("SELECT status, stage FROM tickets WHERE id = ?").get(i.ticket.id)).toEqual({ status: "doing", stage: "rework" });
  expect(i.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE bot_id = ? AND source = 'review'").get(i.producer.id)).toEqual({ n: 1 });

  // A ticket with a hand-over of its own moves by that, not by the organizer.
  const h = fixture();
  const { submission } = handedOver(h);
  organizerSettlesDone(h, h.ticket.id);
  expect(h.store.listSubmissions({ ticketId: h.ticket.id }).map((row) => row.id)).toEqual([submission.id]);
});

test("an organizer's reading is sent to the ticket's reviewer once it has one, not approved on the no-reviewer path", () => {
  const f = fixture();
  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  organizerSettlesDone(f, f.ticket.id);
  const [reading] = f.store.listSubmissions({ ticketId: f.ticket.id });
  expect(reading).toMatchObject({ origin: "organizer", state: "submitted" });
  const tick = superviseSubmissions(f.ctx, later(1_000));
  expect(tick.moved).toMatchObject([{ id: reading!.id, state: "in_review" }]);
  expect(ticketRow(f)).toEqual({ status: "review", stage: "in_review" });
  const asked = f.store.db.query<{ source: string; body_snapshot: string }, [string]>("SELECT source, body_snapshot FROM inbox_items WHERE bot_id = ?").all(f.reviewer.id);
  expect(asked).toMatchObject([{ source: "review" }]);
  // Its note says what it is — the empty-files rendering a plain file list would give it is a bug too.
  expect(asked[0]!.body_snapshot).toContain("整理跳认为这张任务做完了");
  const reviewing = segment(f, f.reviewer.id);
  // The reviewer's clean approve still does not approve it: nobody made the
  // organizer's reading, so it waits on your card too, with the reviewer's verdict shown there.
  const result = f.store.reviewSubmission({ turnId: reviewing.id, submissionId: reading!.id, outcome: "approve" });
  expect(result).toMatchObject({ ok: false, code: "awaiting_user" });
  if (result.ok || result.code !== "awaiting_user") throw new Error("expected to wait on you");
  expect(f.store.getSubmission(reading!.id)).toMatchObject({ state: "in_review", awaiting: { kind: "approval", review: { outcome: "approve", reviewer_bot_id: f.reviewer.id } } });
  expect(result.card?.control).toMatchObject({ offer: ["approve", "reject"] });
  expect(f.store.answerReviewCard(result.card!.id, "approve").submission.state).toBe("approved");
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
});

test("the organizer's reading skips a ticket whose producer is still running, or whose work item is not idle", () => {
  const f = fixture();
  const busy = segment(f);
  const settleDone = () => organizerSettlesDone(f, f.ticket.id);
  // A running segment on the ticket: the reading is skipped, not raced ahead of.
  settleDone();
  expect(f.store.listSubmissions({ ticketId: f.ticket.id })).toEqual([]);
  // The segment ends, but its work item is still queued, not idle: still skipped.
  f.store.setTurnStatus(busy.id, "completed");
  settleDone();
  expect(f.store.listSubmissions({ ticketId: f.ticket.id })).toEqual([]);
  // Once idle, the next reading goes through.
  f.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [busy.work_item_id]);
  settleDone();
  expect(f.store.listSubmissions({ ticketId: f.ticket.id })).toMatchObject([{ origin: "organizer", state: "submitted" }]);
});

test("a plan with no ticket to approve may still be read as done by the organizer", () => {
  const f = fixture();
  const words = f.store.openTask({ sessionId: f.room.id, title: "写一句话" });
  f.store.applyOrganizerResult({ sessionId: f.room.id, current: f.store.getTask(words.id),
    result: { decision: "continue", resumePlanId: null, spec: { kind: "x", goal: "写一句话", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "done" },
      tickets: [], messageTicket: null }, source: { messageId: null, turnId: null, messageBody: "" }, settle: true });
  expect(f.store.db.query("SELECT status FROM tasks WHERE id = ?").get(words.id)).toEqual({ status: "done" });
});

test("words handed over in place of a file — the producer's, on a ticket no file was handed over on, new words only", () => {
  const f = fixture();
  const turn = segment(f);
  const answered = f.store.prepareSubmission({ turnId: turn.id, origin: "answer", artifacts: [], content: "三个选题：雪原、灯塔、潮汐" })!;
  expect(answered.submission).toMatchObject({ origin: "answer", artifacts: [], content: "三个选题：雪原、灯塔、潮汐", state: "checking" });
  expect(f.store.prepareSubmission({ turnId: turn.id, origin: "answer", artifacts: [], content: "三个选题：雪原、灯塔、潮汐" })).toBeNull();
  expect(f.store.prepareSubmission({ turnId: turn.id, origin: "answer", artifacts: [], content: "  " })).toBeNull();
  f.store.settleSubmissionChecks(answered.submission.id);
  // With no reviewer, an answer still waits on your approve/reject card: never approved on its own.
  const tick = superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(tick.moved).toMatchObject([{ id: answered.submission.id, state: "submitted", awaiting: { kind: "approval" } }]);
  const card = tick.messages[0]!;
  expect(card.control).toMatchObject({ offer: ["approve", "reject"] });
  expect(card.body).toContain("三个选题：雪原、灯塔、潮汐");
  expect(f.store.answerReviewCard(card.id, "approve").submission.state).toBe("approved");

  // A ticket a file was handed over on is not closed by words.
  const g = fixture();
  const filed = handedOver(g);
  expect(g.store.prepareSubmission({ turnId: filed.produced.id, origin: "answer", artifacts: [], content: "说明一下" })).toBeNull();
  // Nor by a Bot that is not its producer.
  const reviewing = segment(g, g.reviewer.id);
  expect(g.store.prepareSubmission({ turnId: reviewing.id, origin: "answer", artifacts: [], content: "看过了" })).toBeNull();
});

test("the review request for an answer names the words themselves, not an empty file list", () => {
  const f = fixture();
  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  const turn = segment(f);
  const answered = f.store.prepareSubmission({ turnId: turn.id, origin: "answer", artifacts: [], content: "三个选题：雪原、灯塔、潮汐" })!;
  f.store.settleSubmissionChecks(answered.submission.id);
  const asked = f.store.db.query<{ body_snapshot: string }, [string]>("SELECT body_snapshot FROM inbox_items WHERE bot_id = ?").all(f.reviewer.id);
  expect(asked).toHaveLength(1);
  const body = asked[0]!.body_snapshot;
  expect(body).toContain("三个选题：雪原、灯塔、潮汐");
  expect(body).not.toContain("：。");
});

test("a passing check from your words, not confirmed, backs nothing — the card shows it, with 确认这条检查 first", () => {
  const f = fixture();
  const { submission } = handedOver(f, { reviewer: true, model: "same-model" });
  const said = requirement(f, "R-misread", { times: 2 });
  const offer = proposal(f, said.quote);
  // A misread number that a wrong cut happens to pass.
  run(f, offer.id, "pass", "90.00 秒");
  const reviewing = segment(f, f.reviewer.id);
  onModel(f, reviewing.id, "same-model");
  const result = f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve", verdicts: [{ requirement_id: "R-misread", verdict: "pass", evidence: ["约 2 分钟"] }] });
  expect(result).toMatchObject({ ok: false, code: "awaiting_user" });
  if (result.ok || result.code !== "awaiting_user") throw new Error("expected to wait on you");
  expect(result.card!.control).toMatchObject({ check_ids: [offer.id], offer: ["confirm_check", "confirm_item", "remove_item"] });
  expect(result.card!.body).toContain("90.00 秒");
  expect(f.store.getSubmission(submission.id).state).toBe("in_review");

  // With no reviewer, the same: a card, not an approval.
  const g = fixture();
  const loose = handedOver(g);
  const quote = requirement(g, "R-misread", { times: 2 });
  run(g, proposal(g, quote.quote).id, "pass", "90.00 秒");
  const tick = superviseSubmissions(g.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(tick.messages).toHaveLength(1);
  expect(g.store.getSubmission(loose.submission.id)).toMatchObject({ state: "submitted", awaiting: { requirement_ids: ["R-misread"] } });
});

test("a gate that has not finished running by the tick is waited for, not read as a failure", () => {
  const f = fixture();
  const { submission } = handedOver(f);
  const now = isoNow();
  f.store.db.run(`INSERT INTO acceptance_checks (id, task_id, ticket_id, item, kind, path, source, created_at, updated_at, defined_at)
    VALUES ('late-gate', ?, ?, '母带存在', 'exists', ?, 'user', ?, ?, ?)`, [f.plan.id, f.ticket.id, `${f.ticket.dir}/EP01_MASTER.mp4`, now, now, now]);
  f.store.beginCheckRun("late-gate", "settle");
  const tick = superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(tick).toMatchObject({ moved: [], toRun: [{ taskId: f.plan.id, checkIds: ["late-gate"] }] });
  expect(f.store.getSubmission(submission.id).state).toBe("submitted");
  run(f, "late-gate", "pass");
  expect(superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 2_000)).moved).toMatchObject([{ id: submission.id, state: "approved" }]);
});

test("a Bot that did an owned ticket's work hears once that its files were not handed over; the owner and the reviewer hear nothing", () => {
  const f = fixture();
  const third = f.store.createBot({ name: "Third", duties: "help", boundaries: "none" }).bot;
  f.store.addMember(f.room.id, third.id);
  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  const files = [`${f.ticket.dir}/board.md`];
  const helper = segment(f, third.id);
  const hint = f.store.handOverHint({ turnId: helper.id, paths: files });
  expect(hint).toContain("Director");
  expect(hint).toContain("submit");
  expect(f.store.handOverHint({ turnId: helper.id, paths: files })).toBeNull();
  f.store.setTurnStatus(helper.id, "completed");
  expect(f.store.handOverHint({ turnId: segment(f, f.reviewer.id).id, paths: [`${f.ticket.dir}/frame.png`] })).toBeNull();
  expect(f.store.handOverHint({ turnId: segment(f).id, paths: files })).toBeNull();
});

test("a non-owner hears once that only the owner hands over words; the owner and the reviewer hear nothing", () => {
  const f = fixture();
  const third = f.store.createBot({ name: "Third", duties: "help", boundaries: "none" }).bot;
  f.store.addMember(f.room.id, third.id);
  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  const helper = segment(f, third.id);
  const hint = f.store.answerHint({ turnId: helper.id });
  expect(hint).toContain("owner");
  expect(hint).toContain("submit");
  expect(hint).toContain("Director");
  // Said once per segment, not again.
  expect(f.store.answerHint({ turnId: helper.id })).toBeNull();
  f.store.setTurnStatus(helper.id, "completed");
  expect(f.store.answerHint({ turnId: segment(f, f.reviewer.id).id })).toBeNull();
  expect(f.store.answerHint({ turnId: segment(f).id })).toBeNull();
});

test("the board offers as reviewers only the Bots of the plan's conversation", () => {
  const f = fixture();
  f.store.createBot({ name: "Elsewhere", duties: "other", boundaries: "none" });
  expect(f.store.taskDetail(f.plan.id, () => true).reviewer_ids?.sort()).toEqual([f.producer.id, f.reviewer.id].sort());
});

test("a reviewer's approve of a hand-over nothing of yours backs waits on your card unless it is on another model and gives evidence", () => {
  const onLook = (id: string) => [{ requirement_id: id, verdict: "pass", evidence: ["看过母带第 3 秒的画面"] }];
  const cases = [
    { name: "same model, with evidence", reviewerModel: "m-1", verdicts: "real", backing: null, approves: false },
    { name: "another model, no evidence", reviewerModel: "m-2", verdicts: "none", backing: null, approves: false },
    { name: "another model, evidence on a made-up requirement", reviewerModel: "m-2", verdicts: "made-up", backing: null, approves: false },
    { name: "a model nobody recorded counts as the producer's own", reviewerModel: null, verdicts: "real", backing: null, approves: false },
    { name: "another model, with evidence", reviewerModel: "m-2", verdicts: "real", backing: null, approves: true },
    { name: "same model, no evidence, a passing check of yours behind it", reviewerModel: "m-1", verdicts: "none", backing: "user", approves: true },
    { name: "same model, no evidence, only the organizer's passing check behind it", reviewerModel: "m-1", verdicts: "none", backing: "organizer", approves: false },
  ] as const;
  for (const c of cases) {
    const f = fixture();
    const { submission } = handedOver(f, { reviewer: true, model: "m-1" });
    const look = requirement(f, "R-look", { times: 1 });
    const backing = c.backing ? gate(f, "pass") : null;
    if (backing && c.backing === "organizer") f.store.db.run("UPDATE acceptance_checks SET source = 'organizer' WHERE id = ?", [backing.id]);
    const reviewing = segment(f, f.reviewer.id);
    if (c.reviewerModel) onModel(f, reviewing.id, c.reviewerModel);
    const verdicts = c.verdicts === "real" ? onLook(look.id) : c.verdicts === "made-up" ? onLook("R-made-up") : [];
    const checks = backing ? f.store.submissionCheckResults([backing.id], submission.created_at) : undefined;
    const result = f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve", verdicts, checks });
    const after = f.store.getSubmission(submission.id);
    if (c.approves) {
      expect({ name: c.name, result }).toMatchObject({ name: c.name, result: { ok: true, outcome: "approve" } });
      expect(ticketRow(f).stage).toBe("approved");
      continue;
    }
    expect({ name: c.name, result }).toMatchObject({ name: c.name, result: { ok: false, code: "awaiting_user" } });
    expect(after.awaiting).toMatchObject({ kind: "approval", review: { reviewer_bot_id: f.reviewer.id, same_model: c.reviewerModel !== "m-2" } });
    expect(ticketRow(f).stage).not.toBe("approved");
    const card = f.store.getMessage(after.awaiting!.message_id!);
    expect(card.control).toMatchObject({ kind: "review_item", offer: ["approve", "reject"] });
    expect(card.body).toContain("Reviewer");
    expect(card.body).toContain("EP01_MASTER.mp4");
    if (!c.reviewerModel) expect(card.body).toContain("有一方模型不明，按同模型算");
  }
});

test("with no reviewer, only a passing check of yours lets a file hand-over through on its own; the organizer's passing check does not", () => {
  for (const source of ["user", "organizer"] as const) {
    const f = fixture();
    const { submission } = handedOver(f);
    const check = gate(f, "pass");
    if (source === "organizer") f.store.db.run("UPDATE acceptance_checks SET source = 'organizer' WHERE id = ?", [check.id]);
    superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
    const after = f.store.getSubmission(submission.id);
    if (source === "user") expect(after).toMatchObject({ state: "approved" });
    else expect(after).toMatchObject({ state: "submitted", awaiting: { kind: "approval" } });
  }
});
