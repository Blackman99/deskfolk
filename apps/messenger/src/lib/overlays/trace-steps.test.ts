import { expect, test } from "bun:test";
import { USER_MEMBER, type TaskTrace, type TaskTraceNode, type TraceStep } from "@real-bot/protocol";
import { attachSteps, stepAnomalous } from "./trace-steps.ts";
import { traceFlow } from "./task-trace.ts";
import { copyFor } from "../copy.ts";

function node(over: Partial<TaskTraceNode> = {}): TaskTraceNode {
  return {
    turn_id: "turn-1",
    session_id: "group-1",
    actor: "bot-a",
    status: "completed",
    woken_by_turn_id: null,
    woken_elsewhere: null,
    trigger_message_id: "m1",
    focus_message_id: "m1",
    summary: "",
    created_at: "2026-10-11T10:00:00.000Z",
    artifacts: [],
    ask: null,
    approval: null,
    passed: 0,
    ticket_id: null,
    ...over,
  };
}

let seq = 0;
function step(over: Partial<TraceStep> = {}): TraceStep {
  seq += 1;
  return {
    id: `s${String(seq).padStart(3, "0")}`,
    role: "reader",
    prompt_id: "call.read_user_line",
    prompt_revision: null,
    prompt_locale: "zh",
    session_id: "group-1",
    message_id: null,
    turn_id: null,
    task_id: null,
    ticket_id: null,
    bot_id: null,
    check_run_id: null,
    provider_id: "p",
    model: "haiku",
    thinking_level: null,
    outcome: "ok",
    fail_kind: null,
    verdict: null,
    cached: false,
    spend_id: null,
    ms: 1200,
    created_at: "2026-10-11T10:00:01.000Z",
    ...over,
  };
}

const at = (seconds: number) => new Date(Date.parse("2026-10-11T10:00:00.000Z") + seconds * 1000).toISOString();

/** A group line read, filed and judged by two Bots; one joined and worked, compacting once and reading its words twice. */
function scene() {
  const line = node({ turn_id: "user:m1", actor: USER_MEMBER, created_at: at(0) });
  const turn = node({ turn_id: "turn-1", actor: "bot-a", woken_by_turn_id: "user:m1", created_at: at(5) });
  const reading = step({ message_id: "m1", created_at: at(1), verdict: { kind: "user_line", control: "none", control_only: false, status_only: false, objections: [], by_words: false } });
  const filing = step({ role: "organizer", prompt_id: "call.organizer", message_id: "m1", created_at: at(2),
    verdict: { kind: "organizer", mode: "message", decision: "continue", applied: true, reject_reason: null, organizer_run_id: "r1" } });
  const joined = step({ role: "judgement", prompt_id: "call.judgement", message_id: "m1", bot_id: "bot-a", created_at: at(3), verdict: { kind: "judgement", decision: "join", reason: null } });
  const passed = step({ role: "judgement", prompt_id: "call.judgement", message_id: "m1", bot_id: "bot-b", created_at: at(3.5), verdict: { kind: "judgement", decision: "pass", reason: "不是我的" } });
  const compacted = step({ role: "compaction", prompt_id: "call.compact", turn_id: "turn-1", created_at: at(8), verdict: { kind: "compaction", hops: 12, kept_hops: 3 } });
  const readOnce = step({ prompt_id: "call.read_bot_line", turn_id: "turn-1", created_at: at(9) });
  const readAgain = step({ prompt_id: "call.read_bot_line", turn_id: "turn-1", created_at: at(10), cached: true });
  const judged = step({ role: "judge", prompt_id: "call.seams_image", task_id: "task-1", check_run_id: "run-1", created_at: at(20),
    verdict: { kind: "judge", mode: "image", passed: false, note: "1/2" } });
  const composed = step({ role: "composer", prompt_id: "call.composer", created_at: at(30), verdict: { kind: "composer", suggestions: 3 } });
  return { line, turn, steps: { reading, filing, joined, passed, compacted, readOnce, readAgain, judged, composed } };
}

