/**
 * The small pieces every step of the wizard is made of (the scoped CSS of `Onboarding.svelte`): a
 * step's heading, the buttons it puts in the card's footer, and the segmented switch that chooses a
 * way (how setup reaches a model; how the last step starts; the way of working). The Svelte wizard
 * still draws the ways as cards with every description shown (`.connect-modes`).
 *
 * What a heading or a way is for is a "?" beside it (`HelpTip`), not a paragraph under it: the
 * paragraphs ran the longer steps past the window, and one that came and went with a choice moved
 * everything under it.
 */
import { Text, View, type JSX } from "nsh";
import { narrowWindow } from "../Modal";
import { HelpTip } from "../settings/HelpTip";
import { shadow } from "../styles";

/** `.step-pane-header`: the step's title, and what it is for as the "?" beside it (`tipTestID`). */
export function StepHead(props: { title: string; desc?: string; testID?: string; tipTestID?: string }) {
  return (
    <View class="flex-row items-center gap-2">
      <Text role="header" testID={props.testID} class="shrink min-w-0 text-[16px] font-semibold text-ink">
        {props.title}
      </Text>
      <If when={props.desc}>
        <HelpTip text={props.desc} label={props.title} testID={props.tipTestID} />
      </If>
    </View>
  );
}

/** `.step-pane-desc` and `.field-hint` lines: what a step still says in the open, such as a check not passed. */
export function Desc(props: { testID?: string; children: string }) {
  return (
    <Text testID={props.testID} class="text-[13px] leading-[1.45] text-ink-muted">
      {props.children}
    </Text>
  );
}

/** `.step-nav-footer`: a step's buttons, back (or skip) then on, at the end of the card's footer. */
export function StepFooter(props: { children?: JSX.Element }) {
  return <View class="flex-row items-center justify-end gap-[10px] shrink-0">{props.children}</View>;
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
 * A choice of a few ways as one segmented row, and a "?" after it (`<idPrefix>-tip`) with each
 * way's name over its line, the chosen one in the accent, under `intro` when there is one. The
 * cards' every description at once made the last step longer than the window, and the chosen
 * way's line under the row, one line or two by the way, moved what came after. The options are
 * radios (`<idPrefix>-<value>`), as the cards' were; `hint` is the group's accessibility hint.
 */
export function WaySwitch<T extends string>(props: {
  label: string;
  value: T;
  options: readonly (readonly [T, string, string])[];
  idPrefix: string;
  hint?: string;
  intro?: string;
  disabled?: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <View class="flex-row items-center gap-2 max-w-full">
      <View
        role="radiogroup"
        accessibilityLabel={props.label}
        accessibilityHint={props.hint}
        class={`flex-row items-center min-w-0 p-[3px] gap-[2px] bg-chip border border-chip-line rounded-(--radius-md) ${narrowWindow() ? "flex-1" : "shrink"}`}
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
      <HelpTip label={props.label} testID={`${props.idPrefix}-tip`}>
        <If when={props.intro}>
          <Text class="text-[12px] font-[450] leading-[1.5] text-ink">{props.intro}</Text>
        </If>
        <Each of={props.options.slice()} key={(option) => option[0]}>
          {(option) => (
            <View class="flex-col gap-[2px]">
              <Text class={`text-[12px] font-semibold ${props.value === option()[0] ? "text-brand" : "text-ink"}`}>{option()[1]}</Text>
              <Text class="text-[12px] leading-[1.5] text-ink-secondary">{option()[2]}</Text>
            </View>
          )}
        </Each>
      </HelpTip>
    </View>
  );
}
