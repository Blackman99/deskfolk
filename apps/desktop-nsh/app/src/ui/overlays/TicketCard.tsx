/**
 * One ticket's card on the board (the `{#each column.tickets}` body of `TicketList.svelte`): its tag
 * and title (which pick it), its status (a menu with an api, plain words without), who is on it, who
 * has the ball, what it waits for, its spec, its files and latest turn, and, picked, what it
 * answers to and its settings. A press that travels drags the card to another column.
 */
import { Text, View, token, type ViewRef } from "nsh";
import type { Bot, TaskDetail, TaskTraceNode, TicketStatus, TicketWithArtifacts } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { actorFace, actorName, dependsTags, ticketTag } from "../../m/overlays/plan-board.ts";
import type { TicketEdits } from "../../m/overlays/ticket-edits.svelte.ts";
import { ballLabel, canMakeSample, isDropped, stageLabel } from "../../m/overlays/ticket-labels.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { TicketConfirm } from "./TicketConfirm";
import { TicketDepends } from "./TicketDepends";
import { TicketDetail } from "./TicketDetail";
import { cardDrag, type CardDrag, type EdgeScroller } from "./ticket-list-drag";
import { ActorDot, STATUS_TEXT, TicketLink, StatusPill } from "./ticket-parts";

/** A card's border, its accent edge and its tint, by the column it is drawn in. */
const ROW: Record<TicketStatus, string> = {
  todo: "border-line border-l-muted-light bg-pane",
  doing: "border-brand border-l-brand bg-accent-tint",
  review: "border-purple border-l-purple bg-purple-bg",
  done: "border-ok border-l-ok bg-ok-bg",
  parked: "border-line border-l-ink-muted bg-chip opacity-[0.85]",
};

