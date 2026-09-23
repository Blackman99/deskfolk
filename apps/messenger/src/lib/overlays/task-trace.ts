/**
 * Lays a job's trace out as the shape it actually is: a tree that branches.
 *
 * One message in a group wakes everyone who was named and everyone who judged themselves in, so a
 * stage is not a step — it is a fan-out. Each of those turns can wake others in turn. Drawing it
 * as one column going down said the opposite: that the job was a chain, and that the card above
 * yours was the one that woke you.
 *
 * The layering is dagre's, because a readable layered DAG is a solved problem and doing it by
 * hand is how the column happened. What stays ours is the card and what it says; dagre is handed
 * measured boxes and returns coordinates, nothing more.
 */
import dagre from "@dagrejs/dagre";
import { USER_MEMBER, type TaskTrace, type TaskTraceNode, type TurnStatus } from "@real-bot/protocol";

/** Stages past this stop drawing connectors and say who woke them in words. */
export const TRACE_EDGE_LIMIT = 40;

/** What a card measured to. Heights differ: a card with files open is taller. */
export type TraceBox = { width: number; height: number };

export type TracePlacement = {
  node: TaskTraceNode;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TraceEdge = {
  from: string;
  to: string;
  /** An SVG path from the bottom of the waking card to the top of the woken one. */
  path: string;
};

export type TraceFlow = {
  placements: TracePlacement[];
  edges: TraceEdge[];
  width: number;
  height: number;
};

export const TRACE_CARD_WIDTH = 248;
export const TRACE_CARD_FALLBACK_HEIGHT = 92;
const RANK_GAP = 56;
const NODE_GAP = 20;

/**
 * Coordinates for every card and a curve for every edge.
 *
 * `boxes` is what the cards measured to on screen; anything unmeasured falls back to a sensible
 * size so the first paint is close and the second is exact.
 */
export function traceFlow(trace: TaskTrace, boxes: ReadonlyMap<string, TraceBox> = new Map()): TraceFlow {
  const byId = new Map(trace.nodes.map((node) => [node.turn_id, node]));
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", ranksep: RANK_GAP, nodesep: NODE_GAP, marginx: 12, marginy: 12 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of trace.nodes) {
    const box = boxes.get(node.turn_id);
    graph.setNode(node.turn_id, {
      width: box?.width || TRACE_CARD_WIDTH,
      height: box?.height || estimateHeight(node),
    });
  }
  const links: Array<{ from: string; to: string }> = [];
  for (const node of trace.nodes) {
    const from = node.woken_by_turn_id;
    if (!from || !byId.has(from) || from === node.turn_id) continue;
    graph.setEdge(from, node.turn_id);
    links.push({ from, to: node.turn_id });
  }
  dagre.layout(graph);

  const placements: TracePlacement[] = [];
  for (const node of trace.nodes) {
    const laid = graph.node(node.turn_id) as { x: number; y: number; width: number; height: number } | undefined;
    if (!laid) continue;
    placements.push({
      node,
      // dagre centres a node on its point; the DOM positions from the corner.
      x: Math.round(laid.x - laid.width / 2),
      y: Math.round(laid.y - laid.height / 2),
      width: Math.round(laid.width),
      height: Math.round(laid.height),
    });
  }
  orderSiblingsByTime(placements);
  const at = new Map(placements.map((placement) => [placement.node.turn_id, placement]));
  const edges: TraceEdge[] = [];
  for (const link of links) {
    const from = at.get(link.from);
    const to = at.get(link.to);
    if (!from || !to) continue;
    edges.push({ ...link, path: edgePath(from, to) });
  }
  const size = graph.graph() as { width?: number; height?: number };
  return {
    placements,
    edges,
    width: Math.round(size.width ?? 0),
    height: Math.round(size.height ?? 0),
  };
}

/**
 * Roughly how tall a card will measure, for the frame before it has.
 *
 * A flat fallback made every unmeasured card the height of an empty one, so the first paint
 * stacked children on top of their parents — and if a measurement was ever lost, it stayed that
 * way, because a card whose size never changes never tells anyone its size again.
 */
function estimateHeight(node: TaskTraceNode): number {
  const lines = Math.min(4, Math.ceil((node.summary?.length ?? 0) / 22));
  const waiting = node.ask || node.approval ? 1 : 0;
  return (
    TRACE_CARD_FALLBACK_HEIGHT +
    lines * 20 +
    waiting * 20 +
    (node.passed > 0 ? 18 : 0) +
    (node.route ? 32 : 0) +
    (node.artifacts.length > 0 ? 38 : 0)
  );
}

/**
 * Left to right, in the order the turns happened.
 *
 * dagre picks an order that reduces crossings, which is the right thing to optimise and the wrong
 * thing to read: two Bots woken by the same line of yours would swap places from one render to
 * the next. Only children of the same parent are reordered, and only among the columns dagre
 * already gave them, so nothing new crosses — and moving a card moves everything it woke, or the
 * children end up under a card that did not wake them.
 */
