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
 *
 * A job is also a run of rounds: every line of yours starts a tree of its own. Handed to dagre as
 * one graph, those trees stood side by side, so each new line made the board wider and the order
 * of events ran left to right in one place and top to bottom in the next. Each round is laid out
 * on its own and the rounds are stacked down the board in the order they happened, the way the
 * conversation reads.
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

/** One tree of the job: the card that started it and everything it woke, as a band of the board. */
export type TraceRound = {
  /** The card the round hangs from — your line, usually. */
  root: string;
  node: TaskTraceNode;
  /** Folded, the round is its header row alone. */
  folded: boolean;
  /**
   * The row above the round: when it started, how big it got, which tickets it worked in, and the
   * fold toggle. None on a board with a single round, where it would only repeat the board.
   */
  header: { x: number; y: number; width: number; height: number } | null;
  /** The band the round takes up, header included. */
  y: number;
  height: number;
  cards: number;
  files: number;
  /** The tickets its turns worked in, in the order they first did. */
  ticketIds: string[];
  /** Something in it is still going or waiting on you. */
  live: boolean;
};

export type TraceFlow = {
  placements: TracePlacement[];
  edges: TraceEdge[];
  /** Top to bottom, in the order they started. */
  rounds: TraceRound[];
  /** The x every round's first card is centred on, so your lines read down one column. */
  spine: number;
  width: number;
  height: number;
};

export const TRACE_CARD_WIDTH = 248;
export const TRACE_CARD_FALLBACK_HEIGHT = 92;
/** Wider than a card, so a folded round has room for its line and its tickets. */
export const TRACE_ROUND_WIDTH = 320;
export const TRACE_ROUND_HEIGHT = 34;
const RANK_GAP = 56;
const NODE_GAP = 20;
/** Wider than a rank's gap, so the space between two rounds does not read as a missing edge. */
const ROUND_GAP = 44;
/** Folded rounds in a row sit close, like the lines of a list. */
const FOLDED_GAP = 8;
const HEADER_GAP = 10;
const MARGIN = 12;

/** A job's turns grouped by the line that started them, oldest round first, oldest turn first. */
export function traceRounds(nodes: readonly TaskTraceNode[]): Array<{ root: string; members: TaskTraceNode[] }> {
  const sorted = [...nodes].sort(byTime);
  const byId = new Map(sorted.map((node) => [node.turn_id, node]));
  const rootOf = new Map<string, string>();
  const findRoot = (node: TaskTraceNode): string => {
    const path: string[] = [];
    let at = node;
    let root: string | undefined;
    // A loop in the wakers cannot happen, but a board that hangs on one would be worse than wrong.
    while (root === undefined) {
      root = rootOf.get(at.turn_id);
      if (root !== undefined) break;
      path.push(at.turn_id);
      const up = wakerOn(at, byId);
      if (!up || path.includes(up)) root = at.turn_id;
      else at = byId.get(up)!;
    }
    for (const id of path) rootOf.set(id, root);
    return root;
  };
  const rounds = new Map<string, TaskTraceNode[]>();
  for (const node of sorted) {
    const root = findRoot(node);
    rounds.set(root, [...(rounds.get(root) ?? []), node]);
  }
  return [...rounds].map(([root, members]) => ({ root, members }));
}

function byTime(a: TaskTraceNode, b: TaskTraceNode): number {
  return a.created_at.localeCompare(b.created_at) || a.turn_id.localeCompare(b.turn_id);
}

/** The card that woke this one, when it is on the board and is not this card. */
function wakerOn(node: TaskTraceNode, byId: ReadonlyMap<string, TaskTraceNode>): string | null {
  const from = node.woken_by_turn_id;
  return from && from !== node.turn_id && byId.has(from) ? from : null;
}

/** When a round started: the time for today, the date as well before that. */
export function roundTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const today =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return today ? time : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

/** How many of the newest rounds stay open whatever is in them. */
export const TRACE_OPEN_ROUNDS = 2;

/**
 * The rounds a board starts with folded: all but the newest two, and never one with a turn still
 * going or a card you are looking for (`keepOpen`: the card a message asked for, the cards a ticket
 * or a highlight lights). A board with three rounds or fewer folds nothing, since a folded row
 * would save less than it hides.
 */
export function defaultFolded(
  rounds: ReadonlyArray<{ root: string; members: readonly TaskTraceNode[] }>,
  keepOpen: (node: TaskTraceNode) => boolean = () => false,
): Set<string> {
  const folded = new Set<string>();
  if (rounds.length <= TRACE_OPEN_ROUNDS + 1) return folded;
  rounds.forEach((round, index) => {
    if (index >= rounds.length - TRACE_OPEN_ROUNDS) return;
    if (round.members.some((node) => LIVE.has(node.status) || keepOpen(node))) return;
    folded.add(round.root);
  });
  return folded;
}

