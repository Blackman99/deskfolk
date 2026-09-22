/**
 * Lays a job's trace out as a flow: one row per stage, top to bottom.
 *
 * A stage is one round of the handoff. Your opening line is the first column; every turn it woke
 * sits beside it; every turn those woke sits one column further on. Two people woken by the same
 * turn share a column, so the picture reads as what happened next rather than as a roster.
 * A card with no waking turn on the board starts its own column at the front.
 */
import type { TaskTrace, TaskTraceNode, TurnStatus } from "@real-bot/protocol";

/** Stages past this stop drawing connectors and say who woke them in words. */
export const TRACE_EDGE_LIMIT = 40;

export type TraceEdge = {
  from: string;
  to: string;
};

export type TraceFlow = {
  /** Rows, earliest stage first. */
  stages: TaskTraceNode[][];
  nodes: TaskTraceNode[];
  edges: TraceEdge[];
  /** False once there are too many cards for connectors to stay readable. */
  showEdges: boolean;
};

export function traceFlow(trace: TaskTrace): TraceFlow {
  const byId = new Map(trace.nodes.map((node) => [node.turn_id, node]));
  const depth = new Map<string, number>();

  function depthOf(id: string, seen: Set<string>): number {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = byId.get(id);
    const from = node?.woken_by_turn_id;
    const value = from && byId.has(from) ? depthOf(from, seen) + 1 : 0;
    depth.set(id, value);
    return value;
  }
  for (const node of trace.nodes) depthOf(node.turn_id, new Set());

  const stages: TaskTraceNode[][] = [];
  for (const node of trace.nodes) {
    const at = depth.get(node.turn_id) ?? 0;
    (stages[at] ??= []).push(node);
  }
  const edges = trace.nodes
    .filter((node) => node.woken_by_turn_id && byId.has(node.woken_by_turn_id))
    .map((node) => ({ from: node.woken_by_turn_id!, to: node.turn_id }));
  return {
    stages: stages.filter((stage) => stage.length > 0),
    nodes: trace.nodes,
    edges,
    showEdges: trace.nodes.length <= TRACE_EDGE_LIMIT,
  };
}

const LIVE: ReadonlySet<TurnStatus> = new Set(["running", "waiting_approval", "waiting_ask"]);

/** The one filter the board has: turns still going, and turns that handed a file over. */
export function notableNodes(nodes: readonly TaskTraceNode[]): TaskTraceNode[] {
  return nodes.filter((node) => LIVE.has(node.status) || node.artifacts.length > 0 || node.woken_by_turn_id === null);
}

export function filterTrace(trace: TaskTrace, notableOnly: boolean): TaskTrace {
  if (!notableOnly) return trace;
  const kept = new Set(notableNodes(trace.nodes).map((node) => node.turn_id));
  return { ...trace, nodes: trace.nodes.filter((node) => kept.has(node.turn_id)) };
}

/** Who a card says woke it, once the connectors are gone. */
export function wokenByName(
  node: TaskTraceNode,
  byId: ReadonlyMap<string, TaskTraceNode>,
  nameOf: (actor: string) => string,
): string | null {
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