export function TicketCard(props: {
  api: MessengerApi | null;
  detail: TaskDetail;
  ticket: TicketWithArtifacts;
  /** The trace's latest turn on this ticket, if it has one. */
  node: TaskTraceNode | null;
  bots: readonly Bot[];
  youLabel: string;
  deletedLabel: string;
  edits: TicketEdits;
  picked: boolean;
  /** The job is over, set aside or dormant: a card still open sits back. */
  settled: boolean;
  dragging: boolean;
  /** Whether the picked card unfolds what it answers to and its settings; off where the inspector shows them. */
  details: boolean;
  dependsOpen: string | null;
  onDependsOpenChange: (id: string | null) => void;
  /** What a drag of this card needs from the board: the column views, and where the drag and the drop go. */
  drag: {
    columns: () => Partial<Record<TicketStatus, ViewRef | null>>;
    boardScroll?: () => EdgeScroller | null;
    columnScroll?: (status: TicketStatus) => EdgeScroller | null;
    onDrag: (drag: CardDrag | null) => void;
    onDrop: (ticket: TicketWithArtifacts, status: TicketStatus) => void;
  };
  /** The card's main button, for the board to walk the focus between columns (Left / Right). */
  focus?: { ref: (node: ViewRef | null) => void; onFocusChange: (focused: boolean) => void; focusNow?: () => void };
  onSelect: () => void;
  onJump: (sessionId: string, messageId: string) => void;
  onOpenArtifacts: (ticket: TicketWithArtifacts) => void;
  onShowSpec?: () => void;
  onShowInTrace?: (ticketId: string) => void;
}) {
  const t = () => copy();
  const ticket = () => props.ticket;
  const panHandlers = cardDrag(props.ticket.id, {
    enabled: () => Boolean(props.api),
    from: () => props.edits.columnOfTicket(ticket()),
    busy: () => props.edits.patchingId === ticket().id,
    columns: () => props.drag.columns(),
    boardScroll: props.drag.boardScroll,
    columnScroll: props.drag.columnScroll,
    onDrag: (next) => props.drag.onDrag(next),
    onDrop: (status) => props.drag.onDrop(ticket(), status),
  });
  const botsById = () => new Map(props.bots.map((bot) => [bot.id, bot] as const));
  const nameOf = (id: string) => actorName(id, botsById(), props.youLabel, props.deletedLabel);
  const column = () => props.edits.columnOfTicket(ticket());
  const ball = () => ballLabel(ticket(), props.detail, t(), nameOf);
  /** A closed ticket waits on nothing and nobody is still on it: 「已通过 · 设计师在做 · 要等 #02」 read as contradictory. */
  const closed = () => ticket().status === "done" || ticket().status === "parked";
  const waits = () => {
    if (closed()) return null;
    const tags = dependsTags(ticket(), props.detail.tickets);
    return tags ? t().plan.dependsOn(tags) : null;
  };
  /** Making a ticket the sample is offered on the picked card, where its other actions are. */
  const sampleable = () => Boolean(props.api) && props.picked && canMakeSample(ticket(), props.detail);
  const sits = () => props.settled && (column() === "todo" || column() === "doing" || column() === "review");
  const who = () => {
    const worker = ticket().worker;
    if (!worker) return t().plan.nobody;
    const name = nameOf(worker);
    return closed() ? t().plan.workerDone(name) : t().plan.worker(name, ticket().status !== "todo");
  };
  const meta = (text: string, testID: string, tone = "text-ink-muted") => (
    <Text testID={testID} class={`text-[11px] ${tone}`}>{`  ·  ${text}`}</Text>
  );

  return (
    <View
      testID={`ticket-row-${ticket().id}`}
      accessibilityLabel={ticket().title}
      accessibilityState={{ selected: props.picked }}
      tooltip={props.api ? tip(t().plan.board.dragHint) : undefined}
      class={`gap-[6px] pt-2 pr-[10px] pb-2 pl-[9px] rounded-(--radius-md) border border-l-[3.5px] ${ROW[column()]} ${props.picked ? "border-brand" : ""} ${sits() && !props.picked ? "opacity-[0.55]" : ""} ${props.dragging ? "opacity-[0.45]" : ""}`}
      style={{ boxShadow: props.picked ? `0 0 0 1px ${token("brand")}` : undefined }}
      {...panHandlers}
    >
      <View class="flex-row flex-wrap items-start gap-x-[6px] gap-y-1 min-w-0">
        <View
          role="button"
          focusable
          testID={`ticket-main-${ticket().id}`}
          accessibilityLabel={ticket().title}
          accessibilityState={{ pressed: props.picked }}
          ref={(node: ViewRef | null) => props.focus?.ref(node)}
          onFocus={() => props.focus?.onFocusChange(true)}
          onBlur={() => props.focus?.onFocusChange(false)}
          onPress={() => {
            // A press hands the card the focus, so Left / Right walk from it.
            props.focus?.onFocusChange(true);
            props.focus?.focusNow?.();
            props.onSelect();
          }}
          class="cursor-pointer select-none group flex-row items-start gap-[6px] min-w-0"
          style={{ flexGrow: 1, flexShrink: 1, flexBasis: 140 }}
        >
          <View class="shrink-0 px-[5px] rounded-(--radius-xs) bg-line-subtle">
            <Text class="text-[10px] font-mono font-bold leading-[14px] text-ink-muted">{ticketTag(ticket().seq)}</Text>
          </View>
          <Text class="flex-1 min-w-0 text-[13px] font-semibold leading-[1.4] text-ink group-hover:text-brand line-clamp-2">{ticket().title}</Text>
          <If when={ticket().sample}>
            <View tooltip={tip(t().plan.sampleHint)} class="shrink-0 px-[5px] rounded-[4px] border border-line">
              <Text class="text-[10.5px] leading-[16px] text-ink-secondary">{t().plan.sample}</Text>
            </View>
          </If>
        </View>
        <If when={ticket().parts && ticket().parts!.total > 0}>
          <Text class="shrink-0 text-[10.5px] font-mono text-ink-muted">{t().plan.partsApproved(ticket().parts!.approved, ticket().parts!.total)}</Text>
        </If>
        {/* The status is its own menu: one place says it and changes it. */}
        <If
          when={props.api}
          else={
            <View testID="ticket-status" class="shrink-0 flex-row items-center gap-1">
              <Text class={`text-[11px] font-semibold ${STATUS_TEXT[ticket().status]}`}>{stageLabel(ticket(), t())}</Text>
            </View>
          }
        >
          <StatusPill
            ticket={ticket()}
            label={stageLabel(ticket(), t())}
            disabled={props.edits.patchingId === ticket().id}
            onChange={(value) => void props.edits.changeStatus(ticket(), value)}
          />
        </If>
      </View>
      {/* The rest of the card picks it too, as the title does. */}
      <View testID={`ticket-body-${ticket().id}`} onPress={props.onSelect} class="cursor-pointer select-none gap-[5px] min-w-0">
        <View class="flex-row flex-wrap items-center gap-y-[2px] min-w-0">
          {/* Set aside or dropped, it is nobody's: no 「X做的」 for work never done. */}
          <If when={ticket().status !== "parked"}>
            <View class="flex-row items-center gap-[5px] min-w-0">
              <If
                when={ticket().worker}
                else={
                  <View class="shrink-0 w-4 h-4 rounded-full border border-line bg-line-subtle items-center justify-center">
                    <Icon name="user" size={12} class="tint-muted-light" />
                  </View>
                }
              >
                {(worker) => <ActorDot face={actorFace(worker(), botsById(), props.youLabel, props.deletedLabel)} size={16} font={10} />}
              </If>
              <Text testID={`ticket-who-${ticket().id}`} class="shrink min-w-0 text-[11px] text-ink-muted line-clamp-1">{who()}</Text>
            </View>
          </If>
          <If when={ball()}>{(text) => meta(text(), `ticket-ball-${ticket().id}`, "text-ink-secondary")}</If>
          <If when={waits()}>{(text) => meta(text(), `ticket-depends-${ticket().id}`)}</If>
          {/* Picked, the menus below say these; otherwise the line does, only when one is set. */}
          <If when={!props.picked && props.detail.submissions_on && ticket().reviewer_bot_id}>
            {meta(t().plan.reviewedBy(nameOf(ticket().reviewer_bot_id ?? "")), `ticket-reviewer-${ticket().id}`)}
          </If>
          <If when={!props.picked && props.detail.routing_on && ticket().model_override}>
            <Text testID={`ticket-model-${ticket().id}`} class="text-[11px] font-mono text-ink-muted">{`  ·  ${t().plan.onModel(ticket().model_override?.model ?? "")}`}</Text>
          </If>
          {/* Why its lead dropped it, on a line of its own: no 「·」 in front of it. */}
          <If when={isDropped(ticket()) && ticket().dropped_why}>
            <Text testID={`ticket-dropped-${ticket().id}`} class="w-full text-[11px] text-ink-muted">{t().plan.droppedWhy(ticket().dropped_why ?? "")}</Text>
          </If>
        </View>
        <If when={ticket().spec}>
          <View class="px-[6px] py-[3px] rounded-(--radius-xs) bg-line-subtle">
            <Text class="text-[12px] leading-[1.4] text-ink-secondary line-clamp-2">{ticket().spec}</Text>
          </View>
        </If>
      </View>
      <If when={ticket().artifacts.length > 0 || props.node || (props.picked && props.onShowInTrace) || sampleable()}>
        <View class="flex-row flex-wrap items-center gap-x-[10px] gap-y-[2px] -ml-1">
          <If when={ticket().artifacts.length > 0}>
            <TicketLink
              testID={`ticket-artifacts-${ticket().id}`}
              icon="file"
              label={t().plan.artifacts(ticket().artifacts.length)}
              onPress={() => props.onOpenArtifacts(ticket())}
            />
          </If>
          <If when={props.node}>
            {(node) => (
              <TicketLink
                testID={`ticket-jump-${ticket().id}`}
                icon="corner-down-left"
                label={t().plan.jumpToTurn}
                onPress={() => props.onJump(node().session_id, node().focus_message_id)}
              />
            )}
          </If>
          {/* The board hides the trace; this brings it back on the picked ticket's rounds. */}
          <If when={props.picked && props.node && props.onShowInTrace}>
            <TicketLink
              testID={`ticket-show-trace-${ticket().id}`}
              icon="hierarchy"
              label={t().plan.links.showInTrace}
              onPress={() => props.onShowInTrace?.(ticket().id)}
            />
          </If>
          <If when={sampleable()}>
            <TicketLink
              testID={`ticket-make-sample-${ticket().id}`}
              icon="star"
              label={t().plan.makeSample}
              title={t().plan.makeSampleHint}
              disabled={props.edits.patchingId === ticket().id}
              onPress={() => void props.edits.makeSample(ticket())}
            />
          </If>
        </View>
      </If>
      <If when={props.details && props.picked}>
        <TicketDetail
          api={props.api}
          detail={props.detail}
          ticket={ticket()}
          bots={props.bots}
          youLabel={props.youLabel}
          deletedLabel={props.deletedLabel}
          edits={props.edits}
          onShowSpec={props.onShowSpec}
          dependsOpen={props.dependsOpen}
          onDependsOpenChange={props.onDependsOpenChange}
        />
      </If>
      <If when={props.details && props.dependsOpen === ticket().id}>
        <TicketDepends detail={props.detail} ticket={ticket()} edits={props.edits} />
      </If>
      <TicketConfirm ticket={ticket()} edits={props.edits} />
    </View>
  );
}
