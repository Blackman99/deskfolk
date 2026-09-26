import { expect, test } from "bun:test";
import { USER_MEMBER, type TaskTrace, type TaskTraceNode } from "@real-bot/protocol";
import {
  TRACE_CARD_WIDTH,
  TRACE_GLIDE_MS,
  TRACE_ZOOM_MAX,
  TRACE_ZOOM_MIN,
  centerOnNode,
  clampZoom,
  filterTrace,
  fitView,
  focusMoveDue,
  focusNode,
  glideEase,
  glideView,
  defaultFolded,
  openView,
  roundTime,
  traceRounds,
  TRACE_ROUND_HEIGHT,
  pinchSpan,
  saidNothing,
  TRACE_READABLE_ZOOM,
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

test("centring a card puts its middle in the middle of the viewport", () => {
  const card = { x: 400, y: 800, width: 248, height: 120 };
  const view = centerOnNode(card, { width: 600, height: 400 });
  expect(view.scale).toBe(1);
  expect(view.x + (card.x + card.width / 2) * view.scale).toBe(300);
  expect(view.y + (card.y + card.height / 2) * view.scale).toBe(200);
  // A size past the stops is the stop, and the card is still the thing in the middle.
  const small = centerOnNode(card, { width: 600, height: 400 }, 0.01);
  expect(small.scale).toBe(TRACE_ZOOM_MIN);
  expect(small.x + (card.x + card.width / 2) * small.scale).toBeCloseTo(300, 0);
});

test("a message lands on its own card, and a line you sent does not land on the Bot it woke", () => {
  const nodes = [
    node({ turn_id: "user:m1", actor: USER_MEMBER, trigger_message_id: "m1", focus_message_id: "m1" }),
    node({
      turn_id: "turn-a",
      woken_by_turn_id: "user:m1",
      trigger_message_id: "m1",
      focus_message_id: "m2",
      artifacts: [{ path: "a.png", message_id: "m2", attachment_id: "a" }],
    }),
  ];
  expect(focusNode(nodes, { messageId: "m1", turnId: null })?.turn_id).toBe("user:m1");
  // An earlier bubble of the same turn is still that turn's card.
  expect(focusNode(nodes, { messageId: "m-earlier", turnId: "turn-a" })?.turn_id).toBe("turn-a");
  expect(focusNode(nodes, { messageId: "m2", turnId: "turn-a" })?.turn_id).toBe("turn-a");
  expect(focusNode(nodes, { messageId: "gone", turnId: null })).toBeNull();
});

test("a slide starts where the board is, eases, and ends on the card", () => {
  const from = { scale: 0.5, x: 0, y: 0 };
  const to = { scale: 1, x: -200, y: -400 };
  expect(TRACE_GLIDE_MS).toBeGreaterThan(0);
  expect(glideView(from, to, 0)).toEqual(from);
  expect(glideView(from, to, 1)).toEqual(to);
  const mid = glideView(from, to, 0.5);
  expect(mid.x).toBe(-100);
  expect(mid.scale).toBe(0.75);
  // Slow at both ends: the first step is shorter than the one through the middle.
  expect(glideEase(0.1) - glideEase(0)).toBeLessThan(glideEase(0.5) - glideEase(0.4));
});

test("the same message asked for again is a new move, and a reload of it is not", () => {
  expect(focusMoveDue(0, null)).toBe(false);
  expect(focusMoveDue(1, null)).toBe(true);
  expect(focusMoveDue(1, 1)).toBe(false);
  expect(focusMoveDue(2, 1)).toBe(true);
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

/** Every pair of cards that share any area, as `a over b`. */
function overlapping(flow: ReturnType<typeof traceFlow>): string[] {
  const hits: string[] = [];
  const all = flow.placements;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        hits.push(`${a.node.turn_id} over ${b.node.turn_id}`);
      }
    }
  }
  return hits;
}

