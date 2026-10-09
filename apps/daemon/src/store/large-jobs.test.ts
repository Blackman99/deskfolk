import { afterEach, expect, test } from "bun:test";
import { isoNow } from "../ids";
import { Store } from ".";
import { ENGINE_LEVELS } from "./schema-gate";
import { superviseSubmissions, UNREVIEWED_AFTER_MS } from "./submissions";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const later = (ms: number) => new Date(Date.parse(isoNow()) + ms).toISOString();
const hash = (n: number) => String(n % 10).repeat(64);

function fixture(level: number = ENGINE_LEVELS.submissions) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const lead = store.createBot({ name: "导演", duties: "统筹出片", boundaries: "none" }).bot;
  const writer = store.createBot({ name: "编剧", duties: "写", boundaries: "none" }).bot;
  const room = store.createGroup({ name: "片场", members: [lead.id, writer.id] });
  const plan = store.openTask({ sessionId: room.id, title: "灯塔守夜人" });
  store.db.run("UPDATE tasks SET lead_bot_id = ? WHERE id = ?", [lead.id, plan.id]);
  const ctx = (store as unknown as { ctx: Parameters<typeof superviseSubmissions>[0] }).ctx;
  // Each its own turn, the one before it over (one live turn per Bot and plan).
  const turnOf = (botId: string, ticketId: string | null = null) => {
    for (const live of store.listLiveTurns().filter((turn) => turn.bot_id === botId)) store.setTurnStatus(live.id, "completed");
    const trigger = store.insertMessage({ sessionId: room.id, kind: "system", author: botId, body: "工作" });
    return store.createTurn({ sessionId: room.id, botId, triggerMessageId: trigger.id, taskId: plan.id, ticketId }).id;
  };
  return { store, ctx, lead, writer, room, plan, turnOf };
}
type Fixture = ReturnType<typeof fixture>;

function large(f: Fixture) {
  expect(f.store.markPlanScale({ taskId: f.plan.id, value: "large", by: "reader", why: "20 分钟", unit: "一场" })).toBe(true);
}

/** The lead lays the job out: a style sheet, the sample after it, two more scenes and the assembly. */
function layOut(f: Fixture) {
  const result = f.store.planItems({ turnId: f.turnOf(f.lead.id), items: [
    { title: "设定集", owner: "导演" },
    { title: "第一场", owner: "导演", depends_on: ["设定集"], sample: true },
    { title: "第二场", owner: "导演" },
    { title: "第三场", owner: "编剧" },
    { title: "组装成片", owner: "导演", depends_on: ["第二场", "第三场"] },
  ] });
  const byTitle = (title: string) => result.tickets.find((row) => row.title === title)!;
  return { result, sheet: byTitle("设定集"), sample: byTitle("第一场"), two: byTitle("第二场"), three: byTitle("第三场"), cut: byTitle("组装成片") };
}

function ticket(f: Fixture, id: string) {
  return f.store.db.query<{ dir: string; stage: string | null; status: string }, [string]>("SELECT dir, stage, status FROM tickets WHERE id = ?").get(id)!;
}

function finish(f: Fixture, checkId: string, outcome: "pass" | "fail" | "blocked") {
  const run = f.store.beginCheckRun(checkId, "settle");
  f.store.finishCheckRun(run.id, { outcome, exitCode: null, detail: outcome === "fail" ? "第 3 帧起都是静止图片" : "", output: null });
}

/**
 * A hand-over of `ticketId`'s file; `outcomes` are the runs its checks then make, each by id (every
 * check bound to it passes when left out). Settled: with no reviewer it waits for the tick.
 */
function handOver(f: Fixture, ticketId: string, botId: string, n: number, outcomes: Record<string, "pass" | "fail" | "blocked"> = {}) {
  const turn = f.turnOf(botId, ticketId);
  const prepared = f.store.prepareSubmission({ turnId: turn, origin: "submit", artifacts: [{ path: `${ticket(f, ticketId).dir}/scene.mp4`, sha256: hash(n) }] })!;
  f.store.setTurnStatus(turn, "completed");
  for (const checkId of prepared.checkIds) finish(f, checkId, outcomes[checkId] ?? "pass");
  return f.store.settleSubmissionChecks(prepared.submission.id).submission;
}

