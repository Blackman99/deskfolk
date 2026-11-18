import { USER_MEMBER, type TaskTraceNode, type Ticket, type TurnStatus } from "@real-bot/protocol";

/**
 * The tickets rail's small lanes (ADR 0086): every card of the job on one axis, in the order they
 * happened, so a ticket's row shows when work landed on it and who did it next to every other row.
 * The axis counts cards, not hours — a job runs for days with hours of nothing between bursts, and
 * on a clock it is a few slivers on an empty line — and a silence longer than `LANE_GAP_MS` is
 * folded into a gap that says how long it was.
 */
export const LANE_GAP_MS = 30 * 60_000;

/** How much room a folded gap takes, in cards. */
export const LANE_GAP_UNITS = 1.5;

/** One card on a lane. */
export type LaneMark = {
  col: number;
  turnId: string;
  actor: string;
  status: TurnStatus;
  /** Your own card: a line of yours, or a decision (an answer, 放行, 退回, a send-back to rework). */
  mine: boolean;
  sessionId: string;
  focusMessageId: string;
};

/** A silence folded before card `col`. */
export type LaneGap = { col: number; ms: number };

export type TicketLanes = {
  /** Cards on the axis. */
  cols: number;
  gaps: LaneGap[];
  /** By ticket id. A ticket with no cards has an empty list. */
  byTicket: Map<string, LaneMark[]>;
  /** Your own cards that were filed under no ticket. */
  yours: LaneMark[];
  /** Bots' cards filed under no ticket. */
  loose: LaneMark[];
  /** For each ticket, who ran its turns and how many: the division as it happened. */
  ranBy: Map<string, Map<string, number>>;
};

/** Who answers for a ticket: its owner (ADR 0045), written alongside its worker; older tickets have only the worker. */
export function ticketOwner(ticket: Pick<Ticket, "owner_bot_id" | "worker">): string | null {
  return ticket.owner_bot_id ?? ticket.worker ?? null;
}

/** A turn that was cut rather than ended: drawn as an outline. */
export function laneBroken(status: TurnStatus): boolean {
  return status === "stopped" || status === "interrupted";
}

