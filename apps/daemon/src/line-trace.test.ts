/**
 * The flow board's steps (ADR 0083): a job's trace carries the app's calls beside its cards, a line
 * filed under no job is a board of its own, and a step opened on the board fetches its whole answer.
 */
import { describe, expect, test } from "bun:test";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";
import { Store } from "./store";

registerLocalApiCleanup();

const ok = { outcome: "ok" as const, verdict: null };

/** Your line to Writer, its turn, and the handoff that turn made to Reviewer in a group. */
function chain(store: Store) {
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" });
  const group = store.createGroup({ name: "制作组", members: [writer.bot.id, reviewer.bot.id] });
  const line = store.postMessage(group.id, { body: "先停一下" });
  const first = store.createTurn({ sessionId: group.id, botId: writer.bot.id, triggerMessageId: line.id });
  const handoff = store.insertMessage({ sessionId: group.id, turnId: first.id, kind: "bot", author: writer.bot.id, body: "@Reviewer 你看看" });
  const second = store.createTurn({ sessionId: group.id, botId: reviewer.bot.id, triggerMessageId: handoff.id });
  const reply = store.insertMessage({ sessionId: group.id, turnId: second.id, kind: "bot", author: reviewer.bot.id, body: "看过了" });
  return { writer, reviewer, group, line, first, handoff, second, reply };
}

describe("a line's own board", () => {
  test("is the turns it woke and the ones those woke, with the calls about any of them", () => {
    const store = new Store();
    const { group, line, first, second, reply } = chain(store);
    const reading = store.recordCallRun({ role: "reader", sessionId: group.id, messageId: line.id, ...ok });
    const closing = store.recordCallRun({ role: "reader", sessionId: group.id, turnId: second.id, ...ok });
    store.recordCallRun({ role: "reader", sessionId: group.id, messageId: "another-line", ...ok });

    const board = store.lineTrace(line.id);
    expect(board).toMatchObject({ message_id: line.id, session_id: group.id });
    expect(board.nodes.map((node) => node.turn_id)).toEqual([`user:${line.id}`, first.id, second.id]);
    expect(board.nodes[2]!.woken_by_turn_id).toBe(first.id);
    expect(board.steps.map((step) => step.id)).toEqual([reading.id, closing.id]);
    // A Bot's line stands for the line of yours its turn started from.
    expect(store.lineTrace(reply.id).message_id).toBe(line.id);
    store.close();
  });

  test("a line that woke nobody is a board of its own card, with how each Bot judged it", () => {
    const store = new Store();
    const { group } = chain(store);
    const line = store.postMessage(group.id, { body: "大家早" });
    const judged = store.recordCallRun({ role: "judgement", sessionId: group.id, messageId: line.id, botId: "b",
      outcome: "ok", verdict: { kind: "judgement", decision: "pass", reason: "寒暄" } });
    const board = store.lineTrace(line.id);
    expect(board.nodes).toMatchObject([{ turn_id: `user:${line.id}`, actor: "user", summary: "大家早" }]);
    expect(board.steps.map((step) => step.id)).toEqual([judged.id]);
    store.close();
  });

  test("a job's board stays what the organizer reads: steps are beside the cards, never among them", () => {
    const store = new Store();
    const { line, first } = chain(store);
    store.recordCallRun({ role: "organizer", sessionId: null, messageId: line.id, taskId: first.task_id, ...ok });
    const trace = store.taskTrace(first.task_id!);
    expect("steps" in trace).toBe(false);
    expect(trace.nodes.every((node) => !node.turn_id.startsWith("step:"))).toBe(true);
    expect(store.boardSteps(first.task_id!, trace.nodes)).toHaveLength(1);
    store.close();
  });
});

describe("the board's steps over the local API", () => {
  test("a job's trace carries its steps without answers, a line has its own trace, and a step is fetched whole", async () => {
    const h = await startLocalApi();
    const { group, line, first } = chain(h.store);
    const run = h.store.recordCallRun({ role: "reader", sessionId: group.id, messageId: line.id, model: "haiku", outcome: "ok",
      verdict: { kind: "user_line", control: "stop", control_only: true, status_only: false, objections: [], by_words: false }, raw: '{"control":"stop"}' });

    const traced = (await (await fetch(`${h.origin}/v1/tasks/${first.task_id}/trace`, { headers: auth(h) })).json()) as { steps: Array<Record<string, unknown>> };
    expect(traced.steps).toHaveLength(1);
    expect(traced.steps[0]).toMatchObject({ id: run.id, role: "reader", message_id: line.id, verdict: { control: "stop" } });
    expect("raw" in traced.steps[0]!).toBe(false);

    const own = await fetch(`${h.origin}/v1/messages/${line.id}/trace`, { headers: auth(h) });
    expect(own.status).toBe(200);
    const board = (await own.json()) as { nodes: Array<{ turn_id: string }>; steps: Array<{ id: string }> };
    expect(board.nodes.map((node) => node.turn_id)[0]).toBe(`user:${line.id}`);
    expect(board.steps.map((step) => step.id)).toEqual([run.id]);

    const whole = await fetch(`${h.origin}/v1/call-runs/${run.id}`, { headers: auth(h) });
    expect(((await whole.json()) as { raw: string }).raw).toBe('{"control":"stop"}');
    expect((await fetch(`${h.origin}/v1/call-runs/nope`, { headers: auth(h) })).status).toBe(404);
  });
});