/** A check of yours on the ticket: passing, it backs an approval with no reviewer. */
function gateOn(f: Fixture, ticketId: string) {
  const now = isoNow();
  const id = `gate-${Math.random().toString(36).slice(2)}`;
  f.store.db.run(`INSERT INTO acceptance_checks (id, task_id, ticket_id, item, kind, path, source, created_at, updated_at, defined_at)
    VALUES (?, ?, ?, '成片存在', 'exists', ?, 'user', ?, ?, ?)`, [id, f.plan.id, ticketId, `${ticket(f, ticketId).dir}/scene.mp4`, now, now, now]);
  return id;
}

/** The style sheet through, so the sample may start (it waits for it). */
function sheetDone(f: Fixture, sheetId: string) {
  f.store.db.run("UPDATE tickets SET status = 'done', stage = 'approved' WHERE id = ?", [sheetId]);
}

/** The sample handed over and approved on your card. */
function sampleApproved(f: Fixture, sampleId: string) {
  const submission = handOver(f, sampleId, f.lead.id, 2);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  approveOnCard(f, submission.id);
}

function approveOnCard(f: Fixture, submissionId: string) {
  const card = f.store.getSubmission(submissionId).awaiting?.message_id;
  if (!card) throw new Error("no card waits on you");
  f.store.answerReviewCard(card, "approve");
}

test("a reading only ever finds an unread job large, once; yours stands over it and is the only way back to single", () => {
  const f = fixture();
  expect(f.store.markPlanScale({ taskId: f.plan.id, value: "single", by: "reader" })).toBe(false);
  large(f);
  expect(f.store.planScale(f.plan.id)).toMatchObject({ value: "large", by: "reader", why: "20 分钟", unit: "一场" });
  expect(f.store.markPlanScale({ taskId: f.plan.id, value: "large", by: "signal", why: "又一次" })).toBe(false);
  expect(f.store.markPlanScale({ taskId: f.plan.id, value: "single", by: "user" })).toBe(true);
  expect(f.store.markPlanScale({ taskId: f.plan.id, value: "large", by: "signal" })).toBe(false);
  expect(f.store.planScale(f.plan.id)).toMatchObject({ value: "single", by: "user", unit: "一场" });
  expect(f.store.layoutMissing(f.plan.id)).toBe(false);
});

test("a large job not laid out refuses generating and handing over, and a layout with no sample or with nothing waiting is refused whole", () => {
  const f = fixture();
  large(f);
  const turn = f.turnOf(f.lead.id);
  expect(f.store.largeJobRefusal(turn)).toMatchObject({ code: "layout_first" });
  expect(f.store.largeJobRefusal(turn)!.message).toContain("sample: true");
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "整集", owner: "导演" }] })).toThrow("this job is a large one");
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "整集", owner: "导演", sample: true }] })).toThrow("this job is a large one");
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "甲", owner: "导演", sample: true }, { title: "乙", owner: "导演", sample: true }] }))
    .toThrow("one sample");
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM tickets WHERE task_id = ?").get(f.plan.id)).toEqual({ n: 0 });
  // A job nobody read as large lays out as it always did, a sample or not.
  const other = fixture();
  expect(other.store.planItems({ turnId: other.turnOf(other.lead.id), items: [{ title: "海报", owner: "导演" }] }).tickets).toHaveLength(1);
});

test("laid out, everything but the sample and what it needs first waits for it; nothing starts on them until you approve it", () => {
  const f = fixture();
  large(f);
  const { result, sheet, sample, two, three, cut } = layOut(f);
  expect(result.tickets.find((row) => row.sample)?.title).toBe("第一场");
  expect(f.store.layoutMissing(f.plan.id)).toBe(false);
  expect(sheet.depends_on).toEqual([]);
  expect(sample.depends_on).toEqual([sheet.ticket_id]);
  for (const unit of [two, three, cut]) expect(unit.depends_on).toContain(sample.ticket_id);
  // The style sheet is free to go; the scenes wait for the sample.
  expect(f.store.waitingOn(sheet.ticket_id)).toBeNull();
  expect(f.store.waitingOn(three.ticket_id)).toMatchObject({ id: sample.ticket_id, sample: true });
  expect(f.store.ballHolder({ ticketId: three.ticket_id })).toEqual({ kind: "app", reason: "waits", ref: sample.ticket_id });
  const writing = f.turnOf(f.writer.id);
  expect(() => f.store.workOn({ turnId: writing, plan: f.plan.id, ticket: three.ticket_id })).toThrow("the job's sample, which the user has not approved yet");
  const onIt = f.turnOf(f.writer.id, three.ticket_id);
  expect(f.store.largeJobRefusal(onIt)).toMatchObject({ code: "waits_for" });
  expect(() => f.store.prepareSubmission({ turnId: onIt, origin: "submit", artifacts: [{ path: `${ticket(f, three.ticket_id).dir}/scene.mp4`, sha256: hash(1) }] }))
    .toThrow("waits for the sample");
  // Files left at an ending are simply not handed over.
  expect(f.store.prepareSubmission({ turnId: onIt, origin: "implicit", artifacts: [{ path: `${ticket(f, three.ticket_id).dir}/scene.mp4`, sha256: hash(1) }] })).toBeNull();
  // The board shows what it waits for.
  const board = f.store.taskDetail(f.plan.id, () => true);
  expect(board.scale).toMatchObject({ value: "large", by: "reader" });
  expect(board.tickets.find((row) => row.id === three.ticket_id)).toMatchObject({ sample: false, ball: { kind: "app", reason: "waits", waits_for: sample.ticket_id } });
  expect(board.tickets.find((row) => row.id === sample.ticket_id)?.sample).toBe(true);
});

