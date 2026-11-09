/**
 * A button that is only an icon (`IconButton.svelte`). `label` is required: readers announce it and
 * the pointer's tooltip shows it. Sizes 24 / 28 / 32 / 40 (`xs` / `sm` / `md` / `lg`); `pressed`
 * draws a toggle that is on in the accent tint.
 */
import { View } from "nsh";
import { Icon, type IconName } from "./Icon";
import { tip } from "./tip";

const SIZE = {
  xs: "w-[24px] h-[24px] rounded-[6px]",
  sm: "w-[28px] h-[28px] rounded-[7px]",
  md: "w-[32px] h-[32px] rounded-[8px]",
  lg: "w-[40px] h-[40px] rounded-(--radius-md)",
} as const;

export function IconButton(props: {
  icon: IconName;
  label: string;
  size?: keyof typeof SIZE;
  pressed?: boolean;
  filled?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  class?: string;
  testID?: string;
}) {
  const on = () => props.pressed === true;
  return (
      <View
        role="button"
        tooltip={tip(props.label)}
        testID={props.testID}
        accessibilityLabel={props.label}
        accessibilityState={{ selected: on(), disabled: props.disabled }}
        disabled={props.disabled}
        onPress={() => props.onPress?.()}
        class={`cursor-pointer select-none disabled:cursor-default group items-center justify-center shrink-0 active:scale-[0.92] disabled:opacity-[0.4] ${SIZE[props.size ?? "md"]} ${on() ? "bg-accent-tint" : "hover:bg-row-hover"} ${props.class ?? ""}`}
      >
        <Icon
          name={props.icon}
          size={props.size === "lg" ? 20 : 16}
          filled={props.filled}
          class={on() ? "tint-brand" : "tint-ink-muted group-hover:tint-ink"}
        />
      </View>
  );
}
