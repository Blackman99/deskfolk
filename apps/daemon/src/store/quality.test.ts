import { afterEach, expect, test } from "bun:test";
import { isoNow } from "../ids";
import { Store } from ".";
import { ENGINE_LEVELS } from "./schema-gate";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(level: number = ENGINE_LEVELS.learning) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const maker = store.createBot({ name: "Maker", duties: "make", boundaries: "none" });
  const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" }).bot;
  const plan = store.openTask({ sessionId: maker.direct_session.id, title: "EP01" });
  const ticket = store.createTicket({ taskId: plan.id, title: "母带", worker: maker.bot.id });
  const trigger = store.insertMessage({ sessionId: maker.direct_session.id, kind: "system", author: maker.bot.id, body: "工作" });
  const turn = store.createTurn({ sessionId: maker.direct_session.id, botId: maker.bot.id, triggerMessageId: trigger.id, taskId: plan.id, ticketId: ticket.id });
  store.recordTurnRoute({ turnId: turn.id, decision: { model: "grk", thinkingLevel: "low", providerId: "", signature: "general" } });
  return { store, maker: maker.bot, dm: maker.direct_session.id, reviewer, plan, ticket, turn };
}
type Fixture = ReturnType<typeof fixture>;

function submission(f: Fixture, id: string, createdAt: string, state = "checks_failed") {
  f.store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id, model, turn_id, origin, artifacts, content, claims,
    note, state, created_at, updated_at) VALUES (?, ?, ?, ?, '["shot_07"]', ?, 'grk', ?, 'submit', '[]', NULL, '[]', '', ?, ?, ?)`,
    [id, f.turn.work_item_id ?? null, f.plan.id, f.ticket.id, f.maker.id, f.turn.id, state, createdAt, createdAt]);
}

function check(f: Fixture, id: string, definedAt: string) {
  f.store.db.run(`INSERT INTO acceptance_checks (id, task_id, ticket_id, item, kind, path, source, created_at, updated_at, defined_at)
    VALUES (?, ?, ?, ?, 'exists', 'x.mp4', 'user', ?, ?, ?)`, [id, f.plan.id, f.ticket.id, id, definedAt, definedAt, definedAt]);
}

const at = (minutes: number) => new Date(Date.parse("2026-10-03T08:00:00.000Z") + minutes * 60_000).toISOString();
const filed = (f: Fixture) => f.store.listQualityEvents().map((row) => ({ kind: row.kind, category: row.category, bot: row.bot_id, model: row.model }))
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.category.localeCompare(b.category));

test("each kind of trouble is filed under the category its type decides, on the Bot and model it is about", () => {
  const f = fixture();
  check(f, "check-before", at(0));
  check(f, "check-after", at(10));
  submission(f, "sub-1", at(5));
  const event = (kind: string, payload: Record<string, unknown>, extra: { botId?: string; turnId?: string; ticketId?: string } = {}) =>
    f.store.recordWorkEvent({ kind, actor: "app", taskId: f.plan.id, ticketId: extra.ticketId ?? f.ticket.id, botId: extra.botId ?? null, turnId: extra.turnId ?? null, payload });
  // A check that was there before the hand-over is a requirement it missed; one defined after it was not clear yet.
  event("submission.gates_failed", { submission_id: "sub-1", failures: ["check-before"] });
  event("submission.gates_failed", { submission_id: "sub-1", failures: ["check-after"] });
  // The settle record that follows a failed gate files nothing more.
  event("submission.checked", { submission_id: "sub-1", state: "checks_failed", failures: ["check-before"] });
  // A reject is the producer's, whoever turned it back; an overturned approval is the reviewer's.
  event("review.recorded", { submission_id: "sub-1", outcome: "reject" }, { botId: f.reviewer.id });
  event("review.recorded", { submission_id: "sub-1", outcome: "reject", by: "user" });
  event("review.recorded", { submission_id: "sub-1", outcome: "approve" }, { botId: f.reviewer.id });
  event("review.miss", { submission_id: "sub-1", reviewer_bot_id: f.reviewer.id, reviewer_model: "gemini", message_id: null });
  event("ceiling.reached", { submission_id: "sub-1", part_key: "shot_07" });
  event("job.failed", { job_id: "job-1" }, { botId: f.maker.id });
  event("hold.violation", {}, { botId: f.maker.id });
  // A reply's failure shape is the model's; an endpoint that could not be reached is nobody's quality.
  event("turn.failed", { fail_kind: "repeat" }, { botId: f.maker.id, turnId: f.turn.id });
  event("turn.failed", { fail_kind: "unreachable" }, { botId: f.maker.id, turnId: f.turn.id });
  event("turn.failed", { fail_kind: "stuck" }, { botId: f.maker.id, turnId: f.turn.id });
  event("work.needs_attention", { reason: "repeat" }, { botId: f.maker.id, turnId: f.turn.id });
  event("supervisor.lost_segment", {}, { botId: f.maker.id });
  expect(filed(f)).toEqual([
    { kind: "ceiling", category: "pipeline", bot: f.maker.id, model: "grk" },
    { kind: "checks_failed", category: "execution", bot: f.maker.id, model: "grk" },
    { kind: "checks_failed", category: "unclear", bot: f.maker.id, model: "grk" },
    { kind: "cut_off:stuck", category: "orchestration", bot: f.maker.id, model: "grk" },
    { kind: "failure_shape:repeat", category: "model", bot: f.maker.id, model: "grk" },
    { kind: "hold_violation", category: "orchestration", bot: f.maker.id, model: null },
    { kind: "job_failed", category: "pipeline", bot: f.maker.id, model: null },
    { kind: "review_miss", category: "review_miss", bot: f.reviewer.id, model: "gemini" },
    { kind: "review_rejected", category: "execution", bot: f.maker.id, model: "grk" },
    { kind: "supervisor:lost_segment", category: "orchestration", bot: f.maker.id, model: null },
    { kind: "user_rejected", category: "execution", bot: f.maker.id, model: "grk" },
  ]);
});

test("your send-back of a hand-over a reviewer approved is that reviewer's miss too", () => {
  const f = fixture();
  submission(f, "sub-1", isoNow(), "rejected");
  f.store.db.run("UPDATE submissions SET reviews = ? WHERE id = 'sub-1'", [JSON.stringify([{ reviewer_bot_id: f.reviewer.id, reviewer_model: "gemini", outcome: "approve" }])]);
  f.store.recordWorkEvent({ kind: "review.recorded", actor: "user", taskId: f.plan.id, ticketId: f.ticket.id, payload: { submission_id: "sub-1", outcome: "reject", by: "user" } });
  expect(filed(f)).toEqual([
    { kind: "review_miss", category: "review_miss", bot: f.reviewer.id, model: "gemini" },
    { kind: "user_rejected", category: "execution", bot: f.maker.id, model: "grk" },
  ]);
});

test("taking a complaint back takes back the complaint and the misses it filed", () => {
  const f = fixture();
  submission(f, "sub-1", isoNow(), "approved");
  const event = (kind: string, payload: Record<string, unknown>) => f.store.recordWorkEvent({ kind, actor: "user", taskId: f.plan.id, ticketId: f.ticket.id, payload });
  event("complaint.rework", { message_id: null, card_id: "card-1", parts: [], producer: f.maker.id });
  event("review.miss", { submission_id: "sub-1", reviewer_bot_id: f.reviewer.id, reviewer_model: "gemini", message_id: null, card_id: "card-1" });
  event("complaint.rework", { message_id: null, card_id: "card-2", parts: [], producer: f.maker.id });
  expect(filed(f).map((row) => row.kind)).toEqual(["complaint", "complaint", "review_miss"]);
  event("complaint.rework_undone", { message_id: null, card_id: "card-1" });
  expect(f.store.listQualityEvents().map((row) => [row.kind, row.detail.card_id])).toEqual([["complaint", "card-2"]]);
});

test("a requirement first said in your words after a hand-over files as unclear; one said before it, or imported, does not", () => {
  const f = fixture();
  const add = (quote: string, scope: "ticket" | "plan", sourceKind: "board" | "legacy" = "board") =>
    f.store.addRequirement({ scope, scopeId: scope === "ticket" ? f.ticket.id : f.plan.id, quote, sourceKind, addedBy: sourceKind === "legacy" ? "import" : "user" });
  add("片头要有标题", "ticket");
  expect(filed(f)).toEqual([]);
  submission(f, "sub-1", isoNow(), "approved");
  const ticketWide = add("片尾留三秒黑场", "ticket");
  const planWide = add("全片不要配乐", "plan");
  add("旧规划里的一条", "plan", "legacy");
  expect(f.store.listQualityEvents().map((row) => [row.kind, row.category, row.requirement_id, row.bot_id, row.submission_id, row.ticket_id]).sort()).toEqual([
    ["requirement_after_delivery", "unclear", planWide.id, f.maker.id, "sub-1", f.ticket.id],
    ["requirement_after_delivery", "unclear", ticketWide.id, f.maker.id, "sub-1", f.ticket.id],
  ].sort());
});

test("below level 8 nothing is filed, and a turn cannot be marked", () => {
  const f = fixture(ENGINE_LEVELS.routing);
  f.store.recordWorkEvent({ kind: "hold.violation", actor: "app", botId: f.maker.id, payload: {} });
  expect(f.store.listQualityEvents()).toEqual([]);
  expect(() => f.store.markTurnModel(f.turn.id, true)).toThrow("engine level 8");
});

test("your mark files one model event per turn and unmarking takes it back; clearing the history keeps events and lessons without their sources", () => {
  const f = fixture();
  expect(f.store.markTurnModel(f.turn.id, true)).toEqual({ turn_id: f.turn.id, marked: true });
  f.store.markTurnModel(f.turn.id, true);
  expect(filed(f)).toEqual([{ kind: "marked_model", category: "model", bot: f.maker.id, model: "grk" }]);
  expect(f.store.turnMarkedModel(f.turn.id)).toBe(true);
  f.store.markTurnModel(f.turn.id, false);
  expect(filed(f)).toEqual([]);
  f.store.markTurnModel(f.turn.id, true);
  const lesson = f.store.noteShellTimeout({ workspace: "/ws", turnId: f.turn.id, botId: f.maker.id, signature: "grep -r@home", head: "grep -r", place: "home", seconds: 600, overriding: null })!;
  f.store.clearSessionMessages(f.dm);
  expect(f.store.listQualityEvents().map((row) => [row.kind, row.turn_id])).toEqual([["tool_timeout", null], ["marked_model", null]]);
  expect(f.store.getLesson(lesson.id)!.evidence.map((entry) => entry.turn_id)).toEqual([null]);
});

test("the report counts each Bot's hand-overs on a model, what turned them back, and the cost per approval", () => {
  const f = fixture();
  submission(f, "sub-1", isoNow(), "rejected");
  submission(f, "sub-2", isoNow(), "approved");
  f.store.recordWorkEvent({ kind: "review.recorded", actor: f.reviewer.id, taskId: f.plan.id, ticketId: f.ticket.id, payload: { submission_id: "sub-1", outcome: "reject" } });
  f.store.db.run(`INSERT INTO spend (id, session_id, bot_id, turn_id, kind, model, cost_usd_ticks, created_at) VALUES ('sp-1', ?, ?, ?, 'turn', 'grk', 20000000000, ?)`,
    [f.dm, f.maker.id, f.turn.id, isoNow()]);
  expect(f.store.qualityReport({ days: 7 })).toEqual([{ bot_id: f.maker.id, bot_name: "Maker", model: "grk", plan_kind: null, hand_overs: 2, approved: 1, review_rejected: 1,
    user_rejected: 0, checks_failed: 0, complaints: 0, failure_shapes: 0, review_misses: 0, cost_usd: 2, cost_per_approved: 2 }]);
});

test("a proposal you have not confirmed, or a complaint the scribe caught, files nothing; confirming a proposal files it", () => {
  const f = fixture();
  submission(f, "sub-1", isoNow(), "approved");
  const later = () => f.store.addRequirement({ scope: "ticket", scopeId: f.ticket.id, quote: "片尾留三秒黑场", sourceKind: "message", addedBy: "scribe", status: "proposed" });
  const proposal = later();
  f.store.addRequirement({ scope: "ticket", scopeId: f.ticket.id, quote: "画面太暗了", sourceKind: "message", addedBy: "capture" });
  expect(filed(f)).toEqual([]);
  f.store.confirmRequirement(proposal.id, { taskId: f.plan.id });
  expect(f.store.listQualityEvents().map((row) => [row.kind, row.requirement_id])).toEqual([["requirement_after_delivery", proposal.id]]);
});

test("a supervisor notice is filed under its own code", () => {
  const f = fixture();
  f.store.recordWorkEvent({ kind: "supervisor.notice", actor: "app", botId: f.maker.id, payload: { code: "retry_budget" } });
  expect(filed(f).map((row) => row.kind)).toEqual(["supervisor:retry_budget"]);
});

test("a requirement is dated from your words: one you said before the hand-over but filed after it files nothing", () => {
  const f = fixture();
  const quote = f.store.db.query<{ id: string }, [string, string, string]>(`INSERT INTO user_quotes (id, message_id, session_id, task_id, via, body, created_at)
    VALUES ('q-1', NULL, ?, ?, 'message', '片尾留三秒黑场', ?) RETURNING id`).get(f.dm, f.plan.id, new Date(Date.parse(isoNow()) - 60_000).toISOString())!;
  submission(f, "sub-1", new Date(Date.parse(isoNow()) - 30_000).toISOString(), "approved");
  f.store.addRequirement({ scope: "ticket", scopeId: f.ticket.id, quote: "片尾留三秒黑场", sourceKind: "message", sourceQuoteId: quote.id, addedBy: "scribe" });
  expect(filed(f)).toEqual([]);
});

test("below level 8 the report is empty: turn-backs and complaints are not filed there, and zeros would read as counts", () => {
  const f = fixture(ENGINE_LEVELS.routing);
  submission(f, "sub-1", isoNow(), "approved");
  expect(f.store.qualityReport({ days: 7 })).toEqual([]);
});