test("a ticket that waits for another (not the sample) may start once that one is handed over, not only once approved", () => {
  const f = fixture();
  const [first, second] = f.store.planItems({ turnId: f.turnOf(f.lead.id), items: [
    { title: "文案", owner: "编剧" },
    { title: "海报", owner: "导演", depends_on: ["文案"] },
  ] }).tickets;
  expect(f.store.waitingOn(second!.ticket_id)).toMatchObject({ id: first!.ticket_id, sample: false });
  handOver(f, first!.ticket_id, f.writer.id, 1);
  expect(f.store.waitingOn(second!.ticket_id)).toBeNull();
});

test("the sample comes to you even with a passing check of yours behind it; its card says what it took; approving it holds the rest to it", () => {
  const f = fixture();
  large(f);
  const { sheet, sample, two, three, cut } = layOut(f);
  expect(f.store.waitingOn(sample.ticket_id)).toMatchObject({ id: sheet.ticket_id, sample: false });
  sheetDone(f, sheet.ticket_id);
  gateOn(f, sample.ticket_id);
  const submission = handOver(f, sample.ticket_id, f.lead.id, 2);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  const waiting = f.store.getSubmission(submission.id);
  expect(waiting.state).toBe("submitted");
  expect(waiting.awaiting?.kind).toBe("approval");
  const card = f.store.getMessage(waiting.awaiting!.message_id!);
  expect(card.body).toContain("样片交上来了");
  expect(card.body).toContain("剩下 3 件");
  // Nothing is held to it before you approve it.
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM acceptance_checks WHERE standard_of IS NOT NULL").get()).toEqual({ n: 0 });
  approveOnCard(f, submission.id);
  expect(ticket(f, sample.ticket_id).stage).toBe("approved");
  const standards = f.store.db.query<{ ticket_id: string; kind: string; origin: string; source: string; item: string }, [string]>(
    "SELECT ticket_id, kind, origin, source, item FROM acceptance_checks WHERE standard_of = ? ORDER BY ticket_id").all(sample.ticket_id);
  expect(standards.map((row) => row.ticket_id).sort()).toEqual([two.ticket_id, three.ticket_id, cut.ticket_id].sort());
  expect(standards[0]).toMatchObject({ kind: "continuity", origin: "sample", source: "user" });
  expect(standards[0]!.item).toContain("样片 #02「第一场」");
  expect(f.store.waitingOn(three.ticket_id)).toBeNull();
  expect(f.store.waitingOn(sheet.ticket_id)).toBeNull();
});

