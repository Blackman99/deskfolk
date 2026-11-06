/**
 * Beside the trace, what is picked in the job (`overlays/JobInspector.svelte`, ADR 0086): a step of
 * the app's own, with its call; a ticket, with what it answers to and its settings; or, with nothing
 * picked, the whole job's spec. The host says which, since on a narrow job the switch above decides
 * it. The spec scrolls here (`PlanSpecPanel` never scrolls itself); its 「待你确认」 line cannot yet
 * scroll to the proposed group, as the panel has no hook for it (see the report).
 */
import type { JSX } from "nsh";
import { Scroll, Text, View, signal } from "nsh";
import type { Bot, BuiltinModelRole, TaskTraceNode, TicketStatus, TicketWithArtifacts } from "@real-bot/protocol";
import { copy } from "../../runtime";
import type { MessengerApi } from "../../m/messenger-api.ts";
import type { JobEngineWhy } from "../../m/overlays/job-engine.ts";
import type { JobState } from "../../m/overlays/job-state.svelte.ts";
import { actorName, latestTurnOfTicket, ticketTag } from "../../m/overlays/plan-board.ts";
import type { TicketEdits } from "../../m/overlays/ticket-edits.svelte.ts";
import { ballLabel, canMakeSample, isDropped, stageLabel, statusOptionsFor } from "../../m/overlays/ticket-labels.ts";
import type { DivisionRow, TicketLanes } from "../../m/overlays/ticket-lanes.ts";
import type { TraceStepGroup } from "../../m/overlays/trace-steps.ts";
import { Icon } from "../Icon";
import { Select } from "../Select";
import { tip } from "../tip";
import { JobDivision } from "./JobDivision";
import { JobEngine } from "./JobEngine";
import { PlanSpecPanel } from "./PlanSpecPanel";
import { TicketConfirm } from "./TicketConfirm";
import { TicketDepends } from "./TicketDepends";
import { TicketDetail } from "./TicketDetail";
import { TraceStepDetail } from "./TraceStepDetail";
import { TicketLink } from "./ticket-parts";

/**
 * Beside the trace, what is picked in the job: a step of the app's own, with its call; a ticket,
 * with what it answers to and its settings; or, with nothing picked, the whole job's spec.
 */
export type InspectorView = "step" | "ticket" | "spec";

/** The engine the job's own calls run under, as the whole job's view says it. */
export type InspectorEngine = { name: string; why: JobEngineWhy; off: string[]; sessions: number; stopped?: boolean; onOpen?: () => void };

