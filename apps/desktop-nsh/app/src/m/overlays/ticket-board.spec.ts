import { expect, test } from "bun:test";
import type { TicketStatus, TicketWithArtifacts } from "@real-bot/protocol";
import {
  BOARD_DRAG_THRESHOLD_PX,
  boardColumns,
  columnOf,
  dropStatusAt,
  enqueueMove,
  nextQueuedMove,
  passedDragThreshold,
} from "./ticket-board.ts";

function ticket(over: Partial<TicketWithArtifacts> & { id: string; seq: number; status: TicketStatus }): TicketWithArtifacts {
  return {
    task_id: "task-1",
    title: over.id,
    slug: over.id,
    dir: "work/task",
    spec: "",
    worker: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    closed_at: null,
    artifacts: [],
    ...over,
  };
}

test("five columns in status order, empty ones included, cards inside a column by seq", () => {
  const columns = boardColumns([
    ticket({ id: "c", seq: 3, status: "done" }),
    ticket({ id: "b", seq: 2, status: "todo" }),
    ticket({ id: "a", seq: 1, status: "todo" }),
  ]);
  expect(columns.map((column) => column.status)).toEqual(["todo", "doing", "review", "done", "parked"]);
  expect(columns.find((column) => column.status === "todo")!.tickets.map((row) => row.id)).toEqual(["a", "b"]);
  expect(columns.find((column) => column.status === "doing")!.tickets).toEqual([]);
  expect(columns.find((column) => column.status === "done")!.tickets.map((row) => row.id)).toEqual(["c"]);
});

test("a drop in the same column is not a move; a drop in another column is that status", () => {
  expect(dropStatusAt("todo", "todo")).toBeNull();
  expect(dropStatusAt("todo", null)).toBeNull();
  expect(dropStatusAt("todo", "doing")).toBe("doing");
});

test("3px is not a drag, 4px is, and 8px is", () => {
  expect(BOARD_DRAG_THRESHOLD_PX).toBe(4);
  expect(passedDragThreshold(3, 0)).toBe(false);
  expect(passedDragThreshold(0, 3)).toBe(false);
  expect(passedDragThreshold(4, 0)).toBe(true);
  expect(passedDragThreshold(8, 0)).toBe(true);
});

test("enqueueMove replaces one card's target and keeps the others", () => {
  const first = enqueueMove(new Map(), "a", "doing");
  const both = enqueueMove(first, "b", "review");
  const replaced = enqueueMove(both, "a", "done");
  expect([...replaced.entries()]).toEqual([["a", "done"], ["b", "review"]]);
  expect(first.get("a")).toBe("doing");
});

test("the next card to send is the lowest seq, and nothing goes while one is in flight", () => {
  const pending = enqueueMove(enqueueMove(new Map(), "b", "review"), "a", "doing");
  const tickets = [{ id: "b", seq: 2 }, { id: "a", seq: 1 }];
  expect(nextQueuedMove(pending, tickets, null)).toEqual({ id: "a", status: "doing" });
  expect(nextQueuedMove(pending, tickets, "a")).toBeNull();
  expect(nextQueuedMove(new Map([["b", "done"]]), tickets, null)).toEqual({ id: "b", status: "done" });
});

test("columnOf keeps a card in the column it is going to after the plan still says the old status", () => {
  const optimistic = new Map<string, TicketStatus>([["b", "doing"]]);
  expect(columnOf({ id: "b", status: "todo" }, optimistic)).toBe("doing");
  expect(columnOf({ id: "a", status: "todo" }, optimistic)).toBe("todo");
  const columns = boardColumns(
    [ticket({ id: "b", seq: 2, status: "todo" }), ticket({ id: "a", seq: 1, status: "todo" })],
    optimistic,
  );
  expect(columns.find((column) => column.status === "doing")!.tickets.map((row) => row.id)).toEqual(["b"]);
  expect(columns.find((column) => column.status === "todo")!.tickets.map((row) => row.id)).toEqual(["a"]);
});