function byTime(a: TaskTraceNode, b: TaskTraceNode): number {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

export function ticketLanes(nodes: readonly TaskTraceNode[], tickets: readonly Pick<Ticket, "id">[]): TicketLanes {
  const known = new Set(tickets.map((ticket) => ticket.id));
  const byTicket = new Map<string, LaneMark[]>(tickets.map((ticket) => [ticket.id, []]));
  const ranBy = new Map<string, Map<string, number>>(tickets.map((ticket) => [ticket.id, new Map()]));
  const yours: LaneMark[] = [];
  const loose: LaneMark[] = [];
  const gaps: LaneGap[] = [];
  const sorted = [...nodes].sort(byTime);
  let last: number | null = null;
  sorted.forEach((node, col) => {
    const at = Date.parse(node.created_at);
    if (last !== null && Number.isFinite(at) && at - last > LANE_GAP_MS) gaps.push({ col, ms: at - last });
    if (Number.isFinite(at)) last = at;
    const mine = node.actor === USER_MEMBER;
    const mark: LaneMark = {
      col,
      turnId: node.turn_id,
      actor: node.actor,
      status: node.status,
      mine,
      sessionId: node.session_id,
      focusMessageId: node.focus_message_id,
    };
    const ticket = node.ticket_id && known.has(node.ticket_id) ? node.ticket_id : null;
    if (ticket) {
      byTicket.get(ticket)!.push(mark);
      if (!mine) {
        const counts = ranBy.get(ticket)!;
        counts.set(node.actor, (counts.get(node.actor) ?? 0) + 1);
      }
    } else if (mine) yours.push(mark);
    else loose.push(mark);
  });
  return { cols: sorted.length, gaps, byTicket, yours, loose, ranBy };
}

/** Where card `col` sits along a lane, from 0 to 1, folded gaps counted in. */
export function laneX(lanes: Pick<TicketLanes, "cols" | "gaps">, col: number): number {
  const units = lanes.cols + lanes.gaps.length * LANE_GAP_UNITS;
  if (units <= 1) return 0;
  const before = lanes.gaps.filter((gap) => gap.col <= col).length;
  return (col + before * LANE_GAP_UNITS) / units;
}

/** How wide one card is along a lane, from 0 to 1. */
export function laneMarkWidth(lanes: Pick<TicketLanes, "cols" | "gaps">): number {
  const units = lanes.cols + lanes.gaps.length * LANE_GAP_UNITS;
  return units > 0 ? 1 / units : 0;
}

/** The card nearest to a point along the lane, for a press on a lane that lands between cards. */
export function nearestMark(lanes: Pick<TicketLanes, "cols" | "gaps">, marks: readonly LaneMark[], at: number): LaneMark | null {
  let best: LaneMark | null = null;
  let distance = Infinity;
  const half = laneMarkWidth(lanes) / 2;
  for (const mark of marks) {
    const d = Math.abs(laneX(lanes, mark.col) + half - at);
    if (d < distance) {
      distance = d;
      best = mark;
    }
  }
  return best;
}

/**
 * What a ticket's row says about who actually worked it, when that is not its owner alone: every
 * Bot that ran it when its owner ran none of it, the others beside the owner when it has no reviewer
 * (a reviewer working it is the division as set). Null when the record and the work agree.
 */
export function ranBesides(ticket: Pick<Ticket, "owner_bot_id" | "worker" | "reviewer_bot_id">, ran: ReadonlyMap<string, number> | undefined): { kind: "instead" | "also"; bots: string[] } | null {
  if (!ran || ran.size === 0) return null;
  const owner = ticketOwner(ticket);
  const bots = [...ran.keys()];
  if (!owner || !ran.has(owner)) return { kind: "instead", bots };
  const others = bots.filter((bot) => bot !== owner && bot !== ticket.reviewer_bot_id);
  if (others.length === 0 || ticket.reviewer_bot_id) return null;
  return { kind: "also", bots: others };
}

/** How many of a ticket's turns a Bot must have run before it is offered as the reviewer. */
export const REVIEWER_HINT_TURNS = 5;

/**
 * The Bot that has been reviewing a ticket in all but name: neither its owner nor anyone set to
 * review it, with the most of its turns (at least `REVIEWER_HINT_TURNS`). 2026-10-11: on 做《一拳超人》
 * 审片员 ran 33 of #02's 66 turns while the ticket had no reviewer and 审片员 owned nothing.
 */
export function reviewerHint(ticket: Pick<Ticket, "owner_bot_id" | "worker" | "reviewer_bot_id">, ran: ReadonlyMap<string, number> | undefined, able: ReadonlySet<string>): { bot: string; turns: number } | null {
  if (!ran || ticket.reviewer_bot_id) return null;
  const owner = ticketOwner(ticket);
  let best: { bot: string; turns: number } | null = null;
  for (const [bot, turns] of ran) {
    if (bot === owner || !able.has(bot) || turns < REVIEWER_HINT_TURNS) continue;
    if (!best || turns > best.turns) best = { bot, turns };
  }
  return best;
}

/** One Bot's line in the job's division: what is written down beside what it did. */
export type DivisionRow = {
  bot: string;
  /** Ticket numbers it owns and reviews. */
  owns: number[];
  reviews: number[];
  /** Turns it ran in this job. */
  turns: number;
  /** Of those, on a ticket someone else owns. */
  onOthers: number;
  /** Of those, filed under no ticket. */
  loose: number;
};

/**
 * The job's division of work: each Bot that owns or reviews a ticket or ran a turn in the job, the
 * busiest first, then those named on tickets who ran none (2026-10-11: on the 20-episode script job
 * 故事编剧 owned #01, #02 and #05 and ran no turn in it — owners are filled from the plan's 流程与分工
 * when the organizer opens tickets, not from who works them).
 */
export function divisionOf(nodes: readonly TaskTraceNode[], tickets: readonly Pick<Ticket, "id" | "seq" | "owner_bot_id" | "worker" | "reviewer_bot_id">[]): DivisionRow[] {
  const rows = new Map<string, DivisionRow>();
  const row = (bot: string): DivisionRow => {
    let found = rows.get(bot);
    if (!found) {
      found = { bot, owns: [], reviews: [], turns: 0, onOthers: 0, loose: 0 };
      rows.set(bot, found);
    }
    return found;
  };
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  for (const node of nodes) {
    if (node.actor === USER_MEMBER) continue;
    const entry = row(node.actor);
    entry.turns += 1;
    const ticket = node.ticket_id ? byId.get(node.ticket_id) : undefined;
    if (!ticket) entry.loose += 1;
    else if (ticketOwner(ticket) !== node.actor) entry.onOthers += 1;
  }
  for (const ticket of [...tickets].sort((a, b) => a.seq - b.seq)) {
    const owner = ticketOwner(ticket);
    if (owner && owner !== USER_MEMBER) row(owner).owns.push(ticket.seq);
    if (ticket.reviewer_bot_id) row(ticket.reviewer_bot_id).reviews.push(ticket.seq);
  }
  return [...rows.values()].sort((a, b) => b.turns - a.turns || a.bot.localeCompare(b.bot));
}
