/**
 * Pure helpers for the ticket board: which column a card sits in, and the queue of status moves.
 *
 * Nothing here touches the DOM. `TicketList.svelte` draws from `boardColumns`; the drag only
 * asks `dropStatusAt` and `passedDragThreshold`, then `enqueueMove`.
 */
import { TICKET_STATUS_ORDER } from "./plan-board.ts";
import type { TicketStatus, TicketWithArtifacts } from "@real-bot/protocol";

/** A press has to travel this far before it is a drag rather than a click on the card. */
export const BOARD_DRAG_THRESHOLD_PX = 4;

/** One column of the board, in `TICKET_STATUS_ORDER`, empty ones included. */
export type BoardColumn = {
  status: TicketStatus;
  tickets: TicketWithArtifacts[];
};

/**
 * Where a card is drawn: the status a move already asked for, else the one the plan says.
 * A reload that still has the old status does not pull a card back out of the column it is going to.
 */
export function columnOf(
  ticket: { id: string; status: TicketStatus },
  optimistic: ReadonlyMap<string, TicketStatus>,
): TicketStatus {
  return optimistic.get(ticket.id) ?? ticket.status;
}

/** Five columns, todo to parked. Inside a column, cards stay in `seq` order. */
export function boardColumns(
  tickets: readonly TicketWithArtifacts[],
  optimistic: ReadonlyMap<string, TicketStatus> = new Map(),
): BoardColumn[] {
  const byStatus = new Map<TicketStatus, TicketWithArtifacts[]>();
  for (const status of TICKET_STATUS_ORDER) byStatus.set(status, []);
  const ordered = [...tickets].sort((a, b) => a.seq - b.seq);
  for (const ticket of ordered) {
    const status = columnOf(ticket, optimistic);
    (byStatus.get(status) ?? byStatus.get("todo")!).push(ticket);
  }
  return TICKET_STATUS_ORDER.map((status) => ({ status, tickets: byStatus.get(status)! }));
}

/** The column a drop lands in, or null when it is the column the card already sits in. */
export function dropStatusAt(from: TicketStatus, over: TicketStatus | null): TicketStatus | null {
  if (!over || over === from) return null;
  return over;
}

/** Whether the pointer has moved far enough to mean a drag. */
export function passedDragThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= BOARD_DRAG_THRESHOLD_PX;
}

/**
 * Remember where a card should go. A later move of the same card replaces the earlier one;
 * every other card stays. The map is copied, never changed in place.
 */
export function enqueueMove(
  pending: ReadonlyMap<string, TicketStatus>,
  ticketId: string,
  status: TicketStatus,
): Map<string, TicketStatus> {
  const next = new Map(pending);
  next.set(ticketId, status);
  return next;
}

/**
 * The next card to send, in `seq` order, skipping the one already in flight.
 * `null` when nothing is waiting, or something is already on its way.
 */
export function nextQueuedMove(
  pending: ReadonlyMap<string, TicketStatus>,
  tickets: readonly { id: string; seq: number }[],
  inflight: string | null,
): { id: string; status: TicketStatus } | null {
  if (inflight) return null;
  const waiting = tickets
    .filter((ticket) => pending.has(ticket.id))
    .sort((a, b) => a.seq - b.seq);
  const first = waiting[0];
  if (!first) return null;
  return { id: first.id, status: pending.get(first.id)! };
}
