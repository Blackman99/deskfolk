import { expect, test } from "bun:test";
import { USER_MEMBER, type TaskTraceNode, type Ticket } from "@real-bot/protocol";
import { LANE_GAP_MS, divisionOf, laneX, nearestMark, ranBesides, reviewerHint, ticketLanes, ticketOwner } from "./ticket-lanes.ts";

const t0 = Date.parse("2026-09-29T13:00:00.000Z");

function card(turn: string, actor: string, ticket: string | null, minutes: number, status: TaskTraceNode["status"] = "completed"): TaskTraceNode {
  return {
    turn_id: turn, session_id: "group-1", actor, status, woken_by_turn_id: null, woken_elsewhere: null, trigger_message_id: `m-${turn}`,
    focus_message_id: `f-${turn}`, summary: "", created_at: new Date(t0 + minutes * 60_000).toISOString(), artifacts: [], ask: null, approval: null,
    passed: 0, ticket_id: ticket,
  };
}

function ticket(id: string, seq: number, over: Partial<Ticket> = {}): Ticket {
  return {
    id, task_id: "task-1", seq, title: id, slug: id, dir: `work/${id}`, spec: "", status: "doing", worker: null,
    created_at: "2026-09-29T00:00:00.000Z", updated_at: "2026-09-29T00:00:00.000Z", closed_at: null, ...over,
  };
}

test("every card is a column on one axis, in the order it happened; a long silence is folded and said", () => {
  const lanes = ticketLanes(
    [card("c", "bot-2", "tk-1", 50), card("a", USER_MEMBER, null, 0), card("b", "bot-1", "tk-1", 5), card("d", "bot-1", null, 52, "stopped")],
    [ticket("tk-1", 1), ticket("tk-2", 2)],
  );
  expect(lanes.cols).toBe(4);
  expect(lanes.byTicket.get("tk-1")!.map((mark) => [mark.turnId, mark.col])).toEqual([["b", 1], ["c", 2]]);
  expect(lanes.byTicket.get("tk-2")).toEqual([]);
  expect(lanes.yours.map((mark) => mark.turnId)).toEqual(["a"]);
  expect(lanes.loose.map((mark) => [mark.turnId, mark.status])).toEqual([["d", "stopped"]]);
  // 45 minutes between b and c is folded before c, and says how long it was.
  expect(lanes.gaps).toEqual([{ col: 2, ms: 45 * 60_000 }]);
  expect(LANE_GAP_MS).toBe(30 * 60_000);
  // A folded gap takes room on the lane: c sits further along than its column alone.
  expect(laneX(lanes, 2)).toBeGreaterThan(2 / 4);
  expect(laneX(lanes, 0)).toBe(0);
  expect(lanes.ranBy.get("tk-1")).toEqual(new Map([["bot-1", 1], ["bot-2", 1]]));
});

test("a press on a lane lands on the nearest card of that lane", () => {
  const lanes = ticketLanes([card("a", "bot-1", "tk-1", 0), card("b", "bot-1", "tk-2", 1), card("c", "bot-1", "tk-1", 2)], [ticket("tk-1", 1), ticket("tk-2", 2)]);
  const marks = lanes.byTicket.get("tk-1")!;
  expect(nearestMark(lanes, marks, 0.05)?.turnId).toBe("a");
  expect(nearestMark(lanes, marks, 0.9)?.turnId).toBe("c");
  // Between them, but nearer c; b is not this lane's.
  expect(nearestMark(lanes, marks, 0.6)?.turnId).toBe("c");
  expect(nearestMark(lanes, [], 0.5)).toBeNull();
});

/**
 * The shape of 做《一拳超人》动画 on 2026-10-11: 视频导演 owns #02 and #03, 故事编剧 owns #01, and
 * 审片员 owns nothing but reviews #02 turn after turn, with no reviewer set.
 */
function onePunch() {
  const tickets = [ticket("tk-1", 1, { owner_bot_id: "writer" }), ticket("tk-2", 2, { owner_bot_id: "director" }), ticket("tk-3", 3, { owner_bot_id: "director" })];
  const nodes: TaskTraceNode[] = [card("you", USER_MEMBER, null, 0)];
  for (let i = 0; i < 33; i += 1) {
    nodes.push(card(`d${i}`, "director", "tk-2", 1 + i * 2));
    nodes.push(card(`r${i}`, "reviewer", "tk-2", 2 + i * 2));
  }
  nodes.push(card("r-loose-1", "reviewer", null, 80), card("r-loose-2", "reviewer", null, 81), card("d-loose", "director", null, 82));
  return { tickets, nodes };
}

test("the division says who owns and reviews what beside who ran it, the busiest first", () => {
  const { tickets, nodes } = onePunch();
  expect(divisionOf(nodes, tickets)).toEqual([
    { bot: "reviewer", owns: [], reviews: [], turns: 35, onOthers: 33, loose: 2 },
    { bot: "director", owns: [2, 3], reviews: [], turns: 34, onOthers: 0, loose: 1 },
    { bot: "writer", owns: [1], reviews: [], turns: 0, onOthers: 0, loose: 0 },
  ]);
});

test("a ticket's row says who else worked it, and the inspector offers the one reviewing it in all but name", () => {
  const { tickets, nodes } = onePunch();
  const lanes = ticketLanes(nodes, tickets);
  const two = tickets[1]!;
  expect(ranBesides(two, lanes.ranBy.get("tk-2"))).toEqual({ kind: "also", bots: ["reviewer"] });
  expect(reviewerHint(two, lanes.ranBy.get("tk-2"), new Set(["reviewer", "writer"]))).toEqual({ bot: "reviewer", turns: 33 });
  // Only a Bot that may review it; never when a reviewer is set; never its owner.
  expect(reviewerHint(two, lanes.ranBy.get("tk-2"), new Set(["writer"]))).toBeNull();
  expect(reviewerHint({ ...two, reviewer_bot_id: "writer" }, lanes.ranBy.get("tk-2"), new Set(["reviewer"]))).toBeNull();
  expect(ranBesides({ ...two, reviewer_bot_id: "reviewer" }, lanes.ranBy.get("tk-2"))).toBeNull();
  // #01's owner ran none of it, and nobody else did either: nothing to say.
  expect(ranBesides(tickets[0]!, lanes.ranBy.get("tk-1"))).toBeNull();
  // A ticket worked only by others than its owner says who did it instead.
  expect(ranBesides(tickets[0]!, new Map([["director", 4]]))).toEqual({ kind: "instead", bots: ["director"] });
  // Fewer than five turns is not reviewing it in all but name.
  expect(reviewerHint(two, new Map([["reviewer", 4]]), new Set(["reviewer"]))).toBeNull();
});

test("a ticket's owner is its owner_bot_id, and its worker where an older ticket has none", () => {
  expect(ticketOwner({ owner_bot_id: "a", worker: "b" })).toBe("a");
  expect(ticketOwner({ owner_bot_id: null, worker: "b" })).toBe("b");
  expect(ticketOwner({ worker: null })).toBeNull();
});
