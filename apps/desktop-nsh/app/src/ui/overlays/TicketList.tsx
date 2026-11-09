/**
 * The job's tickets as a board (`overlays/TicketList.svelte`): the heading with the counts and the
 * progress bar, then five columns (todo to parked), each scrolling on its own under its head. A card
 * picks its ticket, its status is a menu, and a press that travels drags it to another column. The
 * board scrolls sideways when the columns do not fit the pane.
 *
 * A card's button with the focus hears Left / Right (bound through `keymap` while it has it, as NSH
 * views take no key events) and passes the focus to the neighbouring column; held at the board's
 * edge, a dragged card scrolls the board under it (`ticket-list-drag`). A lit column is brought into
 * view by scrolling the board to it. Not carried over: the card that had the focus keeping it as it
 * moves to another column.
 */
import { Scroll, Text, View, effect, keymap, signal, token, type ScrollRef, type ViewRef } from "nsh";
import type { Bot, Provider, TaskDetail, TaskTraceNode, Ticket, TicketStatus, TicketWithArtifacts } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api.ts";
import {
  TICKET_STATUS_ORDER,
  boardState,
  completionPercentage,
  countedTicketCount,
  latestTurnOfTicket,
  openTicketCount,
  parkedTicketCount,
  ticketTag,
  totalTicketCount,
} from "../../m/overlays/plan-board.ts";
import { boardColumns } from "../../m/overlays/ticket-board.ts";
import { TicketEdits } from "../../m/overlays/ticket-edits.svelte.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { TicketCard } from "./TicketCard";
import type { CardDrag } from "./ticket-list-drag";

/** A column is at least this wide; wider panes share the room evenly. */
const COLUMN_MIN = 220;
const GAP = 8;