function orderSiblingsByTime(placements: TracePlacement[]): void {
  const childrenOf = new Map<string, TracePlacement[]>();
  for (const placement of placements) {
    const parent = placement.node.woken_by_turn_id;
    if (!parent) continue;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), placement]);
  }
  const shift = (placement: TracePlacement, delta: number, seen: Set<string>): void => {
    if (delta === 0 || seen.has(placement.node.turn_id)) return;
    seen.add(placement.node.turn_id);
    placement.x += delta;
    for (const child of childrenOf.get(placement.node.turn_id) ?? []) shift(child, delta, seen);
  };

  const groups = new Map<string, TracePlacement[]>();
  for (const placement of placements) {
    const key = `${placement.y}|${placement.node.woken_by_turn_id ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), placement]);
  }
  // Top down: a rank is reordered only after everything above it has settled.
  for (const group of [...groups.values()].sort((a, b) => a[0]!.y - b[0]!.y)) {
    if (group.length < 2) continue;
    const columns = group.map((placement) => placement.x).sort((a, b) => a - b);
    const byTime = [...group].sort(
      (a, b) =>
        a.node.created_at.localeCompare(b.node.created_at) ||
        a.node.turn_id.localeCompare(b.node.turn_id),
    );
    const moves = byTime.map((placement, index) => ({ placement, delta: columns[index]! - placement.x }));
    for (const move of moves) shift(move.placement, move.delta, new Set());
  }
}

/** Bottom of the waking card to the top of the woken one, bent so a fan-out reads as a fan. */
function edgePath(from: TracePlacement, to: TracePlacement): string {
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y;
  const bend = Math.max(16, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
}

/** How far in and out the board goes. Past these the cards are either unreadable or absurd. */
export const TRACE_ZOOM_MIN = 0.35;
export const TRACE_ZOOM_MAX = 2;

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(TRACE_ZOOM_MAX, Math.max(TRACE_ZOOM_MIN, scale));
}

/** Where the board sits inside its viewport, and how big it is drawn. */
export type TraceView = { scale: number; x: number; y: number };

/** A view kept so a remounted board can slide from it. `at` is when it was left. */
type KeptView = TraceView & { at: number };

/**
 * Zooming keeps the point under the cursor — or under the middle of a pinch — where it is.
 * Scaling around the corner instead makes the board run away from whatever you were reading.
 */
export function zoomAt(view: TraceView, next: number, at: { x: number; y: number }): TraceView {
  const scale = clampZoom(next);
  if (scale === view.scale) return view;
  // The board point under the pointer has to stay under the pointer.
  const worldX = (at.x - view.x) / view.scale;
  const worldY = (at.y - view.y) / view.scale;
  return { scale, x: at.x - worldX * scale, y: at.y - worldY * scale };
}

/**
 * The view that shows the whole board, centred, never enlarged past life size.
 *
 * There is no other constraint on where the board may sit: panning is unbounded, and this is the
 * way back. Fencing the board in made a long flow feel like it was snagging on something.
 */
export function fitView(
  board: { width: number; height: number },
  viewport: { width: number; height: number },
): TraceView {
  const scale = clampZoom(
    Math.min(1, Math.min(viewport.width / (board.width || 1), viewport.height / (board.height || 1))),
  );
  return {
    scale,
    x: Math.round((viewport.width - board.width * scale) / 2),
    y: Math.round((viewport.height - board.height * scale) / 2),
  };
}

/** The message a context-menu "show this job" was opened from. */
export type TraceFocus = { messageId: string; turnId: string | null };

/**
 * How well a card is the one that message belongs to. Zero is not it.
 *
 * Your own line is the `user:<id>` card. A Bot's line is that turn's card, including an earlier
 * bubble of the same turn, the 中断 note, and the ask or approval still waiting. Matching the
 * trigger alone is last, so a line you sent does not land on the Bot it woke.
 */
export function focusRank(node: TaskTraceNode, focus: TraceFocus): number {
  const id = focus.messageId;
  if (node.focus_message_id === id || node.ask?.message_id === id || node.approval?.message_id === id) {
    return 5;
  }
  if (focus.turnId && node.actor !== USER_MEMBER && node.turn_id === focus.turnId) return 4;
  if (node.turn_id === `user:${id}`) return 4;
  if (node.artifacts.some((file) => file.message_id === id)) return 3;
  if (node.route?.record.feedback.some((note) => note.message_id === id)) return 3;
  if (node.woken_elsewhere?.message_id === id) return 2;
  if (node.trigger_message_id === id) return 1;
  return 0;
}

/** The card that message is, or null when this job has no such card. */
export function focusNode(nodes: readonly TaskTraceNode[], focus: TraceFocus): TaskTraceNode | null {
  let best: TaskTraceNode | null = null;
  let rank = 0;
  for (const node of nodes) {
    const score = focusRank(node, focus);
    if (score > rank) {
      best = node;
      rank = score;
    }
  }
  return best;
}

/**
 * The view that puts one card in the middle of the viewport, at a size you can read.
 *
 * Fitting the whole board is how a job opens from the header. A message asks for its own card,
 * and a board zoomed out to fit is a card you cannot read.
 */
export function centerOnNode(
  node: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  scale = 1,
): TraceView {
  const zoom = clampZoom(scale);
  return {
    scale: zoom,
    x: Math.round(viewport.width / 2 - (node.x + node.width / 2) * zoom),
    y: Math.round(viewport.height / 2 - (node.y + node.height / 2) * zoom),
  };
}

/**
 * A focus that arrived while the board was fitted is done once the card has been centred.
 *
 * A token that changes is a new request, including the same message asked for again. A token
 * that stays put is not: a reload of the same job must not yank the board back to the card.
 */
export function focusMoveDue(token: number, placed: number | null): boolean {
  return token > 0 && token !== placed;
}

/** How long an already-open board takes to slide to the card a message asked for. */
export const TRACE_GLIDE_MS = 320;

/**
 * Where each job's board was last left, so a tab that was unmounted can slide back from there.
 *
 * One per window: a board is one tab of a conversation, and bringing it forward mounts a new
 * copy. The key is the conversation and the job.
 */
const boardViews = new Map<string, KeptView>();

export function boardViewKey(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}

export function rememberedBoardView(sessionId: string, taskId: string | null): TraceView | undefined {
  if (!taskId) return undefined;
  return boardViews.get(boardViewKey(sessionId, taskId));
}

/** How long ago this job's board was left, or null when it has not been. */
export function boardViewAge(sessionId: string, taskId: string | null, now = Date.now()): number | null {
  if (!taskId) return null;
  const kept = boardViews.get(boardViewKey(sessionId, taskId));
  return kept ? now - kept.at : null;
}

export function rememberBoardView(sessionId: string, taskId: string, view: TraceView, now = Date.now()): void {
  boardViews.set(boardViewKey(sessionId, taskId), { scale: view.scale, x: view.x, y: view.y, at: now });
}

/** Slow at both ends, so a slide reads as a move rather than a cut. */
export function glideEase(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2;
}

/** Where the board is along a slide from one view to another. `t` is 0 to 1. */
export function glideView(from: TraceView, to: TraceView, t: number): TraceView {
  const k = glideEase(t);
  return {
    scale: from.scale + (to.scale - from.scale) * k,
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
  };
}

/** The distance between two fingers, which is all a pinch is. */
export function pinchSpan(touches: ReadonlyArray<{ clientX: number; clientY: number }>): number {
  if (touches.length < 2) return 0;
  const [a, b] = touches;
  return Math.hypot(a!.clientX - b!.clientX, a!.clientY - b!.clientY);
}

const LIVE: ReadonlySet<TurnStatus> = new Set(["running", "waiting_approval", "waiting_ask"]);

/** The one filter the board has: turns still going, and turns that handed a file over. */
export function notableNodes(nodes: readonly TaskTraceNode[]): TaskTraceNode[] {
  return nodes.filter(
    (node) => LIVE.has(node.status) || node.artifacts.length > 0 || node.woken_by_turn_id === null,
  );
}

export function filterTrace(trace: TaskTrace, notableOnly: boolean): TaskTrace {
  if (!notableOnly) return trace;
  const kept = new Set(notableNodes(trace.nodes).map((node) => node.turn_id));
  return { ...trace, nodes: trace.nodes.filter((node) => kept.has(node.turn_id)) };
}

/**
 * The two things worth finding in a job's model choices: turns you pushed back on, and turns whose
 * review put it down to the model. Lighting them rather than filtering the rest away keeps the
 * board's shape, so you still see where in the job each one sits and what it led to.
 */
export type RouteHighlight = "feedback" | "blamed";

export function drewFeedback(node: TaskTraceNode): boolean {
  return (node.route?.record.feedback.length ?? 0) > 0;
}

export function blamedTheModel(node: TaskTraceNode): boolean {
  return node.route?.review?.fault === "model";
}

export function routeHighlightCounts(nodes: readonly TaskTraceNode[]): Record<RouteHighlight, number> {
  return {
    feedback: nodes.filter(drewFeedback).length,
    blamed: nodes.filter(blamedTheModel).length,
  };
}

/** Whether a card is lit, dimmed, or neither because nothing is being looked for. */
export function highlightOf(node: TaskTraceNode, highlight: RouteHighlight | null): "lit" | "dim" | null {
  if (!highlight) return null;
  const hit = highlight === "feedback" ? drewFeedback(node) : blamedTheModel(node);
  return hit ? "lit" : "dim";
}

/** Who a card says woke it, once the connectors are gone. */
export function wokenByName(
  node: TaskTraceNode,
  byId: ReadonlyMap<string, TaskTraceNode>,
  nameOf: (actor: string) => string,
): string | null {
  // A handoff from another job has no card here; the card still says who sent it.
  if (node.woken_elsewhere) return nameOf(node.woken_elsewhere.actor);
  if (!node.woken_by_turn_id) return null;
  const from = byId.get(node.woken_by_turn_id);
  return from ? nameOf(from.actor) : null;
}

const RASTER = /\.(png|jpe?g|gif|webp|svg)$/i;

export function traceFileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function traceFileIsImage(path: string): boolean {
  return RASTER.test(traceFileName(path));
}
