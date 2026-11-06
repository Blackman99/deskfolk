/**
 * Where the job stands, at a glance, at the top of the spec (`overlays/PlanSpecOverview.svelte`):
 * its tickets by state (each one opens the board on that column) and how many of its checks passed;
 * then, in the same card, whatever the panel puts under them (`children`).
 */
import { Text, View, type JSX } from "nsh";
import type { TicketStatus } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { tip } from "../tip";

const DOT: Record<TicketStatus, string> = {
  todo: "bg-muted-light",
  doing: "bg-brand",
  review: "bg-purple",
  done: "bg-ok",
  parked: "bg-ink-muted",
};

function StateChip(props: { status: TicketStatus; count: number; onPress?: () => void }) {
  return (
    <View
      role={props.onPress ? "button" : undefined}
      testID={`plan-ticket-state-${props.status}`}
      onPress={props.onPress}
      class={`group flex-row items-center gap-1 px-2 py-px border border-line rounded-full bg-pane ${props.onPress ? "hover:border-accent-border" : ""}`}
    >
      <View class={`w-[6px] h-[6px] rounded-full ${DOT[props.status]}`} />
      <Text class={`text-[11px] text-ink-secondary ${props.onPress ? "group-hover:text-brand" : ""}`}>
        {copy().plan.ticketStatus[props.status]}
      </Text>
      <Text class={`text-[11px] font-mono text-ink-secondary ${props.onPress ? "group-hover:text-brand" : ""}`}>{String(props.count)}</Text>
    </View>
  );
}

export function PlanSpecOverview(props: {
  ticketStates: ReadonlyArray<{ status: TicketStatus; count: number }>;
  checks: { pass: number; total: number };
  onShowTickets?: (status: TicketStatus | "all") => void;
  children?: JSX.Element;
}) {
  const pct = () => (props.checks.total > 0 ? Math.round((props.checks.pass / props.checks.total) * 100) : 0);
  return (
    <View
      accessibilityLabel={copy().plan.spec.overview}
      testID="plan-overview"
      class="gap-[10px] min-w-0 px-[14px] py-3 border border-line rounded-(--radius-md) bg-pane"
    >
      <Text class="text-[12px] font-bold text-ink">{copy().plan.spec.overview}</Text>
      <If when={props.ticketStates.length > 0}>
        <View testID="plan-ticket-states" tooltip={tip(copy().plan.links.progressHint)} class="flex-row flex-wrap items-center gap-1 min-w-0">
          <Text class="w-[40px] shrink-0 text-[12px] font-semibold text-ink-muted">{copy().plan.links.ticketStates}</Text>
          <Each of={props.ticketStates} key={(entry) => entry.status}>
            {(entry) => (
              <StateChip
                status={entry().status}
                count={entry().count}
                onPress={props.onShowTickets ? () => props.onShowTickets?.(entry().status) : undefined}
              />
            )}
          </Each>
        </View>
      </If>
      <If when={props.checks.total > 0}>
        <View class="flex-row items-center gap-2 min-w-0">
          <Text class="w-[40px] shrink-0 text-[12px] font-semibold text-ink-muted">{copy().plan.checks.title}</Text>
          <View class="flex-1 h-[6px] min-w-[40px] overflow-hidden rounded-full bg-line-subtle">
            <View
              testID="plan-overview-meter-fill"
              class={`h-full rounded-full ${props.checks.pass === props.checks.total ? "bg-ok" : "bg-brand"}`}
              style={{ width: `${pct()}%` }}
            />
          </View>
          <Text testID="plan-overview-value" class="shrink-0 text-[11px] font-semibold font-mono text-ink-secondary">
            {`${props.checks.pass}/${props.checks.total}`}
          </Text>
        </View>
      </If>
      {props.children}
    </View>
  );
}