test("siblings stand oldest first without pushing anyone's subtree into another's cards", () => {
  // The screenshot's collision: siblings were put back in time order after dagre had placed them,
  // by sliding each one's whole subtree sideways — onto the cards of a cousin that stayed put.
  // Whatever order the trace lists the turns in and whenever each was woken, nothing overlaps.
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 200; round++) {
    const nodes: TaskTraceNode[] = [];
    const count = 4 + Math.floor(next() * 36);
    for (let i = 0; i < count; i++) {
      const second = String(Math.floor(next() * 3000)).padStart(4, "0");
      nodes.push(
        node({
          turn_id: `n${i}`,
          actor: i === 0 || next() < 0.08 ? USER_MEMBER : "bot",
          woken_by_turn_id: i === 0 || next() < 0.08 ? null : `n${Math.floor(next() * i)}`,
          created_at: `2026-09-22T00:00:00.${second}Z`,
          summary: "字".repeat(Math.floor(next() * 90)),
        }),
      );
    }
    const measured = new Map(nodes.map((row) => [row.turn_id, { width: TRACE_CARD_WIDTH, height: 90 + Math.floor(next() * 220) }]));
    expect(overlapping(traceFlow(trace(nodes), measured))).toEqual([]);
    expect(overlapping(traceFlow(trace(nodes)))).toEqual([]);
  }
});

test("siblings read left to right in the order they were woken, whatever order the trace lists them", () => {
  const flow = traceFlow(
    trace([
      node({ turn_id: "you", actor: USER_MEMBER, created_at: "2026-09-22T00:00:00.000Z" }),
      node({ turn_id: "late", woken_by_turn_id: "you", created_at: "2026-09-22T00:00:03.000Z" }),
      node({ turn_id: "first", woken_by_turn_id: "you", created_at: "2026-09-22T00:00:01.000Z" }),
      node({ turn_id: "second", woken_by_turn_id: "you", created_at: "2026-09-22T00:00:02.000Z" }),
      // The first sibling's child is wide enough to matter, and still stays under its own parent.
      node({ turn_id: "first-a", woken_by_turn_id: "first", created_at: "2026-09-22T00:00:04.000Z" }),
      node({ turn_id: "first-b", woken_by_turn_id: "first", created_at: "2026-09-22T00:00:05.000Z" }),
    ]),
  );
  expect(rows(flow)).toEqual([["you"], ["first", "second", "late"], ["first-a", "first-b"]]);
  const at = (id: string) => flow.placements.find((p) => p.node.turn_id === id)!;
  expect(at("first-b").x).toBeLessThan(at("second").x + TRACE_CARD_WIDTH);
});

