/**
 * The pill switcher of Settings › General's theme and language, as the interface cards use it
 * (`.segmented-control` / `.segmented-btn` in the Svelte cards): a chip-coloured track with one
 * pressed choice drawn as a raised pane in the brand colour. At 540px or less it fills the row.
 *
 * Props: `options` (`{ value, label, testID }`); `value` (the pressed one; `null` for none);
 * `onPick(value)`; `ariaLabel`; `testID` (the group's).
 */
import { Text, View, windowSize } from "nsh";
import { shadow } from "../styles";

export type SegmentedOption<V extends string> = { value: V; label: string; testID?: string };

export function InterfaceSegmented<V extends string>(props: {
  options: readonly SegmentedOption<V>[];
  value: V | null;
  onPick: (value: V) => void;
  ariaLabel?: string;
  testID?: string;
}) {
  const wide = () => windowSize().width <= 540;
  return (
    <View
      role="group"
      testID={props.testID}
      accessibilityLabel={props.ariaLabel}
      class={`flex-row items-center bg-chip border border-chip-line rounded-(--radius-md) p-[3px] gap-[2px] ${wide() ? "w-full" : ""}`}
    >
      <Each of={props.options} key={(option) => option.value}>
        {(option) => (
          <View
            role="button"
            testID={option().testID}
            accessibilityLabel={option().label}
            accessibilityState={{ selected: props.value === option().value }}
            onPress={() => props.onPick(option().value)}
            class={`flex-row items-center justify-center px-[11px] py-[5px] rounded-(--radius-sm) ${wide() ? "grow shrink basis-0" : ""} ${
              props.value === option().value ? "bg-pane" : "hover:bg-line-subtle"
            }`}
            style={{ boxShadow: props.value === option().value ? shadow("xs") : undefined }}
          >
            <Text class={`text-[12px] ${props.value === option().value ? "font-semibold text-brand" : "font-medium text-ink-muted"}`}>
              {option().label}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}
