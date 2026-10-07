import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoNow } from "../ids";
import { Store } from ".";
import { ENGINE_LEVELS } from "./schema-gate";
import { createHold, liftHold } from "./holds";
import { checkLines, setTicketStage, settlePlanStage, superviseSubmissions, UNREVIEWED_AFTER_MS } from "./submissions";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
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

/** Shot `n` as a part of `f`'s ticket, declared as the lead declares it with plan_items (no file name makes one). */
function shotPart(f: Fixture, n: number): string {
  const key = `shot_${String(n).padStart(2, "0")}`;
  f.store.db.run(`INSERT OR IGNORE INTO ticket_parts (id, ticket_id, key, title, declared_by) VALUES (?, ?, ?, ?, 'plan_items')`,
    [`${f.ticket.id}-${key}`, f.ticket.id, key, `Shot ${String(n).padStart(2, "0")}`]);
  return key;
}

/** A hand-over of shot `n`'s file that names its part, as a Bot's submit does. */
function submitShot(f: Fixture, turnId: string, n: number, sha256: string) {
  return f.store.prepareSubmission({ turnId, origin: "submit", artifacts: [{ path: `${f.ticket.dir}/shot_${String(n).padStart(2, "0")}.mp4`, sha256 }], parts: [shotPart(f, n)] });
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
/**
 * A master handed over after an earlier segment on the job, as a master is: not made in one go, so
 * with nothing of yours behind it, it comes to your card.
 */
function handedOver(f: Fixture, opts: { reviewer?: boolean; model?: string } = {}) {
  if (opts.reviewer) f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  f.store.setTurnStatus(segment(f).id, "completed");
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
  // A file's name makes no part (ADR 0057): the hand-over names the part the lead declared.
  const part = shotPart(f, 7);
  const named = f.store.prepareSubmission({ turnId: turn.id, origin: "submit", artifacts: [{ path: `${f.ticket.dir}/EP01_shot_07.mp4`, sha256: HASH_C }], parts: [part] })!;
  expect(named.submission).toMatchObject({ origin: "submit", state: "checking", part_keys: ["shot_07"], bot_id: f.producer.id, awaiting: null,
    artifacts: [{ path: `${f.ticket.dir}/EP01_shot_07.mp4`, sha256: HASH_C }] });
  expect(ticketRow(f)).toEqual({ status: "doing", stage: "doing" });
  expect(f.store.db.query("SELECT key, attempts, current_artifact, stage FROM ticket_parts WHERE ticket_id = ?").all(f.ticket.id))
    .toEqual([{ key: "shot_07", attempts: 1, current_artifact: `${f.ticket.dir}/EP01_shot_07.mp4`, stage: "in_progress" }]);
  // One the app hands over for the Bot names none: it is the ticket's as a whole, whatever the file is called.
  const first = submit(f, turn.id, [[`${f.ticket.dir}/EP01_shot_07.mp4`, HASH_A]], "implicit")!;
  expect(first.submission).toMatchObject({ origin: "implicit", state: "checking", part_keys: [] });
  expect(f.store.getSubmission(named.submission.id).state).toBe("superseded");
  // The same bytes again hand nothing over; new bytes supersede the open one.
  expect(submit(f, turn.id, [[`${f.ticket.dir}/EP01_shot_07.mp4`, HASH_A]], "implicit")).toBeNull();
  const second = submit(f, turn.id, [[`${f.ticket.dir}/EP01_shot_07.mp4`, HASH_B]], "implicit")!;
  expect(f.store.getSubmission(first.submission.id).state).toBe("superseded");
  expect(second.submission.state).toBe("checking");
  expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'submission.created'").get()!.n).toBe(3);
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

test("a check a reflection proposed and you adopted is a gate but backs no approval, until you edit it on the board", async () => {
  const f = fixture();
  await f.store.patchSettings({ workspace_path: mkdtempSync(join(tmpdir(), "submission-reflection-")) });
  const turn = segment(f);
  const check = gate(f, "pass");
  f.store.db.run("UPDATE acceptance_checks SET origin = 'reflection' WHERE id = ?", [check.id]);
  const first = submit(f, turn.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_A]])!;
  run(f, check.id, "pass");
  expect(f.store.settleSubmissionChecks(first.submission.id).submission.checks).toMatchObject([{ check_id: check.id, gate: true, yours: false, outcome: "pass" }]);
  f.store.patchCheckByUser(check.id, { item: "母带在" }, f.store.db.query<{ updated_at: string }, [string]>("SELECT updated_at FROM acceptance_checks WHERE id = ?").get(check.id)!.updated_at);
  const second = submit(f, turn.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_B]])!;
  run(f, check.id, "pass");
  expect(f.store.settleSubmissionChecks(second.submission.id).submission.checks).toMatchObject([{ check_id: check.id, yours: true }]);
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

