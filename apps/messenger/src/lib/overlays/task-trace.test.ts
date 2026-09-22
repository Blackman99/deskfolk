import { expect, test } from "bun:test";
import { USER_MEMBER, type TaskTrace, type TaskTraceNode } from "@real-bot/protocol";
import {
  TRACE_EDGE_LIMIT,
  filterTrace,
  traceFileIsImage,
  traceFileName,
  traceFlow,
  wokenByName,
} from "./task-trace.ts";

function node(over: Partial<TaskTraceNode> = {}): TaskTraceNode {
  return {
    turn_id: "t",
    session_id: "s",
    actor: "bot",
    status: "completed",
    woken_by_turn_id: null,
    trigger_message_id: "m",
    focus_message_id: "m",
    summary: "",
    created_at: "2026-09-22T00:00:00.000Z",
    artifacts: [],
    ask: null,
    approval: null,
    passed: 0,
    ...over,
  };
}

function trace(nodes: TaskTraceNode[]): TaskTrace {
  return { id: "task", dir: "work/x", title: "一件事", session_id: "s", closed_at: null, nodes };
}

test("a handoff reads top to bottom, and two people woken together share a stage", () => {
  const flow = traceFlow(
    trace([
      node({ turn_id: "you", actor: USER_MEMBER }),
      node({ turn_id: "a", actor: "producer", woken_by_turn_id: "you" }),
      node({ turn_id: "b", actor: "board", woken_by_turn_id: "you" }),
      node({ turn_id: "c", actor: "producer", woken_by_turn_id: "b" }),
    ]),
  );
  expect(flow.stages.map((stage) => stage.map((row) => row.turn_id))).toEqual([["you"], ["a", "b"], ["c"]]);
  expect(flow.edges).toEqual([
    { from: "you", to: "a" },
    { from: "you", to: "b" },
    { from: "b", to: "c" },
  ]);
  expect(flow.showEdges).toBe(true);
});

test("a turn whose waker is not on the board starts at the front, with no edge", () => {
  const flow = traceFlow(trace([node({ turn_id: "b", woken_by_turn_id: "missing" })]));
  expect(flow.stages.map((stage) => stage.map((row) => row.turn_id))).toEqual([["b"]]);
  expect(flow.edges).toEqual([]);
});

test("too many cards keep their edges as names instead of lines", () => {
  const nodes = Array.from({ length: TRACE_EDGE_LIMIT + 1 }, (_, i) =>
    node({ turn_id: `t${i}`, actor: i % 2 === 0 ? USER_MEMBER : "bot", woken_by_turn_id: i === 0 ? null : `t${i - 1}` }),
  );
  const flow = traceFlow(trace(nodes));
  expect(flow.showEdges).toBe(false);
  expect(flow.edges).toHaveLength(TRACE_EDGE_LIMIT);
  expect(flow.stages).toHaveLength(TRACE_EDGE_LIMIT + 1);
  const byId = new Map(nodes.map((row) => [row.turn_id, row]));
  expect(wokenByName(nodes[1]!, byId, (actor) => (actor === USER_MEMBER ? "你" : actor))).toBe("你");
  expect(wokenByName(nodes[0]!, byId, () => "你")).toBeNull();
});

test("the one filter keeps what started it, whatever is still going, and whatever handed a file over", () => {
  const nodes = [
    node({ turn_id: "you", actor: USER_MEMBER }),
    node({ turn_id: "talk", actor: "bot", status: "completed", woken_by_turn_id: "you" }),
    node({ turn_id: "live", actor: "bot", status: "running", woken_by_turn_id: "you" }),
    node({
      turn_id: "file",
      actor: "bot",
      woken_by_turn_id: "you",
      artifacts: [{ path: "a.png", message_id: "m", attachment_id: "a" }],
    }),
  ];
  expect(filterTrace(trace(nodes), true).nodes.map((row) => row.turn_id)).toEqual(["you", "live", "file"]);
  expect(filterTrace(trace(nodes), false).nodes).toHaveLength(4);
});

test("a file chip takes its name from the path and knows a picture", () => {
  expect(traceFileName("work/2026-09-22-导出-7f3k/charts/q3.png")).toBe("q3.png");
  expect(traceFileName("report.md")).toBe("report.md");
  expect(traceFileIsImage("charts/Q3.PNG")).toBe(true);
  expect(traceFileIsImage("notes.md")).toBe(false);
});