test("a standard check holds a hand-over only once it judged it: not run is waited for, a pass backs it, a fail sends it back, unjudged holds nothing", () => {
  const f = fixture();
  large(f);
  const { sheet, sample, two, three } = layOut(f);
  sheetDone(f, sheet.ticket_id);
  sampleApproved(f, sample.ticket_id);
  const standard = (ticketId: string) => f.store.db.query<{ id: string }, [string]>("SELECT id FROM acceptance_checks WHERE ticket_id = ? AND standard_of IS NOT NULL").get(ticketId)!.id;
  // Not run since the hand-over: it is waited for, never read as a pass.
  const turn = f.turnOf(f.lead.id, two.ticket_id);
  const pending = f.store.prepareSubmission({ turnId: turn, origin: "submit", artifacts: [{ path: `${ticket(f, two.ticket_id).dir}/scene.mp4`, sha256: hash(3) }] })!;
  expect(pending.checkIds).toContain(standard(two.ticket_id));
  expect(f.store.settleSubmissionChecks(pending.submission.id).state).toBe("checks_failed");
  // A fail sends it back, with what the judge saw.
  const failed = handOver(f, two.ticket_id, f.lead.id, 4, { [standard(two.ticket_id)]: "fail" });
  expect(failed.state).toBe("checks_failed");
  expect(f.store.getSubmission(failed.id).checks).toMatchObject([{ gate: true, outcome: "fail", detail: "第 3 帧起都是静止图片" }]);
  // A pass backs it: approved at the tick with nobody asked.
  const passed = handOver(f, two.ticket_id, f.lead.id, 5);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(f.store.getSubmission(passed.id).state).toBe("approved");
  // Unjudged (nothing to compare, no model, the picture budget): holds nothing, backs nothing — your card.
  const third = handOver(f, three.ticket_id, f.writer.id, 6, { [standard(three.ticket_id)]: "blocked" });
  expect(third.state).toBe("submitted");
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  expect(f.store.getSubmission(third.id).awaiting?.kind).toBe("approval");
});

test("the last ticket of a large job comes to you, whatever backs it: approving it delivers the job", () => {
  const f = fixture();
  large(f);
  const { sheet, sample, two, three, cut } = layOut(f);
  sheetDone(f, sheet.ticket_id);
  sampleApproved(f, sample.ticket_id);
  for (const unit of [two, three]) f.store.db.run("UPDATE tickets SET status = 'done', stage = 'approved' WHERE id = ?", [unit.ticket_id]);
  // Its own gate and its standard check both pass: still yours.
  gateOn(f, cut.ticket_id);
  const last = handOver(f, cut.ticket_id, f.lead.id, 9);
  superviseSubmissions(f.ctx, later(UNREVIEWED_AFTER_MS + 1_000));
  const waiting = f.store.getSubmission(last.id);
  expect(waiting.awaiting?.kind).toBe("approval");
  expect(f.store.getMessage(waiting.awaiting!.message_id!).body).toContain("最后一件");
  approveOnCard(f, last.id);
  expect(f.store.db.query<{ stage: string }, [string]>("SELECT stage FROM tasks WHERE id = ?").get(f.plan.id)?.stage).toBe("delivered");
});

test("the signal: three segments on a job not laid out and nothing approved, unless you said what size it is", () => {
  const f = fixture();
  expect(f.store.signalledPlans()).toEqual([]);
  for (let i = 0; i < 3; i++) {
    const turn = f.turnOf(f.lead.id, null);
    f.store.db.run("UPDATE turns SET status = 'completed', mode = 'work', end_reason = 'done' WHERE id = ?", [turn]);
  }
  expect(f.store.signalledPlans()).toEqual([{ taskId: f.plan.id, segments: 3, handedBack: 0 }]);
  f.store.markPlanScale({ taskId: f.plan.id, value: "single", by: "user" });
  expect(f.store.signalledPlans()).toEqual([]);
});

test("below level 5 nothing of this applies", () => {
  const f = fixture(ENGINE_LEVELS.supervision);
  f.store.db.run("UPDATE tasks SET scale = 'large', scale_by = 'reader' WHERE id = ?", [f.plan.id]);
  expect(f.store.layoutMissing(f.plan.id)).toBe(false);
  expect(f.store.largeJobRefusal(f.turnOf(f.lead.id))).toBeNull();
});

test("once what a ticket waits for is through, the supervisor calls its owner at the next tick, not after the quiet window", () => {
  const f = fixture();
  large(f);
  const { sheet, sample, three } = layOut(f);
  // Waiting: nobody is called to the scenes, however quiet the job is.
  const quiet = new Date(Date.parse(isoNow()) + 60 * 60_000).toISOString();
  expect(f.store.supervisorTick({ now: isoNow() }).wakes.filter((wake) => wake.ticketId === three.ticket_id)).toEqual([]);
  sheetDone(f, sheet.ticket_id);
  // The lead's layout segment over: nobody is at work on the job.
  for (const live of f.store.listLiveTurns()) f.store.setTurnStatus(live.id, "completed");
  // The sample's turn has come at once: its owner is called before any quiet window has passed.
  const first = f.store.supervisorTick({ now: isoNow() });
  expect(first.wakes.map((wake) => wake.ticketId)).toContain(sample.ticket_id);
  sampleApproved(f, sample.ticket_id);
  for (const live of f.store.listLiveTurns()) f.store.setTurnStatus(live.id, "completed");
  const next = f.store.supervisorTick({ now: isoNow() });
  expect(next.wakes.map((wake) => [wake.ticketId, wake.botId])).toContainEqual([three.ticket_id, f.writer.id]);
  void quiet;
});

