/**
 * The plan's spec, whole (`overlays/PlanSpecPanel.svelte`): the goal and the contract (done-when,
 * rules, process, what you asked) read down a main column; where it stands, what the job is and
 * its versions, and its retrospective go down a side column. Narrow, the two make one column, the
 * overview right under the goal. The panel never scrolls itself: its parent does.
 */
import { signal, Text, View } from "nsh";
import { countsEntries } from "../../m/overlays/plan-board.ts";
import { copy } from "../../runtime";
import { PlanRequirements } from "./PlanRequirements";
import { PlanRetrospectives } from "./PlanRetrospectives";
import { PlanSpecOverview } from "./PlanSpecOverview";
import { PlanSpecGuidelines } from "./plan-spec-guidelines";
import { checkGroups } from "./plan-spec-panel";
import { PlanNameBlock } from "./plan-spec-name";
import { PlanAbout, PlanProgress } from "./plan-spec-side";
import { createPlanSpecState, type PlanSpecPanelProps } from "./plan-spec-state";
import { PlanAttention, PlanFocus, PlanGoal, PlanSpecTitle } from "./plan-spec-top";

export type { PlanSpecPanelProps } from "./plan-spec-state";

/** With room for both columns (the Svelte container query's 880px). */
const TWO_COLUMNS = 880;

export function PlanSpecPanel(props: PlanSpecPanelProps) {
  const t = () => copy().plan;
  const state = createPlanSpecState(props);
  const width = signal(0);
  const detail = () => props.detail;
  const focusTicket = () => (props.selectedTicket ? (detail().tickets.find((tk) => tk.id === props.selectedTicket) ?? null) : null);
  const groups = () => checkGroups(detail());

  const emptyCard = () => (
    <View testID="plan-spec-empty" class="gap-[6px] p-3 rounded-(--radius-md) bg-line-subtle">
      <Text class="text-[12px] text-ink-secondary">{t().noSpec}</Text>
      <If when={detail().brief}>
        <Text testID="plan-spec-brief" class="text-[12px] text-ink-secondary">{`${t().brief}：${detail().brief}`}</Text>
      </If>
    </View>
  );

  return (
    <View
      testID="plan-spec"
      accessibilityLabel={t().spec.title}
      onLayout={(e) => width.set(e.bounds.size.width)}
      class="w-full max-w-[1240px] self-center min-w-0 gap-3 px-[18px] pt-4 pb-7"
    >
      <If
        when={detail().spec || detail().revision > 0}
        else={
          // Nothing written up yet: no version to show and no history to open.
          <View testID="plan-spec-blank" class="gap-3">
            <PlanSpecTitle />
            <PlanNameBlock panel={props} state={state} />
            {emptyCard()}
          </View>
        }
      >
        <If when={detail().spec && focusTicket()}>
          <PlanFocus panel={props} ticket={focusTicket()!} />
        </If>
        {() => {
          const spec = detail().spec;
          const goal = spec ? <PlanGoal panel={props} state={state} spec={spec} /> : null;
          const attention = spec ? <PlanAttention panel={props} spec={spec} /> : null;
          const main = (
            <View class="gap-3 min-w-0">
              {spec ? (
                <>
                  <PlanSpecGuidelines panel={props} state={state} spec={spec} groups={groups()} focusTicketId={focusTicket()?.id ?? null} />
                  <If when={detail().requirements}>
                    <PlanRequirements
                      api={props.api}
                      detail={detail()}
                      onSaved={props.onSaved}
                      onJump={props.onJump}
                      selectedTicket={focusTicket()?.id ?? null}
                      onShowTicket={props.onShowTicket}
                    />
                  </If>
                </>
              ) : (
                emptyCard()
              )}
            </View>
          );
          const overview = spec ? (
            <PlanSpecOverview ticketStates={countsEntries(detail().ticket_counts)} checks={groups().total} onShowTickets={props.onShowTickets}>
              <PlanProgress panel={props} state={state} spec={spec} />
            </PlanSpecOverview>
          ) : null;
          const about = <PlanAbout panel={props} state={state} />;
          const retros = (
            <If when={(detail().retrospectives ?? []).length > 0}>
              <PlanRetrospectives api={props.api} detail={detail()} bots={props.bots ?? []} deletedLabel={props.deletedLabel ?? ""} onSaved={props.onSaved} />
            </If>
          );
          return width() >= TWO_COLUMNS ? (
            <View class="flex-row items-start gap-5">
              <View class="flex-1 gap-[14px] min-w-0">
                {goal}
                {attention}
                {main}
              </View>
              <View class="w-[320px] shrink-0 gap-[14px]">
                {overview}
                {about}
                {retros}
              </View>
            </View>
          ) : (
            <View class="gap-[14px] min-w-0">
              {goal}
              {attention}
              {overview}
              {main}
              {about}
              {retros}
            </View>
          );
        }}
      </If>
    </View>
  );
}
