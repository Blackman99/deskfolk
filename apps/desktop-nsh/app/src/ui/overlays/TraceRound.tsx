/**
 * One line per round on the trace board: open, it heads the round; folded, it stands in for the
 * whole round, and says where the round got to under the line that started it (ADR 0094), not how
 * many cards it took.
 */
import { Text, View } from "nsh";
import type { Ticket } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { formatFullTimestamp } from "../../m/chat/chat-view.ts";
import { roundTime, saidNothing, type TraceRound as Round } from "../../m/overlays/task-trace.ts";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { TicketTag } from "./trace-parts";

export function TraceRound(props: {
  round: Round;
  ticketsById: ReadonlyMap<string, Ticket>;
  nameOf: (actor: string) => string;
  onToggle: () => void;
}) {
  const round = () => props.round;
  const header = () => round().header!;
  const tickets = () => (
    <>
      <Each of={round().ticketIds} key={(id: string) => id}>
        {(id: () => string) => {
          const ticket = () => props.ticketsById.get(id());
          return <If when={ticket()}>{(row: () => Ticket) => <TicketTag ticket={row()} />}</If>;
        }}
      </Each>
      <If when={round().live}>
        <View testID="trace-round-live" accessibilityLabel={copy().trace.status.running} tooltip={tip(copy().trace.status.running)} class="shrink-0 w-[7px] h-[7px] rounded-full bg-brand" />
      </If>
    </>
  );
  /** What came of the round, where it is worth a look: turns cut short, files, steps that went wrong. */
  const marks = () => (
    <>
      <If when={round().cut > 0}>
        <Text class="shrink-0 text-[11px] text-danger-text">{copy().trace.roundCut(round().cut)}</Text>
      </If>
      <If when={round().files > 0}>
        <Text class="shrink-0 text-[11px] text-ink-muted">{copy().trace.roundFiles(round().files)}</Text>
      </If>
      <If when={round().anomalies > 0}>
        <Text class="shrink-0 text-[11px] text-warn-text">{copy().traceSteps.anomaliesCount(round().anomalies)}</Text>
      </If>
    </>
  );
  const hint = () => (round().folded ? `${copy().trace.roundUnfold} · ${copy().trace.roundCards(round().cards)}` : copy().trace.roundFold);
  const hasOutcome = () => round().folded && round().last !== null;
  return (
    <View
      role="button"
      testID={`trace-round-${round().root}`}
      accessibilityLabel={hint()}
      accessibilityState={{ expanded: !round().folded }}
      tooltip={tip(hint())}
      onPress={props.onToggle}
      class={`absolute px-[10px] ${hasOutcome() ? "flex-col justify-center gap-[5px]" : `flex-row items-center gap-[6px] ${round().folded ? "" : "justify-center"}`} border ${
        round().folded ? "border-line bg-pane rounded-(--radius-md)" : "border-line rounded-full hover:bg-line-subtle"
      }`}
      style={{
        left: header().x,
        top: header().y,
        width: header().width,
        height: header().height,
        borderStyle: round().folded ? "solid" : "dashed",
      }}
    >
      <If
        when={round().folded}
        else={
          <>
            <View style={{ transform: "rotate(90deg)" }}>
              <Icon name="chevron-right" size={12} />
            </View>
            <Text tooltip={tip(formatFullTimestamp(round().node.created_at))} class="text-[11px] text-ink-muted font-mono">
              {roundTime(round().node.created_at)}
            </Text>
            <Text class="text-[11px] text-ink-muted">
              {`${copy().trace.roundCards(round().cards)}${round().files > 0 ? ` · ${copy().trace.roundFiles(round().files)}` : ""}`}
            </Text>
            {tickets()}
          </>
        }
      >
        <View class="flex-row items-center gap-[6px] min-w-0 w-full">
          <Icon name="chevron-right" size={12} />
          <Text class="flex-1 min-w-0 text-[12px] text-ink-secondary line-clamp-1">
            <Text class="font-semibold text-ink">{`${props.nameOf(round().node.actor)}：`}</Text>
            {round().node.summary}
          </Text>
          <Text tooltip={tip(formatFullTimestamp(round().node.created_at))} class="shrink-0 text-[11px] text-ink-muted font-mono">
            {roundTime(round().node.created_at)}
          </Text>
          {tickets()}
          <If when={!round().last}>{marks()}</If>
        </View>
        <If when={round().last}>
          {(last: () => NonNullable<Round["last"]>) => (
            <View class="flex-row items-center gap-[6px] min-w-0 w-full" style={{ paddingLeft: 18 }}>
              <Text class="flex-1 min-w-0 text-[12px] text-ink-secondary line-clamp-1">
                <Text class="text-ink-muted">{"→ "}</Text>
                <Text class="font-semibold text-ink-secondary">{`${props.nameOf(last().actor)}：`}</Text>
                {saidNothing(last()) ? copy().trace.silent : last().summary}
              </Text>
              {marks()}
            </View>
          )}
        </If>
      </If>
    </View>
  );
}
