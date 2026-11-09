/**
 * The small parts of a job's layout (`JobLayout.svelte`'s markup and style): the chips in the title
 * row, the switch between the job's three parts on a narrow host, the grip on the edge between two
 * parts, and the head of the board opened out.
 */
import { PanResponder, Text, View } from "nsh";
import type { TraceViewKind } from "../../m/overlays/trace-view.ts";
import { copy } from "../../runtime";
import { Icon, type IconName } from "../Icon";
import { tip } from "../tip";

/** What the title row says of the job beside its stop menu: what needs you, its engine, the toggle for the spec. */
export function JobChip(props: {
  label: string;
  title?: string;
  tone?: "toggle" | "attention";
  /** The toggle's on state. */
  pressed?: boolean;
  disabled?: boolean;
  testID?: string;
  onPress: () => void;
}) {
  const on = () => props.tone === "toggle" && props.pressed;
  const box = () =>
    props.tone === "attention"
      ? "border-warn-line bg-warn-bg"
      : on()
        ? "border-accent-border bg-accent-tint"
        : "border-line bg-chip hover:border-line-hover";
  const ink = () => (props.tone === "attention" ? "text-warn-text font-semibold" : on() ? "text-brand" : "text-ink-secondary");
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={props.tone === "toggle" ? { selected: Boolean(props.pressed), disabled: props.disabled } : { disabled: props.disabled }}
      tooltip={props.title ? tip(props.title) : undefined}
      disabled={props.disabled}
      onPress={props.onPress}
      class={`cursor-pointer select-none disabled:cursor-default shrink-0 px-[9px] py-[2px] rounded-full border ${box()}`}
    >
      <Text class={`text-[11.5px] ${ink()}`}>{props.label}</Text>
    </View>
  );
}

const SEGMENT_ICON: Record<TraceViewKind, IconName> = { board: "list", trace: "hierarchy", spec: "file-text" };

/**
 * The three parts of the job: one segmented switch, the part on screen raised out of the track. It
 * shows only narrow, on a row of its own under the title, each part an equal share of it.
 */
export function JobSegments(props: {
  shown: TraceViewKind;
  hasTickets: boolean;
  tickets: number;
  onChoose: (segment: TraceViewKind) => void;
}) {
  const t = () => copy().plan;
  const label = (kind: TraceViewKind) => (kind === "board" ? t().job.segmentTasks : kind === "trace" ? t().segmentTrace : t().segmentSpec);
  const tab = (kind: TraceViewKind) => (
    <View
      role="tab"
      testID={`job-segment-${kind}`}
      accessibilityLabel={label(kind)}
      accessibilityState={{ selected: props.shown === kind }}
      onPress={() => props.onChoose(kind)}
      class={`cursor-pointer select-none flex-1 flex-row items-center justify-center gap-[5px] min-w-0 min-h-[32px] px-3 py-[3px] rounded-full ${props.shown === kind ? "bg-pane" : ""}`}
    >
      <Icon name={SEGMENT_ICON[kind]} size={12} class={props.shown === kind ? "tint-ink" : "tint-ink-muted"} />
      <Text class={`text-[13px] font-semibold ${props.shown === kind ? "text-ink" : "text-ink-muted"}`}>{label(kind)}</Text>
      <If when={kind === "board"}>
        <View class={`px-[5px] rounded-full ${props.shown === kind ? "bg-accent-tint" : "bg-line-subtle"}`}>
          <Text class={`text-[10px] font-mono font-bold leading-[15px] ${props.shown === kind ? "text-brand" : "text-ink-muted"}`}>{String(props.tickets)}</Text>
        </View>
      </If>
    </View>
  );
  return (
    <View
      role="tablist"
      accessibilityLabel={t().views}
      testID="job-segments"
      class="flex-row items-center gap-[2px] p-[3px] rounded-full border border-line bg-chip"
      style={{ flexBasis: "100%", flexGrow: 1, maxWidth: 480 }}
    >
      <If when={props.hasTickets}>{tab("board")}</If>
      {tab("trace")}
      {tab("spec")}
    </View>
  );
}

/**
 * The grip on the edge between two parts, over the border the column already draws there: pressed
 * and moved, it reports how far (`start`, then `move` with the distance since, then `end`).
 */
export function SplitHandle(props: {
  side: "rail" | "inspector";
  label: string;
  active: boolean;
  onStart: () => void;
  onMove: (dx: number) => void;
  onEnd: () => void;
}) {
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => props.onStart(),
    onPanResponderMove: (_e, g) => props.onMove(g.dx),
    onPanResponderRelease: () => props.onEnd(),
    onPanResponderTerminate: () => props.onEnd(),
  });
  return (
    <View
      role="button"
      testID={`job-split-${props.side}`}
      accessibilityLabel={props.label}
      focusable={false}
      hitSlop={{ left: 4, right: 4 }}
      class={`absolute top-0 bottom-0 w-[1px] ${props.active ? "bg-brand" : "bg-transparent hover:bg-line-hover"}`}
      style={{ [props.side === "rail" ? "right" : "left"]: -1, cursor: "col-resize", zIndex: 4 }}
      {...pan.panHandlers}
    />
  );
}

/** The board opened out has a way back to the rail and the trace, at the right of its head. */
export function BoardHead(props: { onClose: () => void }) {
  return (
    <View class="flex-row justify-end pt-[6px] px-[10px]">
      <View
        role="button"
        testID="job-board-close"
        onPress={props.onClose}
        class="cursor-pointer select-none px-2 py-[3px] rounded-full border border-line bg-pane hover:border-accent-border"
      >
        <Text class="text-[12px] text-ink-secondary">{copy().plan.job.collapseBoard}</Text>
      </View>
    </View>
  );
}
