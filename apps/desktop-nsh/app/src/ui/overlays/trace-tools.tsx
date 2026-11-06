/**
 * The pills floating over the bottom of the trace board: the notable-only filter, the model-trouble
 * and step highlights on the left; the zoom, fit and minimap on the right. The strip lets the board
 * through (`box-none`), so a drag anywhere between the pills still pans.
 */
import { Text, View, platform, token } from "nsh";
import type { RouteHighlight } from "../../m/overlays/task-trace.ts";
import type { StepsShown } from "../../m/overlays/trace-steps.ts";
import { copy } from "../../runtime";
import { Checkbox } from "../Checkbox";
import { Icon, type IconName } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";

type Tone = "feedback" | "blamed" | "plain";

/** One highlight: a pill that lights a kind of card, and is pressed while it does. */
function Highlight(props: {
  testID: string;
  tone: Tone;
  pressed: boolean;
  icon?: IconName;
  label: string;
  count?: number;
  tooltip?: string;
  onPress: () => void;
}) {
  const on = () => props.pressed;
  const frame = () =>
    on() && props.tone === "feedback"
      ? "border-accent-border bg-accent-tint"
      : on() && props.tone === "blamed"
        ? "border-warn-line bg-warn-bg"
        : on()
          ? "border-line-hover bg-chip"
          : "border-line bg-chip hover:border-line-hover";
  const text = () => (on() && props.tone === "feedback" ? "text-brand" : on() && props.tone === "blamed" ? "text-warn-text" : on() ? "text-ink" : "text-ink-secondary");
  const tint = () => (on() && props.tone === "feedback" ? "tint-brand" : on() && props.tone === "blamed" ? "tint-warn-text" : "tint-ink-muted");
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ pressed: on() }}
      tooltip={props.tooltip ? tip(props.tooltip) : undefined}
      onPress={props.onPress}
      class={`flex-row items-center gap-[4px] min-h-[28px] px-[9px] border rounded-full ${frame()}`}
      style={{ boxShadow: shadow("xs") }}
    >
      <If when={props.icon}>{(name: () => IconName) => <Icon name={name()} size={12} class={tint()} />}</If>
      <Text class={`text-[12px] ${text()}`}>{props.label}</Text>
      <If when={props.count !== undefined}>
        <Text class={`text-[12px] font-mono ${text()}`}>{String(props.count)}</Text>
      </If>
    </View>
  );
}

function ZoomStep(props: { testID: string; label: string; disabled: boolean; text: string; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      tooltip={tip(props.label)}
      onPress={props.onPress}
      class="min-w-[28px] h-[26px] px-[6px] items-center justify-center rounded-full hover:bg-line-subtle disabled:opacity-[0.4]"
    >
      <Text class="text-[12px] font-medium text-ink-muted">{props.text}</Text>
    </View>
  );
}

function ZoomIcon(props: { testID: string; label: string; icon: IconName; pressed?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={props.pressed === undefined ? undefined : { pressed: props.pressed }}
      tooltip={tip(props.label)}
      onPress={props.onPress}
      class="min-w-[28px] h-[26px] px-[6px] items-center justify-center rounded-full hover:bg-line-subtle"
    >
      <Icon name={props.icon} class={props.pressed ? "tint-brand" : "tint-ink-muted"} />
    </View>
  );
}