/**
 * Coordinates for every card and a curve for every edge.
 *
 * `boxes` is what the cards measured to on screen; anything unmeasured falls back to a sensible
 * size so the first paint is close and the second is exact. `folded` rounds are laid out as their
 * header row alone.
 */
export function traceFlow(
  trace: TaskTrace,
  boxes: ReadonlyMap<string, TraceBox> = new Map(),
  options: { folded?: ReadonlySet<string> } = {},
): TraceFlow {
  const byId = new Map(trace.nodes.map((node) => [node.turn_id, node]));
  const wakerOf = (node: TaskTraceNode) => wakerOn(node, byId);
  const grouped = traceRounds(trace.nodes);
  const headed = grouped.length > 1;
  const folded = options.folded ?? new Set<string>();

  // Each round on its own, then every round's first card on one line down the board.
  const laidRounds = grouped.map(({ root, members }) => {
    const shut = headed && folded.has(root);
    return {
      root,
      members,
      folded: shut,
      laid: shut ? null : layRound(root, members, wakerOf, boxes, trace.session_id),
    };
  });
  const half = headed ? TRACE_ROUND_WIDTH / 2 : 0;
  const left = Math.max(half, ...laidRounds.map(({ laid }) => (laid ? laid.anchor - laid.minX : 0)));
  const right = Math.max(half, ...laidRounds.map(({ laid }) => (laid ? laid.maxX - laid.anchor : 0)));
  const spine = MARGIN + left;

  const at = new Map<string, TracePlacement>();
  const bands: TraceRound[] = [];
  let top = MARGIN;
  laidRounds.forEach(({ root, members, folded: shut, laid }, index) => {
    if (index > 0) top += shut && laidRounds[index - 1]!.folded ? FOLDED_GAP : ROUND_GAP;
    const bandTop = top;
    const header = headed
      ? { x: Math.round(spine - half), y: Math.round(top), width: TRACE_ROUND_WIDTH, height: TRACE_ROUND_HEIGHT }
      : null;
    if (header) top += TRACE_ROUND_HEIGHT + (laid ? HEADER_GAP : 0);
    if (laid) {
      const dx = spine - laid.anchor;
      for (const placement of laid.placements) {
        at.set(placement.node.turn_id, {
          ...placement,
          x: Math.round(placement.x + dx),
          y: Math.round(placement.y + top),
        });
      }
      top += laid.height;
    }
    const ticketIds: string[] = [];
    for (const node of members) {
      if (node.ticket_id && !ticketIds.includes(node.ticket_id)) ticketIds.push(node.ticket_id);
    }
    bands.push({
      root,
      node: members.find((node) => node.turn_id === root) ?? members[0]!,
      folded: shut,
      header,
      y: Math.round(bandTop),
      height: Math.round(top - bandTop),
      cards: members.length,
      files: members.reduce((sum, node) => sum + node.artifacts.length, 0),
      ticketIds,
      live: members.some((node) => LIVE.has(node.status)),
    });
  });

  const edges: TraceEdge[] = [];
  for (const node of trace.nodes) {
    const from = wakerOf(node);
    const fromBox = from ? at.get(from) : undefined;
    const toBox = at.get(node.turn_id);
    if (!from || !fromBox || !toBox) continue;
    edges.push({ from, to: node.turn_id, path: edgePath(fromBox, toBox) });
  }
  const placements = trace.nodes.flatMap((node) => at.get(node.turn_id) ?? []);
  return {
    placements,
    edges,
    rounds: bands,
    spine: Math.round(spine),
    width: bands.length ? Math.round(spine + right + MARGIN) : 0,
    height: bands.length ? Math.round(top + MARGIN) : 0,
  };
}

type LaidRound = {
  root: string;
  placements: TracePlacement[];
  /** The centre of the round's first card, where it meets the spine. */
  anchor: number;
  minX: number;
  maxX: number;
  height: number;
};

/**
 * One round, laid out by dagre in the order its turns happened.
 *
 * dagre's crossing reduction reorders a rank however it likes, which is the right thing for a
 * tangled graph and the wrong thing for a round, which is a tree and has nothing to uncross:
 * two Bots woken by the same line of yours would swap places from one render to the next.
 * Putting them back in time order afterwards meant moving whole subtrees sideways, into cards
 * that were already there. With the reordering off, dagre keeps the depth-first order the cards
 * went in — children together, oldest on the left — and places them without overlap itself.
 */
