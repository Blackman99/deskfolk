/**
 * One of the app's own calls (ADR 0083) on the trace board: smaller than a turn's card, its
 * conclusion on one line, and slanted, so the app's own work reads apart from the Bots' boxes and
 * your lines. The slanted outline is a `Canvas` behind the text (`trace-shape.tsx`).
 */
import { Text, View, signal, token } from "nsh";
import { copy } from "../../runtime";
import { stepSaid, stepTitle, type TraceStepGroup } from "../../m/overlays/trace-steps.ts";
import { tip } from "../tip";
import { TraceShape } from "./trace-shape";

const SLANT = 8;

export function TraceStepCard(props: {
  group: TraceStepGroup;
  open: boolean;
  lit: boolean;
  dim: boolean;
  onToggle: () => void;
}) {
  /** The newest use says what the step stands at; the count says how many there were. */
  const step = () => props.group.steps.at(-1)!;
  const hover = signal(false);
  const warn = () => step().outcome !== "ok" || props.group.anomalous;
  return (
    <View
      role="button"
      testID={`trace-step-${step().id}`}
      accessibilityLabel={stepSaid(step(), copy())}
      accessibilityState={{ expanded: props.open }}
      tooltip={tip(stepSaid(step(), copy()))}
      onPress={props.onToggle}
      onMouseEnter={() => hover.set(true)}
      onMouseLeave={() => hover.set(false)}
      class={`cursor-pointer select-none relative w-full items-start gap-[2px] py-[6px] ${props.dim ? "opacity-[0.32]" : ""}`}
      style={{ paddingLeft: SLANT + 7, paddingRight: SLANT + 7 }}
    >
      <TraceShape
        kind="step"
        cut={SLANT}
        edge={() => (props.open ? token("brand") : props.group.anomalous ? token("warn") : token("line"))}
        fill={() => (props.group.anomalous ? token("warn-bg") : hover() ? token("line-subtle") : token("pane"))}
        ring={() => (props.lit ? token("warn") : null)}
      />
      <View class="flex-row items-center gap-[6px] w-full min-w-0">
        <View class={`w-[6px] h-[6px] rounded-full ${warn() ? "bg-warn" : "bg-ok"}`} />
        <Text class="flex-1 min-w-0 text-[10px] font-semibold text-ink-muted line-clamp-1">{stepTitle(step(), copy())}</Text>
        <If when={props.group.steps.length > 1}>
          <Text class="text-[10px] text-ink-muted font-mono">{copy().traceSteps.times(props.group.steps.length)}</Text>
        </If>
      </View>
      <Text class="w-full text-[12px] leading-[16px] text-ink line-clamp-2">{stepSaid(step(), copy())}</Text>
      <If when={step().outcome !== "ok" && step().verdict}>
        {/* Read all the same, by the word lists: the reading stands, and why the model's did not. */}
        <Text class="text-[11px] text-warn-text">{copy().traceSteps.failed(step().fail_kind)}</Text>
      </If>
    </View>
  );
}
