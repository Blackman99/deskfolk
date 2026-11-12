/**
 * The small pieces every step of the wizard is made of (the scoped CSS of `Onboarding.svelte`): a
 * step's heading, its footer and the two buttons in it, and the segmented switch that chooses a way
 * (how setup reaches a model; how the last step starts; the way of working). The Svelte wizard
 * still draws those as cards with every description shown (`.connect-modes`).
 */
import { Text, View, type JSX } from "nsh";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";

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

/**
 * A choice of a few ways as one segmented row, with only the chosen way's line under it: the
 * cards' every description at once made the last step longer than the window. The options are
 * radios (`<idPrefix>-<value>`), as the cards' were; the whole explanation stays in reach as the
 * group's accessibility hint.
 */
export function WaySwitch<T extends string>(props: {
  label: string;
  value: T;
  options: readonly (readonly [T, string, string])[];
  idPrefix: string;
  hint?: string;
  disabled?: boolean;
  onPick: (value: T) => void;
}) {
  const chosen = () => props.options.find((option) => option[0] === props.value);
  return (
    <View class="flex-col gap-[6px]">
      <View
        role="radiogroup"
        accessibilityLabel={props.label}
        accessibilityHint={props.hint}
        class="flex-row items-center self-start max-w-full p-[3px] gap-[2px] bg-chip border border-chip-line rounded-(--radius-md)"
      >
        <Each of={props.options.slice()} key={(option) => option[0]}>
          {(option) => {
            const on = () => props.value === option()[0];
            return (
              <View
                role="radio"
                testID={`${props.idPrefix}-${option()[0]}`}
                accessibilityLabel={option()[1]}
                accessibilityHint={option()[2]}
                accessibilityState={{ checked: on(), disabled: props.disabled === true }}
                disabled={props.disabled}
                onPress={() => props.onPick(option()[0])}
                class={`cursor-pointer select-none disabled:cursor-default shrink min-w-0 items-center justify-center px-3 rounded-(--radius-sm) disabled:opacity-[0.7] ${narrowWindow() ? "min-h-10 grow basis-0" : "py-[6px]"} ${on() ? "bg-pane" : "hover:bg-line-subtle"}`}
                style={{ boxShadow: on() ? shadow("xs") : undefined }}
              >
                <Text class={`text-[13px] line-clamp-1 ${on() ? "font-semibold text-brand" : "font-medium text-ink-muted"}`}>{option()[1]}</Text>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={chosen()}>
        {(option) => <Text class="text-[12px] leading-[1.45] text-ink-muted">{option()[2]}</Text>}
      </If>
    </View>
  );
}
