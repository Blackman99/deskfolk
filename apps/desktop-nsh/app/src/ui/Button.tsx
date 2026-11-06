/**
 * The messenger's text button (`Button.svelte`): `primary` for the one thing a place asks you to do,
 * `secondary` beside it, `ghost` for the quiet way out, `danger` to confirm a loss, `danger-soft` to
 * offer one. Heights 28 / 32 / 40 (`sm` / `md` / `lg`).
 */
import { Text, View, type JSX } from "nsh";
import { Icon, type IconName } from "./Icon";
import { shadow } from "./styles";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-soft";

const BOX: Record<ButtonVariant, string> = {
  primary: "bg-brand hover:bg-accent-hover active:bg-accent-active",
  secondary: "bg-btn-secondary-bg hover:bg-btn-secondary-hover border border-line hover:border-line-hover",
  ghost: "bg-transparent hover:bg-row-hover",
  danger: "bg-danger",
  "danger-soft": "bg-transparent hover:bg-danger-bg",
};

const INK: Record<ButtonVariant, string> = {
  primary: "text-on-accent",
  secondary: "text-ink",
  ghost: "text-ink-secondary group-hover:text-ink",
  danger: "text-on-danger",
  "danger-soft": "text-danger-text",
};

const TINT: Record<ButtonVariant, string> = {
  primary: "tint-on-accent",
  secondary: "tint-ink",
  ghost: "tint-ink-secondary group-hover:tint-ink",
  danger: "tint-on-danger",
  "danger-soft": "tint-danger-text",
};

const SIZE = {
  sm: { box: "h-[28px] px-[10px] rounded-[7px]", text: "text-[12px]" },
  md: { box: "h-[32px] px-[12px] rounded-[8px]", text: "text-[13px]" },
  lg: { box: "h-[40px] px-[16px] rounded-(--radius-md)", text: "text-[14px]" },
} as const;

export function Button(props: {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  trailingIcon?: IconName;
  disabled?: boolean;
  onPress?: () => void;
  class?: string;
  testID?: string;
  label?: string;
  children?: JSX.Element;
}) {
  const variant = () => props.variant ?? "secondary";
  const size = () => SIZE[props.size ?? "md"];
  const iconSize = () => (props.size === "lg" ? 20 : 16);
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={() => props.onPress?.()}
      class={`group flex-row items-center justify-center gap-[6px] shrink-0 active:scale-[0.97] disabled:opacity-[0.45] ${BOX[variant()]} ${size().box} ${props.class ?? ""}`}
      style={{ boxShadow: variant() === "secondary" ? shadow("xs") : undefined }}
    >
      <If when={props.icon}>{(name) => <Icon name={name()} size={iconSize()} class={TINT[variant()]} />}</If>
      <Text class={`font-semibold line-clamp-1 ${size().text} ${INK[variant()]}`}>
        {props.children}
      </Text>
      <If when={props.trailingIcon}>{(name) => <Icon name={name()} size={iconSize()} class={TINT[variant()]} />}</If>
    </View>
  );
}