test("the sample card's sums leave the model's cost unsaid when the endpoint reports none", async () => {
  const { sampleSumsLines } = await import("./large-jobs");
  expect(sampleSumsLines({ minutes: 4, segments: 2, modelUsd: null, externalCalls: 0, remaining: 3 }, "zh"))
    .toBe("样片做了约 4 分钟（2 段）。按样片的规模粗算，剩下 3 件约 12 分钟。");
  expect(sampleSumsLines({ minutes: 4, segments: 2, modelUsd: 0.5, externalCalls: 6, remaining: 3 }, "zh"))
    .toBe("样片做了约 4 分钟（2 段）、模型费约 $0.50、出图出视频这类外部调用 6 次（费用以各服务为准）。按样片的规模粗算，剩下 3 件约 12 分钟、模型费约 $1.50、外部调用约 18 次。");
  expect(sampleSumsLines({ minutes: 4, segments: 1, modelUsd: 0, externalCalls: 0, remaining: 0 }, "en"))
    .toBe("The sample took about 4 min of work (1 segment).");
});

/** The checks held to `sampleId` still standing, by the ticket each is on. */
function standardChecks(f: Fixture, sampleId: string) {
  return f.store.db.query<{ ticket_id: string; removed_by: string | null }, [string]>(
    "SELECT ticket_id, removed_by FROM acceptance_checks WHERE standard_of = ? AND removed_at IS NULL ORDER BY ticket_id").all(sampleId);
}

test("a turned-down direction is laid out again: the old tickets dropped with why, the sample moved, its checks down, the rest waiting for the new one", () => {
  // IG MV, 2026-10-09: 2D → 3D left the 2D tickets and 2D sample standing beside the 3D ones, and the
  // 3D tickets were held to the 2D sample (which "passed" four 3D versions you sent back).
  const f = fixture();
  large(f);
  const { sheet, sample, two, three, cut } = layOut(f);
  sheetDone(f, sheet.ticket_id);
  sampleApproved(f, sample.ticket_id);
  expect(standardChecks(f, sample.ticket_id).map((row) => row.ticket_id).sort()).toEqual([two.ticket_id, three.ticket_id, cut.ticket_id].sort());
  // A reminder booked on the old scene's work, and mail queued for it.
  const old = f.turnOf(f.lead.id, two.ticket_id);
  const work = f.store.db.query<{ work_item_id: string }, [string]>("SELECT work_item_id FROM turns WHERE id = ?").get(old)!.work_item_id;
  f.store.setTurnStatus(old, "completed");
  f.store.db.run(`INSERT INTO check_backs (id, bot_id, session_id, task_id, note, due_at, created_at, work_item_id, kind)
    VALUES ('cb-2d', ?, ?, ?, '核对第二场 2D 返工', ?, ?, ?, NULL)`, [f.lead.id, f.room.id, f.plan.id, later(3_600_000), isoNow(), work]);

  const result = f.store.planItems({
    turnId: f.turnOf(f.lead.id),
    items: [
      { title: "3D 样镜", owner: "导演", sample: true },
      { title: "3D 第二场", owner: "导演" },
      { title: "3D 组装", owner: "导演", depends_on: ["3D 第二场"] },
    ],
    drop: [{ ticket: "#03", reason: "改成 3D，2D 第二场不做了" }, { ticket: three.title, reason: "改成 3D" }, { ticket: cut.ticket_id, reason: "改成 3D 组装" }],
    resample_reason: "用户否掉了 2D 方向",
  });
  const newSample = result.tickets.find((row) => row.title === "3D 样镜")!;
  expect(result.dropped?.map((row) => [row.seq, row.reason])).toEqual([[3, "改成 3D，2D 第二场不做了"], [4, "改成 3D"], [5, "改成 3D 组装"]]);
  expect(result.resampled).toEqual({ from: sample.ticket_id, to: newSample.ticket_id, removed_checks: 3 });
  for (const id of [two.ticket_id, three.ticket_id, cut.ticket_id]) {
    expect(f.store.getTicket(id)).toMatchObject({ status: "parked", stage: "dropped" });
  }
  expect(f.store.getTicket(two.ticket_id).dropped_why).toBe("改成 3D，2D 第二场不做了");
  // One sample, the old one's checks down (kept with their runs), the new tickets waiting for the new one.
  expect(f.store.db.query("SELECT id FROM tickets WHERE task_id = ? AND sample = 1").all(f.plan.id)).toEqual([{ id: newSample.ticket_id }]);
  expect(standardChecks(f, sample.ticket_id)).toEqual([]);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM acceptance_checks WHERE standard_of = ? AND removed_by = 'resample'").get(sample.ticket_id)).toEqual({ n: 3 });
  const second = result.tickets.find((row) => row.title === "3D 第二场")!;
  expect(f.store.getTicket(second.ticket_id).depends_on).toContain(newSample.ticket_id);
  expect(f.store.getTicket(second.ticket_id).depends_on).not.toContain(sample.ticket_id);
  // The reminder on the dropped scene's work does not fire.
  expect(f.store.db.query<{ voided_at: string | null }, []>("SELECT voided_at FROM check_backs WHERE id = 'cb-2d'").get()!.voided_at).not.toBeNull();
  expect(f.store.listWorkEvents({ kind: "plan.resampled" }).map((event) => event.payload)).toMatchObject([{ from: sample.ticket_id, to: newSample.ticket_id, reason: "用户否掉了 2D 方向" }]);
  // Nothing more on a dropped ticket: working on it, delegating it, generating or handing over there.
  const late = f.turnOf(f.writer.id);
  expect(() => f.store.workOn({ turnId: late, plan: f.plan.id, ticket: three.ticket_id })).toThrow("dropped");
  // Your board reopening it clears the reason: it is work again, not 作废.
  f.store.patchTicketByUser(three.ticket_id, { status: "todo" });
  expect(f.store.getTicket(three.ticket_id).dropped_why).toBeNull();
});

