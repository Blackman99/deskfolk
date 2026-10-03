import { afterEach, expect, test } from "bun:test";
import { isoNow } from "../ids";
import { Store } from ".";
import { ENGINE_LEVELS } from "./schema-gate";
import { superviseSubmissions, UNREVIEWED_AFTER_MS } from "./submissions";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(level: number = ENGINE_LEVELS.routing) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const maker = store.createBot({ name: "Maker", duties: "make", boundaries: "none" }).bot;
  const room = store.createGroup({ name: "Studio", members: [maker.id, store.createBot({ name: "Other", duties: "x", boundaries: "none" }).bot.id] });
  const plan = store.openTask({ sessionId: room.id, title: "EP01" });
  const ticket = store.createTicket({ taskId: plan.id, title: "母带", worker: maker.id });
  const trigger = store.insertMessage({ sessionId: room.id, kind: "system", author: maker.id, body: "工作" });
  const turn = store.createTurn({ sessionId: room.id, botId: maker.id, triggerMessageId: trigger.id, taskId: plan.id, ticketId: ticket.id });
  // Two checks of yours, failing in turn, so no one of them fails three times running (the ceiling's rule).
  const now = isoNow();
  const checks = ["check-a", "check-b"];
  for (const id of checks) {
    store.db.run(`INSERT INTO acceptance_checks (id, task_id, ticket_id, item, kind, path, source, created_at, updated_at, defined_at)
      VALUES (?, ?, ?, ?, 'exists', ?, 'user', ?, ?, ?)`, [id, plan.id, ticket.id, id, `${ticket.dir}/master.mp4`, now, now, now]);
  }
  return { store, maker, plan, ticket, turn, checks };
}
type Fixture = ReturnType<typeof fixture>;

function handOver(f: Fixture, n: number, outcome: "pass" | "fail", file = "master.mp4") {
  const { submission } = f.store.prepareSubmission({ turnId: f.turn.id, origin: "submit", artifacts: [{ path: `${f.ticket.dir}/${file}`, sha256: `${n}`.padStart(64, "0") }] })!;
  for (const [i, id] of f.checks.entries()) {
    const run = f.store.beginCheckRun(id, "settle");
    f.store.finishCheckRun(run.id, { outcome: outcome === "fail" && i === n % 2 ? "fail" : "pass", exitCode: null, detail: "", output: null });
  }
  return f.store.settleSubmissionChecks(submission.id);
}

test("two failed hand-overs in a row take a job one level up, two more another; an approval puts it back", () => {
  const f = fixture();
  const work = f.turn.work_item_id!;
  handOver(f, 1, "fail");
  expect(f.store.workEscalation(work)).toBe(0);
  handOver(f, 2, "fail");
  expect(f.store.workEscalation(work)).toBe(1);
  handOver(f, 3, "fail");
  expect(f.store.workEscalation(work)).toBe(1);
  handOver(f, 4, "fail");
  expect(f.store.workEscalation(work)).toBe(2);
  const passed = handOver(f, 5, "pass");
  f.store.db.run("UPDATE submissions SET updated_at = ? WHERE id = ?", [new Date(Date.parse(isoNow()) - 60_000).toISOString(), passed.submission.id]);
  superviseSubmissions((f.store as unknown as { ctx: never }).ctx, new Date(Date.now() + UNREVIEWED_AFTER_MS + 1_000).toISOString());
  expect(f.store.getSubmission(passed.submission.id).state).toBe("approved");
  expect(f.store.workEscalation(work)).toBe(0);
});

test("below level 7 nothing escalates", () => {
  const f = fixture(ENGINE_LEVELS.jobs);
  handOver(f, 1, "fail");
  handOver(f, 2, "fail");
  expect(f.store.workEscalation(f.turn.work_item_id!)).toBe(0);
});

function approveUnreviewed(f: Fixture, submissionId: string) {
  f.store.db.run("UPDATE submissions SET updated_at = ? WHERE id = ?", [new Date(Date.parse(isoNow()) - 60_000).toISOString(), submissionId]);
  superviseSubmissions((f.store as unknown as { ctx: never }).ctx, new Date(Date.now() + UNREVIEWED_AFTER_MS + 1_000).toISOString());
  expect(f.store.getSubmission(submissionId).state).toBe("approved");
}

test("one part approved keeps the job stepped up while another part is still failing; the ticket's approval puts it back", () => {
  const f = fixture();
  const work = f.turn.work_item_id!;
  handOver(f, 1, "fail", "shot_01.mp4");
  handOver(f, 2, "fail", "shot_01.mp4");
  expect(f.store.workEscalation(work)).toBe(1);
  approveUnreviewed(f, handOver(f, 3, "pass", "shot_02.mp4").submission.id);
  expect(f.store.workEscalation(work)).toBe(1);
  approveUnreviewed(f, handOver(f, 4, "pass", "shot_01.mp4").submission.id);
  expect(f.store.workEscalation(work)).toBe(0);
});

test("your send-back of the organizer's reading is not counted as the producer's failed hand-over", () => {
  const f = fixture();
  const work = f.turn.work_item_id!;
  const now = isoNow();
  f.store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id, model, turn_id, origin, artifacts, content, claims,
    note, state, created_at, updated_at) VALUES ('org-1', ?, ?, ?, '[]', ?, NULL, NULL, 'organizer', '[]', NULL, '[]', '', 'rejected', ?, ?)`,
    [work, f.plan.id, f.ticket.id, f.maker.id, now, now]);
  handOver(f, 1, "fail");
  expect(f.store.workEscalation(work)).toBe(0);
});

test("trouble inside turns steps a job up at most once between two of its hand-overs, and a pinned thinking level is never stepped", () => {
  const f = fixture();
  const work = f.turn.work_item_id!;
  const another = () => f.store.createTurn({ sessionId: f.turn.session_id, botId: f.maker.id,
    triggerMessageId: f.store.insertMessage({ sessionId: f.turn.session_id, kind: "system", author: f.maker.id, body: "再来" }).id, taskId: f.plan.id, ticketId: f.ticket.id });
  expect(f.store.stepUpForTrouble(f.turn.id, "malformed_tool_json")).toBe(true);
  f.store.setTurnStatus(f.turn.id, "completed");
  const second = another();
  expect(second.work_item_id).toBe(work);
  expect(f.store.stepUpForTrouble(second.id, "tool_failures")).toBe(false);
  expect(f.store.workEscalation(work)).toBe(1);
  expect(f.store.workTroubleSteps(work)).toBe(1);
  // A hand-over in between: trouble may step it once more.
  const submit = (n: number) => f.store.prepareSubmission({ turnId: second.id, origin: "submit", artifacts: [{ path: `${f.ticket.dir}/master.mp4`, sha256: `${n}`.padStart(64, "0") }] });
  submit(1);
  expect(f.store.stepUpForTrouble(second.id, "tool_failures")).toBe(true);
  expect(f.store.workTroubleSteps(work)).toBe(2);
  f.store.db.run("UPDATE bots SET thinking_level = 'low', model = 'm' WHERE id = ?", [f.maker.id]);
  submit(2);
  expect(f.store.stepUpForTrouble(second.id, "failure_shape")).toBe(false);
});

test("a step trouble inside a turn made does not start the count of failed hand-overs again", () => {
  const f = fixture();
  const work = f.turn.work_item_id!;
  handOver(f, 1, "fail");
  expect(f.store.stepUpForTrouble(f.turn.id, "malformed_tool_json")).toBe(true);
  expect(f.store.workEscalation(work)).toBe(1);
  handOver(f, 2, "fail");
  expect(f.store.workEscalation(work)).toBe(2);
});
