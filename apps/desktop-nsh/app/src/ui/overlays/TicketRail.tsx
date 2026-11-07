/**
 * The job's tickets down the side of its trace (`overlays/TicketRail.svelte`, ADR 0086), one row
 * each, and in every row a small lane of its turns on the axis every row shares: when work landed
 * on it, who did it, where it was cut, how long the job sat still. A row picks its ticket; a press on
 * its lane also brings the trace to the nearest card. The board of five columns is the rail opened
 * out.
 *
 * The lane is a `Canvas` (the messenger drew an SVG of a 1000-unit viewBox); a press on a row says
 * where on the lane it landed from the row's own press position and the lane's measured frame.
 *
 * A gap's hover hint (the minutes the job sat still) is a small view laid over the canvas where the
 * gap is drawn, since a canvas has no per-shape tooltip. Up / Down between rows are bound through
 * `keymap` while a row has the focus (NSH views take no key events).
 */
import { Canvas, Scroll, Text, View, effect, keymap, signal, token, type ViewRef } from "nsh";
import type { Bot, TaskDetail, TicketStatus, TicketWithArtifacts } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { actorFace, actorName, completionPercentage, countedTicketCount, openTicketCount, parkedTicketCount, ticketTag } from "../../m/overlays/plan-board.ts";
import { stageLabel } from "../../m/overlays/ticket-labels.ts";
import {
  LANE_GAP_UNITS,
  laneBroken,
  laneMarkWidth,
  laneX,
  nearestMark,
  ranBesides,
  ticketOwner,
  type LaneMark,
  type TicketLanes,
} from "../../m/overlays/ticket-lanes.ts";
import { Icon } from "../Icon";
import { cssColor } from "../styles";
import { tip } from "../tip";
import { ActorDot, StageText } from "./ticket-parts";

