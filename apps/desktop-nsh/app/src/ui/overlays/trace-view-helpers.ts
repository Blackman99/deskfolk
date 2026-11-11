/**
 * What the trace view works out about a card from the job around it, as plain functions: who
 * woke it, which ticket and conversation it says, whether its model line is a chip, how it stands
 * out on the minimap. Each takes the maps it reads, so the view stays one list of signals.
 */
import type { Bot, SessionSummary, TaskTraceNode, Ticket } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { classifySession, youBotPeer } from "../../m/sidebar/session-groups.ts";
import { sessionTitle } from "../../m/sidebar/session-title.ts";
import type { RouteLogRow } from "../../m/overlays/route-log.ts";
import { highlightOf, wakerCard, type RouteHighlight } from "../../m/overlays/task-trace.ts";
import type { MinimapTone } from "./TraceMinimap";

/** Where a card's conversation is, as the title row says it: a group, a direct, or none we know. */
export function placeOf(
  node: { session_id: string },
  sessionsById: ReadonlyMap<string, SessionSummary>,
  botsById: ReadonlyMap<string, Bot>,
  nameOf: (actor: string) => string,
  deletedLabel: string,
): string {
  const t = copy();
  const session = sessionsById.get(node.session_id);
  if (!session) return t.trace.sessionUnknown;
  if (session.kind === "group") return t.trace.sessionGroup(session.name ?? session.id);
  if (classifySession(session) === "you-bot") {
    const peer = youBotPeer(session);
    return t.trace.sessionDirect(peer ? nameOf(peer) : deletedLabel);
  }
  return t.trace.sessionDirect(
    sessionTitle(session, botsById, { deleted: deletedLabel, archived: deletedLabel, fileDrop: t.sidebar.fileDrop, projectUntitled: t.project.untitled }),
  );
}

/**
 * The ticket a card worked in, as `01`; nothing on your own card and on turns filed under none.
 * Said where the work moved into it: a card in the same ticket as the card that woke it leaves it
 * to that one, so a run of turns in one ticket names it once (ADR 0094).
 */
export function ticketOf(node: TaskTraceNode, byId: ReadonlyMap<string, TaskTraceNode>, ticketsById: ReadonlyMap<string, Ticket>): Ticket | null {
  if (!node.ticket_id) return null;
  const waker = wakerCard(node, byId);
  if (waker && waker.ticket_id === node.ticket_id) return null;
  return ticketsById.get(node.ticket_id) ?? null;
}

/** Lit when the selected ticket is this card's; dim when a ticket is selected and it is not. */
export function ticketLightOf(node: TaskTraceNode, selected: string | null): "lit" | "dim" | null {
  if (!selected) return null;
  return node.ticket_id === selected ? "lit" : "dim";
}

/** A repeated model choice is a chip, unless something came of it: pushback, blame or a failure. */
export function routeCompactOf(node: TaskTraceNode, route: RouteLogRow | null, repeated: ReadonlySet<string>): boolean {
  return route !== null && repeated.has(node.turn_id) && !route.review?.blamedModel && route.feedback.length === 0 && !route.failReason;
}

/** A card on the minimap stands out the way it does on the board. */
export function minimapToneOf(
  node: TaskTraceNode,
  lighting: RouteHighlight | null,
  selectedTicket: string | null,
  focusedTurn: string | null,
): MinimapTone {
  const litKind = highlightOf(node, lighting);
  const ticketLight = ticketLightOf(node, selectedTicket);
  if (litKind === "lit") return lighting === "blamed" ? "blamed" : "lit";
  if (ticketLight === "lit") return "lit";
  if (litKind === "dim" || ticketLight === "dim") return "dim";
  return focusedTurn === node.turn_id ? "focus" : null;
}
