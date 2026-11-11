/**
 * The app's multi-pick (`MultiSelect.svelte`): the picked options are chips in the field, typing
 * filters the list, a tick toggles an option and the list stays open for the next. Built on
 * nsh/base's `Combobox` (`multiple`), so the keys, the list as a popup under the field or a sheet
 * on a phone, and what screen readers hear are NSH's; this is the look, the chips and their ✕.
 */
import { platform, signal, Text, View, type JSX } from "nsh";
import { Combobox } from "nsh/base";
import { normalizeOptions, toggleValue, type NormalizedSelectOption, type SelectOption } from "../m/select-options.ts";
import { Icon } from "./Icon";
import { shadow } from "./styles";

export function MultiSelect(props: {
  values?: string[];
  options?: readonly (SelectOption | string)[];
  /** Shown in the field while nothing is picked. */
  placeholder?: string;
  /** Shown in the field once something is, where the typing goes. */
  searchPlaceholder?: string;
  /** The list is empty to begin with. */
  emptyLabel?: string;
  /** The query matched nothing. */
  noMatchLabel?: string;
  removeLabel?: string;
  /** Drawn before the label, in a row of the list and in the chip that row becomes. */
  media?: (option: NormalizedSelectOption, where: "chip" | "option") => JSX.Element;
  disabled?: boolean;
  error?: boolean;
  placement?: "auto" | "bottom" | "top";
  class?: string;
  ariaLabel?: string;
  onChange?: (values: string[]) => void;
  testID?: string;
}) {
  const open = signal(false);
  const own = signal(props.values ?? []);
  const values = () => (props.values !== undefined ? props.values : own());
  const options = () => normalizeOptions(props.options ?? []);
  const picked = () =>
    values()
      .map((value) => options().find((opt) => opt.value === value))
      .filter((opt): opt is NormalizedSelectOption => Boolean(opt));
  const phone = () => !platform.desktop;

  function commit(next: string[]): void {
    own.set(next);
    props.onChange?.(next);
  }

  return (
    <Combobox
      multiple
      testID={props.testID}
      // Open or focused, the field keeps its focus border under the pointer, as the messenger's `:focus-within` and
      // `.is-open` rules outrank its `:hover`: NSH ranks `hover:` above `focus-within:` and above a plain class.
      class={`w-full min-h-[36px] flex-row items-center gap-[5px] pl-[6px] pr-[6px] py-[5px] bg-input-bg border rounded-(--radius-md) focus-within:border-field-focus-border hover:focus-within:border-field-focus-border disabled:opacity-[0.55] disabled:bg-line-subtle ${open() ? "border-field-focus-border" : `hover:border-line-hover ${props.error ? "border-danger-line" : "border-line"}`} ${props.class ?? ""}`}
      style={{ boxShadow: shadow("xs") }}
      items={options().map((o) => ({ value: o.value, title: o.label, disabled: o.disabled, group: o.group }))}
      value={values()}
      onChange={(e) => commit(e.value)}
      open={open()}
      onOpenChange={(e) => open.set(e.open)}
      disabled={props.disabled}
      placeholder={picked().length > 0 ? props.searchPlaceholder : props.placeholder}
      accessibilityLabel={props.ariaLabel ?? props.placeholder}
      placement={props.placement === "top" ? "top" : "bottom"}
      offset={4}
      prefix={
        <If when={picked().length > 0}>
          <View class="flex-row flex-wrap items-center gap-[5px] max-w-full">
            <Each of={picked()} key={(opt) => opt.value}>
              {(opt) => (
                <View class={`flex-row items-center gap-1 max-w-full pr-1 py-[2px] rounded-full bg-accent-tint border border-accent-border ${props.media ? "pl-[3px]" : "pl-2"}`}>
                  <If when={props.media}>{(media) => <View class="shrink-0">{media()(opt(), "chip")}</View>}</If>
                  <Text class="text-[12px] font-semibold text-brand line-clamp-1">{opt().label}</Text>
                  <View
                    role="button"
                    testID={`multi-select-remove-${opt().value}`}
                    accessibilityLabel={`${props.removeLabel ?? ""} ${opt().label}`}
                    disabled={props.disabled}
                    onPress={() => commit(toggleValue(values(), opt().value))}
                    class="cursor-pointer select-none disabled:cursor-default w-[15px] h-[15px] rounded-full items-center justify-center opacity-70 hover:opacity-100 hover:bg-accent-border"
                  >
                    <Icon name="x" size={12} class="tint-brand" />
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
      }
      inputClass="flex-1 min-w-[60px] px-1 py-[2px] text-[14px] text-ink bg-transparent"
      triggerButton={
        <View testID={props.testID ? `${props.testID}-trigger` : undefined} class="cursor-pointer px-1 py-1" accessible={false}>
          <Icon name="chevron-down" size={12} class={open() ? "tint-brand rotate-180" : "tint-ink-muted"} />
        </View>
      }
      popupClass={`bg-pane border border-line rounded-(--radius-md) p-1 ${phone() ? "rounded-b-none" : "max-h-[264px]"}`}
      popupStyle={{ boxShadow: shadow("lg") }}
      backdropClass="bg-modal-backdrop"
      groupClass="px-[10px] pt-2 pb-[3px] text-[11px] text-ink-muted"
      itemClass={`cursor-pointer select-none disabled:cursor-default group flex-row items-center rounded-(--radius-sm) focus:bg-line-subtle disabled:opacity-[0.45] ${phone() ? "min-h-[48px] px-3 py-2" : "px-[10px] py-[7px]"}`}
      empty={
        <Text class="px-3 py-[10px] text-[13px] text-ink-muted text-center">
          {options().length === 0 ? (props.emptyLabel ?? "") : (props.noMatchLabel ?? "")}
        </Text>
      }
      renderItem={(item) => {
        const option = () => options()[item.index];
        return (
          <View class="flex-row items-center gap-2 flex-1 min-w-0">
            <View class="w-[15px] h-[15px] shrink-0 rounded-[3px] border border-line-hover bg-input-bg items-center justify-center group-selected:bg-brand group-selected:border-brand">
              <Icon name="check" size={12} class="tint-on-accent opacity-0 group-selected:opacity-100" />
            </View>
            <If when={props.media && option()}>
              {(opt) => <View class="shrink-0">{props.media!(opt(), "option")}</View>}
            </If>
            <Text class={`line-clamp-1 text-ink group-selected:text-brand group-selected:font-semibold ${phone() ? "text-[15px]" : "text-[13px]"}`}>
              {item.title}
            </Text>
            <If when={option()?.hint}>
              {(hint) => <Text class="flex-1 line-clamp-1 text-right text-[11px] font-normal text-ink-muted">{hint()}</Text>}
            </If>
          </View>
        );
      }}
    />
  );
}
