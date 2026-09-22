import { expect, test } from "bun:test";
import { USER_MEMBER, type TaskTrace, type TaskTraceNode } from "@real-bot/protocol";
import {
  TRACE_CARD_WIDTH,
  TRACE_ZOOM_MAX,
  TRACE_ZOOM_MIN,
  clampZoom,
  filterTrace,
  fitView,
  pinchSpan,
  zoomAt,
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
    woken_elsewhere: null,
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

/** Rows, top to bottom, by the y dagre gave each card. */
function rows(flow: ReturnType<typeof traceFlow>): string[][] {
  const byRow = new Map<number, typeof flow.placements>();
  for (const placement of flow.placements) {
    const list = byRow.get(placement.y) ?? [];
    list.push(placement);
    byRow.set(placement.y, list);
  }
  return [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((a, b) => a.x - b.x).map((placement) => placement.node.turn_id));
}

test("one message waking two Bots draws as a fan, not as a queue", () => {
  // The shape the column got wrong: `a` and `b` were woken by the same line of yours, so they
  // are siblings, and `c` hangs off `a` alone rather than off whatever card sat above it.
  const flow = traceFlow(
    trace([
      node({ turn_id: "you", actor: USER_MEMBER }),
      node({ turn_id: "a", woken_by_turn_id: "you" }),
      node({ turn_id: "b", woken_by_turn_id: "you" }),
      node({ turn_id: "c", woken_by_turn_id: "a" }),
    ]),
  );
  expect(rows(flow)).toEqual([["you"], ["a", "b"], ["c"]]);
  expect(flow.edges.map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual(["a>c", "you>a", "you>b"]);
  // Siblings sit apart, and every edge is a real curve rather than a divider.
  const [a, b] = ["a", "b"].map((id) => flow.placements.find((p) => p.node.turn_id === id)!);
  expect(a.x).not.toBe(b.x);
  expect(flow.edges.every((edge) => edge.path.startsWith("M ") && edge.path.includes("C"))).toBe(true);
  expect(flow.width).toBeGreaterThan(TRACE_CARD_WIDTH);
});

test("a child sits under the card that woke it, not under whatever came before", () => {
  const flow = traceFlow(
    trace([
      node({ turn_id: "you", actor: USER_MEMBER }),
      node({ turn_id: "a", woken_by_turn_id: "you" }),
      node({ turn_id: "b", woken_by_turn_id: "you" }),
      node({ turn_id: "c", woken_by_turn_id: "b" }),
    ]),
  );
  const at = (id: string) => flow.placements.find((p) => p.node.turn_id === id)!;
  expect(Math.abs(at("c").x - at("b").x)).toBeLessThan(Math.abs(at("c").x - at("a").x));
});

test("measured cards decide the layout, so an opened file does not overlap the next row", () => {
  const nodes = [node({ turn_id: "you", actor: USER_MEMBER }), node({ turn_id: "a", woken_by_turn_id: "you" })];
  const tall = traceFlow(trace(nodes), new Map([["you", { width: TRACE_CARD_WIDTH, height: 400 }]]));
  const short = traceFlow(trace(nodes), new Map([["you", { width: TRACE_CARD_WIDTH, height: 80 }]]));
  const childY = (flow: ReturnType<typeof traceFlow>) =>
    flow.placements.find((p) => p.node.turn_id === "a")!.y;
  expect(childY(tall)).toBeGreaterThan(childY(short) + 300);
  expect(tall.height).toBeGreaterThan(short.height);
});

test("a turn woken from another job stands on its own and names who sent it", () => {
  const woken = node({
    turn_id: "b",
    woken_by_turn_id: null,
    woken_elsewhere: { actor: "bot-9", message_id: "m9" },
  });
  const flow = traceFlow(trace([woken]));
  expect(rows(flow)).toEqual([["b"]]);
  expect(flow.edges).toEqual([]);
  expect(wokenByName(woken, new Map(), (actor) => `名字:${actor}`)).toBe("名字:bot-9");
});

test("a card whose waker is missing does not invent an edge", () => {
  const flow = traceFlow(trace([node({ turn_id: "b", woken_by_turn_id: "ghost" })]));
  expect(flow.edges).toEqual([]);
  expect(rows(flow)).toEqual([["b"]]);
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

test("zoom keeps what you were reading under the pointer", () => {
  const before = { scale: 1, x: -100, y: -50 };
  const after = zoomAt(before, 2, { x: 200, y: 100 });
  expect(after.scale).toBe(2);
  // The board point under the pointer was (300, 150); at twice the size it has to stay there.
  expect(after.x).toBe(-400);
  expect(after.y).toBe(-200);
  expect(200 - after.x).toBe(300 * 2);
});

test("zoom stops before the cards are unreadable or absurd", () => {
  expect(clampZoom(0.01)).toBe(TRACE_ZOOM_MIN);
  expect(clampZoom(99)).toBe(TRACE_ZOOM_MAX);
  expect(clampZoom(Number.NaN)).toBe(1);
  expect(zoomAt({ scale: TRACE_ZOOM_MIN, x: 0, y: 0 }, 0.1, { x: 0, y: 0 }).scale).toBe(TRACE_ZOOM_MIN);
});

test("fitting centres the board, and nothing else fences it in", () => {
  const wide = fitView({ width: 1000, height: 400 }, { width: 500, height: 400 });
  expect(wide.scale).toBe(0.5);
  expect(wide.x).toBe(0);
  const small = fitView({ width: 200, height: 100 }, { width: 600, height: 400 });
  expect(small.scale).toBe(1);
  expect(small.x).toBe(200);
  expect(small.y).toBe(150);
  // Panning is unbounded: a view dragged far away is still that view, and `fit` brings it back.
  const far = zoomAt({ scale: 1, x: -9999, y: 12345 }, 1, { x: 0, y: 0 });
  expect(far.x).toBe(-9999);
  expect(far.y).toBe(12345);
});

test("a pinch is the span between two fingers, and one finger is not a pinch", () => {
  expect(pinchSpan([{ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 }])).toBe(5);
  expect(pinchSpan([{ clientX: 0, clientY: 0 }])).toBe(0);
});

test("cards never overlap, measured or not", () => {
  // The failure this guards: a reload dropped the measured heights, every card fell back to the
  // same small box, and children were laid out on top of their parents.
  const nodes = [
    node({ turn_id: "you", actor: USER_MEMBER, summary: "继续" }),
    node({
      turn_id: "a",
      woken_by_turn_id: "you",
      summary: "EP01 分镜关键帧已全量按 v2 返修要求完成独立重绘与清理，彻底废弃了六格拼图",
      artifacts: [
        { path: "a/one.md", message_id: "m1", attachment_id: "f1" },
        { path: "a/two.png", message_id: "m1", attachment_id: "f2" },
      ],
    }),
    node({ turn_id: "b", woken_by_turn_id: "a", summary: "【驳回重跑】EP01 v2 18 帧不能进动态分镜" }),
  ];
  const overlaps = (flow: ReturnType<typeof traceFlow>) => {
    const boxes = flow.placements.map((p) => ({ x: p.x, y: p.y, w: p.width, h: p.height }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        if (hit) return `${flow.placements[i]!.node.turn_id} over ${flow.placements[j]!.node.turn_id}`;
      }
    }
    return null;
  };
  // Unmeasured: the estimate has to leave room for a card with a summary and two files.
  expect(overlaps(traceFlow(trace(nodes)))).toBeNull();
  // Measured, with the tall card the screenshot showed.
  const measured = new Map([
    ["you", { width: TRACE_CARD_WIDTH, height: 110 }],
    ["a", { width: TRACE_CARD_WIDTH, height: 260 }],
    ["b", { width: TRACE_CARD_WIDTH, height: 180 }],
  ]);
  expect(overlaps(traceFlow(trace(nodes), measured))).toBeNull();
  // And a taller card pushes its child further down rather than under itself.
  const child = (boxes: Map<string, { width: number; height: number }>) =>
    traceFlow(trace(nodes), boxes).placements.find((p) => p.node.turn_id === "b")!.y;
  const taller = new Map(measured);
  taller.set("a", { width: TRACE_CARD_WIDTH, height: 460 });
  expect(child(taller)).toBeGreaterThan(child(measured) + 150);
});