export function TicketList(props: {
  api: MessengerApi | null;
  detail: TaskDetail;
  nodes: readonly TaskTraceNode[];
  bots: readonly Bot[];
  youLabel: string;
  deletedLabel: string;
  /** The ticket whose cards are lit on the board; null lights nothing. */
  selectedId: string | null;
  /** The endpoints, for a ticket's model menu (level 7). */
  providers?: readonly Provider[];
  onSelect: (ticketId: string | null) => void;
  onJump: (sessionId: string, messageId: string) => void;
  onOpenArtifacts: (ticket: TicketWithArtifacts) => void;
  onPatched: (ticket: Ticket) => void;
  onConflict: () => void;
  /** The column the spec asked to bring into view; 'all' lights none. Cards are never hidden by it. */
  statusFilter?: TicketStatus | "all";
  onStatusFilterChange?: (status: TicketStatus | "all") => void;
  /** Open the spec the tickets answer to, keeping the picked ticket picked. */
  onShowSpec?: () => void;
  /** Show the picked ticket's work on the trace: its rounds lit, its newest card in view. */
  onShowInTrace?: (ticketId: string) => void;
  /** The job's one queue of ticket edits, shared with the inspector; left out, the board keeps its own. */
  edits?: TicketEdits;
  /** Whether the picked card unfolds what it answers to and its settings; off where the inspector shows them. */
  details?: boolean;
  /** Which card has the keyboard focus (null: none), for a host that wants to know. */
  onFocusCard?: (ticketId: string | null) => void;
}) {
  const t = () => copy();
  const filter = () => props.statusFilter ?? "all";
  const details = () => props.details ?? true;
  const botsById = () => new Map(props.bots.map((bot) => [bot.id, bot] as const));
  void botsById;
  const tickets = () => [...props.detail.tickets].sort((a, b) => a.seq - b.seq);

  /** Status moves and the picked ticket's settings, through the plan's one queue of edits. */
  const edits =
    props.edits ??
    new TicketEdits({
      api: () => props.api,
      detail: () => props.detail,
      t: () => copy(),
      providers: () => props.providers ?? [],
      onPatched: (ticket) => props.onPatched(ticket),
      onConflict: () => props.onConflict(),
    });
  effect(() => edits.loadModels());

  /** The card under the pointer, once the press has travelled far enough to be a drag. */
  const drag = signal<CardDrag | null>(null);
  /** The column views, so a drag can read where each one is and a lit column can be scrolled to. */
  const columnViews: Partial<Record<TicketStatus, ViewRef | null>> = {};
  let boardScroll: ScrollRef | null = null;
  /** How far the board is scrolled across and each column down, for a card held at an edge. */
  let boardOffset = 0;
  const columnScrolls: Partial<Record<TicketStatus, { ref: ScrollRef | null; y: number }>> = {};
  /** The cards' main buttons, and the one that has the keyboard focus, for Left / Right. */
  const cardViews = new Map<string, ViewRef>();
  const focusedCard = signal<string | null>(null);
  effect(() => props.onFocusCard?.(focusedCard()));
  const board = signal({ width: 0, height: 0 });

  const counted = () => countedTicketCount(props.detail.ticket_counts);
  const completionPct = () => completionPercentage(props.detail.ticket_counts);
  /** The job is over, set aside or dormant: nobody picks up a ticket left open. */
  const settled = () => boardState(props.detail);
  const settledChip = () => {
    const s = settled();
    return s === "dormant" ? t().plan.dormant : s === "parked" ? t().plan.status.parked : t().plan.status.done;
  };
  /** The hint says tickets are left open, so it waits for one to be. */
  const hasOpenCards = () => tickets().some((row) => row.status === "todo" || row.status === "doing" || row.status === "review");
  const columns = () => boardColumns(tickets(), edits.optimistic);
  const columnWidth = () => Math.max(COLUMN_MIN, (board().width - GAP * 4) / 5);

  /** A different plan clears the conflict line; the first read only records it. */
  let conflictFor: string | null = null;
  effect(() => {
    const id = props.detail.id;
    if (conflictFor === null || id === conflictFor) {
      conflictFor = id;
      return;
    }
    conflictFor = id;
    edits.conflictNote = false;
  });

  /** The column the spec asked for is scrolled to, across if the board runs past the pane. */
  effect(() => {
    const status = filter();
    if (status === "all") return;
    const index = columns().findIndex((column) => column.status === status);
    boardScroll?.scrollTo({ x: Math.max(0, index * (columnWidth() + GAP)), animated: true });
  });

  /** Left / Right pass the focus to the neighbouring column's card (the nearest below this one's number), changing no status. */
  function moveFocus(ticketId: string, direction: 1 | -1): void {
    const ticket = tickets().find((row) => row.id === ticketId);
    if (!ticket) return;
    const index = TICKET_STATUS_ORDER.indexOf(edits.columnOfTicket(ticket));
    const next = TICKET_STATUS_ORDER[index + direction];
    if (!next) return;
    const cards = columns().find((column) => column.status === next)?.tickets ?? [];
    const at = cards.findIndex((row) => row.seq >= ticket.seq);
    const target = cards[at >= 0 ? at : 0];
    if (target) cardViews.get(target.id)?.focus();
  }
  effect(() => {
    const current = focusedCard();
    if (current === null) return;
    const off = [
      keymap.bind("left", () => moveFocus(current, -1), { when: "always" }),
      keymap.bind("right", () => moveFocus(current, 1), { when: "always" }),
    ];
    return () => off.forEach((fn) => fn());
  });

  const dependsOpen = signal<string | null>(null);
  const select = (ticketId: string) => props.onSelect(props.selectedId === ticketId ? null : ticketId);

  const counts = () => t().plan.ticketCounts(openTicketCount(props.detail.ticket_counts), counted(), parkedTicketCount(props.detail.ticket_counts));
  void totalTicketCount;

  return (
    <View
      role="region"
      accessibilityLabel={t().plan.tickets}
      testID="ticket-list"
      class={`flex-1 min-w-0 min-h-0 gap-[10px] ${narrowWindow() ? "px-2 pt-[10px] pb-6" : "px-[14px] pt-3 pb-[14px]"}`}
    >
      <View class="gap-[6px] min-w-0">
        <View class="flex-row items-center justify-between gap-2 min-w-0">
          <View class="flex-row items-center gap-[6px]">
            <Icon name="check-square" size={16} class="tint-brand" />
            <Text class="text-[13px] font-bold text-ink">{t().plan.tickets}</Text>
            <If when={settled()}>
              <View
                testID="ticket-settled-chip"
                class={`px-[6px] rounded-full border ${settled() === "ended" ? "border-ok-line bg-ok-bg" : settled() === "dormant" ? "border-dashed border-line-hover" : "border-line bg-chip"}`}
              >
                <Text class={`text-[11px] font-semibold leading-[16px] ${settled() === "ended" ? "text-ok-text" : "text-ink-muted"}`}>{settledChip()}</Text>
              </View>
            </If>
          </View>
          <View class="shrink-0 flex-row items-center gap-[6px]">
            <Text testID="ticket-list-counts" class="text-[11px] text-ink-muted">{counts()}</Text>
            <If when={counted() > 0}>
              <View class={`px-[5px] py-px rounded-full ${completionPct() === 100 ? "bg-ok-bg" : "bg-line-subtle"}`}>
                <Text testID="ticket-completion" class={`text-[10px] font-mono font-bold ${completionPct() === 100 ? "text-ok-text" : "text-ink-muted"}`}>
                  {`${completionPct()}%`}
                </Text>
              </View>
            </If>
          </View>
        </View>
        <If when={counted() > 0}>
          <View class="w-full h-[3px] rounded-full bg-line overflow-hidden">
            <View class="h-full rounded-full bg-ok" style={{ width: `${completionPct()}%` }} />
          </View>
        </If>
        <If when={settled() && hasOpenCards()}>
          {/* Said once, in a line, and it does not promise the job picks up again when a ticket moves. */}
          <Text testID="ticket-settled-hint" class="text-[11px] leading-[1.45] text-ink-muted">
            {t().plan.board.settled[settled() ?? "ended"]}
          </Text>
        </If>
        <If when={tickets().length > 0}>
          <Text class="text-[11px] leading-[1.45] text-ink-muted">{t().plan.links.ticketsHint}</Text>
        </If>
        <If when={edits.conflictNote}>
          <Text testID="ticket-board-conflict" class="text-[11px] leading-[1.45] text-warn-text">{t().plan.board.conflictDropped}</Text>
        </If>
      </View>

      <If
        when={tickets().length > 0}
        else={
          <View class="my-3 px-3 py-4 rounded-(--radius-md) bg-line-subtle">
            <Text testID="ticket-list-empty" class="text-[12px] text-center text-ink-muted">{t().plan.ticketsNone}</Text>
          </View>
        }
      >
        <View class="flex-1 min-w-0 min-h-0" onLayout={(e) => board.set({ width: e.bounds.size.width, height: e.bounds.size.height })}>
          <Scroll
            horizontal
            testID="ticket-board"
            class="flex-1 min-w-0 min-h-0"
            ref={(node) => (boardScroll = node as ScrollRef | null)}
            onScroll={(e) => (boardOffset = e.offset.x)}
            contentClass="flex-row"
            contentStyle={{ gap: GAP }}
          >
            <Each of={columns()} key={(column) => column.status}>
              {(column) => (
                <View
                  role="region"
                  accessibilityLabel={t().plan.ticketStatus[column().status]}
                  testID={`board-column-${column().status}`}
                  ref={(node) => (columnViews[column().status] = node)}
                  class={`min-h-0 rounded-(--radius-md) border bg-line-subtle ${filter() === column().status ? "border-accent-border" : "border-line"} ${drag()?.over === column().status && drag()?.from !== column().status ? "border-dashed border-brand" : ""}`}
                  style={{ width: columnWidth(), height: Math.max(board().height, 0) }}
                >
                  <View class="flex-row items-center gap-[6px] min-w-0 px-2 pt-2 pb-1 bg-line-subtle rounded-t-(--radius-md)">
                    <Text class={`text-[11px] font-semibold ${filter() === column().status ? "text-brand" : "text-ink-muted"}`}>
                      {t().plan.ticketStatus[column().status]}
                    </Text>
                    <Text testID={`board-count-${column().status}`} class="text-[10px] font-mono text-ink-muted">{String(column().tickets.length)}</Text>
                    <If when={filter() === column().status}>
                      <View
                        role="button"
                        testID="board-focus-clear"
                        onPress={() => props.onStatusFilterChange?.("all")}
                        class="cursor-pointer select-none ml-auto"
                      >
                        <Text class="text-[11px] text-brand">{t().plan.board.focusClear}</Text>
                      </View>
                    </If>
                  </View>
                  <Scroll
                    class="flex-1 min-h-0"
                    contentClass="gap-2 px-2 pb-2"
                    ref={(node) => (columnScrolls[column().status] = { ref: node as ScrollRef | null, y: columnScrolls[column().status]?.y ?? 0 })}
                    onScroll={(e) => {
                      const at = columnScrolls[column().status];
                      if (at) at.y = e.offset.y;
                    }}
                  >
                    <If when={column().tickets.length === 0}>
                      <Text class="text-[11px] text-ink-muted">{t().plan.board.emptyColumn}</Text>
                    </If>
                    <Each of={column().tickets} key={(ticket) => ticket.id}>
                      {(ticket) => (
                        <TicketCard
                          api={props.api}
                          detail={props.detail}
                          ticket={ticket()}
                          node={latestTurnOfTicket(props.nodes, ticket().id)}
                          bots={props.bots}
                          youLabel={props.youLabel}
                          deletedLabel={props.deletedLabel}
                          edits={edits}
                          picked={ticket().id === props.selectedId}
                          settled={settled() !== null}
                          dragging={drag()?.ticketId === ticket().id}
                          details={details()}
                          dependsOpen={dependsOpen()}
                          onDependsOpenChange={(id) => dependsOpen.set(id)}
                          drag={{
                            columns: () => columnViews,
                            boardScroll: () => ({ ref: boardScroll, offset: () => boardOffset }),
                            columnScroll: (status) => {
                              const at = columnScrolls[status];
                              return at ? { ref: at.ref, offset: () => at.y } : null;
                            },
                            onDrag: (next) => drag.set(next),
                            onDrop: (row, status) => edits.requestStatus(row, status),
                          }}
                          focus={{
                            ref: (node) => (node ? cardViews.set(ticket().id, node) : cardViews.delete(ticket().id)),
                            focusNow: () => cardViews.get(ticket().id)?.focus(),
                            onFocusChange: (focused) => {
                              if (focused) focusedCard.set(ticket().id);
                              else if (focusedCard() === ticket().id) focusedCard.set(null);
                            },
                          }}
                          onSelect={() => select(ticket().id)}
                          onJump={props.onJump}
                          onOpenArtifacts={props.onOpenArtifacts}
                          onShowSpec={props.onShowSpec}
                          onShowInTrace={props.onShowInTrace}
                        />
                      )}
                    </Each>
                  </Scroll>
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </If>
      <If when={drag()}>
        {(dragging) => {
          const ghost = () => tickets().find((row) => row.id === dragging().ticketId);
          return (
            <If when={ghost()}>
              {(row) => (
                <View
                  testID="ticket-ghost"
                  class="flex-row items-center gap-[6px] max-w-[220px] px-2 py-[6px] rounded-(--radius-md) border border-accent-border bg-pane"
                  style={{ position: "fixed", left: dragging().x - 16, top: dragging().y - 12, zIndex: 50, pointerEvents: "none", borderColor: token("accent-border") }}
                >
                  <Text class="text-[10px] font-mono font-bold text-ink-muted">{ticketTag(row().seq)}</Text>
                  <Text class="shrink min-w-0 text-[12px] font-semibold text-ink line-clamp-1">{row().title}</Text>
                </View>
              )}
            </If>
          );
        }}
      </If>
    </View>
  );
}
