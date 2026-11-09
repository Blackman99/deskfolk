/**
 * The app's dropdown (`Select.svelte`): one value from a list, under the field on a desktop and as
 * a sheet from the bottom on a phone. Built on nsh/base's `Select`, so the keys (arrows, Home, End,
 * type-to-find, Return, Escape), focus and what screen readers hear are NSH's; this is the look and
 * the Svelte component's options (strings or `{ value, label, hint, group, disabled }`, `emptyLabel`,
 * `clearable`, `size`, `error`).
 */
import { platform, signal, Text, View } from "nsh";
import { Select as BaseSelect } from "nsh/base";
import { normalizeOptions, type SelectOption } from "../m/select-options.ts";
import { Icon } from "./Icon";
import { shadow } from "./styles";

export type { SelectOption };

export function Select(props: {
  value?: string;
  options?: readonly (SelectOption | string)[];
  placeholder?: string;
  /** Prepends an empty-value option with this label. */
  emptyLabel?: string;
  disabled?: boolean;
  error?: boolean;
  size?: "default" | "sm";
  placement?: "auto" | "bottom" | "top";
  clearable?: boolean;
  class?: string;
  ariaLabel?: string;
  /** The phone sheet's heading; NSH's sheet has none, so this is only the field's name for readers. */
  title?: string;
  /** Kept for parity: the sheet closes on its backdrop and Back. */
  closeLabel?: string;
  /** Empty-list text. */
  noOptionsLabel?: string;
  onChange?: (value: string) => void;
  testID?: string;
}) {
  const open = signal(false);
  const own = signal(props.value ?? "");
  const current = () => (props.value !== undefined ? props.value : own());
  const options = () => normalizeOptions(props.options ?? [], props.emptyLabel);
  const selected = () => options().find((opt) => opt.value === current());
  const label = () => selected()?.label ?? (current() || props.placeholder || "");
  const isPlaceholder = () => !selected() && Boolean(props.placeholder);
  const sm = () => props.size === "sm";
  const phone = () => !platform.desktop;

  function pick(value: string | null): void {
    const next = value ?? "";
    if (next === current()) return;
    own.set(next);
    props.onChange?.(next);
  }

  return (
    <BaseSelect
      class={`relative w-full ${props.class ?? ""}`}
      items={options().map((o) => ({ value: o.value, title: o.label, disabled: o.disabled, group: o.group }))}
      value={selected() ? selected()!.value : null}
      open={open()}
      onOpenChange={(e) => open.set(e.open)}
      onChange={(e) => pick(e.value)}
      disabled={props.disabled}
      cleanable={props.clearable && Boolean(current()) && !props.disabled}
      clearButtonAccessibilityLabel={props.closeLabel ?? "Clear"}
      clearButtonClass="cursor-pointer absolute right-[30px] top-[50%] w-[16px] h-[16px] -mt-[8px] rounded-full items-center justify-center hover:bg-line-subtle"
      clearButton={<Icon name="x" size={12} class="tint-ink-muted" />}
      accessibilityLabel={props.ariaLabel ?? props.title ?? props.placeholder}
      placement={props.placement === "top" ? "top" : "bottom"}
      offset={4}
      popupClass={`bg-pane border border-line rounded-(--radius-md) p-1 max-w-[420px] ${phone() ? "rounded-b-none" : "max-h-[230px]"}`}
      popupStyle={{ boxShadow: shadow("lg") }}
      backdropClass="bg-modal-backdrop"
      groupClass={`px-[10px] pt-2 pb-[3px] text-ink-muted ${phone() ? "text-[12px]" : "text-[11px]"}`}
      itemClass={`cursor-pointer select-none disabled:cursor-default group flex-row items-center rounded-(--radius-sm) focus:bg-line-subtle selected:bg-accent-tint disabled:opacity-[0.45] ${phone() ? "min-h-[48px] px-3 py-[10px]" : sm() ? "px-2 py-[5px]" : "px-[10px] py-[7px]"}`}
      empty={
        <Text class="py-5 px-6 text-[13px] text-ink-muted text-center">{props.noOptionsLabel ?? "暂无选项"}</Text>
      }
      renderItem={(item) => (
        <View class="flex-row items-center justify-between gap-2 flex-1 min-w-0">
          <Text class={`flex-1 line-clamp-1 text-ink group-selected:text-brand group-selected:font-semibold ${phone() ? "text-[15px]" : "text-[13px]"}`}>
            {item.title}
            <If when={options()[item.index]?.hint}>
              {(hint) => <Text class="ml-3 text-[11px] font-normal text-ink-muted">{`  ${hint()}`}</Text>}
            </If>
          </Text>
          <Icon name="check" size={12} class="tint-brand opacity-0 group-selected:opacity-100" />
        </View>
      )}
      trigger={
        <View
          testID={props.testID}
          class={`cursor-pointer select-none disabled:cursor-default flex-row items-center justify-between gap-2 w-full bg-input-bg border rounded-(--radius-md) hover:border-line-hover hover:bg-line-subtle focus-visible:border-field-focus-border disabled:opacity-[0.55] disabled:bg-line-subtle ${open() ? "border-field-focus-border" : props.error ? "border-danger-line" : "border-line"} ${sm() ? "px-[10px] py-[6px]" : "px-3 py-2"}`}
          style={{ boxShadow: props.disabled ? undefined : shadow("xs") }}
        >
          <Text class={`flex-1 line-clamp-1 ${sm() ? "text-[13px]" : "text-[14px]"} ${isPlaceholder() ? "text-ink-muted font-normal" : "text-ink font-medium"}`}>
            {label()}
            <If when={selected()?.hint}>
              {(hint) => <Text class={`font-normal text-ink-muted ${sm() ? "text-[11px]" : "text-[12px]"}`}>{`  ${hint()}`}</Text>}
            </If>
          </Text>
          <Icon name="chevron-down" size={12} class={open() ? "tint-brand rotate-180" : "tint-ink-muted"} />
        </View>
      }
    />
  );
}