test("a same-model pass on what you raised twice, with no passing check behind it, waits on your one 放行 card, the measurement on it", () => {
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
    requirement_ids: ["R-9"], check_ids: [], offer: ["approve", "reject"] });
  // The reviewer's word, what you said twice and what the app measured on it, all on the one card.
  expect(card.body).toContain("Reviewer审过了，判通过");
  expect(card.body).toContain("放行就算这几条做到了：\n- 「要求 R-9」（你说过 2 次）——应用量到：「时长约 2 分钟」：不通过——107.00 秒，要时长 108–132 秒（用户还没确认）");
  expect(card.body).toEndWith("看过之后，放行或者退回。");
  // The ball is yours; the producer is told nothing, and nothing asks it to recut.
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "user", reason: "review", ref: card.id });
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE bot_id = ? AND source = 'review'").get(f.producer.id)).toEqual({ n: 0 });
  expect(f.store.getSubmission(submission.id)).toMatchObject({ state: "in_review", awaiting: { kind: "approval", requirement_ids: ["R-9"], message_id: card.id } });
  expect(f.store.db.query("SELECT kind, action_state FROM notifications WHERE semantic_key = ?").get(`review_item:${card.id}`)).toEqual({ kind: "ask", action_state: "open" });
  // A second review of it is not taken while it waits on you.
  expect(() => f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve" })).toThrow("waits on the user");

  // 放行 takes what you said twice as met, and the reviewer's approve with it.
  const answered = f.store.answerReviewCard(card.id, "approve");
  expect(answered.submission).toMatchObject({ state: "approved", awaiting: null, reviews: [{ same_model: true, outcome: "approve" }] });
  expect(answered.message.control).toMatchObject({ acted: ["approve"] });
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
  expect(f.store.db.query("SELECT action_state FROM notifications WHERE semantic_key = ?").get(`review_item:${card.id}`)).toEqual({ action_state: "resolved" });
  expect(() => f.store.answerReviewCard(card.id, "reject")).toThrow("no longer offers");
  expect(reviewCards(f)).toBe(1);
});
test("a required-items card from before keeps its buttons: removing the item stops requiring it here; a passing check behind it needs no card at all", () => {
  const f = fixture();
  const { submission } = handedOver(f);
  gate(f, "pass");
  requirement(f, "R-9", { times: 2 });
  // A card an earlier build put up, still waiting.
  const card = f.store.insertMessage({ sessionId: f.room.id, kind: "system", author: f.producer.id, body: "下面这几条没有东西撑着", hiddenFromBots: true,
    control: { kind: "review_item", submission_id: submission.id, task_id: f.plan.id, ticket_id: f.ticket.id, requirement_ids: ["R-9"], check_ids: [],
      offer: ["confirm_item", "remove_item"] } });
  f.store.db.run("UPDATE submissions SET awaiting = ? WHERE id = ?", [JSON.stringify({ requirement_ids: ["R-9"], check_ids: [], message_id: card.id, review: null,
    at: isoNow(), kind: "items" }), submission.id]);
  expect(f.store.answerReviewCard(card.id, "remove_item").submission.state).toBe("approved");
  expect(f.store.db.query("SELECT status FROM requirements WHERE id = 'R-9'").get()).toEqual({ status: "waived" });
  expect(reviewCards(f)).toBe(1);

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
  expect(reviewCards(g)).toBe(0);
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

test("from level 8 a gate that fails at the tick, not at hand-over, is filed once as the producer's failed checks", () => {
  const f = fixture(ENGINE_LEVELS.learning);
  const { submission } = handedOver(f);
  gate(f, "fail");
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  // The check came after the hand-over: what it asks was not clear when the work was handed over.
  expect(f.store.listQualityEvents().map((row) => [row.kind, row.category, row.bot_id, row.submission_id])).toEqual([["checks_failed", "unclear", f.producer.id, submission.id]]);
});

test("with no reviewer, a required item nothing backs comes to your 放行 card even past a passing check of yours; dropping it on the board lets the next tick approve", () => {
  const f = fixture();
  const { submission } = handedOver(f);
  gate(f, "pass");
  requirement(f, "R-picture", { category: "画面" });
  const tick = superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(tick.moved).toMatchObject([{ id: submission.id, state: "submitted", awaiting: { kind: "approval", requirement_ids: ["R-picture"], review: null } }]);
  expect(tick.messages).toHaveLength(1);
  const card = tick.messages[0]!;
  expect(card.control).toMatchObject({ kind: "review_item", requirement_ids: ["R-picture"], offer: ["approve", "reject"] });
  expect(card.body).toContain("你确认过的检查都过了，但它们管不到下面这几条，所以要你来定。\n放行就算这几条做到了：\n- 「要求 R-picture」（关于画面）");
  // The next tick asks nothing new.
  expect(superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 2_000)).messages).toEqual([]);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE bot_id = ?").get(f.producer.id)).toEqual({ n: 0 });
  // You drop the requirement on the board, not on the card: your check backs the rest, so the next
  // tick lets it through, and the card says so in place of its buttons.
  f.store.waiveRequirement("R-picture", { taskId: f.plan.id });
  const next = superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 3_000));
  expect(next).toMatchObject({ moved: [{ id: submission.id, state: "approved" }], messages: [] });
  expect(f.store.getMessage(card.id).control).toMatchObject({ kind: "review_item", offer: [], result: "已放行。" });

  // With nothing of yours behind it, dropping the item leaves the same card waiting on your press.
  const g = fixture();
  const loose = handedOver(g);
  requirement(g, "R-picture", { category: "画面" });
  const [asked] = superviseSubmissions(g.ctx, later(UNREVIEWED_AFTER_MS + 1_000)).messages;
  expect(asked!.body).toContain("没有审查者，也没有你确认过的检查替你把关");
  g.store.waiveRequirement("R-picture", { taskId: g.plan.id });
  expect(superviseSubmissions(g.ctx, later(UNREVIEWED_AFTER_MS + 2_000))).toMatchObject({ moved: [], messages: [] });
  expect(g.store.getSubmission(loose.submission.id)).toMatchObject({ state: "submitted", awaiting: { kind: "approval", message_id: asked!.id } });
  expect(g.store.answerReviewCard(asked!.id, "approve").submission.state).toBe("approved");
  expect(reviewCards(g)).toBe(1);
});

test("a hand-over waits on you on one card: what nothing backs is listed on 放行/退回, and a line read while it waits adds no card", () => {
  // 2026-10-07 19:37: one hand-over of 「生成一张猫坐在阳台的图片」 asked three times in 26 s — your opening
  // line (about the picture) on a card of its own, then 「把猫改成橘猫」, said while it waited and read
  // after the first card, on another, then 放行 on a third. Each was pressed within seven seconds.
  const f = fixture();
  const { submission } = handedOver(f);
  requirement(f, "R-cat", { category: "画面内容" });
  requirement(f, "R-said", { times: 2 });
  const tick = superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(tick.messages).toHaveLength(1);
  const card = tick.messages[0]!;
  expect(card.control).toEqual({ kind: "review_item", submission_id: submission.id, task_id: f.plan.id, ticket_id: f.ticket.id,
    requirement_ids: ["R-cat", "R-said"], check_ids: [], offer: ["approve", "reject"] });
  expect(card.body).toBe([
    "EP01 的任务 01「06 母带」交上来了（EP01_MASTER.mp4）。没有审查者，也没有你确认过的检查替你把关，所以要你来定。",
    "放行就算这几条做到了：",
    "- 「要求 R-cat」（关于画面）",
    "- 「要求 R-said」（你说过 2 次）",
    "看过之后，放行或者退回。",
  ].join("\n"));
  expect(f.store.getSubmission(submission.id)).toMatchObject({ awaiting: { kind: "approval", requirement_ids: ["R-cat", "R-said"], message_id: card.id } });
  // Another line about the picture, read while the card waits: the card stands, nothing more asks.
  requirement(f, "R-orange", { category: "画面内容" });
  expect(superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 2_000))).toMatchObject({ moved: [], messages: [] });
  // 放行 lets it through.
  expect(f.store.answerReviewCard(card.id, "approve").submission).toMatchObject({ state: "approved", awaiting: null });
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
  expect(reviewCards(f)).toBe(1);
});