function layRound(
  root: string,
  members: TaskTraceNode[],
  wakerOf: (node: TaskTraceNode) => string | null,
  boxes: ReadonlyMap<string, TraceBox>,
  home: string | null,
): LaidRound {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", ranksep: RANK_GAP, nodesep: NODE_GAP, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of members) {
    const box = boxes.get(node.turn_id);
    graph.setNode(node.turn_id, {
      width: box?.width || TRACE_CARD_WIDTH,
      height: box?.height || estimateHeight(node, home),
    });
  }
  for (const node of members) {
    const from = wakerOf(node);
    if (from) graph.setEdge(from, node.turn_id);
  }
  dagre.layout(graph, { disableOptimalOrderHeuristic: true });

  type Laid = { x: number; y: number; width: number; height: number };
  const laid = members.map((node) => ({ node, box: graph.node(node.turn_id) as Laid }));
  // dagre centres every card on its rank; a row of cards reads better sharing a top edge.
  const rankHeight = new Map<number, number>();
  for (const { box } of laid) rankHeight.set(box.y, Math.max(rankHeight.get(box.y) ?? 0, box.height));
  const placements = laid.map(({ node, box }) => ({
    node,
    x: box.x - box.width / 2,
    y: box.y - rankHeight.get(box.y)! / 2,
    width: Math.round(box.width),
    height: Math.round(box.height),
  }));
  const first = placements.find((placement) => placement.node.turn_id === root) ?? placements[0]!;
  return {
    root,
    placements,
    anchor: first.x + first.width / 2,
    minX: Math.min(...placements.map((placement) => placement.x)),
    maxX: Math.max(...placements.map((placement) => placement.x + placement.width)),
    height: Math.max(...placements.map((placement) => placement.y + placement.height)),
  };
}

/**
 * Roughly how tall a card will measure, for the frame before it has.
 *
 * A flat fallback made every unmeasured card the height of an empty one, so the first paint
 * stacked children on top of their parents — and if a measurement was ever lost, it stayed that
 * way, because a card whose size never changes never tells anyone its size again.
 */
function estimateHeight(node: TaskTraceNode, home: string | null): number {
  // A turn that said nothing shows one short line in place of the summary.
  const lines = saidNothing(node) ? 1 : Math.min(4, Math.ceil((node.summary?.length ?? 0) / 22));
  const waiting = node.ask || node.approval ? 1 : 0;
  return (
    TRACE_CARD_FALLBACK_HEIGHT -
    // Only a card from another conversation names where it happened.
    (node.session_id === home ? 18 : 0) +
    lines * 20 +
    waiting * 20 +
    (node.passed > 0 ? 18 : 0) +
    (node.route ? 32 : 0) +
    (node.artifacts.length > 0 ? 38 : 0)
  );
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

/** Below this a card's words are too small to read. */
export const TRACE_READABLE_ZOOM = 0.6;

/**
 * How a board opens: all of it while all of it can still be read, else its newest round.
 *
 * Rounds stack down the board as they happen, so a long job fitted whole is a strip of cards too
 * small to read — and the round you came to look at is the last one, at the bottom, where the
 * conversation's newest line is too. The spine stays in the middle when the board is wider than
 * the viewport, because that is where every round starts.
 */
export function openView(
  board: { width: number; height: number; spine: number },
  viewport: { width: number; height: number },
): TraceView {
  const whole = fitView(board, viewport);
  if (whole.scale >= TRACE_READABLE_ZOOM) return whole;
  const scale = clampZoom(Math.max(TRACE_READABLE_ZOOM, Math.min(1, viewport.width / (board.width || 1))));
  const width = board.width * scale;
  const height = board.height * scale;
  return {
    scale,
    x: Math.round(width <= viewport.width ? (viewport.width - width) / 2 : viewport.width / 2 - board.spine * scale),
    y: Math.round(height <= viewport.height ? (viewport.height - height) / 2 : viewport.height - height),
  };
}

/**
 * A Bot's turn that left no line of its own — moved on to a newer message, or finished without
 * speaking. The daemon then fills its summary with the line that woke it, which on the card read
 * as the Bot saying what the card above it said.
 */
export function saidNothing(node: TaskTraceNode): boolean {
  return (
    node.actor !== USER_MEMBER &&
    node.status !== "running" &&
    !node.ask &&
    !node.approval &&
    node.focus_message_id === node.trigger_message_id
  );
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
