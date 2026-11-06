/**
 * A box to tick with its label (`<input type="checkbox">` with the messenger's `accent-color`): the
 * row is the press target, the box fills with the accent and shows a check while ticked. The caller
 * owns the value.
 */
import { Text, View, type JSX } from "nsh";
import { Icon } from "./Icon";

export function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** The label's text; or `children` for a label of your own (then give `accessibilityLabel`). */
  label?: string;
  accessibilityLabel?: string;
  class?: string;
  testID?: string;
  children?: JSX.Element;
}) {
  return (
    <View
      role="checkbox"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ checked: props.checked, disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={() => props.onChange(!props.checked)}
      class={`group flex-row items-center gap-2 disabled:opacity-[0.45] ${props.class ?? ""}`}
    >
      <View
        class={`w-[14px] h-[14px] rounded-[4px] border items-center justify-center shrink-0 ${props.checked ? "bg-brand border-brand" : "bg-input-bg border-line-hover group-hover:border-brand"}`}
      >
        <If when={props.checked}>
          <Icon name="check" size={12} class="tint-on-accent" />
        </If>
      </View>
      <If when={props.label} else={props.children}>
        {(label: () => string) => <Text class="text-[13px] text-ink-secondary">{label()}</Text>}
      </If>
    </View>
  );
}