export function TraceTools(props: {
  /** The pane is a phone's width: the filter says itself shortly and a touch screen drops the zoom steps. */
  narrow: boolean;
  notableOnly: boolean;
  onNotableOnly: (on: boolean) => void;
  highlightCounts: Record<RouteHighlight, number>;
  lighting: RouteHighlight | null;
  onHighlight: (kind: RouteHighlight) => void;
  /** The job has steps worth a toggle (and is not a line's own board). */
  hasSteps: boolean;
  stepsShown: StepsShown;
  onSteps: () => void;
  anomalyCount: number;
  stepsLit: boolean;
  onStepsLit: () => void;
  scale: number;
  zoomMin: number;
  zoomMax: number;
  onZoom: (scale: number) => void;
  onFit: () => void;
  minimapShown: boolean;
  onMinimap: () => void;
  /** The strip's height, which fitting keeps clear. */
  onHeight: (height: number) => void;
}) {
  const t = () => copy();
  const touch = () => props.narrow && !platform.desktop;
  return (
    <View
      class="absolute left-0 right-0 bottom-0 flex-row items-end justify-between gap-[8px] px-[10px] py-[8px]"
      style={{ pointerEvents: "box-none" }}
      onLayout={(e) => props.onHeight(e.bounds.size.height)}
    >
      <View class="flex-row flex-wrap items-center gap-[6px] min-w-0 shrink" style={{ pointerEvents: "box-none" }}>
        <View
          testID="trace-filter"
          tooltip={tip(t().trace.filter)}
          class="min-h-[28px] justify-center pl-[8px] pr-[10px] py-[3px] border border-line rounded-full bg-pane"
          style={{ boxShadow: shadow("xs") }}
        >
          <Checkbox
            testID="trace-filter-check"
            checked={props.notableOnly}
            onChange={props.onNotableOnly}
            label={props.narrow ? t().trace.filterShort : t().trace.filter}
            accessibilityLabel={t().trace.filter}
          />
        </View>
        <If when={props.highlightCounts.feedback > 0}>
          <Highlight
            testID="trace-highlight-feedback"
            tone="feedback"
            pressed={props.lighting === "feedback"}
            icon="message"
            label={t().routes.filterFeedback}
            count={props.highlightCounts.feedback}
            onPress={() => props.onHighlight("feedback")}
          />
        </If>
        <If when={props.highlightCounts.blamed > 0}>
          <Highlight
            testID="trace-highlight-blamed"
            tone="blamed"
            pressed={props.lighting === "blamed"}
            icon="alert-triangle"
            label={t().routes.filterBlamed}
            count={props.highlightCounts.blamed}
            onPress={() => props.onHighlight("blamed")}
          />
        </If>
        <If when={props.hasSteps}>
          <Highlight
            testID="trace-steps-toggle"
            tone="plain"
            pressed={props.stepsShown === "all"}
            icon="trace-step"
            label={props.stepsShown === "all" ? t().traceSteps.hide : t().traceSteps.show}
            tooltip={t().traceSteps.showHint}
            onPress={props.onSteps}
          />
        </If>
        <If when={props.anomalyCount > 0}>
          <Highlight
            testID="trace-steps-lit"
            tone="blamed"
            pressed={props.stepsLit}
            label={t().traceSteps.anomalies}
            count={props.anomalyCount}
            onPress={props.onStepsLit}
          />
        </If>
      </View>
      <View
        class="shrink-0 flex-row items-center p-[1px] border border-line rounded-full bg-pane"
        style={{ boxShadow: shadow("xs") }}
      >
        <If when={!touch()}>
          <ZoomStep testID="trace-zoom-out" label={t().trace.zoomOut} text="−" disabled={props.scale <= props.zoomMin} onPress={() => props.onZoom(props.scale / 1.2)} />
        </If>
        <View
          role="button"
          testID="trace-zoom-level"
          accessibilityLabel={t().trace.zoomReset}
          tooltip={tip(t().trace.zoomReset)}
          onPress={() => props.onZoom(1)}
          class="min-w-[48px] h-[26px] px-[6px] items-center justify-center rounded-full hover:bg-line-subtle"
        >
          <Text class="text-[12px] font-medium text-ink-muted">{`${Math.round(props.scale * 100)}%`}</Text>
        </View>
        <If when={!touch()}>
          <ZoomStep testID="trace-zoom-in" label={t().trace.zoomIn} text="+" disabled={props.scale >= props.zoomMax} onPress={() => props.onZoom(props.scale * 1.2)} />
        </If>
        <View class="shrink-0 w-[1px] h-[14px] mx-[2px]" style={{ backgroundColor: token("line") }} />
        <ZoomIcon testID="trace-zoom-fit" label={t().trace.zoomFit} icon="fit" onPress={props.onFit} />
        <ZoomIcon
          testID="trace-minimap-toggle"
          label={props.minimapShown ? t().trace.minimapHide : t().trace.minimapShow}
          icon="minimap"
          pressed={props.minimapShown}
          onPress={props.onMinimap}
        />
      </View>
    </View>
  );
}
