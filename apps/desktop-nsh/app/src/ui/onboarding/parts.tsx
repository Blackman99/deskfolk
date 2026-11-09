/**
 * The small pieces every step of the wizard is made of (the scoped CSS of `Onboarding.svelte`): a
 * step's heading, its footer and the two buttons in it, and the radio cards that choose a way
 * (how setup reaches a model; how the last step starts).
 */
import { Text, View, type JSX } from "nsh";
import { narrowWindow } from "../Modal";

/** `.step-pane-header`: the step's title and what it is for. */
export function StepHead(props: { title: string; desc?: string; testID?: string }) {
  return (
    <View class="flex-col gap-1">
      <Text role="header" testID={props.testID} class="text-[16px] font-semibold text-ink">
        {props.title}
      </Text>
      <If when={props.desc}>
        <Text class="text-[13px] leading-[1.45] text-ink-muted">{props.desc}</Text>
      </If>
    </View>
  );
}

/** `.step-pane-desc` and `.field-hint` lines. */
export function Desc(props: { testID?: string; children: string }) {
  return (
    <Text testID={props.testID} class="text-[13px] leading-[1.45] text-ink-muted">
      {props.children}
    </Text>
  );
}

/** `.step-nav-footer`: back on the left, on on the right, under a hairline. */
export function StepFooter(props: { children?: JSX.Element }) {
  return <View class="flex-row items-center justify-between mt-[6px] pt-[14px] border-t border-line-subtle">{props.children}</View>;
}

/** `.btn-step-primary`. */
export function StepPrimary(props: { label: string; testID?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none disabled:cursor-default px-[18px] justify-center rounded-(--radius-md) bg-brand hover:bg-accent-hover disabled:opacity-[0.6] ${narrowWindow() ? "min-h-11" : "py-2"}`}
    >
      <Text class="text-[13px] font-semibold text-on-accent">{props.label}</Text>
    </View>
  );
}

/** `.btn-step-secondary`. */
export function StepSecondary(props: { label: string; testID?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none disabled:cursor-default px-[14px] justify-center border border-line rounded-(--radius-md) bg-btn-secondary-bg hover:bg-line-subtle hover:border-line-hover disabled:opacity-[0.6] ${narrowWindow() ? "min-h-11" : "py-[7px]"}`}
    >
      <Text class="text-[13px] font-medium text-ink-secondary">{props.label}</Text>
    </View>
  );
}

/** `.connect-modes`: two cards of which one is on, side by side (one under the other on a narrow window). */
export function ModeCards<T extends string>(props: {
  label: string;
  value: T;
  options: readonly (readonly [T, string, string])[];
  idPrefix: string;
  disabled?: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <View role="radiogroup" accessibilityLabel={props.label} class={`gap-[10px] ${narrowWindow() ? "flex-col" : "flex-row"}`}>
      <Each of={props.options.slice()} key={(option) => option[0]}>
        {(option) => (
          <View
            role="radio"
            testID={`${props.idPrefix}-${option()[0]}`}
            accessibilityLabel={option()[1]}
            accessibilityState={{ checked: props.value === option()[0], disabled: props.disabled === true }}
            disabled={props.disabled}
            onPress={() => props.onPick(option()[0])}
            class={`cursor-pointer select-none disabled:cursor-default flex-1 min-w-0 gap-1 px-[14px] py-3 rounded-(--radius-md) border bg-pane disabled:opacity-[0.7] ${props.value === option()[0] ? "border-brand" : "border-line hover:border-line-hover"}`}
          >
            <Text class="text-[14px] font-semibold text-ink">{option()[1]}</Text>
            <Text class="text-[12px] leading-[1.45] text-ink-muted">{option()[2]}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}