test("what cannot be dropped or moved: an approved ticket, one waiting on review, a sample with its hand-over out", () => {
  const f = fixture();
  large(f);
  const { sheet, sample, two } = layOut(f);
  sheetDone(f, sheet.ticket_id);
  const lead = f.turnOf(f.lead.id);
  expect(() => f.store.planItems({ turnId: lead, items: [], drop: [{ ticket: sheet.ticket_id, reason: "x" }] })).toThrow("approved");
  // The sample handed over and waiting on your card: it cannot be moved, nor dropped.
  handOver(f, sample.ticket_id, f.lead.id, 3);
  const again = f.turnOf(f.lead.id);
  expect(() => f.store.planItems({ turnId: again, items: [{ title: two.title, owner: "导演", sample: true }] })).toThrow("waiting on review or the user's card");
  expect(() => f.store.planItems({ turnId: again, items: [], drop: [{ ticket: sample.ticket_id, reason: "x" }] })).toThrow("waiting on review");
  expect(() => f.store.planItems({ turnId: again, items: [], drop: [{ ticket: "#09", reason: "x" }] })).toThrow("names no ticket");
  expect(() => f.store.planItems({ turnId: again, items: [], drop: [{ ticket: two.title }] })).toThrow("reason is required");
});

test("the board can make another ticket the sample: the same move, and the new one is yours to approve", () => {
  const f = fixture();
  large(f);
  const { sheet, sample, two, three } = layOut(f);
  sheetDone(f, sheet.ticket_id);
  sampleApproved(f, sample.ticket_id);
  f.store.patchTicketByUser(three.ticket_id, { sample: true });
  expect(f.store.getTicket(three.ticket_id).sample).toBe(true);
  expect(f.store.getTicket(sample.ticket_id).sample).toBe(false);
  expect(standardChecks(f, sample.ticket_id)).toEqual([]);
  expect(f.store.getTicket(two.ticket_id).depends_on).toContain(three.ticket_id);
  expect(() => f.store.patchTicketByUser(two.ticket_id, { sample: false })).toThrow("only ever set to true");
  // Back to the first one: its checks come back, since the app took them down, not you.
  f.store.patchTicketByUser(sample.ticket_id, { sample: true });
  expect(standardChecks(f, sample.ticket_id).length).toBeGreaterThan(0);
});