export function TicketRail(props: {
  detail: TaskDetail;
  lanes: TicketLanes;
  bots: readonly Bot[];
  youLabel: string;
  deletedLabel: string;
  selectedId: string | null;
  /** One status the spec asked for, or every ticket. */
  statusFilter: TicketStatus | "all";
  onPick: (ticketId: string | null) => void;
  /** A card on a ticket's lane: the ticket is picked and the trace slides to the card. */
  onPickMark: (ticketId: string | null, mark: LaneMark) => void;
  onClearFilter: () => void;
  onExpand: () => void;
  /** Which row has the keyboard focus (null: none), for a host that wants to know. */
  onFocusRow?: (ticketId: string | null) => void;
}) {
  const t = () => copy();
  const botsById = () => new Map(props.bots.map((bot) => [bot.id, bot] as const));
  const tickets = () =>
    [...props.detail.tickets]
      .sort((a, b) => a.seq - b.seq)
      .filter((ticket) => props.statusFilter === "all" || ticket.status === props.statusFilter);
  const counted = () => countedTicketCount(props.detail.ticket_counts);
  const done = () => completionPercentage(props.detail.ticket_counts);
  const markWidth = () => Math.max(laneMarkWidth(props.lanes) * 1000 * 0.8, 3);
  const gapWidth = () => laneMarkWidth(props.lanes) * 1000 * LANE_GAP_UNITS;
  /** The rows' views and the one with the keyboard focus, for Up / Down to walk between them. */
  const rowViews = new Map<string, ViewRef>();
  const focusedRow = signal<string | null>(null);
  effect(() => props.onFocusRow?.(focusedRow()));
  effect(() => {
    const current = focusedRow();
    if (current === null) return;
    const walk = (direction: 1 | -1) => {
      const rows = tickets();
      const next = rows[rows.findIndex((row) => row.id === current) + direction];
      if (next) rowViews.get(next.id)?.focus();
    };
    const off = [
      keymap.bind("down", () => walk(1), { when: "always", repeat: true }),
      keymap.bind("up", () => walk(-1), { when: "always", repeat: true }),
    ];
    return () => off.forEach((fn) => fn());
  });
  const nameOf = (actor: string) => actorName(actor, botsById(), props.youLabel, props.deletedLabel);

  /**
   * A Bot's colour on a lane is its avatar's: the ink of its letter, deep enough to read as a mark a
   * couple of pixels wide, so a mark reads as the face on its card.
   */
  const colourOf = (actor: string): string => {
    const palette = actorFace(actor, botsById(), props.youLabel, props.deletedLabel).palette;
    const value = palette?.text ?? palette?.border;
    return value ? cssColor(value) : token("muted-light");
  };

  /** The lane, in a row's own coordinates: where it starts across and down, and how wide it is. */
  type Frame = { x: number; y: number; width: number; height: number };

  /** Where on the lane a press landed, from 0 to 1; null when it was not on the lane. */
  function laneAt(point: { x: number; y: number }, frame: Frame | null): number | null {
    if (!frame || frame.width <= 0) return null;
    if (point.y < frame.y - 4 || point.y > frame.y + frame.height + 4) return null;
    if (point.x < frame.x || point.x > frame.x + frame.width) return null;
    return (point.x - frame.x) / frame.width;
  }

  function Lane(lane: { marks: () => readonly LaneMark[]; label: string; onFrame: (frame: Frame) => void }) {
    return (
      <View
        class="w-full"
        style={{ height: 10 }}
        onLayout={(e) => lane.onFrame({ x: e.bounds.origin.x, y: e.bounds.origin.y, width: e.bounds.size.width, height: e.bounds.size.height })}
      >
      <Canvas
        role="image"
        accessibilityLabel={lane.label}
        testID="rail-lane"
        class="w-full"
        style={{ height: 10 }}
        draw={(cx, size) => {
          const unit = size.width / 1000;
          cx.clearRect(0, 0, size.width, size.height);
          cx.strokeStyle = token("line");
          cx.lineWidth = 1;
          cx.beginPath();
          cx.moveTo(0, 5);
          cx.lineTo(size.width, 5);
          cx.stroke();
          cx.fillStyle = token("line");
          for (const gap of props.lanes.gaps) {
            cx.fillRect((laneX(props.lanes, gap.col) * 1000 - gapWidth()) * unit, 0, gapWidth() * 0.5 * unit, 10);
          }
          for (const mark of lane.marks()) {
            const x = laneX(props.lanes, mark.col) * 1000 * unit;
            const w = Math.max(markWidth() * unit, 1);
            if (laneBroken(mark.status)) {
              cx.fillStyle = token("pane");
              cx.fillRect(x, 1.5, w, 7);
              cx.strokeStyle = colourOf(mark.actor);
              cx.lineWidth = 1.2;
              cx.setLineDash([2, 1.5]);
              cx.strokeRect(x, 1.5, w, 7);
              cx.setLineDash([]);
            } else if (mark.mine) {
              cx.globalAlpha = 0.55;
              cx.fillStyle = token("ink-secondary");
              cx.fillRect(x, 1, w, 8);
              cx.globalAlpha = 1;
            } else {
              cx.fillStyle = colourOf(mark.actor);
              cx.fillRect(x, 1, w, 8);
            }
          }
        }}
      />
      <Each of={props.lanes.gaps.slice()} key={(gap) => gap.col}>
        {(gap) => (
          <View
            testID="rail-lane-gap"
            tooltip={tip(t().plan.job.gap(gap().ms / 60_000))}
            class="absolute top-0 min-w-[4px]"
            style={{
              left: `${(laneX(props.lanes, gap().col) * 1000 - gapWidth()) / 10}%`,
              width: `${(gapWidth() * 0.5) / 10}%`,
              height: 10,
            }}
          />
        )}
      </Each>
      </View>
    );
  }

  /** A press on a row: on a mark's stretch of the lane it also brings the trace to that card. */
  function press(ticket: TicketWithArtifacts, at: number | null): void {
    const mark = at === null ? null : nearestMark(props.lanes, props.lanes.byTicket.get(ticket.id) ?? [], at);
    if (mark) {
      props.onPickMark(ticket.id, mark);
      return;
    }
    props.onPick(props.selectedId === ticket.id ? null : ticket.id);
  }

  const contextRow = (label: string, marks: () => readonly LaneMark[], testID: string, onPress?: (at: number | null) => void, hint?: string) => {
    const frame = signal<Frame | null>(null);
    return (
      <View
        testID={testID}
        role={onPress ? "button" : undefined}
        tooltip={hint ? tip(hint) : undefined}
        onPress={onPress ? (e) => onPress(laneAt(e.position, frame())) : undefined}
        class={`w-full gap-[5px] pt-[7px] pr-[10px] pb-[6px] pl-3 border-b border-line-subtle ${onPress ? "hover:bg-line-subtle" : ""}`}
      >
        <View class="flex-row items-center gap-[6px] min-w-0">
          <Text class="flex-1 min-w-0 text-[12px] text-ink-muted line-clamp-1">{label}</Text>
          <Text class="shrink-0 min-w-[18px] text-right text-[10.5px] font-mono text-ink-muted">{String(marks().length)}</Text>
        </View>
        {Lane({ marks, label, onFrame: (next) => frame.set(next) })}
      </View>
    );
  };

  return (
    <View accessibilityLabel={t().plan.job.railTitle} testID="ticket-rail" class="flex-1 min-w-0 min-h-0 bg-pane">
      <View class="flex-row items-center gap-2 pt-[10px] pr-[10px] pb-2 pl-3 border-b border-line-subtle">
        <Text class="text-[12px] font-bold text-ink">{t().plan.job.railTitle}</Text>
        <Text testID="rail-counts" class="flex-1 min-w-0 text-[11px] text-ink-muted line-clamp-1">
          {t().plan.ticketCounts(openTicketCount(props.detail.ticket_counts), counted(), parkedTicketCount(props.detail.ticket_counts))}
        </Text>
        <If when={counted() > 0}>
          <View class={`px-[6px] rounded-full ${done() === 100 ? "bg-ok-bg" : "bg-chip"}`}>
            <Text testID="rail-done" class={`text-[10px] font-mono font-bold leading-[16px] ${done() === 100 ? "text-ok-text" : "text-ink-muted"}`}>
              {`${done()}%`}
            </Text>
          </View>
        </If>
        <View
          role="button"
          testID="rail-expand"
          accessibilityLabel={t().plan.job.expandBoard}
          tooltip={tip(t().plan.job.expandBoard)}
          onPress={() => props.onExpand()}
          class="w-6 h-6 items-center justify-center rounded-(--radius-sm) border border-transparent hover:bg-line-subtle hover:border-line"
        >
          <Icon name="kanban" size={16} class="tint-ink-muted" />
        </View>
      </View>
      <If when={props.statusFilter !== "all"}>
        <View testID="rail-filter" class="flex-row items-center justify-between gap-2 px-3 py-[6px] border-b border-line-subtle bg-accent-tint">
          <Text class="shrink min-w-0 text-[11px] text-brand">
            {props.statusFilter === "all" ? "" : t().plan.job.filtered(t().plan.ticketStatus[props.statusFilter])}
          </Text>
          <View role="button" testID="rail-filter-clear" onPress={() => props.onClearFilter()}>
            <Text class="text-[11px] font-semibold text-brand">{t().plan.job.clearFilter}</Text>
          </View>
        </View>
      </If>
      <Scroll testID="rail-rows" class="flex-1 min-h-0">
        <If when={props.lanes.yours.length > 0}>
          {contextRow(t().plan.job.yours, () => props.lanes.yours, "rail-yours")}
        </If>
        <Each of={tickets()} key={(ticket) => ticket.id}>
          {(ticket) => {
            const marks = () => props.lanes.byTicket.get(ticket().id) ?? [];
            const owner = () => ticketOwner(ticket());
            const besides = () => ranBesides(ticket(), props.lanes.ranBy.get(ticket().id));
            const picked = () => ticket().id === props.selectedId;
            const frame = signal<Frame | null>(null);
            return (
              <View
                role="button"
                focusable
                testID={`rail-row-${ticket().id}`}
                accessibilityLabel={ticket().title}
                accessibilityState={{ selected: picked() }}
                ref={(node: ViewRef | null) => (node ? rowViews.set(ticket().id, node) : rowViews.delete(ticket().id))}
                onFocus={() => focusedRow.set(ticket().id)}
                onBlur={() => focusedRow() === ticket().id && focusedRow.set(null)}
                onPress={(e) => {
                  // A press hands the row the focus, so Up / Down walk from it.
                  focusedRow.set(ticket().id);
                  rowViews.get(ticket().id)?.focus();
                  press(ticket(), laneAt(e.position, frame()));
                }}
                class={`w-full gap-[5px] pt-[7px] pr-[10px] pb-[6px] pl-3 border-b border-line-subtle focus-visible:bg-line-subtle ${picked() ? "bg-accent-tint" : "hover:bg-line-subtle"}`}
              >
                <View class="flex-row items-center gap-[6px] min-w-0">
                  <Text class="shrink-0 text-[11px] font-mono text-ink-muted">{ticketTag(ticket().seq)}</Text>
                  <Text class="flex-1 min-w-0 text-[12.5px] text-ink line-clamp-1">{ticket().title}</Text>
                  <If when={owner()}>
                    {(who) => (
                      <ActorDot
                        face={actorFace(who(), botsById(), props.youLabel, props.deletedLabel)}
                        size={16}
                        font={10}
                        tooltip={nameOf(who())}
                        testID={`rail-owner-${ticket().id}`}
                      />
                    )}
                  </If>
                  <If when={ticket().reviewer_bot_id}>
                    {(reviewer) => (
                      <ActorDot
                        face={actorFace(reviewer(), botsById(), props.youLabel, props.deletedLabel)}
                        size={13}
                        font={8}
                        class="-ml-[3px]"
                        tooltip={t().plan.reviewedBy(nameOf(reviewer()))}
                        testID={`rail-reviewer-${ticket().id}`}
                      />
                    )}
                  </If>
                  <StageText status={ticket().status} label={stageLabel(ticket(), t())} testID={`rail-stage-${ticket().id}`} />
                  <Text tooltip={tip(t().plan.job.turns(marks().length))} class="shrink-0 min-w-[18px] text-right text-[10.5px] font-mono text-ink-muted">
                    {String(marks().length)}
                  </Text>
                </View>
                <If when={besides()}>
                  {(b) => (
                    <Text testID={`rail-besides-${ticket().id}`} class="-mt-[2px] text-[11px] text-warn-text line-clamp-1">
                      {(b().kind === "instead" ? t().plan.job.ranInstead : t().plan.job.ranAlso)(b().bots.map(nameOf).join("、"))}
                    </Text>
                  )}
                </If>
                {Lane({ marks, label: t().plan.job.turns(marks().length), onFrame: (next) => frame.set(next) })}
              </View>
            );
          }}
        </Each>
        <If when={props.lanes.loose.length > 0}>
          {contextRow(
            t().plan.job.loose,
            () => props.lanes.loose,
            "rail-loose",
            (at) => {
              const mark = at === null ? null : nearestMark(props.lanes, props.lanes.loose, at);
              if (mark) props.onPickMark(null, mark);
            },
            t().plan.job.looseHint,
          )}
        </If>
        <If when={tickets().length === 0 && props.statusFilter === "all"}>
          <Text testID="rail-empty" class="mx-3 my-[14px] text-[12px] text-ink-muted">{t().plan.job.noTickets}</Text>
        </If>
      </Scroll>
    </View>
  );
}