test("an item that only repeats the job's name is not listed again on the card; one with a measurement on it is", () => {
  const f = fixture();
  handedOver(f);
  for (const [id, quote] of [["R-job", "EP01"], ["R-ticket", "06 母带"]] as const) {
    requirement(f, id, { category: "画面" });
    f.store.db.run("UPDATE requirements SET quote = ? WHERE id = ?", [quote, id]);
  }
  const [card] = superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000)).messages;
  // Both are still what 放行 takes as met; the words just do not say the job's name a third time.
  expect(card!.control).toMatchObject({ requirement_ids: ["R-job", "R-ticket"], offer: ["approve", "reject"] });
  expect(card!.body).not.toContain("放行就算这几条做到了");
  expect(card!.body).toBe("EP01 的任务 01「06 母带」交上来了（EP01_MASTER.mp4）。没有审查者，也没有你确认过的检查替你把关，所以要你来定。\n看过之后，放行或者退回。");

  const g = fixture();
  handedOver(g);
  const named = requirement(g, "R-job", { category: "画面" });
  g.store.db.run("UPDATE requirements SET quote = 'EP01' WHERE id = 'R-job'");
  run(g, proposal(g, named.quote).id, "fail", "107.00 秒，要时长 108–132 秒");
  const [measured] = superviseSubmissions(g.ctx, later(UNREVIEWED_AFTER_MS + 1_000)).messages;
  expect(measured!.body).toContain("- 「EP01」（关于画面）——应用量到：「时长约 2 分钟」：不通过——107.00 秒，要时长 108–132 秒（用户还没确认）");
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
  const { submission } = submitShot(f, produced.id, 3, HASH_A)!;
  f.store.setTurnStatus(produced.id, "completed");
  f.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [produced.work_item_id]);
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

