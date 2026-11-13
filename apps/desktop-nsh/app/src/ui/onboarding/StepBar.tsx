/** `.onboarding-step-bar`: the steps, each a circle and a name, joined by a line; a done step is a check and opens again. */
import { Text, View } from "nsh";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import type { Wizard } from "./wizard";

function Item(props: { n: 1 | 2 | 3 | 4; label: string; step: number; disabled: boolean; onPress?: () => void }) {
  const active = () => props.step === props.n;
  const done = () => props.step > props.n;
  return (
    <View
      role="tab"
      testID={`onboarding-step-tab-${props.n}`}
      accessibilityLabel={props.label}
      accessibilityState={{ selected: active(), disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onPress?.()}
      class="cursor-pointer select-none disabled:cursor-default flex-row items-center gap-2 px-2 py-1 rounded-(--radius-md) hover:bg-row-hover"
    >
      <View
        class={`w-[26px] h-[26px] rounded-full items-center justify-center shrink-0 border ${
          done() ? "bg-brand border-brand" : active() ? "bg-pane border-brand border-2" : "bg-chip border-chip-line"
        }`}
        accessible={false}
      >
        {/* The app's check icon, not the font's "✓": thin and off-centre in the CJK fallback. */}
        <If when={done()} else={<Text class={`text-[12px] font-bold ${active() ? "text-brand" : "text-ink-muted"}`}>{String(props.n)}</Text>}>
          <Icon name="check" size={16} class="tint-on-accent" />
        </If>
      </View>
      <If when={!narrowWindow() || active()}>
        <Text class={`text-[13px] ${active() ? "font-semibold text-ink" : done() ? "font-medium text-ink-secondary" : "font-medium text-ink-muted"}`}>{props.label}</Text>
      </If>
    </View>
  );
}

function Line(props: { done: boolean }) {
  return <View class={`flex-1 h-[2px] mx-1 ${props.done ? "bg-brand" : "bg-line"}`} accessible={false} />;
}

export function StepBar(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy().onboarding;
  return (
    <View role="tablist" accessibilityLabel="Setup steps" class="flex-row items-center justify-between py-1">
      <If when={!w.workspaceReadOnly()}>
        <Item n={1} label={t().step1Title} step={w.step()} disabled={w.setupLocked()} onPress={() => w.goToStep(1)} />
        <Line done={w.step() > 1} />
      </If>
      <Item n={2} label={t().step2Title} step={w.step()} disabled={w.setupLocked()} onPress={() => w.goToStep(2)} />
      <Line done={w.step() > 2} />
      <Item n={3} label={t().step3Title} step={w.step()} disabled={w.setupLocked()} onPress={() => w.goToStep(3)} />
      <If when={w.showBotStep()}>
        <Line done={w.step() > 3} />
        {/* Reached first by saving step 3; after that its tab leads back to it, saving setup again on the way. */}
        <Item
          n={4}
          label={w.carryOffered() ? t().step4StartTitle : t().step4Title}
          step={w.step()}
          disabled={!w.botStepReached() || w.setupLocked()}
          onPress={() => w.goToStep(4)}
        />
      </If>
    </View>
  );
}