test("each line of yours starts a round below the last one, and every round starts on one spine", () => {
  // Handed over as one graph, two lines of yours stood side by side: every new line widened the
  // board, and the job read left to right in one place and top to bottom in the next.
  const flow = traceFlow(
    trace([
      node({ turn_id: "you-1", actor: USER_MEMBER, created_at: "2026-09-22T00:00:00.000Z" }),
      node({ turn_id: "a", woken_by_turn_id: "you-1", created_at: "2026-09-22T00:00:01.000Z" }),
      node({ turn_id: "b", woken_by_turn_id: "you-1", created_at: "2026-09-22T00:00:02.000Z" }),
      node({ turn_id: "c", woken_by_turn_id: "a", created_at: "2026-09-22T00:00:03.000Z" }),
      node({ turn_id: "you-2", actor: USER_MEMBER, created_at: "2026-09-22T00:01:00.000Z" }),
      node({ turn_id: "d", woken_by_turn_id: "you-2", created_at: "2026-09-22T00:01:01.000Z" }),
      // A handoff from another job has no waker here, so it is a round of its own, in its turn.
      node({
        turn_id: "handoff",
        woken_elsewhere: { actor: "bot-9", message_id: "m9" },
        created_at: "2026-09-22T00:00:30.000Z",
      }),
    ]),
  );
  expect(flow.rounds.map((round) => round.root)).toEqual(["you-1", "handoff", "you-2"]);
  const at = (id: string) => flow.placements.find((p) => p.node.turn_id === id)!;
  const bottom = (ids: string[]) => Math.max(...ids.map((id) => at(id).y + at(id).height));
  expect(at("handoff").y).toBeGreaterThan(bottom(["you-1", "a", "b", "c"]));
  expect(at("you-2").y).toBeGreaterThan(bottom(["handoff"]));
  for (const root of ["you-1", "handoff", "you-2"]) expect(at(root).x + at(root).width / 2).toBe(flow.spine);
  // As wide as the widest round, not as wide as all of them together.
  expect(flow.width).toBeLessThan(3 * TRACE_CARD_WIDTH + 80);
  expect(flow.edges.map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual(["a>c", "you-1>a", "you-1>b", "you-2>d"]);
});

test("cards on one rank share a top edge, however tall each one is", () => {
  const nodes = [
    node({ turn_id: "you", actor: USER_MEMBER }),
    node({ turn_id: "a", woken_by_turn_id: "you" }),
    node({ turn_id: "b", woken_by_turn_id: "you" }),
  ];
  const flow = traceFlow(
    trace(nodes),
    new Map([
      ["a", { width: TRACE_CARD_WIDTH, height: 320 }],
      ["b", { width: TRACE_CARD_WIDTH, height: 120 }],
    ]),
  );
  const at = (id: string) => flow.placements.find((p) => p.node.turn_id === id)!;
  expect(at("a").y).toBe(at("b").y);
});

test("a board opens whole while it can be read, and on its newest round once it cannot", () => {
  const viewport = { width: 800, height: 600 };
  // Small enough to read whole: the same as fitting.
  const small = { width: 600, height: 500, spine: 300 };
  expect(openView(small, viewport)).toEqual(fitView(small, viewport));
  // A long job: readable size, spine centred, the bottom of the board on the bottom of the view.
  const tall = { width: 520, height: 6000, spine: 136 };
  const opened = openView(tall, viewport);
  expect(opened.scale).toBe(1);
  expect(opened.x).toBe(Math.round((800 - 520) / 2));
  expect(opened.y + tall.height * opened.scale).toBe(600);
  // Too wide as well: never below a readable size, and the spine is what stays in view.
  const wide = { width: 4000, height: 6000, spine: 1800 };
  const both = openView(wide, viewport);
  expect(both.scale).toBe(TRACE_READABLE_ZOOM);
  expect(both.x + wide.spine * both.scale).toBe(400);
});

test("a Bot's turn that left no line of its own says so instead of repeating the line that woke it", () => {
  const woke = { trigger_message_id: "m-trigger", focus_message_id: "m-trigger" };
  expect(saidNothing(node({ ...woke, status: "redirected" }))).toBe(true);
  expect(saidNothing(node({ ...woke, status: "completed" }))).toBe(true);
  // It said something; it is still going; it is waiting on you; it is you.
  expect(saidNothing(node({ trigger_message_id: "m-trigger", focus_message_id: "m-word" }))).toBe(false);
  expect(saidNothing(node({ ...woke, status: "running" }))).toBe(false);
  expect(saidNothing(node({ ...woke, status: "waiting_ask", ask: { message_id: "m-trigger", question: "?" } }))).toBe(false);
  expect(saidNothing(node({ ...woke, actor: USER_MEMBER }))).toBe(false);
});

/** Rounds of one line of yours and one Bot answering it, a minute apart. */
function chatty(count: number, over: (index: number) => Partial<TaskTraceNode> = () => ({})): TaskTraceNode[] {
  return Array.from({ length: count }, (_, index) => {
    const minute = String(index).padStart(2, "0");
    return [
      node({ turn_id: `you-${index}`, actor: USER_MEMBER, created_at: `2026-09-22T00:${minute}:00.000Z`, summary: `第 ${index} 句` }),
      node({ turn_id: `bot-${index}`, woken_by_turn_id: `you-${index}`, created_at: `2026-09-22T00:${minute}:30.000Z`, ...over(index) }),
    ];
  }).flat();
}

test("a folded round is its line alone, and folded lines stack close like a list", () => {
  const nodes = chatty(5);
  const open = traceFlow(trace(nodes));
  const folded = traceFlow(trace(nodes), new Map(), { folded: new Set(["you-0", "you-1", "you-2"]) });
  const ids = folded.placements.map((p) => p.node.turn_id);
  expect(ids).toEqual(["you-3", "bot-3", "you-4", "bot-4"]);
  expect(folded.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(["you-3>bot-3", "you-4>bot-4"]);
  const [a, b, c, d] = folded.rounds;
  expect([a, b, c, d].map((round) => round!.folded)).toEqual([true, true, true, false]);
  // Two folded lines in a row are a few pixels apart; an open round keeps its distance.
  expect(b!.header!.y - (a!.header!.y + TRACE_ROUND_HEIGHT)).toBeLessThan(12);
  expect(d!.header!.y - (c!.header!.y + TRACE_ROUND_HEIGHT)).toBeGreaterThan(30);
  // Every line and every round's first card sit on the spine.
  for (const round of folded.rounds) expect(round.header!.x + round.header!.width / 2).toBe(folded.spine);
  expect(folded.height).toBeLessThan(open.height / 2);
  // A round's line knows what it stands for.
  expect(a).toMatchObject({ root: "you-0", cards: 2, files: 0, live: false });
  expect(a!.node.summary).toBe("第 0 句");
});

test("a board of one round has no round lines, and folding it does nothing", () => {
  const nodes = chatty(1);
  const flow = traceFlow(trace(nodes), new Map(), { folded: new Set(["you-0"]) });
  expect(flow.rounds).toHaveLength(1);
  expect(flow.rounds[0]!.header).toBeNull();
  expect(flow.placements).toHaveLength(2);
});

test("a round's line lists the tickets its turns worked in, and says when something is still going", () => {
  const nodes = [
    node({ turn_id: "you", actor: USER_MEMBER, created_at: "2026-09-22T00:00:00.000Z" }),
    node({ turn_id: "a", woken_by_turn_id: "you", ticket_id: "t2", created_at: "2026-09-22T00:00:01.000Z" }),
    node({ turn_id: "b", woken_by_turn_id: "you", ticket_id: "t1", created_at: "2026-09-22T00:00:02.000Z" }),
    node({
      turn_id: "c",
      woken_by_turn_id: "a",
      ticket_id: "t2",
      status: "running",
      created_at: "2026-09-22T00:00:03.000Z",
      artifacts: [{ path: "x.png", message_id: "m", attachment_id: "f" }],
    }),
    node({ turn_id: "you-2", actor: USER_MEMBER, created_at: "2026-09-22T00:01:00.000Z" }),
  ];
  const [first, second] = traceFlow(trace(nodes)).rounds;
  expect(first).toMatchObject({ ticketIds: ["t2", "t1"], live: true, cards: 4, files: 1 });
  expect(second).toMatchObject({ ticketIds: [], live: false, cards: 1 });
});

test("a long job folds all but its newest rounds, and never what is still going or what you asked for", () => {
  // Three rounds or fewer: nothing is worth folding.
  expect([...defaultFolded(traceRounds(chatty(3)))]).toEqual([]);
  expect([...defaultFolded(traceRounds(chatty(6)))]).toEqual(["you-0", "you-1", "you-2", "you-3"]);
  // Round 1 has a turn still running; round 2 holds the card a message asked for.
  const nodes = chatty(6, (index) => (index === 1 ? { status: "running" } : {}));
  const asked = "bot-2";
  expect([...defaultFolded(traceRounds(nodes), (row) => row.turn_id === asked)]).toEqual(["you-0", "you-3"]);
});

test("a round's time is the clock for today and carries the date before that", () => {
  const now = new Date(2026, 8, 25, 18, 0);
  expect(roundTime(new Date(2026, 8, 25, 9, 5).toISOString(), now)).toBe("09:05");
  expect(roundTime(new Date(2026, 8, 24, 21, 30).toISOString(), now)).toBe("09-24 21:30");
  expect(roundTime("not a time", now)).toBe("");
});