test("what was asked about your line runs down from it, and the turn it woke hangs from the Bot's judgement", () => {
  const { line, turn, steps } = scene();
  const { groups, parent } = attachSteps([line, turn], Object.values(steps));
  const id = (s: TraceStep) => `step:${s.id}`;
  expect(parent.get(id(steps.reading))).toBe("user:m1");
  expect(parent.get(id(steps.filing))).toBe(id(steps.reading));
  expect(parent.get(id(steps.joined))).toBe(id(steps.filing));
  expect(parent.get(id(steps.passed))).toBe(id(steps.filing));
  expect(parent.get("turn-1")).toBe(id(steps.joined));
  // Under the turn, one step per kind of call: its two readings are one step.
  expect(parent.get(id(steps.compacted))).toBe("turn-1");
  const readings = groups.find((group) => group.id === id(steps.readOnce))!;
  expect(readings.steps.map((s) => s.id)).toEqual([steps.readOnce.id, steps.readAgain.id]);
  expect(parent.get(id(steps.readOnce))).toBe("turn-1");
  // About the job only: under the last card before it.
  expect(parent.get(id(steps.judged))).toBe("turn-1");
  // A ✨ suggestion is about no line yet.
  expect(groups.some((group) => group.steps.includes(steps.composed))).toBe(false);
});

test("a step that went wrong or said no is what the round counts", () => {
  const { steps } = scene();
  expect(stepAnomalous(steps.judged)).toBe(true);
  expect(stepAnomalous(steps.reading)).toBe(false);
  expect(stepAnomalous(step({ outcome: "failed", fail_kind: "timeout" }))).toBe(true);
  expect(stepAnomalous(step({ role: "organizer", verdict: { kind: "organizer", mode: "message", decision: "new", applied: false, reject_reason: "x", organizer_run_id: null } }))).toBe(true);
});

test("on the board, steps are placed in their round with edges through them, and the round counts them", () => {
  const { line, turn, steps } = scene();
  const trace: TaskTrace = { id: "task-1", dir: "work/x", title: "x", session_id: "group-1", closed_at: null, nodes: [line, turn], steps: Object.values(steps) };
  const flow = traceFlow(trace);
  expect(flow.placements.map((placement) => placement.node.turn_id)).toEqual(["user:m1", "turn-1"]);
  expect(flow.steps).toHaveLength(7);
  const edges = flow.edges.map((edge) => `${edge.from}>${edge.to}`);
  expect(edges).toContain(`user:m1>step:${steps.reading.id}`);
  expect(edges).toContain(`step:${steps.joined.id}>turn-1`);
  expect(edges).not.toContain("user:m1>turn-1");
  // Steps sit below what they hang from, and nothing overlaps.
  const top = (id: string) => flow.placements.find((p) => p.node.turn_id === id)?.y ?? flow.steps.find((p) => p.group.id === id)!.y;
  expect(top(`step:${steps.reading.id}`)).toBeGreaterThan(top("user:m1"));
  expect(top("turn-1")).toBeGreaterThan(top(`step:${steps.joined.id}`));
  const boxes = [...flow.placements, ...flow.steps];
  for (const a of boxes) {
    for (const b of boxes) {
      if (a === b) continue;
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      expect(apart).toBe(true);
    }
  }
  expect(flow.rounds[0]).toMatchObject({ steps: 8, anomalies: 1 });

  // Hidden, the board is the turns as before.
  const bare = traceFlow(trace, new Map(), { showSteps: false });
  expect(bare.steps).toEqual([]);
  expect(bare.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(["user:m1>turn-1"]);
});

test("each step says what it concluded, and how a call that came to nothing ended", () => {
  const zh = copyFor("zh").traceSteps;
  const en = copyFor("en").traceSteps;
  const { steps } = scene();
  expect(zh.verdict(steps.joined.verdict!)).toBe("接下");
  expect(zh.verdict(steps.passed.verdict!)).toBe("不下场：不是我的");
  expect(zh.verdict({ kind: "user_line", control: "stop", control_only: true, status_only: false, objections: [], by_words: true })).toBe("读成：停下（按词表）");
  const nod = { kind: "user_line", control: "none", control_only: false, status_only: false, objections: [], passes: ["sub_1", "sub_2"], by_words: false } as const;
  expect(zh.verdict(nod)).toBe("读成：放行 2 份交付");
  expect(en.verdict({ ...nod, passes: ["sub_1"] })).toBe("Read as: lets 1 hand-over through");
  // A record from before passes were read says what it always said.
  expect(zh.verdict({ ...nod, passes: undefined })).toBe("读成：普通的一句");
  expect(zh.verdict(steps.compacted.verdict!)).toBe("留下 3/12 跳");
  expect(en.verdict(steps.judged.verdict!)).toBe("Failed 1/2");
  expect(zh.failed("timeout")).toBe("没成：超时");
  expect(en.failed("something_new")).toBe("Did not work: something_new");
});
