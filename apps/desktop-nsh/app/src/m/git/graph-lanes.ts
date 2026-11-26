/**
 * Pure deterministic lane-layout engine for the commit graph (ADR 0118).
 * Computes per-row lane indices, colour slots, pass-through lines, and fork/merge curves so each
 * virtualised List row can paint its own small Canvas without reading global state.
 */
import type { GitLogCommit } from "@real-bot/protocol";

export type GraphEdge = {
  /** Column index at the top edge of this row (for incoming lines) or the commit's column. */
  fromCol: number;
  /** Column index at the bottom edge of this row (for outgoing lines) or the commit's column. */
  toCol: number;
  colorIndex: number;
  kind: "through" | "in" | "out";
};

export type GraphRowLayout = {
  commit: GitLogCommit;
  col: number;
  colorIndex: number;
  isMerge: boolean;
  isHead: boolean;
  maxCols: number;
  edges: GraphEdge[];
};

type LaneSlot = { oid: string; colorIndex: number } | null;

/**
 * Assigns each commit in topological order a lane column and the incoming/outgoing/pass-through
 * edges crossing its row. Handles linear history, branches, merges, octopus merges, and roots.
 */
export function buildCommitGraph(commits: readonly GitLogCommit[]): GraphRowLayout[] {
  const lanes: LaneSlot[] = [];
  let nextColor = 0;
  const rows: GraphRowLayout[] = [];
  let globalMaxCols = 1;

  const allocColor = () => {
    const c = nextColor;
    nextColor += 1;
    return c;
  };

  const firstEmpty = (arr: LaneSlot[]): number => {
    const idx = arr.indexOf(null);
    return idx >= 0 ? idx : arr.length;
  };

  const trimTrailingNulls = (arr: LaneSlot[]): void => {
    while (arr.length > 0 && arr[arr.length - 1] === null) arr.pop();
  };

  for (const commit of commits) {
    // 1. Find all active lanes currently expecting this commit.
    const matchingCols: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i]?.oid === commit.oid) matchingCols.push(i);
    }

    let col: number;
    let colorIndex: number;
    if (matchingCols.length > 0) {
      col = matchingCols[0]!;
      colorIndex = lanes[col]!.colorIndex;
    } else {
      col = firstEmpty(lanes);
      colorIndex = allocColor();
      lanes[col] = { oid: commit.oid, colorIndex };
    }

    const edges: GraphEdge[] = [];

    // Incoming edges from top edge of this row into the commit node.
    for (const mCol of matchingCols) {
      edges.push({
        fromCol: mCol,
        toCol: col,
        colorIndex: lanes[mCol]!.colorIndex,
        kind: "in",
      });
    }

    // Build next row's lanes.
    const nextLanes: LaneSlot[] = lanes.map((slot) => (slot ? { ...slot } : null));
    // Collapse duplicate lanes that converged on this commit.
    for (let k = 1; k < matchingCols.length; k += 1) {
      nextLanes[matchingCols[k]!] = null;
    }

    // Pass-through lanes (active lanes unrelated to this commit).
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === null || lanes[i]!.oid === commit.oid) continue;
      edges.push({ fromCol: i, toCol: i, colorIndex: lanes[i]!.colorIndex, kind: "through" });
    }

    // Outgoing edges from this commit to each of its parents.
    const parents = commit.parents;
    if (parents.length === 0) {
      nextLanes[col] = null;
    } else {
      // First parent stays in `col`, pulling any duplicate lane to the leftmost column so mainline stays anchored left.
      const firstParent = parents[0]!;
      const existingFirst = nextLanes.findIndex((s, idx) => idx !== col && s?.oid === firstParent);
      if (existingFirst >= 0 && existingFirst < col) {
        nextLanes[col] = null;
        edges.push({ fromCol: col, toCol: existingFirst, colorIndex, kind: "out" });
      } else {
        nextLanes[col] = { oid: firstParent, colorIndex };
        edges.push({ fromCol: col, toCol: col, colorIndex, kind: "out" });
      }

      // Secondary parents (merge commits) route to an existing lane tracking them or a new lane.
      for (let p = 1; p < parents.length; p += 1) {
        const parentOid = parents[p]!;
        const existing = nextLanes.findIndex((s) => s?.oid === parentOid);
        if (existing >= 0) {
          edges.push({ fromCol: col, toCol: existing, colorIndex: nextLanes[existing]!.colorIndex, kind: "out" });
        } else {
          const targetCol = firstEmpty(nextLanes);
          const pColor = allocColor();
          nextLanes[targetCol] = { oid: parentOid, colorIndex: pColor };
          edges.push({ fromCol: col, toCol: targetCol, colorIndex: pColor, kind: "out" });
        }
      }
    }

    trimTrailingNulls(nextLanes);
    const rowWidth = Math.max(col + 1, lanes.length, nextLanes.length, 1);
    if (rowWidth > globalMaxCols) globalMaxCols = rowWidth;

    rows.push({
      commit,
      col,
      colorIndex,
      isMerge: parents.length > 1,
      isHead: commit.refs.some((r) => r.kind === "head"),
      maxCols: rowWidth,
      edges,
    });

    lanes.length = 0;
    lanes.push(...nextLanes);
  }

  // Stabilise canvas column count across rows so text columns align cleanly.
  const cappedMax = Math.min(globalMaxCols, 10);
  for (const row of rows) row.maxCols = cappedMax;
  return rows;
}
