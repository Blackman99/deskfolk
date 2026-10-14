import { describe, expect, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { Store } from ".";
import { CALL_RUN_RAW_MAX, CALL_RUNS_KEPT_PER_SESSION } from "./call-runs";

function seeded() {
  const store = new Store();
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const sessionId = writer.direct_session.id;
  const line = store.postMessage(sessionId, { body: "先停一下" });
  return { store, writer, sessionId, line };
}

describe("call runs", () => {
  test("a use of a call keeps what it was about, the prompt and model it ran with, and its verdict", () => {
    const { store, sessionId, line } = seeded();
    const run = store.recordCallRun({
      role: "reader",
      prompt: { id: "call.read_user_line", revision_id: "rev-4", locale: "zh" },
      sessionId,
      messageId: line.id,
      providerId: "p1",
      model: "haiku",
      thinkingLevel: "minimal",
      outcome: "ok",
      verdict: { kind: "user_line", control: "stop", control_only: true, status_only: false, objections: [], by_words: false },
      raw: '{"control":"stop"}',
      ms: 3120.4,
    });
    expect(run.prompt_revision).toBe("rev-4");
    expect(run.ms).toBe(3120);
    expect(store.getCallRun(run.id)).toEqual(run);
    // The flow board's steps leave the model's answer out; it is fetched when a step is opened.
    const [step] = store.traceSteps({ messageIds: [line.id], turnIds: [] });
    expect(step).toEqual({ ...(({ raw: _raw, ...rest }) => rest)(run) });
    expect("raw" in step!).toBe(false);
    store.close();
  });

  test("the model's answer is clipped, and a call made in no conversation keeps none", () => {
    const { store } = seeded();
    const run = store.recordCallRun({ role: "reflection", sessionId: "", outcome: "ok", verdict: null, raw: "x".repeat(CALL_RUN_RAW_MAX + 50) });
    expect(run.raw!.length).toBe(CALL_RUN_RAW_MAX);
    expect(run.session_id).toBeNull();
    store.close();
  });

  test("a board's steps are the job's calls and the calls about its lines and turns, oldest first, once each", () => {
    const { store, writer, sessionId, line } = seeded();
    const turn = store.createTurn({ sessionId, botId: writer.bot.id, triggerMessageId: line.id });
    const base = { sessionId, outcome: "ok" as const, verdict: null };
    const reading = store.recordCallRun({ ...base, role: "reader", messageId: line.id, now: new Date("2026-10-11T10:00:00Z") });
    const filed = store.recordCallRun({ ...base, role: "organizer", messageId: line.id, taskId: "job-1", now: new Date("2026-10-11T10:00:01Z") });
    const compacted = store.recordCallRun({ ...base, role: "compaction", turnId: turn.id, now: new Date("2026-10-11T10:00:02Z") });
    store.recordCallRun({ ...base, role: "reader", messageId: "another-line", now: new Date("2026-10-11T10:00:03Z") });
    const ids = store.traceSteps({ taskId: "job-1", messageIds: [line.id], turnIds: [turn.id] }).map((step) => step.id);
    expect(ids).toEqual([reading.id, filed.id, compacted.id]);
    store.close();
  });

  test("on a board, a reading of where your line goes names its jobs and tickets as they are called now", () => {
    const { store, sessionId, line } = seeded();
    const job = store.openTask({ sessionId, title: "宣传片" });
    const ticket = store.createTicket({ taskId: job.id, title: "剪辑", status: "doing" });
    const run = store.recordCallRun({ role: "reader", prompt: { id: "call.read_filing", revision_id: null, locale: "zh" }, sessionId, messageId: line.id,
      outcome: "ok", verdict: { kind: "filing", about: "jobs", task_ids: [job.id, "gone"], ticket_ids: [ticket.id] } });
    store.db.run("UPDATE tasks SET title = '宣传片 v2' WHERE id = ?", [job.id]);
    const [step] = store.traceSteps({ messageIds: [line.id], turnIds: [] });
    expect(step!.verdict).toEqual({ kind: "filing", about: "jobs", task_ids: [job.id, "gone"], ticket_ids: [ticket.id], titles: { [job.id]: "宣传片 v2", [ticket.id]: "剪辑" } });
    // The call's own record keeps what was read, not the names.
    expect(store.getCallRun(run.id)!.verdict).toEqual({ kind: "filing", about: "jobs", task_ids: [job.id, "gone"], ticket_ids: [ticket.id] });
    store.close();
  });

  test("each session keeps its newest runs, and deleting or clearing a session takes its runs with it", () => {
    const { store, sessionId, line } = seeded();
    const other = store.createBot({ name: "Editor", duties: "edit", boundaries: "none" }).direct_session.id;
    const at = Date.parse("2026-10-11T10:00:00Z");
    for (let i = 0; i < CALL_RUNS_KEPT_PER_SESSION + 3; i++) {
      store.recordCallRun({ role: "reader", sessionId, messageId: line.id, outcome: "ok", verdict: null, now: new Date(at + i * 1000) });
    }
    store.recordCallRun({ role: "reader", sessionId: other, outcome: "ok", verdict: null });
    const count = (id: string) => store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM call_runs WHERE session_id = ?").get(id)!.n;
    expect(count(sessionId)).toBe(CALL_RUNS_KEPT_PER_SESSION);
    store.clearSessionMessages(sessionId);
    expect(count(sessionId)).toBe(0);
    expect(count(other)).toBe(1);
    store.close();
  });

  test("a new run is published as call_run.created, without the model's answer", () => {
    const { store, sessionId, line } = seeded();
    const events: ClientEvent[] = [];
    store.onCommit((event) => events.push(event));
    const run = store.recordCallRun({ role: "judgement", sessionId, messageId: line.id, botId: "b1", outcome: "ok",
      verdict: { kind: "judgement", decision: "pass", reason: "not mine" }, raw: "secret words" });
    const published = events.filter((event) => event.event === "call_run.created");
    expect(published).toEqual([
      { event: "call_run.created", occurred_at: expect.any(String), id: run.id, role: "judgement", session_id: sessionId,
        message_id: line.id, turn_id: null, task_id: null },
    ]);
    expect(JSON.stringify(published)).not.toContain("secret words");
    store.close();
  });
});
