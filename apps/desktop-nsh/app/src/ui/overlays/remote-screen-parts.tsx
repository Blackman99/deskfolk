/** The remote screen header's text button (`.screen-text-button`): a toggle shows its state in the accent tint. */
import { Text, View, type JSX } from "nsh";

export function TextButton(props: {
  onPress: () => void;
  pressed?: boolean;
  small?: boolean;
  label?: string;
  tooltip?: string;
  testID?: string;
  children?: JSX.Element;
}) {
  const on = () => props.pressed === true;
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ selected: on() }}
      tooltip={props.tooltip}
      onPress={props.onPress}
      class={`shrink-0 rounded-(--radius-sm) ${props.small ? "px-1 py-[2px]" : "px-2 py-[6px]"} ${on() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
    >
      {typeof props.children === "string" ? (
        <Text class={`text-[13px] ${on() ? "text-brand" : "text-ink"}`}>{props.children}</Text>
      ) : (
        props.children
      )}
    </View>
  );
}