export function JobInspector(props: {
  api: MessengerApi | null;
  job: JobState;
  edits: TicketEdits;
  view: InspectorView;
  /** The step whose panel is open, for the step view. */
  stepGroup: TraceStepGroup | null;
  /** The trace's cards, for a ticket's latest turn. */
  nodes: readonly TaskTraceNode[];
  bots: readonly Bot[];
  youLabel: string;
  deletedLabel: string;
  /** The spec held to the picked ticket, opened from the ticket's 「在要点里看」. */
  specHeld: boolean;
  onSpecHeldChange: (held: boolean) => void;
  /** Wide: the inspector takes the whole tab. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Whether widening is offered: only beside the board, not as a narrow job's page or sheet. */
  canExpand: boolean;
  /** The call itself (its model and prompts), changed from a step's panel; CallEditor is ported separately. */
  callEditor?: (role: BuiltinModelRole) => JSX.Element;
  onJump: (sessionId: string, messageId: string) => void;
  onOpenArtifacts: (ticket: TicketWithArtifacts) => void;
  onShowInTrace: (ticketId: string) => void;
  onShowTickets: (status: TicketStatus | "all") => void;
  /** A ticket named in the spec: picked, and shown in place of the spec. */
  onShowTicket: (ticketId: string) => void;
  /** The job's lanes, for who actually ran each ticket. */
  lanes?: TicketLanes | null;
  /** Who does what in the job, above its plan. */
  division?: readonly DivisionRow[];
  engine?: InspectorEngine | null;
  /** Where the spec lies over the trace (medium), the way to put it away. */
  onClose?: () => void;
}) {
  const t = () => copy();
  const job = props.job;
  const botsById = () => new Map(props.bots.map((bot) => [bot.id, bot] as const));
  const ticket = () => (job.selectedTicket ? (job.detail?.tickets.find((row) => row.id === job.selectedTicket) ?? null) : null);
  const latest = () => {
    const picked = ticket();
    return picked ? latestTurnOfTicket(props.nodes, picked.id) : null;
  };
  /** The ticket whose list of what it waits for is open. */
  const dependsOpen = signal<string | null>(null);
  const nameOf = (id: string) => actorName(id, botsById(), props.youLabel, props.deletedLabel);

  const IconBox = (box: { icon: "minimize" | "maximize" | "x"; label: string; pressed?: boolean; testID: string; onPress: () => void }) => (
    <View
      role="button"
      testID={box.testID}
      accessibilityLabel={box.label}
      accessibilityState={box.pressed === undefined ? undefined : { selected: box.pressed }}
      tooltip={tip(box.label)}
      onPress={box.onPress}
      class={`shrink-0 w-6 h-6 items-center justify-center rounded-(--radius-sm) border hover:bg-line-subtle hover:border-line ${box.pressed ? "bg-line-subtle border-line" : "border-transparent"}`}
    >
      <Icon name={box.icon} size={12} class="tint-ink-muted" />
    </View>
  );

  const widen = () => (
    <If when={props.canExpand}>
      {IconBox({
        icon: props.expanded ? "minimize" : "maximize",
        label: props.expanded ? t().plan.job.collapse : t().plan.job.expand,
        pressed: props.expanded,
        testID: "insp-expand",
        onPress: () => props.onExpandedChange(!props.expanded),
      })}
    </If>
  );

  const head = (children: JSX.Element) => (
    <View class="flex-row items-center gap-[6px] min-h-[40px] py-[6px] pr-2 pl-3 border-b border-line-subtle">{children}</View>
  );

  return (
    <View testID="job-inspector-inner" accessibilityLabel={props.view} class="flex-1 min-w-0 min-h-0 bg-pane">
      <If when={props.view === "step" ? props.stepGroup : null}>
        {(group) => (
          <TraceStepDetail
            group={group()}
            fetchRun={props.api ? (id) => props.api!.callRun(id) : undefined}
            onJump={props.onJump}
            callEditor={props.callEditor}
            onClose={() => (job.openStep = null)}
          />
        )}
      </If>
      <If when={props.view === "ticket" && ticket() && job.detail}>
        {() => {
          const picked = () => ticket()!;
          const detail = () => job.detail!;
          const ball = () => ballLabel(picked(), detail(), t(), nameOf);
          return (
            <>
              {head(
                <>
                  <Text class="shrink-0 text-[11px] font-mono text-ink-muted">{`#${ticketTag(picked().seq)}`}</Text>
                  <Text role="header" testID="insp-title" class="flex-1 min-w-0 text-[13px] font-semibold text-ink line-clamp-1">
                    {picked().title}
                  </Text>
                  {widen()}
                  {IconBox({ icon: "x", label: t().plan.job.unpick, testID: "insp-unpick", onPress: () => (job.selectedTicket = null) })}
                </>,
              )}
              <Scroll class="flex-1 min-h-0" testID="insp-body">
                <View class="gap-[10px] px-3 pt-[10px] pb-[14px]">
                  <View class="flex-row flex-wrap items-center gap-x-[10px] gap-y-[6px]">
                    <If
                      when={props.api}
                      else={<Text testID="insp-stage" class="text-[12px] font-semibold text-ink">{stageLabel(picked(), t())}</Text>}
                    >
                      <View class="min-w-[132px]" testID="insp-status">
                        <Select
                          value={picked().status}
                          options={statusOptionsFor(picked(), t())}
                          size="sm"
                          ariaLabel={t().plan.changeStatus}
                          disabled={props.edits.patchingId === picked().id}
                          onChange={(value) => void props.edits.changeStatus(picked(), value)}
                        />
                      </View>
                    </If>
                    <If when={picked().parts && picked().parts!.total > 0}>
                      <Text class="text-[11px] font-mono text-ink-muted">{t().plan.partsApproved(picked().parts!.approved, picked().parts!.total)}</Text>
                    </If>
                    <If when={ball()}>
                      <Text class="text-[11px] text-ink-muted">{ball()}</Text>
                    </If>
                  </View>
                  <If when={isDropped(picked()) && picked().dropped_why}>
                    <Text class="text-[11.5px] text-ink-muted">{t().plan.droppedWhy(picked().dropped_why!)}</Text>
                  </If>
                  <If when={picked().spec}>
                    <View class="px-2 py-[6px] rounded-(--radius-xs) bg-line-subtle">
                      <Text testID="insp-spec" class="text-[12px] leading-[1.5] text-ink-secondary">{picked().spec}</Text>
                    </View>
                  </If>
                  <View class="flex-row flex-wrap gap-x-[10px] gap-y-[2px] -ml-1">
                    <If when={picked().artifacts.length > 0}>
                      <TicketLink
                        testID="insp-artifacts"
                        label={t().plan.artifacts(picked().artifacts.length)}
                        size={11.5}
                        onPress={() => props.onOpenArtifacts(picked())}
                      />
                    </If>
                    <If when={latest()}>
                      {(node) => (
                        <>
                          <TicketLink testID="insp-show-trace" label={t().plan.links.showInTrace} size={11.5} onPress={() => props.onShowInTrace(picked().id)} />
                          <TicketLink
                            testID="insp-jump"
                            label={t().plan.jumpToTurn}
                            size={11.5}
                            onPress={() => props.onJump(node().session_id, node().focus_message_id)}
                          />
                        </>
                      )}
                    </If>
                    <If when={props.api && canMakeSample(picked(), detail())}>
                      <TicketLink
                        testID="insp-make-sample"
                        label={t().plan.makeSample}
                        title={t().plan.makeSampleHint}
                        size={11.5}
                        disabled={props.edits.patchingId === picked().id}
                        onPress={() => void props.edits.makeSample(picked())}
                      />
                    </If>
                  </View>
                  <View class="gap-2 min-w-0">
                    <TicketDetail
                      api={props.api}
                      detail={detail()}
                      ticket={picked()}
                      bots={props.bots}
                      youLabel={props.youLabel}
                      deletedLabel={props.deletedLabel}
                      edits={props.edits}
                      onShowSpec={() => props.onSpecHeldChange(true)}
                      dependsOpen={dependsOpen()}
                      onDependsOpenChange={(id) => dependsOpen.set(id)}
                      ranBy={props.lanes?.ranBy.get(picked().id) ?? null}
                    />
                    <If when={dependsOpen() === picked().id}>
                      <TicketDepends detail={detail()} ticket={picked()} edits={props.edits} />
                    </If>
                    <TicketConfirm ticket={picked()} edits={props.edits} />
                  </View>
                </View>
              </Scroll>
            </>
          );
        }}
      </If>
      <If when={props.view === "spec" ? job.detail : null}>
        {(detail) => {
          const held = () => (props.specHeld ? ticket() : null);
          return (
            <>
              {head(
                <>
                  <If
                    when={held()}
                    else={<Text testID="insp-label" class="flex-1 min-w-0 text-[12px] font-bold text-ink">{t().plan.job.wholeJob}</Text>}
                  >
                    {(picked) => (
                      <View
                        role="button"
                        testID="insp-back"
                        onPress={() => props.onSpecHeldChange(false)}
                        class="flex-1 min-w-0 flex-row items-center gap-1 px-1 py-[2px] self-start rounded-(--radius-sm) hover:bg-accent-tint"
                      >
                        <Icon name="chevron-left" size={12} class="tint-brand" />
                        <Text class="text-[12px] font-semibold text-brand line-clamp-1">{t().plan.job.backToTicket(`#${ticketTag(picked().seq)}`)}</Text>
                      </View>
                    )}
                  </If>
                  {widen()}
                  <If when={props.onClose}>
                    {IconBox({ icon: "x", label: t().common.close, testID: "insp-close", onPress: () => props.onClose?.() })}
                  </If>
                </>,
              )}
              <Scroll class="flex-1 min-h-0" testID="insp-body-spec">
                <If when={!held() && ((props.division?.length ?? 0) > 0 || props.engine)}>
                  {/* Who does what: the Bots on the job's tickets, then the app's own steps. */}
                  <View testID="insp-job" class="gap-[14px] px-4 py-3 border-b border-line-subtle">
                    <JobDivision rows={props.division ?? []} bots={props.bots} youLabel={props.youLabel} deletedLabel={props.deletedLabel} />
                    <If when={props.engine}>
                      {(engine) => (
                        <JobEngine
                          name={engine().name}
                          why={engine().why}
                          off={engine().off}
                          sessions={engine().sessions}
                          stopped={engine().stopped}
                          onOpen={engine().onOpen}
                        />
                      )}
                    </If>
                  </View>
                </If>
                <PlanSpecPanel
                  api={props.api}
                  detail={detail()}
                  onSaved={(next) => (job.detail = next)}
                  onConflict={() => job.reloadPlan()}
                  onJump={props.onJump}
                  selectedTicket={held()?.id ?? null}
                  onShowTicket={props.onShowTicket}
                  onClearTicket={() => props.onSpecHeldChange(false)}
                  onShowTickets={props.onShowTickets}
                  bots={props.bots.slice()}
                  deletedLabel={props.deletedLabel}
                />
              </Scroll>
            </>
          );
        }}
      </If>
    </View>
  );
}
