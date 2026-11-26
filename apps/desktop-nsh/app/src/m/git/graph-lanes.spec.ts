import { expect, test } from "bun:test";
import type { GitLogCommit } from "@real-bot/protocol";
import { buildCommitGraph } from "./graph-lanes.ts";

function c(oid: string, parents: string[], head = false): GitLogCommit {
  return {
    oid,
    short_oid: oid.slice(0, 7),
    parents,
    author_name: "Alice",
    authored_at: "2026-11-25T10:00:00Z",
    subject: `commit ${oid}`,
    refs: head ? [{ name: "HEAD", kind: "head" }] : [],
  };
}

test("linear history stays on column 0 with a single colour", () => {
  const rows = buildCommitGraph([c("c3", ["c2"], true), c("c2", ["c1"]), c("c1", [])]);
  expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
  expect(rows[0]!.isHead).toBe(true);
  expect(rows[0]!.maxCols).toBe(1);
  expect(rows[2]!.edges.some((e) => e.kind === "out")).toBe(false);
});

test("merge commit opens a second lane and converges back on the common ancestor", () => {
  const rows = buildCommitGraph([
    c("m1", ["a2", "b1"], true),
    c("b1", ["a1"]),
    c("a2", ["a1"]),
    c("a1", []),
  ]);
  expect(rows[0]!.isMerge).toBe(true);
  expect(rows[0]!.col).toBe(0);
  // Second parent routes to lane 1.
  expect(rows[0]!.edges.some((e) => e.kind === "out" && e.fromCol === 0 && e.toCol === 1)).toBe(true);
  expect(rows[1]!.col).toBe(1);
  // b1 passes through lane 0 while sitting on lane 1.
  expect(rows[1]!.edges.some((e) => e.kind === "through" && e.fromCol === 0)).toBe(true);
  // a2 sits on lane 0 and converges onto a1.
  expect(rows[2]!.col).toBe(0);
  expect(rows[3]!.col).toBe(0);
  expect(rows[0]!.maxCols).toBe(2);
});

test("handles multiple disconnected tips (worktree / branch heads)", () => {
  const rows = buildCommitGraph([
    c("tipA", ["base"], true),
    c("tipB", ["base"]),
    c("base", []),
  ]);
  expect(rows[0]!.col).toBe(0);
  expect(rows[1]!.col).toBe(1);
  // tipB converges from lane 1 onto base's lane 0.
  expect(rows[1]!.edges.some((e) => e.kind === "out" && e.fromCol === 1 && e.toCol === 0)).toBe(true);
  expect(rows[2]!.col).toBe(0);
});
