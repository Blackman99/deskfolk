/**
 * The ledger's segmented control (`.segmented` under `.spend` in `SpendView.svelte`): a few
 * toggle buttons in a pill, the pressed one lifted. Not a messenger component of its own; the
 * trend's Tokens/Money switch and the group table's dimension switch both draw it.
 */
import { Text, View } from "nsh";
import { shadow } from "../styles";

export function Segmented<T extends string>(props: {
  items: ReadonlyArray<{ value: T; label: string; testID?: string }>;
  value: T;
  onChange: (value: T) => void;
  /** The group's name for readers. */
  label?: string;
  testID?: string;
}) {
  return (
    <View testID={props.testID} role="group" accessibilityLabel={props.label} class="flex-row gap-[2px] p-[2px] bg-line-subtle rounded-(--radius-sm) self-start">
      {props.items.map((item) => (
        <View
          testID={item.testID}
          role="button"
          accessibilityState={{ pressed: props.value === item.value }}
          onPress={() => props.onChange(item.value)}
          class={`items-center justify-center min-h-[26px] px-3 py-[2px] rounded-(--radius-xs) ${props.value === item.value ? "bg-pane" : "group"}`}
          style={props.value === item.value ? { boxShadow: shadow("xs") } : undefined}
        >
          <Text class={`text-[12px] ${props.value === item.value ? "font-semibold text-ink" : "font-medium text-ink-muted"}`}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}