const DONE_SPEC = { kind: "x", goal: "EP01", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active" as const };
/** The organizer's settle reading `ticketId` as done, on `f`'s own plan and session. */
function organizerSettlesDone(f: Fixture, ticketId: string) {
  return f.store.applyOrganizerResult({ sessionId: f.room.id, current: f.store.getTask(f.plan.id),
    result: { decision: "continue", resumePlanId: null, spec: DONE_SPEC, tickets: [{ id: ticketId, spec: "", status: "done" }], messageTicket: null },
    source: { messageId: null, turnId: null, messageBody: "" }, settle: true });
}

test("the organizer's done on a ticket nothing was handed over on goes the no-reviewer way — checks, one card naming an unbacked required item, never straight to approved", () => {
  const f = fixture();
  const settleDone = (ticketId: string) => organizerSettlesDone(f, ticketId);
  settleDone(f.ticket.id);
  const [reading] = f.store.listSubmissions({ ticketId: f.ticket.id });
  expect(reading).toMatchObject({ origin: "organizer", state: "submitted", bot_id: f.producer.id, artifacts: [] });
  expect(ticketRow(f)).toEqual({ status: "review", stage: "submitted" });
  // Said again, nothing more is made.
  settleDone(f.ticket.id);
  expect(f.store.listSubmissions({ ticketId: f.ticket.id })).toHaveLength(1);
  // A required item about the picture with nothing behind it: the next tick asks you, with no
  // reviewer to ask instead — on the one card an organizer's reading always gets, the item listed.
  requirement(f, "R-picture", { category: "画面" });
  const tick = superviseSubmissions(f.ctx, later(1_000));
  expect(tick.messages).toHaveLength(1);
  expect(f.store.getSubmission(reading!.id)).toMatchObject({ state: "submitted", awaiting: { requirement_ids: ["R-picture"], review: null, kind: "approval" } });
  expect(tick.messages[0]!.control).toMatchObject({ kind: "review_item", requirement_ids: ["R-picture"], check_ids: [], offer: ["approve", "reject"] });
  expect(tick.messages[0]!.body).toContain("整理跳认为这张任务做完了。\n放行就算这几条做到了：\n- 「要求 R-picture」（关于画面）");
  // Dropping the item does not let an organizer's reading through by itself: nobody made it.
  f.store.waiveRequirement("R-picture", { taskId: f.plan.id });
  expect(superviseSubmissions(f.ctx, later(2_000)).moved).toEqual([]);
  expect(ticketRow(f)).toEqual({ status: "review", stage: "submitted" });
  expect(f.store.answerReviewCard(tick.messages[0]!.id, "approve").submission.state).toBe("approved");
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
  expect(reviewCards(f)).toBe(1);

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

test("a passing check from your words, not confirmed, backs nothing — the 放行 card shows what it measured, and nothing approves on it", () => {
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
  expect(result.card!.control).toMatchObject({ requirement_ids: ["R-misread"], check_ids: [], offer: ["approve", "reject"] });
  expect(result.card!.body).toContain("「时长约 2 分钟」：通过——90.00 秒（用户还没确认）");
  expect(f.store.getSubmission(submission.id).state).toBe("in_review");

  // With no reviewer, the same: a card, not an approval.
  const g = fixture();
  const loose = handedOver(g);
  const quote = requirement(g, "R-misread", { times: 2 });
  run(g, proposal(g, quote.quote).id, "pass", "90.00 秒");
  const tick = superviseSubmissions(g.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(tick.messages).toHaveLength(1);
  expect(g.store.getSubmission(loose.submission.id)).toMatchObject({ state: "submitted", awaiting: { kind: "approval", requirement_ids: ["R-misread"] } });
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
    if (!c.reviewerModel) expect(card.body).toContain("有一方的模型不明，按同一个模型算");
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

/** A hand-over by one fresh segment on `f`'s ticket, checked and taken up at the tick. */
function inOneGo(f: Fixture, sha256: string = HASH_A) {
  const produced = segment(f);
  const { submission } = submit(f, produced.id, [[`${f.ticket.dir}/avatar.jpg`, sha256]], "implicit")!;
  f.store.settleSubmissionChecks(submission.id);
  f.store.setTurnStatus(produced.id, "completed");
  return { produced, submission };
}
const reviewCards = (f: Fixture) => f.store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM messages
  WHERE json_valid(control) AND json_extract(control, '$.kind') = 'review_item'`).get()!.n;

test("with no reviewer, a hand-over made in one go — one ticket, one segment, never on your card — is approved at the tick with no card", () => {
  const f = fixture();
  const { submission } = inOneGo(f);
  // Your next line starts a segment while it waits: that does not count against it.
  const next = segment(f);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(f.store.getSubmission(submission.id)).toMatchObject({ state: "approved", awaiting: null });
  expect(f.store.listWorkEvents({ kind: "submission.approved" }).map((event) => event.payload)).toMatchObject([{ submission_id: submission.id, by: "one_go" }]);
  expect(reviewCards(f)).toBe(0);
  // A change after it, made by the one segment since the approval, goes the same way.
  const { submission: change } = submit(f, next.id, [[`${f.ticket.dir}/avatar.jpg`, HASH_B]], "implicit")!;
  f.store.settleSubmissionChecks(change.id);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 2_000));
  expect(f.store.getSubmission(change.id).state).toBe("approved");
  expect(reviewCards(f)).toBe(0);
});

test("made in one go, it goes through at the tick even with what you said about the picture, or twice, behind nothing", () => {
  // 2026-10-07 19:36: 「生成一张猫坐在阳台的图片」 was made and handed over by the segment it opened. The
  // line itself is about the picture, with nothing behind it, so a card asked about it; 「把猫改成橘猫」,
  // said while it waited, was read after that card and got another; then came the 放行 card.
  const f = fixture();
  requirement(f, "R-cat", { category: "画面内容" });
  requirement(f, "R-said", { times: 2 });
  const { submission } = inOneGo(f);
  segment(f);
  requirement(f, "R-orange", { category: "画面内容" });
  const tick = superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(tick.messages).toEqual([]);
  expect(f.store.getSubmission(submission.id)).toMatchObject({ state: "approved", awaiting: null });
  expect(f.store.listWorkEvents({ kind: "submission.approved" }).map((event) => event.payload)).toMatchObject([{ submission_id: submission.id, by: "one_go" }]);
  expect(reviewCards(f)).toBe(0);
});

/** The job's first hand-over, made after another segment on it, so it comes to your card; `answer` is your press. */
function cardedFirst(f: Fixture, answer: "approve" | "reject") {
  const earlier = segment(f);
  f.store.setTurnStatus(earlier.id, "completed");
  const { submission } = inOneGo(f);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  const card = f.store.db.query<{ id: string }, []>(`SELECT id FROM messages WHERE json_valid(control) AND json_extract(control, '$.kind') = 'review_item'`).get()!;
  f.store.answerReviewCard(card.id, answer);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 2_000));
  return submission;
}

test("once a hand-over of the job is approved, what one segment hands over next goes through at the tick, card before or not", () => {
  // 2026-10-07: each follow-up question on a one-ticket job came back as a 放行 card, five in half an
  // hour, all let through, because the job's first hand-over had come to your card.
  const f = fixture();
  expect(f.store.getSubmission(cardedFirst(f, "approve").id).state).toBe("approved");
  const next = segment(f);
  const { submission } = submit(f, next.id, [[`${f.ticket.dir}/compare.mp4`, HASH_B]])!;
  f.store.settleSubmissionChecks(submission.id);
  f.store.setTurnStatus(next.id, "completed");
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 3_000));
  expect(f.store.getSubmission(submission.id)).toMatchObject({ state: "approved", awaiting: null });
  expect(f.store.listWorkEvents({ kind: "submission.approved" }).map((event) => event.payload).at(-1)).toMatchObject({ submission_id: submission.id, by: "one_go" });
  expect(reviewCards(f)).toBe(1);
});

test("a job whose hand-over you sent back on its card keeps its card for the next one", () => {
  const f = fixture();
  expect(f.store.getSubmission(cardedFirst(f, "reject").id).state).toBe("rejected");
  const next = segment(f);
  const { submission } = submit(f, next.id, [[`${f.ticket.dir}/avatar.jpg`, HASH_B]])!;
  f.store.settleSubmissionChecks(submission.id);
  f.store.setTurnStatus(next.id, "completed");
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 3_000));
  expect(f.store.getSubmission(submission.id)).toMatchObject({ state: "submitted", awaiting: { kind: "approval" } });
});

test("not in one go — a second ticket, words handed over, or a job once on your card — it comes to your card", () => {
  const cases: Array<[string, (f: Fixture) => void]> = [
    ["second ticket", (f) => { f.store.createTicket({ taskId: f.plan.id, title: "07 字幕", worker: f.producer.id }); }],
    ["once on your card", (f) => {
      f.store.insertMessage({ sessionId: f.room.id, kind: "system", author: f.producer.id, body: "旧卡",
        control: { kind: "review_item", submission_id: "old", task_id: f.plan.id, ticket_id: f.ticket.id, requirement_ids: [], check_ids: [], offer: [] } });
    }],
  ];
  for (const [name, arrange] of cases) {
    const f = fixture();
    arrange(f);
    const { submission } = inOneGo(f);
    superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
    expect({ name, ...f.store.getSubmission(submission.id) }).toMatchObject({ name, state: "submitted", awaiting: { kind: "approval" } });
  }
  // The words themselves, not a file: never approved on nobody's look.
  const f = fixture();
  const produced = segment(f);
  const { submission } = f.store.prepareSubmission({ turnId: produced.id, origin: "answer", artifacts: [], content: "三个选题：雪原、旧城、列车" })!;
  f.store.settleSubmissionChecks(submission.id);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(f.store.getSubmission(submission.id)).toMatchObject({ state: "submitted", awaiting: { kind: "approval" } });
});

/** A master approved by a reviewer on another model that gave evidence, its check of yours passing: the plan is delivered. */
function approvedByReviewer(f: Fixture) {
  const { produced, submission } = handedOver(f, { reviewer: true, model: "maker-model" });
  const look = requirement(f, "R-look", { times: 1 });
  const check = gate(f, "pass");
  const reviewing = segment(f, f.reviewer.id);
  onModel(f, reviewing.id, "checker-model");
  const result = f.store.reviewSubmission({ turnId: reviewing.id, outcome: "approve", checks: f.store.submissionCheckResults([check.id], submission.created_at),
    verdicts: [{ requirement_id: look.id, verdict: "pass", evidence: ["看过第 3 秒"] }] });
  if (!result.ok) throw new Error(`expected an approval: ${JSON.stringify(result)}`);
  f.store.setTurnStatus(produced.id, "completed");
  f.store.setTurnStatus(reviewing.id, "completed");
  return { submission, check };
}

/** A line of yours filed under the ticket (or one of its parts) by the rows, as the arrival path files it. */
function said(f: Fixture, body: string, target: { partKey?: string; parentId?: string } = {}) {
  const line = f.store.postMessage(f.room.id, { body, parent_id: target.parentId ?? null });
  f.store.fileMessage(line.id, { explicit: [{ taskId: f.plan.id, ticketId: f.ticket.id, ...(target.partKey ? { partKey: target.partKey } : {}) }] });
  return line;
}

const reworkCardsOf = (f: Fixture) => f.store.db.query<{ id: string }, []>("SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'rework' ORDER BY created_at, rowid")
  .all().map((row) => f.store.getMessage(row.id));

test("a complaint about approved work only asks; sending it back reworks it, counts a miss, reopens the plan and wakes the producer — undo puts it back", () => {
  const f = fixture();
  approvedByReviewer(f);
  const line = said(f, "母带太短了，不对");
  const [card] = f.store.noteComplaint(line.id);
  // Asked, nothing moved yet.
  expect(card!.control).toMatchObject({ kind: "rework", ticket_id: f.ticket.id, part_keys: [], message_id: line.id, offer: ["rework", "dismiss"] });
  expect(card!.body).toContain("母带太短了，不对");
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
  expect(f.store.noteComplaint(line.id)).toEqual([]);

  const sent = f.store.answerReworkCard(card!.id, "rework");
  expect(sent.control).toMatchObject({ offer: ["undo"], result: "已转回返工。" });
  expect(ticketRow(f)).toEqual({ status: "doing", stage: "rework" });
  expect(f.store.getTask(f.plan.id).status).not.toBe("done");
  expect(f.store.reviewMisses({ botId: f.reviewer.id, sessionId: f.room.id })).toMatchObject([{ ticket: "06 母带", quote: "母带太短了，不对" }]);
  expect(f.store.db.query("SELECT body_snapshot AS body FROM inbox_items WHERE bot_id = ? ORDER BY seq DESC LIMIT 1").get(f.producer.id))
    .toMatchObject({ body: expect.stringContaining("母带太短了，不对") });

  const undone = f.store.answerReworkCard(card!.id, "undo");
  expect(undone.control).toMatchObject({ acted: ["undo"] });
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
  expect(f.store.getTask(f.plan.id)).toMatchObject({ status: "done" });
  expect(f.store.reviewMisses({ botId: f.reviewer.id, sessionId: f.room.id })).toEqual([]);
  expect(() => f.store.answerReworkCard(card!.id, "undo")).toThrow();
});

test("praise, a redo turned down, a reply that only acknowledges, a Bot's filing, level 4, or work still being made ask nothing", () => {
  const f = fixture();
  approvedByReviewer(f);
  const delivery = f.store.insertMessage({ sessionId: f.room.id, kind: "bot", author: f.producer.id, body: "母带在这", paths: [`${f.ticket.dir}/EP01_MASTER.mp4`] });
  for (const body of ["很好，就这样", "别重做了，就这样", "比上一版那个错乱的好多了"]) expect(f.store.noteComplaint(said(f, body).id)).toEqual([]);
  for (const body of ["收到", "收到，谢谢", "辛苦了", "👌", "嗯", "我晚点看", "给老板看看"]) {
    expect(f.store.noteComplaint(said(f, body, { parentId: delivery.id }).id)).toEqual([]);
  }
  const botFiled = f.store.postMessage(f.room.id, { body: "母带太短了，不对" });
  f.store.db.run(`INSERT INTO message_filings (message_id, task_id, ticket_id, part_key, filed_by, strength, is_primary, created_at)
    VALUES (?, ?, ?, NULL, 'bot:x', 'bot', 1, ?)`, [botFiled.id, f.plan.id, f.ticket.id, isoNow()]);
  expect(f.store.noteComplaint(botFiled.id)).toEqual([]);
  expect(reworkCardsOf(f)).toEqual([]);
  expect(ticketRow(f).stage).toBe("approved");

  const low = fixture(ENGINE_LEVELS.supervision);
  expect(low.store.noteComplaint(said(low, "母带太短了，不对").id)).toEqual([]);
  const doing = fixture();
  segment(doing);
  expect(doing.store.noteComplaint(said(doing, "母带太短了，不对").id)).toEqual([]);
});

/** A line of yours the rows filed under the plan as a whole, no ticket, the way 「从头再做一遍」 was. */
function saidOfPlan(f: Fixture, body: string) {
  const line = f.store.postMessage(f.room.id, { body });
  f.store.db.run(`INSERT INTO message_filings (message_id, task_id, ticket_id, part_key, filed_by, strength, is_primary, created_at)
    VALUES (?, ?, NULL, NULL, 'rule:6', 'default', 1, ?)`, [line.id, f.plan.id, isoNow()]);
  return line;
}

test("starting over, said of the whole plan, asks about its one handed-over ticket whose maker is still here", () => {
  // 2026-10-03: 「从头再做一遍，之前的作废」 was filed under the plan, its one ticket still read handed over
  // (from before submissions, nothing behind it, its reviewer archived), and nothing asked or moved.
  const f = fixture();
  f.store.db.run("UPDATE tickets SET status = 'review', reviewer_bot_id = ? WHERE id = ?", [f.reviewer.id, f.ticket.id]);
  const theirs = f.store.createTicket({ taskId: f.plan.id, title: "回复视频导演", worker: f.reviewer.id });
  f.store.db.run("UPDATE tickets SET status = 'review' WHERE id = ?", [theirs.id]);
  f.store.archiveBot(f.reviewer.id);
  const line = saidOfPlan(f, "从头再做一遍，之前的作废");
  const cards = f.store.noteComplaint(line.id);
  // The archived reviewer's own ticket is not asked about: sending it back would wake nobody.
  expect(cards.map((card) => card.control)).toMatchObject([{ kind: "rework", ticket_id: f.ticket.id, part_keys: [], message_id: line.id }]);
  expect(cards[0]!.body).toContain("从头再做一遍，之前的作废");
  f.store.answerReworkCard(cards[0]!.id, "rework");
  expect(ticketRow(f)).toEqual({ status: "doing", stage: "rework" });
  expect(f.store.db.query("SELECT body_snapshot AS body FROM inbox_items WHERE bot_id = ? ORDER BY seq DESC LIMIT 1").get(f.producer.id))
    .toMatchObject({ body: expect.stringContaining("从头再做一遍") });
});

test("a plan-wide complaint with more than one handed-over ticket, or praise of the plan, asks nothing", () => {
  const f = fixture();
  f.store.db.run("UPDATE tickets SET status = 'review' WHERE id = ?", [f.ticket.id]);
  const second = f.store.createTicket({ taskId: f.plan.id, title: "07 预告", worker: f.producer.id });
  f.store.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [second.id]);
  expect(f.store.noteComplaint(saidOfPlan(f, "全部作废，从头再做").id)).toEqual([]);
  const one = fixture();
  one.store.db.run("UPDATE tickets SET status = 'review' WHERE id = ?", [one.ticket.id]);
  expect(one.store.noteComplaint(saidOfPlan(one, "很好，就这样").id)).toEqual([]);
  expect(reworkCardsOf(one)).toEqual([]);
});

test("a complaint asks about the parts its line is filed under, not every part it mentions; a question asks nothing; dismissing leaves everything as it was", () => {
  const f = fixture();
  const produced = segment(f);
  const keys = [shotPart(f, 7), shotPart(f, 8)];
  const { submission } = f.store.prepareSubmission({ turnId: produced.id, origin: "submit",
    artifacts: [{ path: `${f.ticket.dir}/shot_07.mp4`, sha256: HASH_A }, { path: `${f.ticket.dir}/shot_08.mp4`, sha256: HASH_B }], parts: keys })!;
  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  f.store.settleSubmissionChecks(submission.id);
  /** A line the reading (ADR 0057) filed under the parts it asks about: C07, not the C08 it praises. */
  const aboutC07 = (body: string) => {
    const line = f.store.postMessage(f.room.id, { body });
    f.store.fileMessage(line.id, { read: { source: "model", about: "jobs", targets: [{ taskId: f.plan.id, ticketId: f.ticket.id, partKey: keys[0]! }] } });
    return line;
  };
  /** A line you filed under both parts yourself. */
  const both = (body: string) => {
    const line = f.store.postMessage(f.room.id, { body });
    f.store.fileMessage(line.id, { explicit: keys.map((partKey) => ({ taskId: f.plan.id, ticketId: f.ticket.id, partKey })) });
    return line;
  };
  const [card] = f.store.noteComplaint(aboutC07("C07 跳跃，C08 很好").id);
  expect(card!.control).toMatchObject({ part_keys: [keys[0]] });
  expect(f.store.answerReworkCard(card!.id, "dismiss").control).toMatchObject({ acted: ["dismiss"] });
  expect(ticketRow(f).stage).toBe("in_review");
  expect(f.store.getSubmission(submission.id).state).toBe("in_review");

  expect(f.store.noteComplaint(aboutC07("C07 是不是太短了？").id)).toEqual([]);
  // Filed under both by you, both are asked about.
  const [mine] = f.store.noteComplaint(both("这两镜都太暗").id);
  expect(mine!.control).toMatchObject({ part_keys: keys });
  f.store.answerReworkCard(mine!.id, "dismiss");
  const [asked] = f.store.noteComplaint(aboutC07("C07 好短啊").id);
  expect(asked!.control).toMatchObject({ part_keys: [keys[0]], offer: ["rework", "dismiss"] });
  // Sending a part in review back supersedes the hand-over, and undo brings it back.
  f.store.answerReworkCard(asked!.id, "rework");
  expect(f.store.db.query("SELECT key, stage FROM ticket_parts ORDER BY key").all()).toEqual([{ key: keys[0], stage: "rework" }, { key: keys[1], stage: "submitted" }]);
  expect(f.store.getSubmission(submission.id).state).toBe("superseded");
  f.store.answerReworkCard(asked!.id, "undo");
  expect(f.store.getSubmission(submission.id).state).toBe("in_review");
  expect(ticketRow(f).stage).toBe("in_review");
});

test("a part-level entry the scribe made asks without complaint words; a refiled line's card stops asking about the ticket it left", () => {
  const f = fixture();
  approvedByReviewer(f);
  const line = said(f, "第三秒那里重新剪一下");
  f.store.db.run(`INSERT INTO requirements (id, scope, scope_id, quote, source_kind, status, times_raised, last_raised_at, added_by, created_at, updated_at, origin_task_id)
    VALUES ('R-part', 'part', ?, '第三秒重新剪', 'message', 'open', 1, '2026-01-01', 'scribe', '2026-01-01', '2026-01-01', ?)`, [f.ticket.id, f.plan.id]);
  expect(f.store.noteComplaint(line.id, { scribeAdded: ["R-plan-only"] })).toEqual([]);
  const [card] = f.store.noteComplaint(line.id, { scribeAdded: ["R-part"] });
  expect(card).toBeDefined();
  f.store.db.run("DELETE FROM message_filings WHERE message_id = ?", [line.id]);
  f.store.noteComplaint(line.id);
  expect(f.store.getMessage(card!.id).control).toMatchObject({ offer: [], result: "这句话后来改归别处了。" });
  expect(() => f.store.answerReworkCard(card!.id, "rework")).toThrow();
});

test("sending back is refused once the ticket moved on, and undo once there is a newer hand-over", () => {
  const f = fixture();
  approvedByReviewer(f);
  const [card] = f.store.noteComplaint(said(f, "母带太短了，不对").id);
  f.store.answerReworkCard(card!.id, "rework");
  const again = segment(f);
  submit(f, again.id, [[`${f.ticket.dir}/EP01_MASTER.mp4`, HASH_B]]);
  expect(() => f.store.answerReworkCard(card!.id, "undo")).toThrow("moved on");

  const g = fixture();
  approvedByReviewer(g);
  const [late] = g.store.noteComplaint(said(g, "母带太短了，不对").id);
  g.store.patchTicketByUser(g.ticket.id, { status: "doing" });
  expect(g.store.answerReworkCard(late!.id, "rework").control).toMatchObject({ offer: [], result: "它已经不在交付或通过的状态，没有可转回的。" });
  expect(ticketRow(g).stage).toBe("doing");

  // A newer version handed over after the line: the old card does not send that one back.
  const k = fixture();
  const { submission, check } = approvedByReviewer(k);
  const [old] = k.store.noteComplaint(said(k, "母带太短了，不对").id);
  const redone = segment(k);
  const { submission: newer } = submit(k, redone.id, [[`${k.ticket.dir}/EP01_MASTER.mp4`, HASH_B]])!;
  run(k, check.id, "pass");
  k.store.settleSubmissionChecks(newer.id);
  expect(ticketRow(k).stage).toBe("in_review");
  expect(k.store.answerReworkCard(old!.id, "rework").control).toMatchObject({ offer: [], result: expect.stringContaining("又交了新的一版") });
  expect(k.store.getSubmission(newer.id).state).not.toBe("superseded");
  expect(k.store.reviewMisses({ botId: k.reviewer.id, sessionId: k.room.id })).toEqual([]);
  expect(submission.id).not.toBe(newer.id);
});

test("undoing a rework takes back the producer's call to redo it, or tells it when already read", () => {
  const f = fixture();
  approvedByReviewer(f);
  const [card] = f.store.noteComplaint(said(f, "母带太短了，不对").id);
  f.store.answerReworkCard(card!.id, "rework");
  const call = f.store.db.query<{ seq: number; state: string }, [string]>("SELECT seq, state FROM inbox_items WHERE bot_id = ? ORDER BY seq DESC LIMIT 1").get(f.producer.id)!;
  expect(call.state).toBe("queued");
  f.store.answerReworkCard(card!.id, "undo");
  expect(f.store.db.query("SELECT state FROM inbox_items WHERE seq = ?").get(call.seq)).toEqual({ state: "superseded" });

  const g = fixture();
  approvedByReviewer(g);
  const [read] = g.store.noteComplaint(said(g, "母带太短了，不对").id);
  g.store.answerReworkCard(read!.id, "rework");
  g.store.db.run("UPDATE inbox_items SET state = 'delivered' WHERE bot_id = ?", [g.producer.id]);
  g.store.answerReworkCard(read!.id, "undo");
  expect(g.store.db.query("SELECT body_snapshot AS body, wakes FROM inbox_items WHERE bot_id = ? ORDER BY seq DESC LIMIT 1").get(g.producer.id))
    .toEqual({ body: expect.stringContaining("撤销了任务「06 母带」的返工"), wakes: 0 });
});

/** One hand-over of shot_01 by `turnId`, judged on `checkId`'s next run: `outcome`. */
function shotHandOver(f: Fixture, turnId: string, checkId: string, outcome: "pass" | "fail", n: number) {
  const { submission } = submitShot(f, turnId, 1, `${n}`.padStart(64, "0"))!;
  run(f, checkId, outcome, outcome === "fail" ? "107.00 秒，要 108–132 秒" : "");
  return f.store.settleSubmissionChecks(submission.id);
}

const ceilingCards = (f: Fixture) => f.store.db.query<{ id: string }, []>("SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'ceiling' ORDER BY created_at, rowid").all().map((row) => f.store.getMessage(row.id));

test("the same check failing three hand-overs in a row blocks the part, refuses a fourth, gives you the ball and asks how to go on", () => {
  const f = fixture();
  const produced = segment(f);
  const check = gate(f, "fail");
  for (let n = 1; n <= 2; n++) expect(shotHandOver(f, produced.id, check.id, "fail", n).state).toBe("checks_failed");
  expect(ceilingCards(f)).toEqual([]);
  shotHandOver(f, produced.id, check.id, "fail", 3);
  const [card] = ceilingCards(f);
  expect(card!.control).toMatchObject({ kind: "ceiling", part_key: expect.any(String), requirement_id: null, offer: ["another_way", "another_plan", "accept"] });
  expect(card!.body).toContain("连续 3 次没过");
  expect(f.store.db.query("SELECT stage FROM ticket_parts").get()).toEqual({ stage: "blocked" });
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "user", reason: "ceiling", ref: card!.id });
  expect(() => submitShot(f, produced.id, 1, "9".repeat(64))).toThrow("capability ceiling");

  // Another way: back to rework, the producer told, the count starts over — one more failure does not block again.
  f.store.answerCeilingCard(card!.id, "another_way");
  expect(f.store.db.query("SELECT stage FROM ticket_parts").get()).toEqual({ stage: "rework" });
  expect(f.store.db.query("SELECT body_snapshot AS body FROM inbox_items WHERE bot_id = ? ORDER BY seq DESC LIMIT 1").get(f.producer.id)).toMatchObject({ body: expect.stringContaining("换一种做法") });
  shotHandOver(f, produced.id, check.id, "fail", 4);
  expect(ceilingCards(f)).toHaveLength(1);
  expect(f.store.db.query("SELECT stage FROM ticket_parts").get()).toEqual({ stage: "rework" });
});

test("a requirement a review failed three times in a row offers to relax it; relaxing waives it for the plan", () => {
  const f = fixture();
  f.store.patchTicketByUser(f.ticket.id, { reviewerBotId: f.reviewer.id });
  const nose = requirement(f, "R-nose", { times: 2 });
  for (let n = 1; n <= 3; n++) {
    const produced = segment(f);
    const { submission } = submitShot(f, produced.id, 1, `${n}`.padStart(64, "0"))!;
    f.store.settleSubmissionChecks(submission.id);
    f.store.setTurnStatus(produced.id, "completed");
    const reviewing = segment(f, f.reviewer.id);
    f.store.reviewSubmission({ turnId: reviewing.id, outcome: "reject", note: "鼻头白块还在", verdicts: [{ requirement_id: nose.id, verdict: "fail", evidence: ["第 2 秒"] }] });
    f.store.setTurnStatus(reviewing.id, "completed");
  }
  const [card] = ceilingCards(f);
  expect(card!.control).toMatchObject({ requirement_id: nose.id, offer: ["another_way", "another_plan", "relax", "accept"] });
  expect(card!.body).toContain("要求 R-nose");
  f.store.answerCeilingCard(card!.id, "relax");
  expect(f.store.db.query("SELECT status FROM requirements WHERE id = ?").get(nose.id)).toEqual({ status: "waived" });
  expect(() => f.store.answerCeilingCard(card!.id, "accept")).toThrow();
});

test("more than six hand-overs of a part block it however they failed; taking it as it is approves the part, the ticket and the plan", () => {
  const f = fixture();
  const produced = segment(f);
  for (let n = 1; n <= 7; n++) {
    const check = gate(f, "fail");
    shotHandOver(f, produced.id, check.id, "fail", n);
    f.store.db.run("UPDATE acceptance_checks SET removed_at = ? WHERE id = ?", [isoNow(), check.id]);
  }
  const [card] = ceilingCards(f);
  expect(card!.body).toContain("已经交了 7 次");
  f.store.answerCeilingCard(card!.id, "accept");
  expect(f.store.db.query("SELECT stage FROM ticket_parts").get()).toEqual({ stage: "approved" });
  expect(ticketRow(f)).toEqual({ status: "done", stage: "approved" });
  expect(f.store.getTask(f.plan.id).status).toBe("done");
});

test("a check whose last verdict came from judging pictures is a reference at level 5: it neither blocks a hand-over nor the plan", () => {
  const f = fixture();
  const { submission } = handedOver(f);
  const look = gate(f, "fail");
  f.store.db.run("UPDATE acceptance_check_runs SET judged_by = 'vision' WHERE check_id = ?", [look.id]);
  const plain = gate(f, "pass");
  const checks = f.store.submissionCheckResults([look.id, plain.id], submission.created_at);
  expect(checks).toMatchObject([{ check_id: look.id, gate: false, reference: "vision", outcome: "fail" }, { check_id: plain.id, gate: true, yours: true }]);
  expect(checkLines(checks, "zh")[0]).toContain("看图判定，只作参考");
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(f.store.getSubmission(submission.id).state).toBe("approved");
  expect(f.store.getTask(f.plan.id).status).toBe("done");

  // Level 4 is untouched: the same verdict still decides.
  const low = fixture(ENGINE_LEVELS.supervision);
  const lowLook = gate(low, "fail");
  low.store.db.run("UPDATE acceptance_check_runs SET judged_by = 'vision' WHERE check_id = ?", [lowLook.id]);
  expect(low.store.submissionCheckResults([lowLook.id], "")).toMatchObject([{ gate: true, outcome: "fail" }]);
});

test("at the ceiling the producer only hears that you are asked, and is not woken to try again", () => {
  const f = fixture();
  const produced = segment(f);
  const check = gate(f, "fail");
  for (let n = 1; n <= 3; n++) {
    const { submission } = submitShot(f, produced.id, 1, `${n}`.padStart(64, "0"))!;
    run(f, check.id, "fail", "107.00 秒，要 108–132 秒");
    f.store.settleSubmissionChecks(submission.id, undefined, { tell: true });
  }
  const told = f.store.db.query<{ body: string; wakes: number }, [string]>("SELECT body_snapshot AS body, wakes FROM inbox_items WHERE bot_id = ? ORDER BY seq").all(f.producer.id);
  expect(told.map((item) => item.wakes)).toEqual([1, 1, 0]);
  expect(told.at(-1)!.body).toContain("能力天花板");
  expect(told.at(-1)!.body).not.toContain("改好再交");
});

test("the whole ticket counts only hand-overs of no part, and only failed ones; approved parts never add up to a ceiling", () => {
  const f = fixture();
  const produced = segment(f);
  for (let n = 1; n <= 7; n++) {
    const { submission } = submitShot(f, produced.id, n, `${n}`.padStart(64, "0"))!;
    f.store.settleSubmissionChecks(submission.id);
    superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + n * 1_000));
  }
  const check = gate(f, "fail");
  shotHandOver(f, produced.id, check.id, "fail", 99);
  const { submission } = submit(f, produced.id, [[`${f.ticket.dir}/final.mp4`, "f".repeat(64)]])!;
  run(f, check.id, "fail");
  f.store.settleSubmissionChecks(submission.id);
  expect(ceilingCards(f)).toEqual([]);
});

test("while a part is stuck, a hand-over of no part is refused, and your board edit closes its card", () => {
  const f = fixture();
  const produced = segment(f);
  const check = gate(f, "fail");
  for (let n = 1; n <= 3; n++) shotHandOver(f, produced.id, check.id, "fail", n);
  const [card] = ceilingCards(f);
  expect(() => submit(f, produced.id, [[`${f.ticket.dir}/final.mp4`, "f".repeat(64)]])).toThrow("capability ceiling");
  f.store.patchTicketByUser(f.ticket.id, { status: "done" });
  expect(f.store.getMessage(card!.id).control).toMatchObject({ offer: [], result: "你在看板上改了这张任务的状态，不再问了。" });
  expect(() => f.store.answerCeilingCard(card!.id, "accept")).toThrow();
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "closed" });
});

test("one part approved does not approve the ticket or lift another part's ceiling", () => {
  const f = fixture();
  const produced = segment(f);
  const check = gate(f, "fail");
  for (let n = 1; n <= 3; n++) shotHandOver(f, produced.id, check.id, "fail", n);
  const [card] = ceilingCards(f);
  f.store.db.run("UPDATE acceptance_checks SET removed_at = ? WHERE id = ?", [isoNow(), check.id]);
  const { submission } = submitShot(f, produced.id, 2, "2".repeat(64))!;
  gate(f, "pass");
  f.store.settleSubmissionChecks(submission.id);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(f.store.getSubmission(submission.id).state).toBe("approved");
  expect(f.store.db.query("SELECT key, stage FROM ticket_parts ORDER BY key").all()).toEqual([{ key: "shot_01", stage: "blocked" }, { key: "shot_02", stage: "approved" }]);
  expect(ticketRow(f).stage).toBe("doing");
  expect(f.store.getMessage(card!.id).control).toMatchObject({ offer: ["another_way", "another_plan", "accept"] });
  expect(() => submitShot(f, produced.id, 1, "1".repeat(64))).toThrow("capability ceiling");
});


test("a delivered job goes back to active when one of its tickets takes new work, and is delivered again once it is through", () => {
  // Walked through on 2026-10-03: after delivery you said the third slogan was too plain, the lead
  // asked for a new one and it was handed in — the ticket was in review again, the job still read
  // delivered, and the supervisor, which only chases active jobs, would never chase that review.
  const f = fixture();
  setTicketStage(f.ctx, { ticketId: f.ticket.id, stage: "approved", source: "review" });
  expect(settlePlanStage(f.ctx, f.plan.id)).toBe(true);
  expect(f.store.getTask(f.plan.id)).toMatchObject({ stage: "delivered", status: "done" });

  setTicketStage(f.ctx, { ticketId: f.ticket.id, stage: "in_review", source: "submission" });
  expect(f.store.getTask(f.plan.id)).toMatchObject({ stage: "active", status: "active" });
  expect(f.store.listWorkEvents({ kind: "plan.reopened" }).map((event) => event.payload)).toMatchObject([{ ticket: f.ticket.id, after: "in_review" }]);

  setTicketStage(f.ctx, { ticketId: f.ticket.id, stage: "approved", source: "review" });
  expect(settlePlanStage(f.ctx, f.plan.id)).toBe(true);
  expect(f.store.getTask(f.plan.id)).toMatchObject({ stage: "delivered" });
});

test("handing in files that all sit in one of its own tickets' folders puts a segment on the whole job onto that ticket", () => {
  // Real-model run, 2026-10-04: the lead's poster came from a command you approved, which did not put
  // the segment on its ticket; submit asked it to bind first and it gave up with the poster made.
  const f = fixture();
  const whole = segment(f, f.producer.id, null);
  const other = f.store.createTicket({ taskId: f.plan.id, title: "07 字幕", worker: f.reviewer.id });
  // Files across tickets, or in another Bot's ticket, bind nothing: the hand-over stays refused.
  expect(() => submit(f, whole.id, [[`${f.ticket.dir}/master.mp4`, HASH_A], [`${other.dir}/subs.srt`, HASH_B]])).toThrow("bind this segment");
  expect(() => submit(f, whole.id, [[`${other.dir}/subs.srt`, HASH_B]])).toThrow("bind this segment");
  const handed = submit(f, whole.id, [[`${f.ticket.dir}/master.mp4`, HASH_A]])!;
  expect(handed.submission.ticket_id).toBe(f.ticket.id);
  expect(f.store.getTurn(whole.id).ticket_id).toBe(f.ticket.id);
  expect(f.store.listWorkEvents({ kind: "work.bound" }).map((event) => event.payload)).toMatchObject([{ by: "write", path: `${f.ticket.dir}/master.mp4` }]);
});
